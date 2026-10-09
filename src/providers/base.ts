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
  SecretRef,
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
  /**
   * 把这个平台的所有账号并进**一张卡片**（每个账号成为卡片里的一条 entry）。
   *
   * 适用于「同一个东西的多份」：D1V 的每个账号都是一把项目密钥 + 一份 quota，
   * 拆成多张卡片会让额度对比被冲散。默认 false = 一个账号一张卡片。
   */
  groupAccounts?: boolean;
  /**
   * 该平台的额度**永不过期**。
   *
   * 必须由适配器显式声明，不能靠「没有批次/没有到期时间」推断——
   * 「确认不会过期」和「上游没给过期信息」是两件事，
   * 后者在界面上应该什么标签都不给，而不是标一个「永不过期」骗人。
   */
  neverExpires?: boolean;
  /**
   * 声明哪些凭证允许在看板上「显示 / 复制」。不声明即整条链路关闭：
   * 快照不带 secrets，`/api/reveal` 也会拒绝该 key。
   *
   * 之所以做成函数而不是静态对象：是否暴露要看账号的具体配置
   * （例如 D1V 默认只暴露项目密钥，账号密钥要显式开启 options.revealApiKey）。
   */
  revealableSecrets?: (account: AccountConfig) => SecretDescriptor[];
  probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot>;
}

export interface SecretDescriptor {
  key: string;
  label: string;
  hint?: string;
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
  const round = (value: number): number => Math.round(value * 100) / 100;
  const used = round(Math.max(0, input.used));
  const limit = round(Math.max(0, input.limit));
  const remaining = round(Math.max(0, input.remaining ?? limit - used));
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
  basis?: 'remaining' | 'granted';
}): CreditLot {
  return {
    id: input.id,
    label: input.label,
    amount: Math.max(0, Math.round(input.amount * 100) / 100),
    currency: input.currency,
    expiresAt: input.expiresAt ? toIso(input.expiresAt) : null,
    note: input.note ?? '',
    basis: input.basis ?? 'remaining',
  };
}

/** 分成「仍可用」与「已过期」两组：过期的批次不再逐条展示，只汇总成一句提示 */
export function splitByExpiry(
  lots: CreditLot[],
  now: number,
): { active: CreditLot[]; expired: CreditLot[] } {
  const active: CreditLot[] = [];
  const expired: CreditLot[] = [];
  for (const lot of lots) {
    if (lot.expiresAt && Date.parse(lot.expiresAt) < now) expired.push(lot);
    else active.push(lot);
  }
  return { active, expired };
}

export function sumAmount(lots: CreditLot[]): number {
  return Math.round(lots.reduce((sum, lot) => sum + lot.amount, 0) * 100) / 100;
}

/**
 * 生成「被隐藏批次」的说明。
 * 看板只展示还能用的批次，但不能让人以为数据丢了，所以把过滤掉的数量说清楚。
 */
export function hiddenLotsNote(expired: CreditLot[], usedUpCount = 0): string | null {
  const parts: string[] = [];
  if (usedUpCount > 0) parts.push(`已隐藏 ${usedUpCount} 个已用尽的积分包`);
  if (expired.length > 0) {
    parts.push(
      `另有 ${expired.length} 个批次已过期（共 ${sumAmount(expired)} 积分作废），未在列表中展示`,
    );
  }
  return parts.length > 0 ? parts.join('；') : null;
}

export function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const kept = notes.filter((note): note is string => typeof note === 'string' && note !== '');
  return kept.length > 0 ? kept.join('；') : null;
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

  // 合并成一张卡片的平台，标题用适配器名（账号身份下移到 entries[].id），
  // 否则多张卡片会顶着各自的账号名、看起来像不同平台
  const displayName = input.adapter.groupAccounts
    ? input.adapter.displayName
    : input.account.displayName || input.adapter.displayName;

  return {
    provider: input.adapter.id,
    displayName,
    accountId: input.account.displayName ?? '',
    groupAccounts: input.adapter.groupAccounts === true,
    neverExpires: input.adapter.neverExpires === true,
    entries: [],
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
    secrets: describeSecrets(input.adapter, input.account),
    stale: false,
  };
}

/**
 * 密钥掩码。保留前后缀是为了让「多个账号」场景下能一眼分辨是哪把钥匙，
 * 这与各家控制台存 `key_prefix` 的做法一致；短到没法安全截断时整体打码。
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * 把适配器声明的可托管凭证转成快照里的 secrets。
 * 只输出**是否存在 + 掩码预览**，明文永远不进快照、不进 API 响应。
 */
export function describeSecrets(
  adapter: ProviderAdapter,
  account: AccountConfig,
): SecretRef[] {
  const declared = adapter.revealableSecrets?.(account) ?? [];
  const out: SecretRef[] = [];
  for (const item of declared) {
    const value = account.credentials[item.key];
    if (!value) continue;
    out.push({
      key: item.key,
      label: item.label,
      preview: maskSecret(value),
      hint: item.hint ?? '',
    });
  }
  return out;
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

/** options 里的布尔开关，兼容 true / "true" / 1 / "1" */
export function optBool(account: AccountConfig, key: string, fallback = false): boolean {
  const value = account.options[key];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
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
