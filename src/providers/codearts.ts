import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
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
 * CodeArts 华为云（codearts.huaweicloud.com，码道代码智能体）
 *
 * 三个接口全部通过 npm run capture 抓包定位并实测：
 *   ① GET  /portal/rest/me
 *      → { projectId, region, userId }   （projectId 用作 tenantId）
 *   ② GET  /portal/snap-manager/v1/package/overview
 *      → { all_credit_package, basic_package, bonus_credit_package,
 *          ondemand_credit_package, model_package[] }
 *        各包字段：package_credit_amount / package_credit_used / package_credit_remain
 *   ③ POST /portal/rest/bss/v1/cloudservices/countdown-iam5
 *      body: { tenantId, cloudServiceType, resourceType, regionId, resourceIds[] }
 *      → cloudServiceCountDowns[].countDownTips（JSON 字符串）→ { effTime, expTime }
 *
 * 必需请求头（实测踩坑）：
 *   x-requested-with: XMLHttpRequest、x-language: zh-cn  —— 缺失会被网关当成前端路由，返回 SPA 的 HTML
 *   cftk: <值>  —— ②不需要，③必需；其值等于 Cookie `devclouddevuibjtcftk`，因此可从 Cookie 自动推导
 *
 * 口径：三个包的 remain 之和 === all_credit_package.package_credit_remain，
 * 因此批次按 basis='remaining' 正常参与汇总。
 */

const CA_BASE = 'https://codearts.huaweicloud.com';
const CA_TIMEOUT_FALLBACK = 12_000;
const CFTK_COOKIE_NAME = 'devclouddevuibjtcftk';
const DEFAULT_RESOURCE_TYPE = 'hws.resource.type.codearts.snap';

/** 从拼好的 Cookie 头里取某个 cookie 的值（华为云的 CSRF token 就是放在 cookie 里的） */
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
  // 取最晚的到期时间（订阅整体到期）
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

    try {
      const overviewResponse = await fetchJson(
        `${CA_BASE}/portal/snap-manager/v1/package/overview?_=${Date.now()}`,
        { headers, timeoutMs },
      );
      const overview = parseCodeArtsOverview(overviewResponse.body);

      // 取到期时间：先拿 projectId / region，再调 countdown
      let expiresAt: string | null = null;
      if (overview.resourceId) {
        try {
          const meResponse = await fetchJson(`${CA_BASE}/portal/rest/me?_=${Date.now()}`, {
            headers,
            timeoutMs: Math.min(timeoutMs, 8_000),
          });
          const me = isRecord(meResponse.body) ? meResponse.body : {};
          const tenantId = firstString(pick(me, 'projectId', 'project_id'));
          const regionId =
            firstString(pick(me, 'region', 'regionId')) || optString(account, 'region') || 'cn-north-4';

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
          expiresAt = parseCountdownExpiry(countdownResponse.body);
        } catch (error) {
          ctx.log(`CodeArts 到期时间获取失败（不影响余额）：${(error as Error).message}`);
        }
      } else {
        ctx.log('CodeArts 未找到 resource_id，跳过到期时间查询');
      }

      const lots: CreditLot[] = [];
      const push = (label: string, pack: CreditPackage | null, id: string): void => {
        if (!pack || pack.remain <= 0) return;
        lots.push(
          makeLot({
            id,
            label,
            amount: pack.remain,
            currency: 'CREDITS',
            expiresAt,
            note: `额度 ${pack.amount}，已用 ${pack.used}`,
          }),
        );
      };
      push('基础套餐积分', overview.basic, 'codearts-basic');
      push('赠送积分包', overview.bonus, 'codearts-bonus');
      push('按需积分包', overview.ondemand, 'codearts-ondemand');

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（全部资源包）',
        used: overview.total.used,
        limit: overview.total.amount,
        remaining: overview.total.remain,
        boundary: expiresAt ? 'expiry' : 'mixed',
        expiresAt,
      });

      const notes: string[] = [];
      if (overview.expiringAmount > 0) {
        notes.push(`有 ${overview.expiringAmount} 积分临近过期`);
      }
      if (!expiresAt) notes.push('未取到订阅到期时间，可检查 cftk 是否随 Cookie 一并提供');

      return buildSnapshot({
        adapter: codeartsAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: overview.total.remain, currency: 'CREDITS' },
        credits: lots,
        windows: [window],
        note: notes.length > 0 ? notes.join('；') : null,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(codeartsAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
