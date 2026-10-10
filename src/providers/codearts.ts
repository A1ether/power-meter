import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { localDateKey, localNoonOf, startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
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
 * CodeArts 华为云（codearts.huaweicloud.com，码道代码智能体）
 *
 * 接口全部通过 npm run capture 抓包定位并实测。分两层：
 *
 * 【汇总层】
 *   ① GET /portal/rest/me                          → projectId / domainId / region
 *   ② GET /portal/snap-manager/v1/package/overview  → 账户级总额度与各桶剩余
 *   ③ POST /portal/rest/bss/v1/cloudservices/countdown-iam5 → 订阅到期时间
 *
 * 【逐笔明细层】—— 页面上「套餐及积分包 / 活动福利」里每一笔的来源
 *   ④ GET /portal/promptcenter/v1/ops/credit/overview          → 活动列表（含 campaignId）
 *   ⑤ GET /portal/promptcenter/v1/ops/credit/campaign/{id}     → 该活动下每一笔的独立到期时间
 *      benefits[]: { benefitId, claimedAmount, consumedAmount, expiredAmount,
 *                    claimedAt, expireAt, validDuration }
 *
 * 为什么需要 ④⑤：② 只给出聚合桶（basic 500 / bonus 8000），
 * 而「每日签到领1000积分 共4笔」各自有独立的 expireAt，
 * 只有 ④⑤ 才能还原出与官方页面一致的分笔列表。
 *
 * 必需请求头（实测踩坑）：
 *   x-requested-with: XMLHttpRequest、x-language: zh-cn
 *     —— 缺失会被网关当成前端路由，返回 SPA 的 HTML（HTTP 200 但不是 JSON）
 *   cftk: <值>  —— ②④⑤ 不强制，③ 必需；其值等于 Cookie `devclouddevuibjtcftk`，从 Cookie 推导
 */

const CA_BASE = 'https://codearts.huaweicloud.com';

/** 给 GET 路径追加时间戳参数（避免浏览器/网关缓存，与页面行为一致） */
function withStamp(path: string): string {
  return `${CA_BASE}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;
}
const CA_TIMEOUT_FALLBACK = 12_000;
const CFTK_COOKIE_NAME = 'devclouddevuibjtcftk';
const DEFAULT_RESOURCE_TYPE = 'hws.resource.type.codearts.snap';
/** 活动数量上限，避免异常账号拉出几百个请求 */
const MAX_CAMPAIGNS = 20;

/** 从拼好的 Cookie 头里取某个 cookie 的值（华为云的 CSRF token 就放在 cookie 里） */
export function cookieValue(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() === name) return trimmed.slice(eq + 1).trim();
  }
  return '';
}

interface CreditPackage {
  amount: number;
  used: number;
  remain: number;
}

function readCreditPackage(source: unknown): CreditPackage | null {
  if (!isRecord(source)) return null;
  const amount = firstNumber(pick(source, 'package_credit_amount', 'packageCreditAmount'));
  const remain = firstNumber(pick(source, 'package_credit_remain', 'packageCreditRemain'));
  if (amount === null && remain === null) return null;
  return {
    amount: amount ?? 0,
    used: firstNumber(pick(source, 'package_credit_used', 'packageCreditUsed')) ?? 0,
    remain: remain ?? 0,
  };
}

export interface CodeArtsOverview {
  total: CreditPackage;
  basic: CreditPackage | null;
  bonus: CreditPackage | null;
  ondemand: CreditPackage | null;
  resourceId: string;
  expiringAmount: number;
}

export function parseCodeArtsOverview(body: unknown): CodeArtsOverview {
  const allRaw = pick(body, 'all_credit_package', 'allCreditPackage');
  const all = readCreditPackage(allRaw);
  if (!all) throw new Error('响应缺少 all_credit_package（Cookie 可能已失效）');

  const basicRaw = pick(body, 'basic_package', 'basicPackage');
  const resourceId = isRecord(basicRaw)
    ? firstString(pick(basicRaw, 'resource_id', 'resourceId'))
    : '';

  return {
    total: all,
    basic: readCreditPackage(basicRaw),
    bonus: readCreditPackage(pick(body, 'bonus_credit_package', 'bonusCreditPackage')),
    ondemand: readCreditPackage(pick(body, 'ondemand_credit_package', 'ondemandCreditPackage')),
    resourceId,
    // 临近过期的积分额度（在 all_credit_package 内部）
    expiringAmount:
      firstNumber(
        isRecord(allRaw) ? pick(allRaw, 'expiring_credit_amount', 'expiringCreditAmount') : undefined,
      ) ?? 0,
  };
}

export interface CreditCampaign {
  id: number;
  title: string;
  claimCount: number;
  claimed: number;
  consumed: number;
}

export interface CampaignBenefit {
  benefitId: string;
  amount: number;
  expiresAt: string | null;
  claimedAt: string | null;
  validDuration: string;
}

/** ④ 活动列表 */
export function parseCampaignList(body: unknown): CreditCampaign[] {
  const data = pick(body, 'data');
  const items = isRecord(data) ? pick(data, 'items') : undefined;
  if (!Array.isArray(items)) return [];
  const campaigns: CreditCampaign[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const id = firstNumber(pick(raw, 'campaignId', 'campaign_id'));
    if (id === null) continue;
    campaigns.push({
      id,
      title: firstString(pick(raw, 'campaignTitle', 'campaign_title')) || `活动 ${id}`,
      claimCount: firstNumber(pick(raw, 'claimCount', 'claim_count')) ?? 0,
      claimed: firstNumber(pick(raw, 'totalClaimed', 'total_claimed')) ?? 0,
      consumed: firstNumber(pick(raw, 'totalConsumed', 'total_consumed')) ?? 0,
    });
  }
  return campaigns;
}

/** ⑤ 单个活动下每一笔的明细（含各自 expireAt） */
export function parseCampaignBenefits(body: unknown): CampaignBenefit[] {
  const data = pick(body, 'data');
  const benefits = isRecord(data) ? pick(data, 'benefits') : undefined;
  if (!Array.isArray(benefits)) return [];
  const out: CampaignBenefit[] = [];
  for (const raw of benefits) {
    if (!isRecord(raw)) continue;
    const claimed = firstNumber(pick(raw, 'claimedAmount', 'claimed_amount')) ?? 0;
    const consumed = firstNumber(pick(raw, 'consumedAmount', 'consumed_amount')) ?? 0;
    const expired = firstNumber(pick(raw, 'expiredAmount', 'expired_amount')) ?? 0;
    const amount = claimed - consumed - expired;
    if (amount <= 0) continue;
    out.push({
      benefitId: firstString(pick(raw, 'benefitId', 'benefit_id')) || `${out.length}`,
      amount,
      expiresAt: toIso(pick(raw, 'expireAt', 'expire_at')),
      claimedAt: toIso(pick(raw, 'claimedAt', 'claimed_at')),
      validDuration: firstString(pick(raw, 'validDuration', 'valid_duration')),
    });
  }
  return out;
}

/** ⑤ 活动奖励的「获取」记录：claimedAmount（本次领取总量）+ claimedAt，用于日级增量 */
export function parseCampaignClaims(body: unknown): Array<{ amount: number; claimedAt: string | null }> {
  const data = pick(body, 'data');
  const benefits = isRecord(data) ? pick(data, 'benefits') : undefined;
  if (!Array.isArray(benefits)) return [];
  const out: Array<{ amount: number; claimedAt: string | null }> = [];
  for (const raw of benefits) {
    if (!isRecord(raw)) continue;
    const amount = firstNumber(pick(raw, 'claimedAmount', 'claimed_amount')) ?? 0;
    if (amount <= 0) continue;
    out.push({ amount, claimedAt: toIso(pick(raw, 'claimedAt', 'claimed_at')) });
  }
  return out;
}

/** countdown 接口把详情塞在 JSON 字符串里 */
export function parseCountdownExpiry(body: unknown): string | null {
  const list = pick(body, 'cloudServiceCountDowns', 'cloudServiceCountdowns');
  if (!Array.isArray(list)) return null;
  const times: string[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const tipsRaw = pick(raw, 'countDownTips', 'countdownTips');
    let tips: unknown = tipsRaw;
    if (typeof tipsRaw === 'string') {
      try {
        tips = JSON.parse(tipsRaw);
      } catch {
        tips = null;
      }
    }
    const iso = isRecord(tips)
      ? toIso(pick(tips, 'expTime', 'exp_time') ?? pick(tips, 'effTime', 'eff_time'))
      : null;
    if (iso) times.push(iso);
  }
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[times.length - 1] ?? null;
}

export const codeartsAdapter: ProviderAdapter = {
  id: 'codearts',
  displayName: 'CodeArts 华为云',
  region: 'cn',
  dashboardUrl: 'https://codearts.huaweicloud.com/portal/settings/personal-usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 codearts.huaweicloud.com 后，从 DevTools 复制任意 codearts.huaweicloud.com 请求的 Cookie 头' +
    '（需包含 devclouddevuibjJ_SESSION_ID 与 devclouddevuibjtcftk），填入 credentials.cookie' +
    '（也可用 npm run capture 自动抓取）。',
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：按天图表（`xDimension=DATE_DAY` + `TOTAL_CREDITS`，取昨日/今日两天），
   *     与页面「使用明细」同一数据源，缺天视为 0；
   *   - 获取：活动福利逐笔（`credit/overview` + `campaign/{id}` 的 claimedAmount/claimedAt），
   *     即页面「获取明细」页签的数据源。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return null;
    const timeoutMs = ctx.timeoutMs || CA_TIMEOUT_FALLBACK;
    const cftk = optString(account, 'cftk') || cookieValue(cookie, CFTK_COOKIE_NAME);
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-language': 'zh-cn',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${CA_BASE}/portal/settings/personal-usage?locale=zh-cn`,
      ...(cftk ? { cftk } : {}),
    };
    const records: UsageRecord[] = [];

    // ① 用量：按天图表
    let useCovered = false;
    try {
      const { body } = await fetchJson(
        withStamp('/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            startDate: localDateKey(startOfDay(ctx.now) - 86_400_000),
            endDate: localDateKey(ctx.now),
            metrics: ['TOTAL_CREDITS'],
            xDimension: 'DATE_DAY',
          }),
          timeoutMs,
        },
      );
      const data = pick(body, 'data');
      const series = isRecord(data) ? pick(data, 'series') : undefined;
      const creditsSeries = Array.isArray(series)
        ? series.find((item) => isRecord(item) && /credit/i.test(String(pick(item, 'name') ?? '')))
        : undefined;
      if (isRecord(creditsSeries)) {
        const cells = pick(creditsSeries, 'cells');
        if (Array.isArray(cells)) {
          for (const cell of cells) {
            if (!isRecord(cell)) continue;
            const at = localNoonOf(String(pick(cell, 'xLabel', 'x_label') ?? ''));
            const amount = firstNumber(pick(cell, 'value'));
            if (at === null || amount === null || amount <= 0) continue;
            records.push({ at, kind: 'use', amount });
          }
          useCovered = true;
        }
      }
    } catch (error) {
      ctx.log(`CodeArts 按天用量获取失败（退回本地采样）：${(error as Error).message}`);
    }

    // ② 获取：活动福利逐笔（与页面「获取明细」页签同源）
    let grantCovered = false;
    try {
      const { body } = await fetchJson(withStamp('/portal/promptcenter/v1/ops/credit/overview'), {
        headers,
        timeoutMs,
      });
      assertBusinessOk(body);
      for (const campaign of parseCampaignList(body).slice(0, MAX_CAMPAIGNS)) {
        const detail = await fetchJson(
          withStamp(`/portal/promptcenter/v1/ops/credit/campaign/${campaign.id}`),
          { headers, timeoutMs: Math.min(timeoutMs, 8_000) },
        );
        assertBusinessOk(detail.body);
        for (const claim of parseCampaignClaims(detail.body)) {
          const at = claim.claimedAt ? Date.parse(claim.claimedAt) : Number.NaN;
          if (!Number.isFinite(at)) continue;
          records.push({ at, kind: 'grant', amount: claim.amount });
        }
      }
      grantCovered = true;
    } catch (error) {
      ctx.log(`CodeArts 获取明细获取失败（退回本地采样）：${(error as Error).message}`);
    }

    return { records, covers: { use: useCovered, grant: grantCovered } };
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return notConfigured(codeartsAdapter, account, ctx, ['cookie']);

    const timeoutMs = ctx.timeoutMs || CA_TIMEOUT_FALLBACK;
    const cftk = optString(account, 'cftk') || cookieValue(cookie, CFTK_COOKIE_NAME);
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-language': 'zh-cn',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${CA_BASE}/portal/settings/personal-usage?locale=zh-cn`,
      ...(cftk ? { cftk } : {}),
    };
    const stamp = (path: string): string => `${CA_BASE}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;

    try {
      // ② 账户级汇总
      const overviewResponse = await fetchJson(stamp('/portal/snap-manager/v1/package/overview'), {
        headers,
        timeoutMs,
      });
      const overview = parseCodeArtsOverview(overviewResponse.body);

      // ③ 订阅到期时间
      let subscriptionExpiry: string | null = null;
      let tenantId = '';
      let regionId = optString(account, 'region') || 'cn-north-4';
      if (overview.resourceId) {
        try {
          const meResponse = await fetchJson(stamp('/portal/rest/me'), {
            headers,
            timeoutMs: Math.min(timeoutMs, 8_000),
          });
          const me = isRecord(meResponse.body) ? meResponse.body : {};
          tenantId = firstString(pick(me, 'projectId', 'project_id'));
          regionId = firstString(pick(me, 'region', 'regionId')) || regionId;

          const countdownResponse = await fetchJson(
            `${CA_BASE}/portal/rest/bss/v1/cloudservices/countdown-iam5`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                tenantId,
                cloudServiceType: 'hws.service.type.devcloud',
                resourceType: optString(account, 'resourceType') || DEFAULT_RESOURCE_TYPE,
                regionId,
                resourceIds: [overview.resourceId],
              }),
              timeoutMs: Math.min(timeoutMs, 8_000),
            },
          );
          subscriptionExpiry = parseCountdownExpiry(countdownResponse.body);
        } catch (error) {
          ctx.log(`CodeArts 订阅到期时间获取失败（不影响余额）：${(error as Error).message}`);
        }
      } else {
        ctx.log('CodeArts 未找到 resource_id，跳过订阅到期时间查询');
      }

      // ④⑤ 逐笔明细：把 bonus 桶展开成每笔活动奖励
      const lots: CreditLot[] = [];
      let campaignNote: string | null = null;
      let benefitTotal = 0;

      try {
        const listResponse = await fetchJson(
          stamp('/portal/promptcenter/v1/ops/credit/overview'),
          { headers, timeoutMs },
        );
        assertBusinessOk(listResponse.body);
        const campaigns = parseCampaignList(listResponse.body).slice(0, MAX_CAMPAIGNS);

        for (const campaign of campaigns) {
          const detailResponse = await fetchJson(
            stamp(`/portal/promptcenter/v1/ops/credit/campaign/${campaign.id}`),
            { headers, timeoutMs: Math.min(timeoutMs, 8_000) },
          );
          assertBusinessOk(detailResponse.body);
          for (const benefit of parseCampaignBenefits(detailResponse.body)) {
            benefitTotal += benefit.amount;
            lots.push(
              makeLot({
                id: `codearts-campaign-${campaign.id}-${benefit.benefitId}`,
                label: campaign.title,
                amount: benefit.amount,
                currency: 'CREDITS',
                expiresAt: benefit.expiresAt,
                note: [
                  benefit.claimedAt ? `领取于 ${benefit.claimedAt.slice(0, 10)}` : '',
                  benefit.validDuration ? `有效期 ${benefit.validDuration}` : '',
                ]
                  .filter(Boolean)
                  .join('，'),
              }),
            );
          }
        }
      } catch (error) {
        campaignNote = `活动明细获取失败，已退回聚合口径：${(error as Error).message}`;
        ctx.log(campaignNote);
      }

      // ① 基础套餐（订阅自带额度）
      if (overview.basic && overview.basic.remain > 0) {
        lots.unshift(
          makeLot({
            id: 'codearts-basic',
            label: '个人订阅套餐',
            amount: overview.basic.remain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: `套餐额度 ${overview.basic.amount}，已用 ${overview.basic.used}`,
          }),
        );
      }
      // 活动奖励桶与账户级 bonus 对账：明细拉不到就退回聚合口径，差值补一条调节项
      const bonusRemain = Math.round((overview.bonus?.remain ?? 0) * 100) / 100;
      if (benefitTotal <= 0 && bonusRemain > 0) {
        lots.push(
          makeLot({
            id: 'codearts-bonus',
            label: '活动奖励积分（合计）',
            amount: bonusRemain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: '活动明细不可用，已退回聚合额度',
          }),
        );
      } else {
        const gap = Math.round((bonusRemain - benefitTotal) * 100) / 100;
        if (gap >= 1) {
          lots.push(
            makeLot({
              id: 'codearts-bonus-gap',
              label: '活动奖励积分（未明细部分）',
              amount: gap,
              currency: 'CREDITS',
              expiresAt: subscriptionExpiry,
              note: `活动明细合计 ${benefitTotal}，与聚合额度 ${bonusRemain} 的差额`,
            }),
          );
        }
      }

      // 按需积分包（如有）
      if (overview.ondemand && overview.ondemand.remain > 0) {
        lots.push(
          makeLot({
            id: 'codearts-ondemand',
            label: '按需积分包',
            amount: overview.ondemand.remain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: '按需计费额度',
          }),
        );
      }

      const { active, expired } = splitByExpiry(lots, ctx.now);

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（全部资源包）',
        used: overview.total.used,
        limit: overview.total.amount,
        remaining: overview.total.remain,
        boundary: subscriptionExpiry ? 'expiry' : 'mixed',
        expiresAt: subscriptionExpiry,
      });

      return buildSnapshot({
        adapter: codeartsAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: overview.total.remain, currency: 'CREDITS' },
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired),
          campaignNote,
          overview.expiringAmount > 0 ? `有 ${overview.expiringAmount} 积分临近过期` : null,
          !subscriptionExpiry ? '未取到订阅到期时间，可检查 cftk 是否随 Cookie 一并提供' : null,
        ),
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(codeartsAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
