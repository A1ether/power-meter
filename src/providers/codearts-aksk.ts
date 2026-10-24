import { HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { huaweiSignedFetch } from '../lib/huaweicloud.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  hiddenLotsNote,
  joinNotes,
  cred,
  makeLot,
  makeWindow,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * CodeArts 华为云 · AK/SK 数据源（snap-access 网关）。
 *
 * 与 `codearts.ts` 的 Cookie 路径并列，作为**首选凭证**：AK/SK 长期有效，
 * 不受华为云控制台「会话超时（默认 1 小时）」影响，因此不会出现登录态失效。
 *
 * 接口（2026-10-11 实测打通，见 docs/fixes/CodeArts-华为云登录态频繁失效-修复方案.md）：
 *   GET https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin
 *   签名：SDK-HMAC-SHA256「换行式 + 带日期 + 空 body 哈希」（该组合是唯一被 APIG 接受的，
 *         其余空格分隔/不带日期/UNSIGNED-PAYLOAD 组合均返回 401 APIG.0301）。
 *
 * 响应要点（已实测）：
 *   metrics[usageTotalPackageCredit]      → package_credit_amount / _used / _remain / _expiring_amount
 *   metrics[usageBasicPackageCredit]      → 订阅套餐额度（体验版 500）
 *   metrics[usageBonusPackageCredit]      → 活动福利额度（如邀请活动 20000）
 *   metrics[usageOnDemandPackageCredit]   → 按需积分包
 *   start_date ~ end_date                 → 计费周期，即页面显示的到期日（2026-09-25 ~ 2026-10-26）
 *   package.{status,package_name_cn,...}  → 套餐状态与名称
 *   metrics/model_metrics 里的 token 字段  → 与积分不是同一计量，本适配器不接入
 *
 * 混合增强（hybrid）：AK/SK 负责余额/额度窗口（权威口径），若登录态可用，
 * 活动福利批次改用控制台逐笔明细（每笔独立到期时间），并由调用方传入 `detail`；
 * 逐笔之和与账户级 bonus 桶的差额补一条「未明细部分」调节项。
 */

const SNAP_ACCESS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com';
const STATISTICS_PLUGIN_PATH = '/snap-manager/v1/statistics/plugin';
const AK_SK_TIMEOUT_FALLBACK = 12_000;

export interface CodeArtsAkSk {
  accessKey: string;
  secretKey: string;
}

/** 积分桶：总额 / 已用 / 剩余 / 临近过期 */
export interface CodeArtsCreditMetric {
  amount: number;
  used: number;
  remain: number;
  expiring: number;
}

export interface CodeArtsSubscription {
  total: CodeArtsCreditMetric | null;
  basic: CodeArtsCreditMetric | null;
  bonus: CodeArtsCreditMetric | null;
  ondemand: CodeArtsCreditMetric | null;
  packageName: string;
  packageStatus: string;
  periodStart: string | null;
  periodEnd: string | null;
}

/** 登录态口径的活动福利逐笔明细（由 codearts.ts 抓取后传入） */
export interface CodeArtsCampaignDetail {
  lots: CreditLot[];
  benefitTotal: number;
}

/**
 * 读取 AK/SK。优先级：accounts.json 的 credentials.accessKey/secretKey
 * → ctx 凭证解析（`cred()`，含进程环境变量的全局兜底与看板校验时的临时账号）
 * → 直接读进程环境变量（CODEARTS_AK/CODEARTS_SK，兼容 CLI 官方的 CODEARTS_CLI_AK/CODEARTS_CLI_SK）。
 *
 * 支持环境变量兜底是为了让「只往 .env 里加两个变量」就能切换到 AK/SK，
 * 不必再改 accounts.json（凭证明文始终只落在 .env）。
 */
export function readCodeArtsAkSk(account: AccountConfig, ctx?: ProbeContext): CodeArtsAkSk | null {
  const accessKey = (
    account.credentials.accessKey ||
    (ctx ? cred(account, ctx, ['accessKey']) : '') ||
    optString(account, 'accessKey') ||
    process.env.CODEARTS_AK ||
    process.env.CODEARTS_CLI_AK ||
    ''
  ).trim();
  const secretKey = (
    account.credentials.secretKey ||
    (ctx ? cred(account, ctx, ['secretKey']) : '') ||
    optString(account, 'secretKey') ||
    process.env.CODEARTS_SK ||
    process.env.CODEARTS_CLI_SK ||
    ''
  ).trim();
  return accessKey && secretKey ? { accessKey, secretKey } : null;
}

function readCreditMetric(source: unknown): CodeArtsCreditMetric | null {
  if (!isRecord(source)) return null;
  const amount = firstNumber(pick(source, 'package_credit_amount', 'packageCreditAmount'));
  const remain = firstNumber(pick(source, 'package_credit_remain', 'packageCreditRemain'));
  if (amount === null && remain === null) return null;
  return {
    amount: amount ?? 0,
    used: firstNumber(pick(source, 'package_credit_used', 'packageCreditUsed')) ?? 0,
    remain: remain ?? 0,
    expiring:
      firstNumber(pick(source, 'package_credit_expiring_amount', 'packageCreditExpiringAmount')) ?? 0,
  };
}

/** 按指标名取 metrics 里的某一项（名字大小写不敏感） */
function findMetric(metrics: unknown, name: string): unknown {
  if (!Array.isArray(metrics)) return undefined;
  const target = name.toLowerCase();
  return metrics.find(
    (item) => isRecord(item) && String(pick(item, 'name') ?? '').toLowerCase() === target,
  );
}

export function parseStatisticsPlugin(body: unknown): CodeArtsSubscription {
  if (!isRecord(body)) throw new Error('响应不是 JSON 对象');
  const metrics = pick(body, 'metrics');
  const pkg = pick(body, 'package');

  return {
    total: readCreditMetric(findMetric(metrics, 'usageTotalPackageCredit')),
    basic: readCreditMetric(findMetric(metrics, 'usageBasicPackageCredit')),
    bonus: readCreditMetric(findMetric(metrics, 'usageBonusPackageCredit')),
    ondemand: readCreditMetric(findMetric(metrics, 'usageOnDemandPackageCredit')),
    packageName: isRecord(pkg)
      ? firstString(pick(pkg, 'package_name_cn', 'packageNameCn'), pick(pkg, 'package_name_en'))
      : '',
    packageStatus: isRecord(pkg) ? firstString(pick(pkg, 'status')) : '',
    periodStart: toIso(pick(body, 'start_date', 'startDate')),
    periodEnd: toIso(pick(body, 'end_date', 'endDate')),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 拉取并解析订阅/积分快照（失败抛错，由调用方决定是否回退 Cookie） */
export async function fetchCodeArtsSubscription(
  aksk: CodeArtsAkSk,
  timeoutMs: number,
): Promise<CodeArtsSubscription> {
  const result = await huaweiSignedFetch({
    accessKey: aksk.accessKey,
    secretKey: aksk.secretKey,
    method: 'GET',
    url: `${SNAP_ACCESS_BASE}${STATISTICS_PLUGIN_PATH}`,
    // 这两项是实测唯一通过的组合，改动前请先复跑 npm run codearts:aksk-probe
    signatureStyle: 'newline',
    unsignedPayload: false,
    timeoutMs: Math.min(timeoutMs || AK_SK_TIMEOUT_FALLBACK, AK_SK_TIMEOUT_FALLBACK),
  });

  if (!result.ok) {
    const detail = result.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    // APIG.0613：网关能连上，但下游 IAM 校验 AK/SK 时报系统错误——实测对错误的
    // AK/SK 也返回它（不是 401），因此按「凭证验证失败」而不是「服务不可用」上报，
    // 否则看板添加账号时会让人以为等一会儿就好。
    const iamCheckFailed = /APIG\.0613/.test(result.text);
    throw new HttpError(
      `snap-access 返回 HTTP ${result.status}：${detail}` +
        (iamCheckFailed ? '（网关无法完成 AK/SK 签名校验，请确认密钥正确且未被停用）' : ''),
      // 401 = 凭证不对（HTTP 本身可能仍是 5xx），401 映射为 unauthorized，区别于服务不可用
      iamCheckFailed ? 401 : result.status,
    );
  }
  return parseStatisticsPlugin(result.json);
}

/**
 * 组装快照：
 *   - 余额/额度窗口永远取 AK/SK 的账户级口径（total）；
 *   - 活动福利批次：`detail` 非空时用逐笔（各自到期），否则退回聚合桶；
 *   - 逐笔之和与聚合桶的差额 ≥1 时补「未明细部分」调节项。
 */
export function buildCodeArtsSnapshot(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  subscription: CodeArtsSubscription,
  detail: CodeArtsCampaignDetail | null = null,
  extraNote: string | null = null,
): ProviderSnapshot {
  const total = subscription.total;
  if (!total) throw new Error('响应缺少 usageTotalPackageCredit（检查 AK/SK 权限）');

  const lots: CreditLot[] = [];

  if (subscription.basic && subscription.basic.remain > 0) {
    lots.push(
      makeLot({
        id: 'codearts-basic',
        label: '个人订阅套餐',
        amount: subscription.basic.remain,
        currency: 'CREDITS',
        expiresAt: subscription.periodEnd,
        note: `套餐额度 ${subscription.basic.amount}，已用 ${subscription.basic.used}`,
      }),
    );
  }

  const bonusRemain = round2(subscription.bonus?.remain ?? 0);
  if (detail && detail.lots.length > 0) {
    lots.push(...detail.lots);
    const gap = round2(bonusRemain - detail.benefitTotal);
    if (gap >= 1) {
      lots.push(
        makeLot({
          id: 'codearts-bonus-gap',
          label: '活动奖励积分（未明细部分）',
          amount: gap,
          currency: 'CREDITS',
          expiresAt: subscription.periodEnd,
          note: `活动明细合计 ${detail.benefitTotal}，与账户级 ${bonusRemain} 的差额`,
        }),
      );
    }
  } else if (subscription.bonus && bonusRemain > 0) {
    lots.push(
      makeLot({
        id: 'codearts-bonus',
        label: '活动福利积分',
        amount: bonusRemain,
        currency: 'CREDITS',
        expiresAt: subscription.periodEnd,
        note: `活动额度 ${subscription.bonus.amount}，已用 ${subscription.bonus.used}`,
      }),
    );
  }

  if (subscription.ondemand && subscription.ondemand.remain > 0) {
    lots.push(
      makeLot({
        id: 'codearts-ondemand',
        label: '按需积分包',
        amount: subscription.ondemand.remain,
        currency: 'CREDITS',
        expiresAt: subscription.periodEnd,
        note: `按需额度 ${subscription.ondemand.amount}，已用 ${subscription.ondemand.used}`,
      }),
    );
  }

  const window = makeWindow({
    kind: 'billing',
    label: '积分额度（套餐 + 活动福利）',
    used: total.used,
    limit: total.amount,
    remaining: total.remain,
    boundary: subscription.periodEnd ? 'expiry' : 'mixed',
    expiresAt: subscription.periodEnd,
  });

  // 与 Cookie 路径保持一致：已过期批次不再逐条展示，只汇总成一句提示
  // （逐笔明细里可能残留「已过期但上游尚未结清」的记录，直接列出会被误读成可用额度）
  const { active, expired } = splitByExpiry(lots, ctx.now);
  const detailCount = detail?.lots.length ?? 0;

  return buildSnapshot({
    adapter,
    account,
    status: 'ok',
    now: ctx.now,
    balance: { amount: total.remain, currency: 'CREDITS' },
    credits: active,
    windows: [window],
    note: joinNotes(
      subscription.packageName
        ? `套餐：${subscription.packageName}${subscription.packageStatus ? `（${subscription.packageStatus}）` : ''}`
        : null,
      subscription.packageStatus && subscription.packageStatus !== 'normal'
        ? '套餐状态非 normal，请到码道控制台检查订阅'
        : null,
      total.expiring > 0 ? `有 ${total.expiring} 积分临近过期` : null,
      detailCount > 0
        ? `活动福利：登录态逐笔口径（取到 ${detailCount} 笔）`
        : '活动福利：聚合口径',
      hiddenLotsNote(expired),
      extraNote,
      subscription.periodStart && subscription.periodEnd
        ? `计费周期 ${subscription.periodStart.slice(0, 10)} ~ ${subscription.periodEnd.slice(0, 10)}`
        : null,
    ),
  });
}

/** 纯 AK/SK 模式（不叠加登录态明细） */
export async function probeCodeArtsViaAkSk(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  aksk: CodeArtsAkSk,
): Promise<ProviderSnapshot> {
  const subscription = await fetchCodeArtsSubscription(aksk, ctx.timeoutMs);
  return buildCodeArtsSnapshot(adapter, account, ctx, subscription, null);
}
