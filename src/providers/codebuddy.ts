import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
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
 * CodeBuddy（codebuddy.cn，腾讯云代码助手）
 *
 * 接口是通过 npm run capture 抓包定位的（GitHub 上没有任何现成实现），已实测：
 *   ① POST https://www.codebuddy.cn/billing/meter/get-user-resource-summary
 *      → data.Packages[]: CycleTotalCapacity / CycleRemainCapacity / CycleUsedCapacity
 *        （字符串形式的数字，容量单位 capacityUnit 通常为 credits）
 *   ② POST https://www.codebuddy.cn/billing/meter/get-user-resource-free-packages
 *      → data.Accounts[]: PackageName / CycleStartTime / CycleEndTime / DeductionEndTime
 *        / CycleCapacitySize / CycleCapacityRemain（含 Precise 精确值）
 *
 * 必需请求头：Cookie（**必须包含 www.codebuddy.cn 子域下的会话 Cookie**）、
 *            x-client-platform: web。
 * 只发送 .codebuddy.cn 父域 Cookie 会得到 401——这是实测踩过的坑。
 *
 * 口径：①给账户级汇总（余额取它），②给各资源包的周期与到期时间。
 * 两者粒度不同（②是包内某个子资源的周期额度），因此批次标记 basis='granted'，
 * 只用于「最快到期」，不参与汇总，避免与余额重复计算。
 */

const CB_SUMMARY_URL = 'https://www.codebuddy.cn/billing/meter/get-user-resource-summary';
const CB_PACKAGES_URL = 'https://www.codebuddy.cn/billing/meter/get-user-resource-free-packages';
const CB_TIMEOUT_FALLBACK = 12_000;

export interface CodeBuddySummary {
  limit: number;
  used: number;
  remaining: number;
  unit: string;
  packageCount: number;
  /** 资源包编码，详情接口必须带上它（实测缺失会返回 400 PackageCodes required） */
  packageCodes: string[];
}

export function parseCodeBuddySummary(body: unknown): CodeBuddySummary {
  const data = pick(body, 'data');
  const packages = isRecord(data) ? pick(data, 'Packages', 'packages') : undefined;
  if (!Array.isArray(packages)) {
    throw new Error('响应缺少 data.Packages（Cookie 可能已失效）');
  }

  let limit = 0;
  let used = 0;
  let remaining = 0;
  let unit = '';
  let counted = 0;
  const packageCodes: string[] = [];

  for (const raw of packages) {
    if (!isRecord(raw)) continue;
    const total = firstNumber(pick(raw, 'CycleTotalCapacity', 'cycleTotalCapacity')) ?? 0;
    const remain = firstNumber(pick(raw, 'CycleRemainCapacity', 'cycleRemainCapacity')) ?? 0;
    const consumed = firstNumber(pick(raw, 'CycleUsedCapacity', 'cycleUsedCapacity')) ?? 0;
    limit += total;
    remaining += remain;
    used += consumed;
    unit = unit || firstString(pick(raw, 'CapacityUnit', 'capacityUnit'));
    const code = firstString(pick(raw, 'PackageCode', 'packageCode'));
    if (code) packageCodes.push(code);
    counted += 1;
  }

  if (counted === 0) throw new Error('data.Packages 为空，没有可统计的资源包');
  return {
    limit,
    used,
    remaining,
    unit: unit || 'credits',
    packageCount: counted,
    packageCodes,
  };
}

export interface CodeBuddyPack {
  label: string;
  size: number;
  remain: number;
  expiresAt: string | null;
  product: string;
}

export function parseCodeBuddyPackages(body: unknown): CodeBuddyPack[] {
  const data = pick(body, 'data');
  const accounts = isRecord(data) ? pick(data, 'Accounts', 'accounts') : undefined;
  if (!Array.isArray(accounts)) return [];

  const packs: CodeBuddyPack[] = [];
  for (const raw of accounts) {
    if (!isRecord(raw)) continue;
    const size = firstNumber(pick(raw, 'CycleCapacitySizePrecise', 'CycleCapacitySize')) ?? 0;
    const remain = firstNumber(pick(raw, 'CycleCapacityRemainPrecise', 'CycleCapacityRemain')) ?? 0;
    // 周期结束时间优先；缺失时退回抵扣截止时间（毫秒时间戳）
    const expiresAt =
      toIso(pick(raw, 'CycleEndTime', 'cycleEndTime')) ??
      toIso(pick(raw, 'DeductionEndTime', 'deductionEndTime')) ??
      toIso(pick(raw, 'ExpiredTime', 'expiredTime'));
    if (size <= 0 && remain <= 0) continue;

    // SubProductName 更短更有辨识度（如「腾讯云代码助手 (IDE) - 赠送包」），优先用它
    const product = firstString(pick(raw, 'SubProductName', 'subProductName'));
    packs.push({
      label: product || firstString(pick(raw, 'PackageName', 'packageName')) || '资源包',
      size,
      remain,
      expiresAt,
      product: '',
    });
  }
  return packs;
}

export const codebuddyAdapter: ProviderAdapter = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  region: 'cn',
  dashboardUrl: 'https://www.codebuddy.cn/profile/plans-usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 www.codebuddy.cn 后，在 DevTools 里复制任意 www.codebuddy.cn 请求的 Cookie 头' +
    '（务必包含 www 子域下的会话 Cookie），填入 credentials.cookie（也可用 npm run capture 自动抓取）。',
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return notConfigured(codebuddyAdapter, account, ctx, ['cookie']);

    const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;
    const headers: Record<string, string> = {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: 'https://www.codebuddy.cn',
      Referer: 'https://www.codebuddy.cn/profile/plans-usage',
      'x-client-platform': 'web',
    };
    const summaryUrl = optString(account, 'endpoint') || CB_SUMMARY_URL;

    try {
      const summaryResponse = await fetchJson(summaryUrl, {
        method: 'POST',
        headers,
        body: '{}',
        timeoutMs,
      });
      assertBusinessOk(summaryResponse.body);
      const summary = parseCodeBuddySummary(summaryResponse.body);

      // 资源包详情接口必须带上 summary 给出的 PackageCodes，失败不影响余额展示
      let packs: CodeBuddyPack[] = [];
      if (summary.packageCodes.length > 0) {
        try {
          const packagesResponse = await fetchJson(CB_PACKAGES_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              PageNumber: 1,
              PageSize: 200,
              Status: [0],
              PackageCodes: summary.packageCodes,
              NeedInUsage: true,
            }),
            timeoutMs,
          });
          assertBusinessOk(packagesResponse.body);
          packs = parseCodeBuddyPackages(packagesResponse.body);
        } catch (error) {
          ctx.log(`CodeBuddy 资源包详情获取失败（不影响余额）：${(error as Error).message}`);
        }
      }

      const lots: CreditLot[] = packs.map((pack, index) =>
        makeLot({
          id: `cb-pack-${index}`,
          label: pack.label,
          amount: pack.size || pack.remain,
          currency: 'CREDITS',
          expiresAt: pack.expiresAt,
          note: `本周期剩余 ${Math.round(pack.remain * 100) / 100}；批次金额为本周期额度，账户级剩余见上方余额`,
          basis: 'granted',
        }),
      );

      const earliest = lots
        .map((lot) => lot.expiresAt)
        .filter((value): value is string => typeof value === 'string')
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const round = (value: number): number => Math.round(value * 100) / 100;
      const window = makeWindow({
        kind: 'billing',
        label: `积分额度（${summary.packageCount} 个资源包）`,
        used: summary.used,
        limit: summary.limit,
        remaining: summary.remaining,
        boundary: earliest ? 'expiry' : 'reset',
        expiresAt: earliest,
      });

      return buildSnapshot({
        adapter: codebuddyAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: round(summary.remaining), currency: 'CREDITS' },
        credits: lots,
        windows: [window],
        note: lots.some((lot) => lot.expiresAt)
          ? null
          : '资源包接口未返回周期结束时间，无法给出批次到期日',
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(codebuddyAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
