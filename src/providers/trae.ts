import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractHeaderValue,
  failure,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * Trae（trae.cn）
 *
 * 关键点：网页版接口用 `Cloud-IDE-JWT`，而该 Token **只有效约 1 天**。
 * 实测确认 `GetUserToken` 可以用登录态 Cookie 换取新 Token，
 * 因此这里只要求用户提供 Cookie，Token 每次刷新自动续签，无需手工更新。
 *
 * 请求链路（均已实测）：
 *   ① POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken      （Cookie 鉴权）
 *      → { Result: { Token, ExpiredAt, TenantID } }
 *   ② POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list
 *      Authorization: Cloud-IDE-JWT <Token>
 *      → { usage_summary: { consumed_amount, total_amount, consumption_ratio },
 *          user_entitlement_pack_list: [ { display_desc, expire_time,
 *            entitlement_base_info: { quota: { credits_limit } }, usage } ] }
 *
 * 注意口径：实测 `Σ credits_limit === usage_summary.total_amount`，
 * 即 credits_limit 是**授予量**而非剩余量；账户级消耗只由 usage_summary 给出。
 * 所以批次标记为 basis='granted'（只用于表达到期时间，不参与汇总），
 * 余额取 total_amount - consumed_amount。
 */

const TRAE_TOKEN_URL = 'https://api.trae.cn/cloudide/api/v3/common/GetUserToken';
const TRAE_USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list';
const TRAE_TIMEOUT_FALLBACK = 12_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** 按 Cookie 缓存换来的 JWT，避免每次刷新都多打一次接口 */
const tokenCache = new Map<string, CachedToken>();

function cookieKey(cookie: string): string {
  let hash = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    hash = (hash * 31 + cookie.charCodeAt(index)) | 0;
  }
  return `trae-${hash}`;
}

export interface TraePack {
  label: string;
  limit: number;
  expiresAt: string | null;
}

export interface TraeUsage {
  used: number;
  limit: number;
  remaining: number;
  packs: TraePack[];
}

export function parseTraeUsage(body: unknown): TraeUsage {
  if (!isRecord(body)) throw new Error('Trae 返回了非对象响应');
  const summary = pick(body, 'usage_summary', 'usageSummary');
  const packsRaw = pick(body, 'user_entitlement_pack_list', 'userEntitlementPackList');
  if (!Array.isArray(packsRaw)) {
    throw new Error('响应缺少 user_entitlement_pack_list（Token 可能已失效）');
  }

  const packs: TraePack[] = [];
  for (const raw of packsRaw) {
    if (!isRecord(raw)) continue;
    const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo') ?? raw;
    const quota = isRecord(base) ? pick(base, 'quota') : undefined;
    const limit = firstNumber(
      isRecord(quota) ? pick(quota, 'credits_limit', 'creditsLimit') : undefined,
    );
    // 没有 credits_limit 的是功能权益（免费版的开关项），不是积分，跳过
    if (limit === null || limit <= 0) continue;

    const label =
      firstString(
        pick(raw, 'display_desc', 'displayDesc'),
        pick(raw, 'group_name', 'groupName'),
        isRecord(base) ? pick(base, 'product_name', 'productName') : undefined,
      ) || '权益包';
    const expiresAt =
      toIso(pick(raw, 'expire_time', 'expireTime')) ??
      toIso(isRecord(base) ? pick(base, 'end_time', 'endTime') : undefined);

    packs.push({ label, limit, expiresAt });
  }

  if (packs.length === 0) {
    // 全部是功能权益包时，仍允许用 usage_summary 展示总额
    if (!isRecord(summary)) throw new Error('响应中没有可用的积分权益包');
  }

  const summaryUsed = firstNumber(isRecord(summary) ? pick(summary, 'consumed_amount', 'consumedAmount') : undefined);
  const summaryTotal = firstNumber(isRecord(summary) ? pick(summary, 'total_amount', 'totalAmount') : undefined);
  const packLimit = packs.reduce((sum, pack) => sum + pack.limit, 0);

  const limit = summaryTotal ?? packLimit;
  const used = summaryUsed ?? 0;

  return {
    used: Math.max(0, used),
    limit: Math.max(0, limit),
    remaining: Math.max(0, limit - used),
    packs,
  };
}

/**
 * 把同名的、同一时刻到期的包归并成一条，避免签到类平台出现几十条重复批次。
 */
export function mergeLots(packs: TraePack[]): CreditLot[] {
  const grouped = new Map<string, { label: string; expiresAt: string | null; total: number; count: number }>();
  for (const pack of packs) {
    const key = `${pack.label}|${pack.expiresAt ?? ''}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.total += pack.limit;
      entry.count += 1;
    } else {
      grouped.set(key, { label: pack.label, expiresAt: pack.expiresAt, total: pack.limit, count: 1 });
    }
  }

  return [...grouped.entries()]
    .sort((a, b) => {
      const aTime = a[1].expiresAt ? Date.parse(a[1].expiresAt) : Number.POSITIVE_INFINITY;
      const bTime = b[1].expiresAt ? Date.parse(b[1].expiresAt) : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })
    .map(([key, entry]) =>
      makeLot({
        id: `trae-${key}`,
        label: entry.label,
        amount: entry.total,
        currency: 'CREDITS',
        expiresAt: entry.expiresAt,
        note:
          (entry.count > 1 ? `${entry.count} 个同类权益包合计 ${entry.total}；` : '') +
          '该包授予量，账户级剩余见上方总额',
        basis: 'granted',
      }),
    );
}

/** 用 Cookie 换取（并缓存）Cloud-IDE-JWT */
async function resolveToken(
  cookie: string,
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<string> {
  const explicit = extractHeaderValue(
    cred(account, ctx, ['accessToken', 'token', 'authorization']),
    'authorization',
  )
    .replace(/^cloud-ide-jwt\s+/i, '')
    .trim();
  if (explicit) return explicit;

  const key = cookieKey(cookie);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60 * 1000) return cached.token;

  const { body } = await fetchJson(TRAE_TOKEN_URL, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'https://www.trae.cn',
      Referer: 'https://www.trae.cn/',
    },
    body: '{}',
    timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
  });

  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  const token = firstString(isRecord(result) ? pick(result, 'Token', 'token') : undefined);
  if (!token) {
    throw new Error('GetUserToken 未返回 Token，Cookie 可能已失效');
  }
  const expiresAt = toIso(isRecord(result) ? pick(result, 'ExpiredAt', 'expiredAt') : undefined);
  tokenCache.set(key, {
    token,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : Date.now() + 6 * 60 * 60 * 1000,
  });
  ctx.log('已用 Cookie 续签 Trae Token');
  return token;
}

export const traeAdapter: ProviderAdapter = {
  id: 'trae',
  displayName: 'Trae',
  region: 'cn',
  dashboardUrl: 'https://www.trae.cn/dashboard#usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 trae.cn 后从 DevTools 复制任意 api.trae.cn 请求的 Cookie 头，填入 credentials.cookie。' +
    'Token 会自动续签，无需手工维护（也可用 npm run capture 自动抓取）。',
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasExplicitToken = Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization']));
    if (!cookie && !hasExplicitToken) {
      return notConfigured(traeAdapter, account, ctx, ['cookie']);
    }

    const usageUrl = optString(account, 'usageUrl') || TRAE_USAGE_URL;

    try {
      const token = await resolveToken(cookie, account, ctx);
      const { body } = await fetchJson(usageUrl, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${token}`,
          'X-User-Region': 'CN',
          Origin: 'https://www.trae.cn',
          Referer: 'https://www.trae.cn/',
        },
        body: '{}',
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });

      const parsed = parseTraeUsage(body);
      const lots = mergeLots(parsed.packs);
      const nextExpiry = lots
        .map((lot) => lot.expiresAt)
        .filter((value): value is string => typeof value === 'string')
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（本期）',
        used: parsed.used,
        limit: parsed.limit,
        remaining: parsed.remaining,
        boundary: nextExpiry ? 'expiry' : 'mixed',
        expiresAt: nextExpiry,
      });

      return buildSnapshot({
        adapter: traeAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: parsed.remaining, currency: 'CREDITS' },
        credits: lots,
        windows: [window],
        note:
          lots.length > 0
            ? '批次金额为「该包授予量」，账户级剩余以卡片上方的余额为准'
            : null,
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(traeAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
