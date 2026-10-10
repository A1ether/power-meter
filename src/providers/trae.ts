import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractHeaderValue,
  failure,
  hiddenLotsNote,
  joinNotes,
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
 * 关键点一：网页版接口用 `Cloud-IDE-JWT`，而该 Token **只有效约 1 天**。
 * 实测 `GetUserToken` 可以用登录态 Cookie 换取新 Token，
 * 因此这里只要求用户提供 Cookie，Token 每次刷新自动续签。
 *
 * 关键点二：**`usage.credits_amount` 是「已用量」而不是「授予量」**。
 * 实测 `Σ usage.credits_amount === usage_summary.consumed_amount`
 * （1361.5476 === 1361.55），因此每个包的剩余 = credits_limit - credits_amount。
 * 用完的包会被过滤掉，不再展示。
 *
 * 请求链路（均已实测）：
 *   ① POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken      （Cookie 鉴权）
 *      → { Result: { Token, ExpiredAt, TenantID } }
 *   ② POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list
 *      Authorization: Cloud-IDE-JWT <Token>
 *      → { usage_summary: { consumed_amount, total_amount },
 *          user_entitlement_pack_list: [ { display_desc, expire_time, usage,
 *            entitlement_base_info: { quota: { credits_limit } } } ] }
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
  used: number;
  remaining: number;
  expiresAt: string | null;
}

export interface TraeUsage {
  packs: TraePack[];
  /** 已用尽的包数量（会被过滤，仅用于提示） */
  usedUpCount: number;
  summaryUsed: number;
  summaryTotal: number;
}

export function parseTraeUsage(body: unknown): TraeUsage {
  if (!isRecord(body)) throw new Error('Trae 返回了非对象响应');
  const summary = pick(body, 'usage_summary', 'usageSummary');
  const packsRaw = pick(body, 'user_entitlement_pack_list', 'userEntitlementPackList');
  if (!Array.isArray(packsRaw)) {
    throw new Error('响应缺少 user_entitlement_pack_list（Token 可能已失效）');
  }

  const packs: TraePack[] = [];
  let usedUpCount = 0;

  for (const raw of packsRaw) {
    if (!isRecord(raw)) continue;
    const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo') ?? raw;
    const quota = isRecord(base) ? pick(base, 'quota') : undefined;
    const limit = firstNumber(
      isRecord(quota) ? pick(quota, 'credits_limit', 'creditsLimit') : undefined,
    );
    // 没有 credits_limit 的是功能权益（免费版的开关项），不是积分
    if (limit === null || limit <= 0) continue;

    const usage = pick(raw, 'usage');
    const used = firstNumber(isRecord(usage) ? pick(usage, 'credits_amount', 'creditsAmount') : undefined) ?? 0;
    const remaining = Math.max(0, limit - Math.max(0, used));
    if (remaining <= 0) {
      usedUpCount += 1;
      continue;
    }

    const label =
      firstString(
        pick(raw, 'display_desc', 'displayDesc'),
        pick(raw, 'group_name', 'groupName'),
        isRecord(base) ? pick(base, 'product_name', 'productName') : undefined,
      ) || '权益包';
    const expiresAt =
      toIso(pick(raw, 'expire_time', 'expireTime')) ??
      toIso(isRecord(base) ? pick(base, 'end_time', 'endTime') : undefined);

    packs.push({ label, limit, used, remaining, expiresAt });
  }

  const summaryUsed = firstNumber(
    isRecord(summary) ? pick(summary, 'consumed_amount', 'consumedAmount') : undefined,
  );
  const summaryTotal = firstNumber(
    isRecord(summary) ? pick(summary, 'total_amount', 'totalAmount') : undefined,
  );

  return {
    packs,
    usedUpCount,
    summaryUsed: summaryUsed ?? 0,
    summaryTotal: summaryTotal ?? 0,
  };
}

/** 把同名且同时到期的包归并成一条，避免签到类平台出现几十条重复批次 */
export function mergeLots(packs: TraePack[]): CreditLot[] {
  const grouped = new Map<
    string,
    { label: string; expiresAt: string | null; remaining: number; limit: number; count: number }
  >();
  for (const pack of packs) {
    const key = `${pack.label}|${pack.expiresAt ?? ''}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.remaining += pack.remaining;
      entry.limit += pack.limit;
      entry.count += 1;
    } else {
      grouped.set(key, {
        label: pack.label,
        expiresAt: pack.expiresAt,
        remaining: pack.remaining,
        limit: pack.limit,
        count: 1,
      });
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
        amount: entry.remaining,
        currency: 'CREDITS',
        expiresAt: entry.expiresAt,
        note:
          entry.count > 1
            ? `${entry.count} 个同类包合计：剩余 ${Math.round(entry.remaining * 100) / 100} / 额度 ${entry.limit}`
            : `额度 ${entry.limit}`,
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
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：`query_user_usage_group_by_session` 逐笔（`usage_time` + `credits_float`），
   *     与页面「使用记录」同源；
   *   - 获取：权益包列表逐笔（`start_time` 发放时间 + `quota.credits_limit` 发放额度），
   *     与页面「奖励积分 / 查看详情」同源——每日签到、每月登录赠送、套餐发放各成一笔。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasExplicitToken = Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization']));
    if (!cookie && !hasExplicitToken) return null;

    const token = await resolveToken(cookie, account, ctx);
    // 与页面请求同源同参：usage_type=[7] 对应页面「使用记录」列表；
    // page_size 实测上限 20（再大会返回 400 code 9004），因此按 20 分页、上限 10 页
    const origin = new URL(optString(account, 'usageUrl') || TRAE_USAGE_URL).origin;
    const recordsUrl = `${origin}/trae/api/v1/pay/query_user_usage_group_by_session`;
    const startSec = Math.floor((startOfDay(ctx.now) - 86_400_000) / 1000);
    const endSec = Math.ceil(ctx.now / 1000);
    const pageSize = 20;
    const records: UsageRecord[] = [];

    for (let pageNum = 1; pageNum <= 10; pageNum += 1) {
      const { body } = await fetchJson(recordsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${token}`,
          'X-User-Region': 'CN',
          'Content-Type': 'application/json',
          Origin: 'https://www.trae.cn',
          Referer: 'https://www.trae.cn/',
        },
        body: JSON.stringify({
          start_time: startSec,
          end_time: endSec,
          page_size: pageSize,
          page_num: pageNum,
          usage_type: [7],
        }),
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });
      const list = isRecord(body)
        ? pick(body, 'user_usage_group_by_sessions', 'userUsageGroupBySessions')
        : undefined;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const raw of list) {
        if (!isRecord(raw)) continue;
        const at = firstNumber(pick(raw, 'usage_time', 'usageTime'));
        const amount = firstNumber(pick(raw, 'credits_float', 'creditsFloat', 'credits'));
        if (at === null || amount === null || amount <= 0) continue;
        records.push({ at: at * 1000, kind: 'use', amount });
      }
      const total = firstNumber(isRecord(body) ? pick(body, 'total') : undefined);
      if (list.length < pageSize || (total !== null && pageNum * pageSize >= total)) break;
    }

    // 获取明细：权益包即「发放」逐笔——每个包带 start_time（发放时间）与
    // quota.credits_limit（发放额度），每日签到 / 每月登录赠送 / 套餐发放都会各成一笔
    let grantCovered = false;
    try {
      const { body } = await fetchJson(optString(account, 'usageUrl') || TRAE_USAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${token}`,
          'X-User-Region': 'CN',
          'Content-Type': 'application/json',
          Origin: 'https://www.trae.cn',
          Referer: 'https://www.trae.cn/',
        },
        body: '{}',
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });
      const packs = isRecord(body)
        ? pick(body, 'user_entitlement_pack_list', 'userEntitlementPackList')
        : undefined;
      if (Array.isArray(packs)) {
        for (const raw of packs) {
          if (!isRecord(raw)) continue;
          const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo');
          if (!isRecord(base)) continue;
          const start = firstNumber(pick(base, 'start_time', 'startTime'));
          const quota = pick(base, 'quota');
          const limit = isRecord(quota)
            ? firstNumber(pick(quota, 'credits_limit', 'creditsLimit'))
            : null;
          if (start === null || limit === null || limit <= 0) continue;
          records.push({ at: start * 1000, kind: 'grant', amount: limit });
        }
        grantCovered = true;
      }
    } catch (error) {
      ctx.log(`Trae 权益包发放明细获取失败（增量退回本地采样）：${(error as Error).message}`);
    }
    return { records, covers: { use: true, grant: grantCovered } };
  },

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
      const round = (value: number): number => Math.round(value * 100) / 100;

      // 只统计「仍在有效期内且未用尽」的包，这样与 Trae 页面显示的 剩余/总额 一致
      const alivePacks = parsed.packs.filter(
        (pack) => !pack.expiresAt || Date.parse(pack.expiresAt) >= ctx.now,
      );
      const expiredPacks = parsed.packs.filter(
        (pack) => pack.expiresAt !== null && Date.parse(pack.expiresAt) < ctx.now,
      );

      const active = mergeLots(alivePacks);
      // 余额取「未用尽且未过期」的包之和（这是真正还能用的部分）；
      // 窗口分母用账户级 usage_summary，与 Trae 页面显示的「总可用积分」一致
      const usableRemaining = round(alivePacks.reduce((sum, pack) => sum + pack.remaining, 0));
      const balance =
        alivePacks.length > 0
          ? usableRemaining
          : round(Math.max(0, parsed.summaryTotal - parsed.summaryUsed));
      const expired = expiredPacks.map((pack, index) =>
        makeLot({
          id: `trae-expired-${index}`,
          label: pack.label,
          amount: pack.remaining,
          currency: 'CREDITS',
          expiresAt: pack.expiresAt,
        }),
      );

      const nextExpiry =
        active
          .map((lot) => lot.expiresAt)
          .filter((value): value is string => typeof value === 'string')
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（本期）',
        used: parsed.summaryUsed,
        limit: parsed.summaryTotal,
        remaining: balance,
        boundary: nextExpiry ? 'expiry' : 'mixed',
        expiresAt: nextExpiry,
      });

      return buildSnapshot({
        adapter: traeAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: balance, currency: 'CREDITS' },
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired, parsed.usedUpCount),
          active.length === 0 ? '所有积分包都已用尽或过期' : null,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(traeAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
