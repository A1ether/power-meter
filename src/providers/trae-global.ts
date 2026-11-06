import { randomUUID } from 'node:crypto';
import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages, incompleteNote, type PagedResult } from '../lib/pagination.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import type { Currency, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractHeaderValue,
  failure,
  joinNotes,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';
import {
  mergeLots,
  traeCallbackUrl,
  traeDeviceInfo,
  traeDeviceKeyFromPem,
  traeDeviceLimitMessage,
  traeDeviceProof,
  traeHostAllowed,
  traeLoginDeviceIdentity,
  traePkce,
  traeReadCallback,
  type TraeDeviceKey,
  type TraePack,
} from './trae.js';

/**
 * Trae 国际版（trae.ai）
 *
 * 与国内版（`trae.ts`）是**两套部署**：域名、账号体系、计费口径都不同，
 * 因此是独立平台（provider id `trae-global`），凭证变量也用 `TRAE_GLOBAL_*` 前缀，
 * 与国内版互不覆盖。
 *
 * 相同点（协议事实，见 `trae.ts` 的注释与本机 `Trae.app` 的 `out/main.js`）：
 *   - OAuth：授权页 `{consoleHost}/authorization`，回调固定 `127.0.0.1:<port>/authorize`，
 *     client_id 同为 `ono9krqynydwx5`（`product.json` 的 `iCubeApp.authConfig.TRAE.stable`）；
 *   - 换令牌 / 续期：`POST {账号主机}/trae/api/v3/oauth/ExchangeToken`（DeviceProof 签名）；
 *   - Cookie 换 JWT：`POST {账号主机}/cloudide/api/v3/common/GetUserToken`；
 *   - 鉴权头：`Authorization: Cloud-IDE-JWT <token>`。
 *
 * 不同点：
 *   - 主机：授权页 `www.trae.ai`；账号 / 令牌 `growsg-normal.trae.ai`（SG）；
 *     计费面 `api-sg-central.trae.ai`（SG）/ `api-us-east.trae.ai`（US）；
 *   - 用量接口是 **v1** `/trae/api/v1/pay/user_current_entitlement_list`，
 *     不是国内的 v2；返回 `user_entitlement_pack_list` 但**没有** `usage_summary`；
 *   - 计费口径随套餐变化：美元用量 / 快速请求次数 / 积分，见 `GLOBAL_DIMENSIONS`。
 *
 * 证据等级见 `docs/plans/平台适配器-接入Trae国际版-开发设计方案.md` §2.2：
 * 本机安装包常量与日志为 A 级，社区实测为 B 级；计费面主机组合尚待人工验证。
 */

/** 授权页（与 `product.json` 的 `bootConfig.condition.website` 一致） */
const GLOBAL_CONSOLE_HOST = 'https://www.trae.ai';
/** 账号 / 令牌主机（本机 Trae.app 日志实测；SG 区） */
const GLOBAL_ACCOUNT_HOST = 'https://growsg-normal.trae.ai';
/**
 * 主机表按区域分组。国际版有两个部署（SG / US），Cookie 里的 `store-idc`
 * 决定账号归属，不同角色的主机也不同：
 *   - 账号 / 令牌面：`grow…-normal.trae.ai`（SG）、`grow-normal.traeapi.us`（US）；
 *   - 计费面：`api-sg-central.trae.ai`（SG）、`api-us-east.trae.ai`（US）。
 * 来源：`product.json` 的 `bootConfig.account.trae` / `ug.trae`（账号面）
 * 与社区实测（计费面，见设计文档 §2.2）。
 */
const GLOBAL_REGION_HOSTS: Record<
  'sg' | 'us',
  { account: string[]; pay: string[] }
> = {
  sg: {
    account: ['https://growsg-normal.trae.ai', 'https://grow-normal.trae.ai'],
    pay: ['https://api-sg-central.trae.ai', 'https://growsg-normal.trae.ai'],
  },
  us: {
    account: ['https://grow-normal.traeapi.us', 'https://grow-normal.trae.ai'],
    pay: ['https://api-us-east.trae.ai', 'https://grow-normal.traeapi.us'],
  },
};

/** Cookie 换 JWT（与国内版同一端点，只换主机） */
const GLOBAL_TOKEN_PATH = '/cloudide/api/v3/common/GetUserToken';
const GLOBAL_EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const GLOBAL_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';
const GLOBAL_PAY_STATUS_PATH = '/trae/api/v1/pay/ide_user_pay_status';
/** 用量接口：优先控制台口径，失败再试 IDE 口径（两者返回同一份 pack 列表） */
const GLOBAL_USAGE_PATHS = [
  '/trae/api/v1/pay/user_current_entitlement_list',
  '/trae/api/v1/pay/ide_user_ent_usage',
];
const GLOBAL_LEDGER_PATH = '/trae/api/v1/pay/query_user_usage_group_by_session';

const GLOBAL_TIMEOUT_FALLBACK = 12_000;
const GLOBAL_CLIENT_ID = 'ono9krqynydwx5';
const GLOBAL_IDE_VERSION = '1.107.1';
const GLOBAL_LOGIN_TTL_MS = 5 * 60 * 1000;
/** 回调里带的 host 只认 Trae 国际版域名（SG 的 trae.ai、US 的 traeapi.us），防止 SSRF / 令牌外送 */
const GLOBAL_HOST_PATTERN = /(^|\.)(trae\.ai|traeapi\.us)$/;

/* ------------------------------------------------------------------ *
 * 主机解析
 * ------------------------------------------------------------------ */

/**
 * Cookie 里的区域标记决定账号归属：`useast` → 美东，其余（含 `alisg`）→ 新加坡。
 * 判据与社区实现（traehop / Trae-Account-Manager）一致。
 */
function regionOfCookie(cookie: string): 'sg' | 'us' {
  const lowered = cookie.toLowerCase();
  return lowered.includes('store-idc=useast') || lowered.includes('trae-target-idc=useast')
    ? 'us'
    : 'sg';
}

/** 去重并保持顺序（候选链里 `options` 覆盖与默认值可能重复） */
function uniqueHosts(hosts: string[]): string[] {
  const out: string[] = [];
  for (const host of hosts) {
    const trimmed = host.replace(/\/+$/, '');
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 账号 / 令牌面候选：`options.apiHost` 显式覆盖优先（代理 / 自定义域名），
 * 其余按 Cookie 的区域判定；另一区域的主机留作兜底，避免区域标记缺失时打不通。
 */
function accountHostsOf(account: AccountConfig, cookie: string): string[] {
  const override = optString(account, 'apiHost').replace(/\/+$/, '');
  const region = regionOfCookie(cookie);
  const other = region === 'us' ? 'sg' : 'us';
  return uniqueHosts([
    override,
    ...GLOBAL_REGION_HOSTS[region].account,
    ...GLOBAL_REGION_HOSTS[other].account,
  ]);
}

/**
 * 计费面候选：`options.usageUrl` 的 origin 优先，其次按区域判定。
 *
 * 与国内版 `trae.ts:543` / `:794` 的 `options.usageUrl` 约定一致——
 * 用户可指向自建代理，但只换 origin，路径仍是国际版 v1。
 */
function payHostsOf(account: AccountConfig, cookie: string): string[] {
  const usageUrl = optString(account, 'usageUrl');
  let origin = '';
  if (usageUrl) {
    try {
      origin = new URL(usageUrl).origin;
    } catch {
      // 不是合法 URL 时忽略，继续走区域判定
    }
  }
  const region = regionOfCookie(cookie);
  const other = region === 'us' ? 'sg' : 'us';
  return uniqueHosts([
    origin,
    ...GLOBAL_REGION_HOSTS[region].pay,
    ...GLOBAL_REGION_HOSTS[other].pay,
  ]);
}

/* ------------------------------------------------------------------ *
 * 令牌解析（Cookie / refreshToken / 显式 accessToken）
 * ------------------------------------------------------------------ */

interface GlobalCachedToken {
  token: string;
  expiresAtMs: number;
}

/** 按「主机 + Cookie」缓存换来的 JWT，避免每次刷新都多打一次接口 */
const globalTokenCache = new Map<string, GlobalCachedToken>();

function globalCookieKey(host: string, cookie: string): string {
  let hash = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    hash = (hash * 31 + cookie.charCodeAt(index)) | 0;
  }
  return `trae-global-${host}-${hash}`;
}

function globalDeviceKeyOf(account: AccountConfig, ctx: ProbeContext): TraeDeviceKey | null {
  const raw = cred(account, ctx, ['deviceKey', 'devicePrivateKey']);
  if (!raw) return null;
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    return traeDeviceKeyFromPem(pem);
  } catch {
    return null;
  }
}

/** 用 refreshToken + DeviceProof 换新 JWT（国际版主机，协议与国内版同形） */
async function globalRefreshJwt(
  host: string,
  account: AccountConfig,
  ctx: ProbeContext,
  refreshToken: string,
  key: TraeDeviceKey,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const proof = traeDeviceProof('POST', GLOBAL_EXCHANGE_PATH, GLOBAL_CLIENT_ID, refreshToken, key.privateKeyPem);
  const { body } = await fetchJson(`${host}${GLOBAL_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
    body: JSON.stringify({
      ClientID: GLOBAL_CLIENT_ID,
      ClientSecret: '',
      RefreshToken: refreshToken,
      DeviceInfo: traeDeviceInfo(account, key),
      DeviceProof: { Signature: proof.signature, Timestamp: proof.timestamp, Nonce: proof.nonce },
      IDEVersion: GLOBAL_IDE_VERSION,
    }),
    timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
  });
  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  if (!isRecord(result)) throw new Error('ExchangeToken 响应缺少 Result');
  const accessToken = firstString(pick(result, 'Token', 'token'));
  if (!accessToken) throw new Error('ExchangeToken 未返回 Token，需重新登录');
  return {
    accessToken,
    refreshToken: firstString(pick(result, 'RefreshToken', 'refreshToken')) || null,
  };
}

/** 用 Cookie 换 JWT（带缓存）；Cookie 失效时给出可操作的中文提示 */
async function globalTokenFromCookie(
  host: string,
  cookie: string,
  ctx: ProbeContext,
): Promise<string> {
  const cacheKey = globalCookieKey(host, cookie);
  const cached = globalTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60 * 1000) return cached.token;

  const { body } = await fetchJson(`${host}${GLOBAL_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: GLOBAL_CONSOLE_HOST,
      Referer: `${GLOBAL_CONSOLE_HOST}/`,
    },
    body: '{}',
    timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
  });
  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  const token = firstString(isRecord(result) ? pick(result, 'Token', 'token') : undefined);
  if (!token) throw new Error('GetUserToken 未返回 Token，Cookie 可能已失效');
  const expiresAt = toIso(isRecord(result) ? pick(result, 'ExpiredAt', 'expiredAt') : undefined);
  globalTokenCache.set(cacheKey, {
    token,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : Date.now() + 6 * 60 * 60 * 1000,
  });
  ctx.log('已用 Cookie 续签 Trae 国际版 Token');
  return token;
}

/**
 * 解析可用的 Cloud-IDE-JWT。三条路径按顺序，与国内版一致：
 *   ① 显式 accessToken；② refreshToken + deviceKey 续期并写回 `.env`；③ Cookie 换 JWT。
 */
async function resolveGlobalJwt(account: AccountConfig, ctx: ProbeContext): Promise<string> {
  const explicit = extractHeaderValue(
    cred(account, ctx, ['accessToken', 'token', 'authorization']),
    'authorization',
  )
    .replace(/^cloud-ide-jwt\s+/i, '')
    .trim();
  if (explicit) return explicit;

  const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
  const hosts = accountHostsOf(account, cookie);
  const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);
  const key = globalDeviceKeyOf(account, ctx);

  if (refreshToken && key) {
    let lastError: Error | null = null;
    for (const host of hosts) {
      try {
        ctx.log('Trae 国际版令牌缺失，尝试用 refreshToken + DeviceProof 续期');
        const refreshed = await globalRefreshJwt(host, account, ctx, refreshToken, key);
        if (ctx.persistCredentials) {
          const patch: Record<string, string> = { accessToken: refreshed.accessToken };
          if (refreshed.refreshToken) patch.refreshToken = refreshed.refreshToken;
          try {
            await ctx.persistCredentials(patch);
          } catch (persistError) {
            ctx.log(
              `Trae 国际版新令牌写回 .env 失败（不影响本次取数）：${(persistError as Error).message}`,
            );
          }
        }
        return refreshed.accessToken;
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (lastError) ctx.log(`Trae 国际版续期失败，改用 Cookie：${lastError.message}`);
  }

  if (!cookie) {
    throw new Error('缺少 Trae 国际版登录令牌与 Cookie：请重新登录，或粘贴 Cookie。');
  }

  let lastError: Error | null = null;
  for (const host of hosts) {
    try {
      return await globalTokenFromCookie(host, cookie, ctx);
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error('Trae 国际版 Cookie 换令牌失败');
}

/* ------------------------------------------------------------------ *
 * 用量解析
 * ------------------------------------------------------------------ */

/**
 * 国际版有三种计量维度，同一账户只取其中一种，整张卡片口径统一：
 *   - `dollar`：`is_dollar_usage_billing` 为真，按美元额度计量；
 *   - `credits`：pack 带 `credits_limit`（部分账户沿用积分口径）；
 *   - `requests`：免费档的「进阶模型请求次数」，单位是次数不是积分。
 */
type GlobalDimension = 'dollar' | 'credits' | 'requests';

const DIMENSION_META: Record<GlobalDimension, { currency: Currency; windowLabel: string }> = {
  dollar: { currency: 'USD', windowLabel: '美元用量（本期）' },
  credits: { currency: 'CREDITS', windowLabel: '积分额度（本期）' },
  requests: { currency: 'POINTS', windowLabel: '快速请求次数（本期）' },
};

export interface GlobalPack {
  label: string;
  /** 该批次在当前维度下的授予量 */
  limit: number;
  /** 该批次在当前维度下的已用量 */
  used: number;
  remaining: number;
  expiresAt: string | null;
}

export interface GlobalUsage {
  dimension: GlobalDimension;
  packs: GlobalPack[];
  /** 已隐藏的批次数量（上游隐藏 / 已过期 / 尚未生效 / 已用尽） */
  hiddenCount: number;
  used: number;
  limit: number;
  plan: string | null;
  isDollarBilling: boolean;
}

/**
 * 解出响应信封：国际版网关在不同版本上返回平铺对象或 `{code, data}` 两种形态。
 * 业务码非 0 一律视为失败（避免把错误当空数据）；`data` 是对象时取它。
 */
function unwrapEnvelope(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error('Trae 国际版返回了非对象响应');
  const code = firstNumber(pick(body, 'code'));
  if (code !== null && code !== 0) {
    throw new Error(
      `Trae 国际版返回业务错误 ${code}：${firstString(pick(body, 'message')) || '未提供原因'}`,
    );
  }
  const data = pick(body, 'data', 'Data');
  return isRecord(data) ? data : body;
}

/** 该响应是否是「带权益包列表」的用量响应（用于候选链判成功） */
function hasPackList(body: unknown): boolean {
  try {
    const payload = unwrapEnvelope(body);
    return Array.isArray(pick(payload, 'user_entitlement_pack_list', 'userEntitlementPackList'));
  } catch {
    return false;
  }
}

/**
 * 取某个 pack 的配额对象。
 * 增购包（`product_type === 2`）的额度在 `product_extra.package_extra.quota`，
 * 其余在 `product_extra.subscription_extra.quota`；都没有时退回 `quota`。
 * 与社区实现（EchoBird 的 `pack_quota`）一致，避免读错层级拿到 0。
 */
function packQuotaOf(base: Record<string, unknown>): Record<string, unknown> | undefined {
  const productType = firstNumber(pick(base, 'product_type', 'productType'));
  const extra = pick(base, 'product_extra', 'productExtra');
  const packageExtra = isRecord(extra) ? pick(extra, 'package_extra', 'packageExtra') : undefined;
  const subscriptionExtra = isRecord(extra)
    ? pick(extra, 'subscription_extra', 'subscriptionExtra')
    : undefined;
  const preferred = isRecord(productType === 2 ? packageExtra : subscriptionExtra)
    ? pick(productType === 2 ? packageExtra : subscriptionExtra, 'quota')
    : undefined;
  const direct = pick(base, 'quota');
  const fallbackPackage = isRecord(packageExtra) ? pick(packageExtra, 'quota') : undefined;
  for (const candidate of [preferred, direct, fallbackPackage]) {
    if (isRecord(candidate)) return candidate;
  }
  return undefined;
}

/** 某维度下该 pack 的 (limit, used)；缺字段返回 null（该 pack 不属于此维度） */
function dimensionAmounts(
  quota: Record<string, unknown>,
  usage: Record<string, unknown> | undefined,
  dimension: GlobalDimension,
): { limit: number; used: number } | null {
  const usedOf = (...keys: string[]): number =>
    firstNumber(...keys.map((key) => (usage ? pick(usage, key) : undefined))) ?? 0;

  if (dimension === 'dollar') {
    const basic = firstNumber(pick(quota, 'basic_usage_limit', 'basicUsageLimit'));
    if (basic === null || basic < 0) return null;
    const noBonus = pick(quota, 'no_bonus_quota', 'noBonusQuota') === true;
    const bonus = noBonus
      ? 0
      : (firstNumber(pick(quota, 'bonus_usage_limit', 'bonusUsageLimit')) ?? 0);
    const used = usedOf('basic_usage_amount', 'basicUsageAmount') +
      (noBonus ? 0 : usedOf('bonus_usage_amount', 'bonusUsageAmount'));
    return { limit: basic + bonus, used };
  }

  if (dimension === 'credits') {
    const limit = firstNumber(pick(quota, 'credits_limit', 'creditsLimit'));
    if (limit === null || limit <= 0) return null;
    return { limit, used: usedOf('credits_amount', 'creditsAmount') };
  }

  // requests：免费档以「进阶模型请求次数」计量，个别 pack 只给 premium fast 次数。
  // 取**第一个大于 0** 的候选：上游会把不适用的一侧写成 0，而 firstNumber 会把 0 当成有效值。
  const limit = [
    firstNumber(pick(quota, 'premium_model_fast_request_limit', 'premiumModelFastRequestLimit')),
    firstNumber(pick(quota, 'advanced_model_request_limit', 'advancedModelRequestLimit')),
  ].find((value): value is number => value !== null && value > 0);
  if (limit === undefined) return null;
  const used = firstNumber(
    pick(usage, 'premium_model_fast_amount'),
    pick(usage, 'premium_model_fast_request_usage'),
    pick(usage, 'advanced_model_amount'),
    pick(usage, 'advanced_model_request_usage'),
  ) ?? 0;
  return { limit, used };
}

/** 选择维度：美元计费 → 美元；否则有积分额度 → 积分；否则次数 */
function pickDimension(payload: Record<string, unknown>, quotaList: Record<string, unknown>[]): GlobalDimension {
  const dollar = pick(payload, 'is_dollar_usage_billing', 'isDollarUsageBilling') === true;
  // 美元口径的额度可能只在 bonus 上（免费档 `basic_usage_limit: 0`），两个都要看
  const hasDollarQuota = quotaList.some((quota) => {
    const basic = firstNumber(pick(quota, 'basic_usage_limit', 'basicUsageLimit')) ?? 0;
    const noBonus = pick(quota, 'no_bonus_quota', 'noBonusQuota') === true;
    const bonus = noBonus
      ? 0
      : (firstNumber(pick(quota, 'bonus_usage_limit', 'bonusUsageLimit')) ?? 0);
    return basic > 0 || bonus > 0;
  });
  if (dollar && hasDollarQuota) return 'dollar';
  const hasCredits = quotaList.some((quota) => {
    const limit = firstNumber(pick(quota, 'credits_limit', 'creditsLimit'));
    return limit !== null && limit > 0;
  });
  if (hasCredits) return 'credits';
  return 'requests';
}

export function parseGlobalUsage(body: unknown, now: number): GlobalUsage {
  const payload = unwrapEnvelope(body);
  const packsRaw = pick(payload, 'user_entitlement_pack_list', 'userEntitlementPackList');
  if (!Array.isArray(packsRaw)) {
    throw new Error('响应缺少 user_entitlement_pack_list（Token 可能已失效）');
  }

  const records = packsRaw.filter(isRecord);
  const quotaList = records.map((pack) => {
    const base = pick(pack, 'entitlement_base_info', 'entitlementBaseInfo');
    return (isRecord(base) ? packQuotaOf(base) : undefined) ?? {};
  });
  const dimension = pickDimension(payload, quotaList);

  const packs: GlobalPack[] = [];
  let hiddenCount = 0;
  let plan: string | null = null;
  // 窗口分母覆盖「本期有效」的全部包（含已用尽的），只有已用尽的不进批次列表——
  // 否则一个包用完后会连同它的额度一起从 剩余/总额 里消失，读数变成 0/0
  let periodUsed = 0;
  let periodLimit = 0;

  records.forEach((pack, index) => {
    const base = pick(pack, 'entitlement_base_info', 'entitlementBaseInfo');
    const baseRecord = isRecord(base) ? base : {};
    const usageRaw = pick(pack, 'usage');
    const usage = isRecord(usageRaw) ? usageRaw : undefined;
    const quota = quotaList[index] ?? {};

    const expiresAt =
      toIso(pick(pack, 'expire_time', 'expireTime')) ??
      toIso(pick(baseRecord, 'end_time', 'endTime')) ??
      toIso(pick(pack, 'yearly_expire_time', 'yearlyExpireTime'));
    const startAt = toIso(pick(baseRecord, 'start_time', 'startTime'));
    const hidden = pick(pack, 'is_hide', 'isHide') === true;
    // 已过期 / 尚未生效 / 上游标记隐藏的包不展示（与页面「当前可用」口径一致）
    const notYetValid = startAt !== null && Date.parse(startAt) > now;
    const expired = expiresAt !== null && Date.parse(expiresAt) <= now;

    const amounts = dimensionAmounts(quota, usage, dimension);
    // 不属于该维度 / 额度为 0 的包（免费档的占位权益）不算「被隐藏」，静默跳过
    if (!amounts || amounts.limit <= 0) return;

    // 套餐名只认上游给的 display_desc：缺省时用中性占位名，但不拿它当「套餐」
    const displayDesc = firstString(pick(pack, 'display_desc', 'displayDesc'));
    const label = displayDesc || (dimension === 'requests' ? '免费额度' : '权益包');
    if (!plan && displayDesc) plan = displayDesc;

    if (hidden || expired || notYetValid) {
      hiddenCount += 1;
      return;
    }

    periodUsed += Math.max(0, amounts.used);
    periodLimit += amounts.limit;

    const remaining = Math.max(0, amounts.limit - Math.max(0, amounts.used));
    if (remaining <= 0) {
      hiddenCount += 1;
      return;
    }

    packs.push({
      label,
      limit: amounts.limit,
      used: Math.max(0, amounts.used),
      remaining,
      expiresAt,
    });
  });

  return {
    dimension,
    packs,
    hiddenCount,
    used: periodUsed,
    limit: periodLimit,
    plan,
    isDollarBilling: pick(payload, 'is_dollar_usage_billing', 'isDollarUsageBilling') === true,
  };
}

/**
 * 账户级订阅状态（best-effort）：套餐名 / 订阅到期时间，拿不到不影响取数。
 *
 * 官方客户端把这条打在**账号主机**（`growsg-normal.trae.ai`）上而不是计费面，
 * 所以按账号主机候选链尝试，不复用用量接口的主机。
 */
async function fetchGlobalPlan(
  accountHosts: string[],
  token: string,
  ctx: ProbeContext,
): Promise<{ plan: string | null; subscriptionEndsAt: string | null }> {
  let lastError: Error | null = null;
  for (const host of accountHosts) {
    try {
      const { body } = await fetchJson(`${host}${GLOBAL_PAY_STATUS_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${token}`,
          'Content-Type': 'application/json',
          Origin: GLOBAL_CONSOLE_HOST,
          Referer: `${GLOBAL_CONSOLE_HOST}/`,
        },
        body: JSON.stringify({ trae_client: 'IDE' }),
        timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
      });
      const payload = isRecord(body) ? unwrapEnvelope(body) : {};
      const plan =
        firstString(pick(payload, 'user_pay_identity_str', 'userPayIdentityStr')) || null;
      const trial = pick(payload, 'trial_status', 'trialStatus');
      const trialEnd =
        isRecord(trial) && pick(trial, 'is_in_trial', 'isInTrial') === true
          ? toIso(pick(trial, 'trial_end_time', 'trialEndTime'))
          : null;
      const subscriptionEndsAt =
        toIso(pick(payload, 'last_pro_entitlement_expire_time', 'lastProEntitlementExpireTime')) ??
        trialEnd;
      return { plan, subscriptionEndsAt };
    } catch (error) {
      lastError = error as Error;
    }
  }
  ctx.log(`Trae 国际版订阅状态查询失败（不影响余额）：${lastError?.message ?? '未知原因'}`);
  return { plan: null, subscriptionEndsAt: null };
}

/** 依次尝试「计费面 × 用量路径」，第一个成功的即返回；全失败抛最后一个错误 */
async function fetchGlobalUsageBody(
  payHosts: string[],
  token: string,
  ctx: ProbeContext,
): Promise<{ body: unknown; host: string; path: string }> {
  let lastError: Error | null = null;
  for (const host of payHosts) {
    for (const path of GLOBAL_USAGE_PATHS) {
      try {
        const { body } = await fetchJson(`${host}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Cloud-IDE-JWT ${token}`,
            'Content-Type': 'application/json',
            Origin: GLOBAL_CONSOLE_HOST,
            Referer: `${GLOBAL_CONSOLE_HOST}/`,
          },
          body: JSON.stringify({ require_usage: true }),
          timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
        });
        if (!hasPackList(body)) throw new Error(`响应缺少 user_entitlement_pack_list：${host}${path}`);
        return { body, host, path };
      } catch (error) {
        lastError = error as Error;
        // 网络层失败（没有 HTTP 状态）说明这台主机整体不可达：
        // 换路径只会再等一个超时，直接跳到下一台主机
        if (!(error instanceof HttpError)) break;
      }
    }
  }
  throw lastError ?? new Error('Trae 国际版用量接口全部失败');
}

/**
 * 把状态错误映射成 `ProviderStatus`。
 *
 * `HttpError.status === 0` 是「一个字节都没拿到」的网络层失败（见 `src/lib/http.ts:190`），
 * 它不携带任何上游语义，按 `error` 报，避免把断网显示成「平台不可用」。
 */
function statusOfGlobalError(error: unknown): ProviderSnapshot['status'] {
  if (!(error instanceof HttpError)) return 'error';
  if (error.status === 0) return 'error';
  return error.kind;
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export const traeGlobalAdapter: ProviderAdapter = {
  id: 'trae-global',
  displayName: 'Trae 国际版',
  region: 'global',
  dashboardUrl: 'https://www.trae.ai/account-setting#usage',
  usageUrl: 'https://www.trae.ai/account-setting#usage',
  requiredCredentialKeys: ['cookie'],
  /**
   * 凭证变量独立前缀：与国内版 `TRAE_*` 互不覆盖。
   * 第 2 个账号自动用 `_2` 槽位（见 `src/account-store.ts` 的 `slotEnvName`）。
   */
  envNames: {
    cookie: 'TRAE_GLOBAL_COOKIE',
    accessToken: 'TRAE_GLOBAL_ACCESS_TOKEN',
    refreshToken: 'TRAE_GLOBAL_REFRESH_TOKEN',
    deviceKey: 'TRAE_GLOBAL_DEVICE_KEY',
  },
  // Cookie 可换 JWT；登录产物只要有 accessToken 就能取数，refreshToken+deviceKey 负责续期
  isConfigured: (account) =>
    Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken),
  credentialHint:
    '登录 trae.ai 后从 DevTools 复制任意 *.trae.ai 请求的 Cookie 头，填入 credentials.cookie。' +
    'Token 会自动续签，无需手工维护（也可用 npm run capture -- trae-global 自动抓取）；' +
    '或在看板上点「打开链接登录」自动写入 OAuth 令牌。',
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '登录 trae.ai → DevTools → 任意 *.trae.ai 请求 → 复制 Cookie 整段值',
      hint: '必须是 trae.ai 的登录态（与 trae.cn 的账号互不通用）。',
      multiline: true,
    },
  ],
  manageHint:
    'Cookie 会先真实调用一次国际版用量接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',

  /**
   * 逐笔用量 / 获取明细。
   *
   * 国际版沿用 v1 的 `query_user_usage_group_by_session`（与国内版同形，但**无** `usage_type`），
   * 该接口对国际版账号是否返回数据尚未实测：第一页拿不到记录即判定不可用，
   * 整体返回 null 交给本地采样兜底（不谎报 upstream，见设计文档 §7）。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const hasCookie = Boolean(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasToken =
      Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization'])) ||
      Boolean(cred(account, ctx, ['refreshToken', 'refresh_token']));
    if (!hasCookie && !hasToken) return null;

    let token: string;
    try {
      token = await resolveGlobalJwt(account, ctx);
    } catch (error) {
      ctx.log(`Trae 国际版用量明细取令牌失败，已回退本地采样：${(error as Error).message}`);
      return null;
    }

    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    const payHosts = payHostsOf(account, cookie);

    // 先取一次用量响应：既确定账户的计量维度，也用于后面的「获取明细」。
    // 逐笔用量接口只回「积分」，美元 / 次数账户接上会混单位，因此只对积分账户继续。
    let usageBody: unknown;
    let usageHost = payHosts[0] ?? GLOBAL_ACCOUNT_HOST;
    try {
      const fetched = await fetchGlobalUsageBody(payHosts, token, ctx);
      usageBody = fetched.body;
      // 复用**真正成功的那台主机**：首台候选可能 404，明细接口未必同在首台上
      usageHost = fetched.host;
    } catch (error) {
      ctx.log(`Trae 国际版用量明细取维度失败，已回退本地采样：${(error as Error).message}`);
      return null;
    }
    if (parseGlobalUsage(usageBody, ctx.now).dimension !== 'credits') return null;

    const startSec = Math.floor((startOfDay(ctx.now) - 86_400_000) / 1000);
    const endSec = Math.ceil(ctx.now / 1000);
    const pageSize = 20;
    const records: UsageRecord[] = [];

    // 逐笔用量：列表型接口一律走 fetchAllPages（AGENTS.md §9），由它给出 complete
    let usagePages: PagedResult<UsageRecord>;
    try {
      usagePages = await fetchAllPages<UsageRecord>({
        label: 'Trae 国际版用量明细',
        pageSize,
        maxPages: 10,
        // 同一条记录跨页重复时去重（上游分页参数若被忽略会命中）
        keyOf: (record) => `${record.at}|${record.amount}`,
        async fetchPage(pageNum) {
          const { body } = await fetchJson(`${usageHost}${GLOBAL_LEDGER_PATH}`, {
            method: 'POST',
            headers: {
              Authorization: `Cloud-IDE-JWT ${token}`,
              'Content-Type': 'application/json',
              Origin: GLOBAL_CONSOLE_HOST,
              Referer: `${GLOBAL_CONSOLE_HOST}/`,
            },
            body: JSON.stringify({
              start_time: startSec,
              end_time: endSec,
              page_size: pageSize,
              page_num: pageNum,
            }),
            timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
          });
          const list = isRecord(body)
            ? pick(body, 'user_usage_group_by_sessions', 'userUsageGroupBySessions')
            : undefined;
          if (!Array.isArray(list)) {
            throw new Error('响应缺少 user_usage_group_by_sessions（接口可能未对本账户开放）');
          }
          const items: UsageRecord[] = [];
          for (const raw of list) {
            if (!isRecord(raw)) continue;
            const at = firstNumber(pick(raw, 'usage_time', 'usageTime'));
            const amount = firstNumber(pick(raw, 'credits_float', 'creditsFloat', 'credits'));
            if (at === null || amount === null || amount <= 0) continue;
            items.push({ at: at * 1000, kind: 'use', amount });
          }
          return { items, total: firstNumber(pick(body, 'total')) };
        },
      });
    } catch (error) {
      // 首页失败 = 接口对本账户不可用（国际版是否开放该接口尚未实测）
      ctx.log(`Trae 国际版用量明细不可用，已回退本地采样：${(error as Error).message}`);
      return null;
    }

    // 一页都没有 = 上游没给数据，不是「今天没用量」：不声明覆盖，交给本地采样
    if (usagePages.pages === 0 || (usagePages.items.length === 0 && usagePages.expected === null)) {
      return null;
    }
    records.push(...usagePages.items);

    // 未取全时**不能**声明 use 覆盖（AGENTS.md §9 第 5 条）：整份退回本地采样
    if (!usagePages.complete) {
      ctx.log(`Trae 国际版用量明细分页未取全，已回退本地采样：${incompleteNote(usagePages) ?? ''}`);
      return null;
    }

    // 获取明细：权益包即「发放」逐笔——每个包带 start_time 与 credits 授予量。
    // 只能看到**当前有效**的包（上游不提供历史发放流水），因此「某天没有记录」
    // 不能推出「那天没有发放」：不声明 grant 覆盖，增量维度始终走本地采样。
    try {
      const payload = unwrapEnvelope(usageBody);
      const packsRaw = pick(payload, 'user_entitlement_pack_list', 'userEntitlementPackList');
      if (Array.isArray(packsRaw)) {
        for (const raw of packsRaw) {
          if (!isRecord(raw)) continue;
          const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo');
          if (!isRecord(base)) continue;
          const start = firstNumber(pick(base, 'start_time', 'startTime'));
          const quota = packQuotaOf(base);
          const amounts = quota ? dimensionAmounts(quota, undefined, 'credits') : null;
          if (start === null || !amounts || amounts.limit <= 0) continue;
          records.push({ at: start * 1000, kind: 'grant', amount: amounts.limit });
        }
      }
    } catch (error) {
      ctx.log(`Trae 国际版权益包发放明细获取失败（不影响用量维度）：${(error as Error).message}`);
    }

    return { records, covers: { use: true, grant: false } };
  },

  /**
   * 「打开链接登录」：与国内版同一套 OAuth + 本地回调，只换主机。
   *
   * 回调同样必须是裸地址 `http://127.0.0.1:<port>/authorize`（授权页严格校验），
   * 因此 `qr: false`，且会话定位走「当前活跃会话」反查。
   */
  login: {
    label: '打开链接登录',
    hint: '必须在本机浏览器打开（回调固定 127.0.0.1）；完成后回到本页面。',
    qr: false,
    intervalMs: 1_000,
    async start(input) {
      const { verifier, challenge } = traePkce();
      // 与国内版共用同一套持久化设备身份逻辑，但按 provider 分文件，互不覆盖
      const identity = traeLoginDeviceIdentity('trae-global');
      const key = traeDeviceKeyFromPem(identity.privateKeyPem);
      const traceId = randomUUID();
      const machineId = identity.machineId;
      const deviceId = identity.deviceId;
      const callbackUrl = traeCallbackUrl(input.callbackBase);
      const query = new URLSearchParams({
        login_version: '1',
        auth_from: 'trae',
        login_channel: 'native_ide',
        plugin_version: GLOBAL_IDE_VERSION,
        auth_type: 'local',
        client_id: GLOBAL_CLIENT_ID,
        redirect: '0',
        login_trace_id: traceId,
        auth_callback_url: callbackUrl,
        machine_id: machineId,
        device_id: deviceId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      input.log('Trae 国际版登录链接已生成，等待浏览器回调');
      return {
        authUrl: `${GLOBAL_CONSOLE_HOST}/authorization?${query.toString()}`,
        qr: false,
        ttlMs: GLOBAL_LOGIN_TTL_MS,
        hint: '在本机浏览器完成登录后，这个窗口会自动继续。',
        secret: {
          verifier,
          privateKeyPem: key.privateKeyPem,
          publicKeyPem: key.publicKeyPem,
          consoleHost: GLOBAL_CONSOLE_HOST,
          apiHost: GLOBAL_ACCOUNT_HOST,
          deviceId,
          machineId,
          callback: null,
        },
      };
    },
    handleCallback(secret, query) {
      if (!isRecord(secret)) return false;
      const parsed = traeReadCallback(query);
      if (!parsed.authCode) return false;
      (secret as Record<string, unknown>).callback = parsed;
      return true;
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) {
        return { status: 'failed', message: '登录会话缺少 OAuth 参数，请重新发起。' };
      }
      const callback = pick(secret, 'callback');
      if (!isRecord(callback)) return { status: 'waiting' };
      const authCode = firstString(pick(callback, 'authCode'));
      if (!authCode) return { status: 'waiting' };

      const verifier = firstString(pick(secret, 'verifier'));
      const privateKeyPem = firstString(pick(secret, 'privateKeyPem'));
      if (!verifier || !privateKeyPem) {
        return { status: 'failed', message: '登录会话缺少 PKCE / 设备私钥，请重新发起。' };
      }
      const key = traeDeviceKeyFromPem(privateKeyPem);
      const consoleHost = traeHostAllowed(
        firstString(pick(callback, 'consoleHost')),
        GLOBAL_CONSOLE_HOST,
        GLOBAL_HOST_PATTERN,
      );
      const apiHost = traeHostAllowed(
        firstString(pick(callback, 'apiHost')),
        GLOBAL_ACCOUNT_HOST,
        GLOBAL_HOST_PATTERN,
      );

      // ① 授权码换令牌（不需要 DeviceProof，与国内版同形）
      let exchangeBody: unknown;
      try {
        ({ body: exchangeBody } = await fetchJson(`${apiHost}${GLOBAL_EXCHANGE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
          body: JSON.stringify({
            ClientID: GLOBAL_CLIENT_ID,
            AuthCode: authCode,
            CodeVerifier: verifier,
            DeviceInfo: traeDeviceInfo(
              {
                provider: 'trae-global',
                enabled: true,
                displayName: null,
                credentials: {},
                options: {
                  deviceId: firstString(pick(secret, 'deviceId')),
                  machineId: firstString(pick(secret, 'machineId')),
                },
              },
              key,
            ),
            IDEVersion: GLOBAL_IDE_VERSION,
          }),
          timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
        }));
      } catch (error) {
        const limited = traeDeviceLimitMessage(error, 'Trae 国际版');
        if (limited) return { status: 'failed', message: limited };
        throw error;
      }
      const result = isRecord(exchangeBody) ? pick(exchangeBody, 'Result', 'result') : undefined;
      if (!isRecord(result)) return { status: 'failed', message: 'ExchangeToken 响应缺少 Result，请重试。' };
      const accessToken = firstString(pick(result, 'Token', 'token'));
      const refreshToken = firstString(pick(result, 'RefreshToken', 'refreshToken'));
      if (!accessToken) return { status: 'failed', message: 'ExchangeToken 未返回 Token，请重试。' };

      // ② 取用户身份：优先回调带的 userInfo / userJwt，省一次请求
      let user: { id: string; name: string } = { id: '', name: '' };
      for (const raw of [firstString(pick(callback, 'userInfo')), firstString(pick(callback, 'userJwt'))]) {
        if (!raw || user.id) continue;
        try {
          const parsed = JSON.parse(raw);
          if (isRecord(parsed)) {
            user = {
              id: firstString(pick(parsed, 'UserID', 'userId', 'uid', 'ID')),
              name: firstString(pick(parsed, 'ScreenName', 'screenName', 'UserName', 'userName')),
            };
          }
        } catch {
          // 不是 JSON：忽略，继续尝试下一个 / 走 GetUserInfo
        }
      }
      if (!user.id) {
        try {
          const { body: infoBody } = await fetchJson(`${apiHost}${GLOBAL_USER_INFO_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cloudide-token': accessToken },
            body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: GLOBAL_IDE_VERSION, IfWebPage: true }),
            timeoutMs: ctx.timeoutMs || GLOBAL_TIMEOUT_FALLBACK,
          });
          // 国际版网关有两种返回形态：`Result.Data.UserInfo` 或 `Result` 本身即用户对象
          const infoResult = isRecord(infoBody) ? pick(infoBody, 'Result', 'result') : undefined;
          const infoData = isRecord(infoResult) ? pick(infoResult, 'Data', 'data') : undefined;
          const info = isRecord(infoData)
            ? (pick(infoData, 'UserInfo', 'userInfo') ?? infoData)
            : infoResult;
          if (isRecord(info)) {
            user = {
              id: firstString(pick(info, 'UserID', 'userId', 'uid', 'ID')),
              name: firstString(
                pick(info, 'ScreenName', 'screen_name', 'UserName', 'userName', 'Name'),
              ),
            };
          }
        } catch (error) {
          ctx.log(`Trae 国际版用户信息查询失败：${(error as Error).message}`);
        }
      }
      if (!user.id) {
        return {
          status: 'failed',
          message: '已拿到 Trae 国际版令牌，但上游没有返回用户 ID，无法安全落库。请重试或改用 Cookie。',
        };
      }

      return {
        status: 'ready',
        account: { id: user.id, name: user.name },
        credentials: {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          deviceKey: Buffer.from(key.privateKeyPem, 'utf8').toString('base64'),
        },
        options: {
          userId: user.id,
          consoleHost,
          apiHost,
          deviceId: firstString(pick(secret, 'deviceId')),
          machineId: firstString(pick(secret, 'machineId')),
        },
        message: '登录成功，正在验证取数并写入本机配置…',
      };
    },
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const hasCookie = Boolean(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasExplicitToken = Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization']));
    const hasLoginTokens = Boolean(cred(account, ctx, ['refreshToken', 'refresh_token']));
    if (!hasCookie && !hasExplicitToken && !hasLoginTokens) {
      return notConfigured(traeGlobalAdapter, account, ctx, [
        'cookie 或 accessToken+refreshToken+deviceKey',
      ]);
    }

    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    const payHosts = payHostsOf(account, cookie);
    const accountHosts = accountHostsOf(account, cookie);

    try {
      const token = await resolveGlobalJwt(account, ctx);
      // 订阅状态是补充信息（拿不到也照常出余额）：与用量请求并发，避免串行叠加超时
      const planPromise = fetchGlobalPlan(accountHosts, token, ctx);
      const { body, host, path } = await fetchGlobalUsageBody(payHosts, token, ctx);
      const parsed = parseGlobalUsage(body, ctx.now);
      const meta = DIMENSION_META[parsed.dimension];
      const status = await planPromise;

      const active = mergeLots(
        parsed.packs.map(
          (pack): TraePack => ({
            label: pack.label,
            limit: pack.limit,
            used: pack.used,
            remaining: pack.remaining,
            expiresAt: pack.expiresAt,
          }),
        ),
        { currency: meta.currency, idPrefix: 'trae-global' },
      );

      const round = (value: number): number => Math.round(value * 100) / 100;
      const balance = round(parsed.packs.reduce((sum, pack) => sum + pack.remaining, 0));
      const nextExpiry =
        active
          .map((lot) => lot.expiresAt)
          .filter((value): value is string => typeof value === 'string')
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const window = makeWindow({
        kind: 'billing',
        label: meta.windowLabel,
        used: round(parsed.used),
        limit: round(parsed.limit),
        remaining: balance,
        boundary: nextExpiry ? 'expiry' : 'mixed',
        expiresAt: nextExpiry,
      });

      const dimensionNote =
        parsed.dimension === 'requests'
          ? '该账户按「进阶模型请求次数」计量，单位是次数不是积分'
          : parsed.dimension === 'dollar'
            ? '该账户按美元用量计量（is_dollar_usage_billing）'
            : null;

      return buildSnapshot({
        adapter: traeGlobalAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        plan: status.plan ?? parsed.plan,
        balance: { amount: balance, currency: meta.currency },
        credits: active,
        windows: [window],
        note: joinNotes(
          `用量接口：${host.replace(/^https:\/\//, '')}${path}`,
          dimensionNote,
          status.subscriptionEndsAt && Date.parse(status.subscriptionEndsAt) > ctx.now
            ? `订阅到期：${status.subscriptionEndsAt.slice(0, 10)}`
            : null,
          // 隐藏 / 已用尽 / 未生效的包合并成一句（hiddenLotsNote 的文案是「积分包」，
          // 国际版可能按美元或次数计量，这里换成中性的「额度包」）
          parsed.hiddenCount > 0
            ? `已隐藏 ${parsed.hiddenCount} 个已用尽、过期或未生效的额度包`
            : null,
          parsed.packs.length === 0 ? '当前没有可用的额度包（可能全部用尽、过期或尚未生效）' : null,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      ctx.log(`Trae 国际版取数失败：${(error as Error).message}`);
      return failure(traeGlobalAdapter, account, ctx, statusOfGlobalError(error), (error as Error).message);
    }
  },
};
