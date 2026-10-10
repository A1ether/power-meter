import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { localDateKey, startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
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
const CB_PAID_PACKAGES_URL = 'https://www.codebuddy.cn/billing/meter/get-user-resource-paid-packages';
const CB_REQUEST_USAGE_URL = 'https://www.codebuddy.cn/billing/meter/get-user-request-usage';
const CB_GIFT_URL = 'https://www.codebuddy.cn/billing/meter/check-gift-claimed';
const CB_TIMEOUT_FALLBACK = 12_000;

/**
 * 资源包列表 → 「获取」记录：每个包的当前周期发放时间（CycleStartTime）
 * 与周期额度（CycleCapacitySizePrecise），即页面资源包列表里的发放口径。
 */
function parsePackageGrants(body: unknown): UsageRecord[] {
  const data = pick(body, 'data');
  const accounts = isRecord(data) ? pick(data, 'Accounts', 'accounts') : undefined;
  if (!Array.isArray(accounts)) return [];
  const out: UsageRecord[] = [];
  for (const raw of accounts) {
    if (!isRecord(raw)) continue;
    const at = toIso(pick(raw, 'CycleStartTime', 'cycleStartTime', 'CreateTime', 'createTime'));
    const amount = firstNumber(
      pick(raw, 'CycleCapacitySizePrecise', 'cycleCapacitySizePrecise', 'CycleCapacitySize'),
    );
    if (!at || amount === null || amount <= 0) continue;
    out.push({ at: Date.parse(at), kind: 'grant', amount });
  }
  return out;
}

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
    packs.push({
      label:
        firstString(pick(raw, 'SubProductName', 'subProductName')) ||
        firstString(pick(raw, 'PackageName', 'packageName')) ||
        '资源包',
      size,
      remain,
      expiresAt,
    });
  }
  return packs;
}

export const codebuddyAdapter: ProviderAdapter = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  region: 'cn',
  dashboardUrl: 'https://www.codebuddy.cn/profile/plans-usage',
  usageUrl: 'https://www.codebuddy.cn/profile/plans-usage',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '登录 www.codebuddy.cn 后，在 DevTools 里复制任意 www.codebuddy.cn 请求的 Cookie 头' +
    '（务必包含 www 子域下的会话 Cookie），填入 credentials.cookie（也可用 npm run capture 自动抓取）。',
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：`get-user-request-usage` 逐笔（`requestTime` + `credit`，支持日期区间与翻页），
   *     与页面「使用明细」同源；
   *   - 获取：资源包当前周期发放（`CycleStartTime` + `CycleCapacitySizePrecise`）+
   *     礼包（`claimed_at` + `credit_num`，只回最近一次领取）。任一获取来源失败即整体
   *     退回本地采样（不标 upstream），避免「只统计了一半还说完整」。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return null;
    const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;
    const headers: Record<string, string> = {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: 'https://www.codebuddy.cn',
      Referer: 'https://www.codebuddy.cn/profile/plans-usage',
      'x-client-platform': 'web',
    };
    const records: UsageRecord[] = [];

    // ① 逐笔用量：本地日区间，按页拉取（上限 10 页 × 100）
    const startDay = localDateKey(startOfDay(ctx.now) - 86_400_000);
    const endDay = localDateKey(ctx.now);
    const pageSize = 100;
    for (let pageNum = 1; pageNum <= 10; pageNum += 1) {
      const { body } = await fetchJson(CB_REQUEST_USAGE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startTime: `${startDay} 00:00:00`,
          endTime: `${endDay} 23:59:59`,
          pageNum,
          pageSize,
        }),
        timeoutMs,
      });
      assertBusinessOk(body);
      const data = isRecord(body) ? pick(body, 'data') : undefined;
      const list = isRecord(data) ? pick(data, 'data') : undefined;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const raw of list) {
        if (!isRecord(raw)) continue;
        const at = toIso(pick(raw, 'requestTime', 'request_time'));
        const amount = firstNumber(pick(raw, 'credit', 'credits'));
        if (!at || amount === null || amount <= 0) continue;
        records.push({ at: Date.parse(at), kind: 'use', amount });
      }
      if (list.length < pageSize) break;
    }

    // ②③ 获取记录：任一步失败即放弃覆盖声明（grant 回退本地采样）
    let grantCovered = true;
    try {
      const summaryResponse = await fetchJson(optString(account, 'endpoint') || CB_SUMMARY_URL, {
        method: 'POST',
        headers,
        body: '{}',
        timeoutMs,
      });
      assertBusinessOk(summaryResponse.body);
      const summary = parseCodeBuddySummary(summaryResponse.body);
      const packageBody = JSON.stringify({
        PageNumber: 1,
        PageSize: 200,
        Status: [0],
        PackageCodes: summary.packageCodes,
        NeedInUsage: true,
      });
      for (const url of [CB_PACKAGES_URL, CB_PAID_PACKAGES_URL]) {
        try {
          const { body } = await fetchJson(url, { method: 'POST', headers, body: packageBody, timeoutMs });
          records.push(...parsePackageGrants(body));
        } catch (error) {
          grantCovered = false;
          ctx.log(`CodeBuddy 资源包发放明细获取失败（退回本地采样）：${(error as Error).message}`);
        }
      }
    } catch (error) {
      grantCovered = false;
      ctx.log(`CodeBuddy 资源包清单获取失败（退回本地采样）：${(error as Error).message}`);
    }
    try {
      const { body } = await fetchJson(CB_GIFT_URL, { method: 'POST', headers, body: '{}', timeoutMs });
      const data = isRecord(body) ? pick(body, 'data') : undefined;
      if (isRecord(data) && pick(data, 'claimed') === true) {
        const at = toIso(pick(data, 'claimed_at', 'claimedAt'));
        const amount = firstNumber(pick(data, 'credit_num', 'creditNum'));
        if (at && amount !== null && amount > 0) {
          records.push({ at: Date.parse(at), kind: 'grant', amount });
        }
      }
    } catch (error) {
      grantCovered = false;
      ctx.log(`CodeBuddy 礼包明细获取失败（退回本地采样）：${(error as Error).message}`);
    }

    return { records, covers: { use: true, grant: grantCovered } };
  },

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

      // 实测各包本周期剩余之和 === summary 的账户级剩余，因此批次按「剩余量」参与汇总
      const usable = packs.filter((pack) => pack.remain > 0);
      const usedUpCount = packs.length - usable.length;
      const lots: CreditLot[] = usable.map((pack, index) =>
        makeLot({
          id: `cb-pack-${index}`,
          label: pack.label,
          amount: pack.remain,
          currency: 'CREDITS',
          expiresAt: pack.expiresAt,
          note: `本周期额度 ${pack.size}`,
        }),
      );
      const { active, expired } = splitByExpiry(lots, ctx.now);

      const earliest =
        active
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
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired, usedUpCount),
          active.length > 0 && active.some((lot) => lot.expiresAt)
            ? null
            : '资源包接口未返回周期结束时间，无法给出批次到期日',
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(codebuddyAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
