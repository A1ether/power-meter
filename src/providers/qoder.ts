import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  failure,
  hiddenLotsNote,
  joinNotes,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * Qoder（qoder.com.cn / qoder.cn，兼容 qoder.com 国际站）
 *
 * 接口（已实测确认，Cookie 鉴权）：
 *   GET {origin}/api/v2/me/usages/big_model_credits
 *   GET {origin}/api/v1/me/userplan                     套餐名（可选，失败不影响主流程）
 *
 * 大陆站响应结构（实测）：
 *   {
 *     plan_quota:                        { quota_summary, quota_detail },
 *     resource_package_quota:            { quota_summary, quota_detail },
 *     dedicated_resource_package_quota:  { quota_summary, quota_detail },
 *     total_quota:                       { quota_summary, quota_detail },   // ← 用这个
 *     nextResetAt, lastResetAt
 *   }
 *   quota_summary: used_value / limit_value / remaining_value / usage_percentage / unit
 *   quota_detail[]: 每笔额度的明细，带 expires_at（毫秒时间戳）→ 正是「最快到期」所需
 *
 * 国际站响应结构为 { data: { totalQuota, sharedQuota, nextResetAt } }（camelCase），
 * 这里同时兼容两种命名。
 */

const QODER_TIMEOUT_FALLBACK = 12_000;

/** 同一笔额度可能出现在多个容器里，用 id 去重 */
function parseQuotaDetail(container: unknown): unknown[] {
  const detail = pick(container, 'quotaDetail', 'quota_detail');
  return Array.isArray(detail) ? detail : [];
}

function sourceLabel(source: string): string {
  const upper = source.toUpperCase();
  if (upper.includes('PLAN')) return '套餐额度';
  if (upper.includes('BONUS')) return '赠送资源包';
  if (upper.includes('PURCHASE') || upper.includes('PAID')) return '购买的资源包';
  if (upper.includes('DEDICATED')) return '专属资源包';
  return source.replace(/^RESOURCE_PACKAGE_SOURCE_/i, '').replace(/_/g, ' ').trim() || '额度';
}

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  if (override) return override.replace(/\/+$/, '');
  const site = (optString(account, 'site') || 'cn').toLowerCase();
  return site === 'global' ? 'https://qoder.com' : 'https://qoder.com.cn';
}

interface QoderSummary {
  used: number;
  total: number;
  remaining: number;
  unit: string;
}

function readSummary(container: unknown): QoderSummary | null {
  if (!isRecord(container)) return null;
  const summary = pick(container, 'quotaSummary', 'quota_summary');
  if (!isRecord(summary)) return null;
  const used = firstNumber(pick(summary, 'usedValue', 'used_value')) ?? 0;
  const total = firstNumber(pick(summary, 'limitValue', 'limit_value'));
  if (total === null) return null;
  const explicitRemaining = firstNumber(pick(summary, 'remainingValue', 'remaining_value'));
  return {
    used: Math.max(0, used),
    total: Math.max(0, total),
    remaining: Math.max(0, explicitRemaining ?? total - used),
    unit: firstString(pick(summary, 'unit')),
  };
}

/**
 * 把 quota_detail 转成带过期时间的积分批次。
 * expires_at 为 0 / 缺失表示「不过期」（通常是套餐额度，随 nextResetAt 重置）。
 */
export function parseQoderLots(container: unknown, unit: string): CreditLot[] {
  const lots: CreditLot[] = [];
  for (const [index, raw] of parseQuotaDetail(container).entries()) {
    if (!isRecord(raw)) continue;
    const remaining = firstNumber(pick(raw, 'remainingValue', 'remaining_value')) ?? 0;
    if (remaining <= 0) continue;
    if (pick(raw, 'isActive', 'is_active') === false) continue;
    const expiresAt = toIso(pick(raw, 'expiresAt', 'expires_at')) ?? null;
    const source = firstString(pick(raw, 'source'));
    const id = firstString(pick(raw, 'id')) || `detail-${index}`;
    lots.push(
      makeLot({
        id: `qoder-${id}`,
        label: sourceLabel(source),
        amount: remaining,
        currency: 'CREDITS',
        expiresAt,
        note: expiresAt ? '' : '无独立过期时间，随本期重置作废',
      }),
    );
  }
  return lots;
}

export interface QoderUsage {
  usedCredits: number;
  totalCredits: number;
  remainingCredits: number;
  usagePercentage: number;
  unit: string;
  resetsAt: string | null;
  lots: CreditLot[];
}

export function parseQoderUsage(body: unknown): QoderUsage {
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const container = pick(payload, 'totalQuota', 'total_quota');
  const total = readSummary(container);
  if (!total) throw new Error('响应缺少 total_quota.quota_summary，Cookie 可能已失效或站点选择错误');

  // 国际站会把团队共享额度放在单独的字段里，累加进总量
  const sharedContainer = pick(payload, 'sharedQuota', 'shared_quota');
  const shared = readSummary(sharedContainer);

  const usedCredits = total.used + (shared?.used ?? 0);
  const totalCredits = total.total + (shared?.total ?? 0);
  const remainingCredits = total.remaining + (shared?.remaining ?? 0);
  const usagePercentage = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0;

  const resetsAt = toIso(
    pick(payload, 'nextResetAt', 'next_reset_at', 'resetAt', 'reset_at') ??
      pick(container, 'nextResetAt', 'next_reset_at'),
  );

  const lots = parseQoderLots(container, total.unit);
  if (sharedContainer && (shared?.remaining ?? 0) > 0) {
    lots.push(
      makeLot({
        id: 'qoder-shared',
        label: '团队共享额度',
        amount: shared?.remaining ?? 0,
        currency: 'CREDITS',
        expiresAt: resetsAt,
        note: resetsAt ? '随本期重置作废' : '',
      }),
    );
  }

  return {
    usedCredits,
    totalCredits,
    remainingCredits,
    usagePercentage,
    unit: total.unit,
    resetsAt,
    lots,
  };
}

function parsePlanLabel(body: unknown): string {
  const candidates: unknown[] = [];
  if (isRecord(body)) {
    candidates.push(body, body.data);
    const data = isRecord(body.data) ? body.data : null;
    if (data) {
      candidates.push(
        pick(data, 'subscription'),
        pick(data, 'currentPlan', 'current_plan', 'current'),
      );
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const raw = firstString(
      pick(candidate, 'planTier', 'plan_tier'),
      pick(candidate, 'plan'),
      pick(candidate, 'tier'),
      pick(candidate, 'productName', 'product_name'),
      pick(candidate, 'name'),
    );
    if (!raw) continue;
    return raw
      .replace(/^ORGANIZATION_PLAN_TIER_/i, '')
      .replace(/^PLAN_TIER_/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\bpro\s+plus\b/i, 'Pro+')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return '';
}

export const qoderAdapter: ProviderAdapter = {
  id: 'qoder',
  displayName: 'Qoder',
  region: 'cn',
  dashboardUrl: 'https://qoder.com.cn/account/usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 qoder.com.cn 后，从 DevTools 的 Network 里复制任意 /api/ 请求的 Cookie 头，' +
    '填入 credentials.cookie（也可用 npm run capture 自动抓取）。',
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return notConfigured(qoderAdapter, account, ctx, ['cookie']);

    const origin = resolveOrigin(account);
    const site = (optString(account, 'site') || (origin.includes('qoder.com.cn') ? 'cn' : 'global')).toLowerCase();
    const timeoutMs = ctx.timeoutMs || QODER_TIMEOUT_FALLBACK;
    const baseHeaders: Record<string, string> = {
      Cookie: cookie,
      Origin: origin,
      Referer: `${origin}/account/usage`,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'x-requested-with': 'XMLHttpRequest',
    };

    try {
      const usage = await fetchJson(`${origin}/api/v2/me/usages/big_model_credits`, {
        headers: baseHeaders,
        timeoutMs,
      });
      assertBusinessOk(usage.body);
      const parsed = parseQoderUsage(usage.body);

      let plan = '';
      try {
        const planResponse = await fetchJson(`${origin}/api/v1/me/userplan`, {
          headers: baseHeaders,
          timeoutMs: Math.min(timeoutMs, 6_000),
        });
        plan = parsePlanLabel(planResponse.body);
      } catch (error) {
        ctx.log(`Qoder 套餐信息获取失败（不影响余额）：${(error as Error).message}`);
      }

      // 上游偶尔返回已过去的重置时间（例如当前处于免费档位），展示出来只会让人困惑
      const resetsAt =
        parsed.resetsAt && Date.parse(parsed.resetsAt) > ctx.now ? parsed.resetsAt : null;

      const window = makeWindow({
        kind: 'billing',
        label: parsed.unit ? `大模型积分（${parsed.unit}）` : '大模型积分',
        used: parsed.usedCredits,
        limit: parsed.totalCredits,
        remaining: parsed.remainingCredits,
        boundary: resetsAt ? 'reset' : 'mixed',
        resetsAt,
      });

      // 只展示还有效的批次，已过期的汇总成一句提示
      const { active, expired } = splitByExpiry(parsed.lots, ctx.now);
      const datedLots = active.filter((lot) => lot.expiresAt !== null).length;

      return buildSnapshot({
        adapter: { ...qoderAdapter, region: site === 'global' ? 'global' : 'cn' },
        account,
        status: 'ok',
        now: ctx.now,
        plan: plan || null,
        balance: { amount: parsed.remainingCredits, currency: 'CREDITS' },
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired),
          datedLots === 0 && resetsAt
            ? '未返回独立过期时间，未用完的积分将在本期重置时作废'
            : null,
          parsed.resetsAt && !resetsAt ? '上游返回的重置时间早于当前时间，已忽略' : null,
        ),
      });
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.kind
          : /Unauthorized/i.test((error as Error).message)
            ? 'unauthorized'
            : 'error';
      return failure(qoderAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
