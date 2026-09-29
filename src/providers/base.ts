import type { AccountConfig } from '../config.js';
import { clamp, daysBetween, firstString, toIso } from '../lib/json.js';
import type {
  BoundaryKind,
  CreditLot,
  Currency,
  MoneyBalance,
  ProviderSnapshot,
  ProviderStatus,
  QuotaWindow,
  WindowKind,
} from '../types.js';

export interface ProbeContext {
  now: number;
  timeoutMs: number;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * 平台适配器契约。新增平台只需实现 probe() 并注册到 registry。
 * 与 token-monitor 的 per-provider `limits.js` 一一对应。
 */
export interface ProviderAdapter {
  id: string;
  displayName: string;
  region: 'cn' | 'global';
  dashboardUrl: string;
  /** 需要哪些凭证 key，缺失即 notConfigured */
  requiredCredentialKeys: string[];
  credentialHint: string;
  probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot>;
}

export interface WindowInput {
  kind?: WindowKind;
  label: string;
  used: number;
  limit: number;
  remaining?: number;
  boundary?: BoundaryKind;
  resetsAt?: string | null;
  expiresAt?: string | null;
  currency?: Currency;
}

/** 归一化额度窗口，百分比与 remaining 由 used/limit 推导，避免上游字段不一致 */
export function makeWindow(input: WindowInput): QuotaWindow {
  const used = Math.max(0, input.used);
  const limit = Math.max(0, input.limit);
  const remaining = Math.max(0, input.remaining ?? limit - used);
  const usedPercent = limit > 0 ? clamp((used / limit) * 100, 0, 100) : 0;
  return {
    kind: input.kind ?? 'billing',
    label: input.label,
    used,
    limit,
    remaining,
    usedPercent,
    remainingPercent: clamp(100 - usedPercent, 0, 100),
    boundary: input.boundary ?? 'mixed',
    resetsAt: input.resetsAt ? toIso(input.resetsAt) : null,
    expiresAt: input.expiresAt ? toIso(input.expiresAt) : null,
    showMeter: limit > 0,
  };
}

export function makeLot(input: {
  id: string;
  label: string;
  amount: number;
  currency: Currency;
  expiresAt?: string | null;
  note?: string;
}): CreditLot {
  return {
    id: input.id,
    label: input.label,
    amount: Math.max(0, Math.round(input.amount * 100) / 100),
    currency: input.currency,
    expiresAt: input.expiresAt ? toIso(input.expiresAt) : null,
    note: input.note ?? '',
  };
}

export interface SnapshotInput {
  adapter: ProviderAdapter;
  account: AccountConfig;
  status: ProviderStatus;
  now: number;
  source?: 'api' | 'web' | 'local';
  plan?: string | null;
  balance?: MoneyBalance | null;
  credits?: CreditLot[];
  windows?: QuotaWindow[];
  message?: string | null;
  note?: string | null;
  /** 无批次过期时间时，用窗口的重置时间兜底 */
  fallbackExpiryFromWindow?: boolean;
}

/**
 * 组装快照并计算「最快到期」。
 *
 * 过期时间优先级：
 *   1. credits[].expiresAt 中最早的未来时间（真正意义上的积分过期）
 *   2. 窗口 expir/sreset 时间兜底（周期重置等同于作废）
 */
export function buildSnapshot(input: SnapshotInput): ProviderSnapshot {
  const credits = input.credits ?? [];
  const windows = input.windows ?? [];
  let nextExpiryAt: string | null = null;

  const datedLots = credits
    .filter((lot) => lot.expiresAt !== null && lot.amount > 0)
    .sort((a, b) => Date.parse(a.expiresAt as string) - Date.parse(b.expiresAt as string));
  const futureLot = datedLots.find((lot) => Date.parse(lot.expiresAt as string) >= input.now);
  if (futureLot) nextExpiryAt = futureLot.expiresAt;

  if (!nextExpiryAt && input.fallbackExpiryFromWindow !== false) {
    const boundaryTimes = windows
      .map((window) => window.expiresAt ?? (window.boundary === 'reset' ? window.resetsAt : null))
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const future = boundaryTimes.find((value) => Date.parse(value) >= input.now);
    if (future) nextExpiryAt = future;
  }

  return {
    provider: input.adapter.id,
    displayName: input.account.displayName || input.adapter.displayName,
    region: input.adapter.region,
    status: input.status,
    source: input.source ?? 'api',
    updatedAt: new Date(input.now).toISOString(),
    plan: input.plan ?? null,
    balance: input.balance ?? null,
    credits,
    windows,
    nextExpiryAt,
    nextExpiryInDays: nextExpiryAt ? daysBetween(input.now, nextExpiryAt) : null,
    dashboardUrl: input.adapter.dashboardUrl,
    message: input.message ?? null,
    note: input.note ?? null,
    stale: false,
  };
}

export function notConfigured(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  missingKeys: string[],
): ProviderSnapshot {
  return buildSnapshot({
    adapter,
    account,
    status: 'notConfigured',
    now: ctx.now,
    source: 'api',
    message: `缺少凭证：${missingKeys.join(', ')}。${adapter.credentialHint}`,
  });
}

export function failure(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  status: ProviderStatus,
  message: string,
): ProviderSnapshot {
  return buildSnapshot({ adapter, account, status, now: ctx.now, source: 'api', message });
}

/** 从凭证/选项中取第一个非空值，凭证优先 */
export function cred(
  account: AccountConfig,
  ctx: ProbeContext,
  keys: string[],
  optionKeys: string[] = [],
): string {
  for (const key of keys) {
    const value = account.credentials[key];
    if (value) return value;
  }
  for (const key of optionKeys) {
    const value = account.options[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function optString(account: AccountConfig, key: string): string {
  const value = account.options[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function optNumber(account: AccountConfig, key: string): number | null {
  const value = account.options[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 从任意粘贴形式里抽出指定请求头的值。兼容以下三种常见做法：
 *   1. DevTools 右键请求 → Copy as cURL：
 *      curl 'https://x' -H 'cookie: a=1; b=2' -H "authorization: Bearer x"
 *   2. 从 Request Headers 直接复制一整行：Cookie: a=1; b=2
 *   3. 只复制值本身：a=1; b=2
 */
export function extractHeaderValue(raw: string, headerName: string): string {
  const value = raw.trim();
  if (!value) return '';
  const name = headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const curl = new RegExp(
    `(?:-H|--header)\\s+(['"])\\s*${name}\\s*:\\s*([\\s\\S]*?)\\1`,
    'i',
  ).exec(value);
  if (curl?.[2]) return curl[2].trim();
  const line = new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*([^\\n]+)`, 'i').exec(value);
  if (line?.[1]) return line[1].trim();
  return value;
}

/**
 * 把裸 Cookie 值 / `Cookie:` 头 / cURL 抓包统一成可直接发送的 Cookie 头。
 * 另外兼容 Cookie 被换行折行的情况：只把后续仍然长得像 `k=v` 的行拼回来，
 * 这样多行 cURL 命令行不会被误吞。
 */
export function normalizeCookieHeader(raw: string): string {
  const first = extractHeaderValue(raw, 'cookie').replace(/\s+/g, ' ').trim();
  if (!first) return '';
  const continuations = raw
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[^\s:=]+=[^\s;]*;?$/.test(line));
  if (continuations.length === 0) return first;
  return `${first} ${continuations.join(' ')}`.replace(/\s+/g, ' ').trim();
}

/** 从多个候选字段里抽取过期时间，兼容各家命名 */
export function extractExpiry(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const record = source as Record<string, unknown>;
  const nested = [
    record,
    (record.entitlement_base_info ?? record.entitlementBaseInfo) as
      | Record<string, unknown>
      | undefined,
    (record.quota ?? {}) as Record<string, unknown>,
    (record.pack ?? {}) as Record<string, unknown>,
  ].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);

  for (const candidate of nested) {
    const raw = firstString(
      candidate.expiresAt,
      candidate.expires_at,
      candidate.expireAt,
      candidate.expire_at,
      candidate.expireTime,
      candidate.expire_time,
      candidate.expiryDate,
      candidate.expiry_date,
      candidate.validUntil,
      candidate.valid_until,
      candidate.validEndTime,
      candidate.valid_end_time,
      candidate.endTime,
      candidate.end_time,
      candidate.deadline,
    );
    if (raw) {
      const iso = toIso(raw);
      if (iso) return iso;
    }
    const numeric = candidate.expiredAt ?? candidate.expired_at;
    if (numeric !== undefined) {
      const iso = toIso(numeric);
      if (iso) return iso;
    }
  }
  return null;
}
