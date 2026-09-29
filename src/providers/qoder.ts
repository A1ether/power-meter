import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractExpiry,
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
 * Qoder（qoder.com / qoder.com.cn / qoder.cn）
 *
 * 接口来自开源实现 steipete/CodexBar(docs/qoder.md) 与 Javis603/token-monitor
 * (src/shared/providers/qoder/limits.js)，并已实测确认：
 *   GET  {origin}/api/v2/me/usages/big_model_credits   -> 无凭证时 401 {"errorCode":"Unauthorized"}
 *   GET  {origin}/api/v1/me/userplan                   -> 套餐名（可选，失败不影响主流程）
 * 认证方式：浏览器登录态 Cookie。
 */

const QODER_TIMEOUT_FALLBACK = 12_000;

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  if (override) return override.replace(/\/+$/, '');
  const site = (optString(account, 'site') || 'global').toLowerCase();
  return site === 'cn' ? 'https://qoder.com.cn' : 'https://qoder.com';
}

interface QoderSummary {
  used: number;
  total: number;
  remaining: number;
}

function readSummary(container: unknown): QoderSummary | null {
  if (!isRecord(container)) return null;
  const summary = pick(container, 'quotaSummary', 'quota_summary');
  if (!isRecord(summary)) return null;
  const used = firstNumber(pick(summary, 'usedValue', 'used_value'));
  const total = firstNumber(pick(summary, 'limitValue', 'limit_value'));
  if (used === null || total === null || used < 0 || total < 0) return null;
  const explicitRemaining = firstNumber(pick(summary, 'remainingValue', 'remaining_value'));
  return {
    used,
    total,
    remaining: explicitRemaining === null ? Math.max(0, total - used) : Math.max(0, explicitRemaining),
  };
}

export function parseQoderUsage(body: unknown): {
  usedCredits: number;
  totalCredits: number;
  remainingCredits: number;
  usagePercentage: number;
  unit: string;
  resetsAt: string | null;
  lots: CreditLot[];
} {
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const total = readSummary(pick(payload, 'totalQuota', 'total_quota'));
  if (!total) throw new Error('响应缺少 totalQuota.quotaSummary，Cookie 可能已失效或站点选择错误');

  const shared = readSummary(pick(payload, 'sharedQuota', 'shared_quota'));
  const usedCredits = total.used + (shared?.used ?? 0);
  const totalCredits = total.total + (shared?.total ?? 0);
  const remainingCredits = total.remaining + (shared?.remaining ?? 0);
  const usagePercentage =
    totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0;

  const totalSummaryRecord = pick(
    pick(payload, 'totalQuota', 'total_quota'),
    'quotaSummary',
    'quota_summary',
  );
  const resetsAt = toIso(
    pick(payload, 'nextResetAt', 'next_reset_at', 'resetAt', 'reset_at') ??
      pick(totalSummaryRecord, 'nextResetAt', 'next_reset_at', 'resetAt', 'reset_at'),
  );
  const unit = firstString(
    pick(totalSummaryRecord, 'unit'),
    pick(
      pick(payload, 'sharedQuota', 'shared_quota'),
      'quotaSummary',
      'quota_summary',
      'unit',
    ),
  );

  const lots: CreditLot[] = [];
  const explicitExpiry =
    extractExpiry(totalSummaryRecord) ?? extractExpiry(pick(payload, 'totalQuota', 'total_quota'));
  if (explicitExpiry && remainingCredits > 0) {
    lots.push(
      makeLot({
        id: 'total',
        label: '大模型积分（本期剩余）',
        amount: remainingCredits,
        currency: 'CREDITS',
        expiresAt: explicitExpiry,
        note: '响应中显式给出的过期时间',
      }),
    );
  }
  if (shared && shared.remaining > 0) {
    lots.push(
      makeLot({
        id: 'shared',
        label: '团队共享积分',
        amount: shared.remaining,
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
    unit,
    resetsAt,
    lots,
  };
}

function parsePlanLabel(body: unknown): string {
  const candidates: unknown[] = [];
  if (isRecord(body)) {
    candidates.push(body, body.data);
    const data = isRecord(body.data) ? body.data : null;
    if (data) candidates.push(pick(data, 'subscription'), pick(data, 'currentPlan', 'current_plan', 'current'));
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
  region: 'global',
  dashboardUrl: 'https://qoder.com/account/usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 qoder.com 或 qoder.com.cn 后，在 DevTools Network 里复制任意 /api/ 请求的 Cookie 头，' +
    '填入 credentials.cookie；大陆站点请同时设置 options.site = "cn"。',
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return notConfigured(qoderAdapter, account, ctx, ['cookie']);

    const origin = resolveOrigin(account);
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

      const window = makeWindow({
        kind: 'billing',
        label: parsed.unit ? `大模型积分（${parsed.unit}）` : '大模型积分',
        used: parsed.usedCredits,
        limit: parsed.totalCredits,
        remaining: parsed.remainingCredits,
        boundary: parsed.resetsAt ? 'reset' : 'mixed',
        resetsAt: parsed.resetsAt,
      });

      return buildSnapshot({
        adapter: qoderAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        plan: plan || null,
        balance: { amount: parsed.remainingCredits, currency: 'CREDITS' },
        credits: parsed.lots,
        windows: [window],
        note: parsed.resetsAt ? '未用完的积分将在本期重置时作废' : null,
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
