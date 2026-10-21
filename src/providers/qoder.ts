import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot, ProviderStatus } from '../types.js';
import {
  buildSnapshot,
  cred,
  failure,
  hiddenLotsNote,
  isPlaceholderAccountName,
  joinNotes,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optBool,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
  type ProviderLogin,
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
 *
 * openapi `/api/v2/quota/usage`（令牌模式兜底）与新版网页接口改用**扁平结构**：
 *   {
 *     user_quota:   { total, used, remaining, unit },          // 套餐额度
 *     add_on_quota: { total, used, remaining },                // 赠送 / 活动额度
 *     org_resource_package: { cap, used, remaining },          // 团队共享额度
 *     dedicated_resource_packages: [                           // 模型专属资源包
 *       { id, name, total, used, remaining, unit, expires_at, available, status }
 *     ],
 *     is_quota_exceeded, total_usage_percentage, expires_at
 *   }
 * 两种结构都由 `parseQoderUsage()` 统一解析：账户级额度桶各拆一个批次，
 * `dedicated_resource_packages[]` 逐包拆批次（带各自 `expires_at`）。
 * 详见 `docs/fixes/Qoder-令牌模式批次明细缺失-修复方案.md`。
 */

const QODER_TIMEOUT_FALLBACK = 12_000;

/* ------------------------------------------------------------------ *
 * 登录（设备流）与令牌取数
 * ------------------------------------------------------------------ */

/**
 * 设备流常量（逐字取自 qodercli 1.1.63 的 `startDeviceFlow`）：
 *   authUrl = {website}/device/selectAccounts?challenge&challenge_method&nonce&machine_id&client_id
 *   poll    = GET {openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method
 *             404 = 等待；1000ms 间隔；300s 超时
 *   refresh = POST {openapi}/api/v1/deviceToken/refresh，body { refresh_token, machine_id? }
 *
 * `machine_id` 用登录时生成的随机 UUID 并写进 options——设备流只要求「稳定」，
 * 不参与业务签名，因此不必复刻 qodercli 的机器指纹派生。
 */
const QODER_LOGIN = {
  cn: {
    website: 'https://qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
  },
  global: {
    website: 'https://qoder.com',
    openapi: 'https://openapi.qoder.sh',
  },
} as const;
const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
const QODER_LOGIN_TTL_MS = 5 * 60 * 1000;
const QODER_POLL_INTERVAL_MS = 1_000;
/** 网页端登录的轮询间隔：抓 Cookie 无需打上游接口，稍慢一点也无妨 */
const QODER_WEB_POLL_INTERVAL_MS = 2_000;
/**
 * 网页端登录：页面**空闲**超过此时长且仍未检测到登录态，才主动刷新页面重新采集。
 *
 * 为什么必须等页面空闲：用户正在调试 Chrome 里填表单 / 扫码时，页面是「忙」的
 * （有请求在飞），此时刷新会重置表单、打断登录。旧实现是「等待超过 20 秒后
 * 每一轮轮询（2 秒）都刷新一次」，5 分钟 TTL 内约 140 次刷新，等于把登录页
 * 反复重置——这正是用户「登录完成后仍一直等待」的加剧因素。
 */
const QODER_WEB_RELOAD_IDLE_MS = 20_000;
/** 两次主动刷新之间的最小间隔 */
const QODER_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
/** 整个会话内最多主动刷新几次（用于「页面不再发请求」「跨标签页 SSO」这类兜底） */
const QODER_WEB_RELOAD_MAX = 2;
/** 网页端登录是人工操作（输密码 / 扫码），TTL 比扫码登录放宽一倍，避免输到一半被判超时 */
const QODER_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
/** 网页侧身份接口：登录态 200、访客态 401（实测），作为站点无关的功能性登录判据 */
const QODER_WEB_IDENTITY_PATH = '/api/v1/me';
const PKCE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function pkcePair(): { verifier: string; challenge: string } {
  const length = 43 + Math.floor(Math.random() * 86);
  const bytes = randomBytes(length);
  let verifier = '';
  for (let index = 0; index < length; index += 1) {
    verifier += PKCE_CHARS[bytes[index] % PKCE_CHARS.length];
  }
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

/** 业务面请求头：只发 Bearer + Accept（禁带 cosy-*，见 QoderBridge/docs/协议参考.md §0） */
function qoderBearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

/** openapi 响应信封：部分接口把数据包在 data 里 */
function qoderPayload(body: unknown): unknown {
  return isRecord(body) && isRecord(body.data) ? body.data : body;
}

/**
 * 账号昵称（openapi `GET /api/v1/userinfo`，纯 Bearer）。
 *
 * 设备流首次授权的响应里不一定带昵称（`user_name` 常常为空），
 * 而卡片标题需要「Qoder · <昵称>」——这是唯一权威来源。
 * 纯 best-effort：失败只记日志，不阻断取数（展示名退回原值）。
 */
async function qoderUserInfo(
  site: QoderSiteId,
  token: string,
  ctx: ProbeContext,
): Promise<{ id: string; name: string } | null> {
  try {
    const { body } = await fetchJson(`${QODER_LOGIN[site].openapi}/api/v1/userinfo`, {
      headers: qoderBearerHeaders(token),
      timeoutMs: Math.min(ctx.timeoutMs || QODER_TIMEOUT_FALLBACK, 8_000),
    });
    const payload = qoderPayload(body);
    if (!isRecord(payload)) return null;
    return {
      id: firstString(pick(payload, 'id', 'user_id', 'uid')),
      name: firstString(pick(payload, 'name', 'username', 'user_name')),
    };
  } catch (error) {
    ctx.log(`Qoder ${QODER_SITES[site].label}账号信息获取失败（不影响取数）：${(error as Error).message}`);
    return null;
  }
}

/**
 * 用设备令牌刷新：返回新 accessToken / refreshToken。
 * 新值由调用方写回 `.env`（`ctx.persistCredentials`）。
 *
 * `site` 必须是**本次实际生效站点**（调用方传入），不能在这里再取
 * `candidates[0]`——`auto` 的先选恒为国内站，但令牌可能属于国际站，
 * 跨站点刷新必然 401。
 */
async function qoderRefreshToken(
  account: AccountConfig,
  ctx: ProbeContext,
  refreshToken: string,
  site: QoderSiteId,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const machineId = optString(account, 'machineId');
  const { body } = await fetchJson(`${QODER_LOGIN[site].openapi}/api/v1/deviceToken/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      ...(machineId ? { machine_id: machineId } : {}),
    }),
    timeoutMs: ctx.timeoutMs || QODER_TIMEOUT_FALLBACK,
  });
  const payload = qoderPayload(body);
  const next = firstString(
    isRecord(payload) ? pick(payload, 'token', 'device_token', 'access_token') : undefined,
  );
  if (!next) throw new Error('刷新响应里没有 token，需重新登录');
  const nextRefresh = firstString(
    isRecord(payload) ? pick(payload, 'refresh_token', 'refreshToken') : undefined,
  );
  return { accessToken: next, refreshToken: nextRefresh || null };
}

interface QoderTokenUsage {
  used: number;
  total: number;
  remaining: number;
  /** 是否拿到批次到期（网页接口或 openapi 的 dedicated_resource_packages） */
  lots: CreditLot[];
  resetsAt: string | null;
  /** 上游额度单位（可能为空） */
  unit: string;
  /** true = 走的是 openapi 额度接口（网页用量接口不可用） */
  openapiOnly: boolean;
}

/**
 * 令牌探测第一优先：用 Bearer 直接打**网页用量接口**。
 * 能解析出 `total_quota` 就沿用现有解析（含 `quota_detail[].expires_at` 批次到期）。
 */
async function qoderTokenWebUsage(
  site: QoderSiteMeta,
  token: string,
  ctx: ProbeContext,
): Promise<QoderUsage> {
  const { body } = await fetchJson(`${site.origin}${QODER_PATHS.usage}`, {
    headers: {
      ...qoderBearerHeaders(token),
      Origin: site.origin,
      Referer: `${site.origin}/account/usage`,
      'Accept-Language': site.acceptLanguage,
    },
    timeoutMs: ctx.timeoutMs || QODER_TIMEOUT_FALLBACK,
  });
  assertBusinessOk(body);
  return parseQoderUsage(body);
}

/**
 * 令牌探测兜底：openapi `/api/v2/quota/usage`。
 *
 * 该接口是**扁平结构**（`user_quota` / `add_on_quota` / `org_resource_package` /
 * `dedicated_resource_packages[]`），由 `parseQoderUsage()` 统一解析：
 *   - 三个账户级额度桶各拆一个批次；
 *   - `dedicated_resource_packages[]` 逐包拆批次，带各自的 `expires_at`——
 *     这是令牌模式拿到「批次到期」的主要来源（此前被硬编码成空数组，见
 *     `docs/fixes/Qoder-令牌模式批次明细缺失-修复方案.md`）。
 *
 * 退化响应守卫（照 QoderBridge `fetchQuota`）：额度结构全部缺失，或
 * `isQuotaExceeded=true` 且 total/remaining 全为 0，都按异常处理而不是写 0——
 * 「从没有过额度」与「真的用完了」必须区分，后者才会显示 0。
 */
function parseQoderOpenApiQuota(body: unknown): QoderTokenUsage {
  const parsed = parseQoderUsage(body);
  return {
    used: parsed.usedCredits,
    total: parsed.totalCredits,
    remaining: parsed.remainingCredits,
    lots: parsed.lots,
    resetsAt: parsed.resetsAt,
    unit: parsed.unit,
    // 走的是 openapi 额度接口（网页用量接口不可用）
    openapiOnly: true,
  };
}

/**
 * 令牌探测失败时携带失败站点：续期必须回到**同一个站点**的 openapi，
 * `auto` 的 `candidates[0]` 恒为国内站，不能用来推断令牌属于哪个站点。
 */
class QoderTokenFailure extends Error {
  constructor(
    readonly site: QoderSiteMeta,
    readonly original: unknown,
  ) {
    super((original as Error)?.message ?? '取数失败');
  }
}

/** openapi 额度接口（登录令牌的原生业务面）——路径按站点主机组装 */
async function qoderOpenApiQuota(
  site: QoderSiteMeta,
  token: string,
  ctx: ProbeContext,
): Promise<QoderTokenUsage> {
  const { body } = await fetchJson(`${QODER_LOGIN[site.id].openapi}/api/v2/quota/usage`, {
    headers: qoderBearerHeaders(token),
    timeoutMs: ctx.timeoutMs || QODER_TIMEOUT_FALLBACK,
  });
  return parseQoderOpenApiQuota(body);
}

/**
 * 令牌模式的完整探测：先试网页接口（保留批次到期），失败退回 openapi；
 * 任一接口 401/403 时刷新一次令牌、写回 `.env`，再按同一顺序重试一次。
 *
 * 两个接口都沿站点候选链走：`auto` / `fallbackSite` 账号的令牌可能属于
 * 国际站，兜底与续期必须用同一个站点的主机（国内站 openapi 不认识国际站令牌）。
 */
async function qoderProbeWithToken(
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): Promise<ProviderSnapshot> {
  const sitePlan = resolveSitePlan(account);
  const primary = sitePlan.candidates[0];
  const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);

  /** 多站失败时挑「最可操作」的那个（401 优先于网络错误），并带上站点 */
  const pickFailure = (failures: Array<{ site: QoderSiteMeta; error: unknown }>): QoderTokenFailure => {
    const chosen = failures.find((item) => statusOfError(item.error) === pickStatus(failures.map((f) => f.error)));
    return new QoderTokenFailure((chosen ?? failures[0]).site, (chosen ?? failures[0]).error);
  };

  const attempt = async (accessToken: string): Promise<{ usage: QoderTokenUsage; site: QoderSiteMeta }> => {
    const failures: Array<{ site: QoderSiteMeta; error: unknown }> = [];
    for (const site of sitePlan.candidates) {
      try {
        const parsed = await qoderTokenWebUsage(site, accessToken, ctx);
        return {
          site,
          usage: {
            used: parsed.usedCredits,
            total: parsed.totalCredits,
            remaining: parsed.remainingCredits,
            lots: parsed.lots,
            resetsAt: parsed.resetsAt,
            unit: parsed.unit,
            openapiOnly: false,
          },
        };
      } catch (error) {
        failures.push({ site, error });
        ctx.log(`Qoder ${site.label}网页用量接口（令牌）不可用：${(error as Error).message}`);
      }
    }

    // 兜底：openapi 额度接口，同样沿候选链（站点与主机一一对应）
    for (const site of sitePlan.candidates) {
      try {
        return { site, usage: await qoderOpenApiQuota(site, accessToken, ctx) };
      } catch (error) {
        failures.push({ site, error });
        ctx.log(`Qoder ${site.label} openapi 额度接口不可用：${(error as Error).message}`);
      }
    }
    throw pickFailure(failures);
  };

  // `current` 是「本轮实际生效的令牌」：401 续期后会换成新令牌，昵称查询必须用它
  let current = token;
  let result: { usage: QoderTokenUsage; site: QoderSiteMeta };
  try {
    result = await attempt(current);
  } catch (error) {
    const failure = error instanceof QoderTokenFailure ? error : null;
    const original = failure ? failure.original : error;
    const authError =
      original instanceof HttpError && (original.status === 401 || original.status === 403);
    if (!authError || !refreshToken) throw error;
    // 续期回到令牌所属站点（auto 的首选是 cn，不能直接拿来刷新）
    const site = failure?.site ?? primary;
    ctx.log(`Qoder ${site.label}登录令牌已失效，尝试用 refreshToken 续期`);
    const refreshed = await qoderRefreshToken(account, ctx, refreshToken, site.id);
    current = refreshed.accessToken;
    if (ctx.persistCredentials) {
      const patch: Record<string, string> = { accessToken: refreshed.accessToken };
      if (refreshed.refreshToken) patch.refreshToken = refreshed.refreshToken;
      try {
        await ctx.persistCredentials(patch);
      } catch (persistError) {
        ctx.log(`Qoder 新令牌写回 .env 失败（不影响本次取数）：${(persistError as Error).message}`);
      }
    }
    result = await attempt(current);
  }

  const { usage, site } = result;
  // 与 Cookie 路径同一口径：上游偶尔返回已过去的重置时间，展示出来只会让人困惑
  const resetsAt = usage.resetsAt && Date.parse(usage.resetsAt) > ctx.now ? usage.resetsAt : null;
  const window = makeWindow({
    kind: 'billing',
    label: usage.unit ? `大模型积分（${usage.unit}）` : '大模型积分',
    used: usage.used,
    limit: usage.total,
    remaining: usage.remaining,
    boundary: resetsAt ? 'reset' : 'mixed',
    resetsAt,
  });
  const { active, expired } = splitByExpiry(usage.lots, ctx.now);
  const hasDatedLots = active.some((lot) => lot.expiresAt !== null);
  const packageLots = active.filter((lot) => lot.id.startsWith(QODER_PACKAGE_LOT_PREFIX));

  // 昵称：设备流不一定带回；仅当卡片名还是「登录账号」占位名时补查一次，改完就不再打这个接口
  const needsName =
    Boolean(ctx.persistAccountName) &&
    isPlaceholderAccountName(qoderAdapter.displayName, account.displayName ?? '');
  const userInfo = needsName ? await qoderUserInfo(site.id, current, ctx) : null;
  const displayName =
    userInfo?.name && ctx.persistAccountName
      ? await ctx
          .persistAccountName(userInfo.name)
          .catch((error: unknown) => {
            ctx.log(`Qoder 账号昵称写回失败（不影响取数）：${(error as Error).message}`);
            return null;
          })
      : null;

  return buildSnapshot({
    adapter: adapterForSite(site),
    account,
    // 本轮已解析出昵称时直接用最终展示名，避免等下一轮配置热加载才更新标题；
    // accountId 同步指向新名字，卡片上的管理操作才不会落在旧条目上
    displayName,
    accountId: displayName,
    status: 'ok',
    now: ctx.now,
    balance: { amount: usage.remaining, currency: 'CREDITS' },
    credits: active,
    windows: [window],
    note: joinNotes(
      `站点：${site.label}（${site.origin}）`,
      '登录令牌模式，逐笔用量由本地采样兜底',
      usage.openapiOnly
        ? '令牌模式仅返回账户级额度分桶（套餐 / 赠送 / 团队共享）；逐包批次明细需 Cookie 模式'
        : null,
      packageLots.length > 0
        ? `其中 ${packageLots.length} 个专属资源包来自 dedicated_resource_packages`
        : null,
      usage.openapiOnly && active.length === 0
        ? '平台未返回额度数据；未用完额度随本期重置作废'
        : null,
      hiddenLotsNote(expired),
      active.length > 0 && !hasDatedLots && resetsAt
        ? '未返回独立过期时间，未用完的积分将在本期重置时作废'
        : null,
    ),
  });
}

/** 归一化后属于「免费档」的套餐名，不展示在卡片上 */
const FREE_TIER_LABELS = new Set([
  'free',
  'free tier',
  'community',
  'community edition',
  '社区版',
  '免费',
  '免费版',
]);

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

/* ------------------------------ 站点体系 ------------------------------ */

export type QoderSiteId = 'cn' | 'global';

interface QoderSiteMeta {
  id: QoderSiteId;
  /** 站点中文名（note / 失败文案里给人看） */
  label: string;
  origin: string;
  dashboardUrl: string;
  usageUrl: string;
  /** 该站点偏好的 Accept-Language：语言会跟着站点走，国际站以英文优先 */
  acceptLanguage: string;
  /**
   * 该站点的**登录态** Cookie 名（用来把「已登录」和「只是访客」区分开）。
   *
   * 注意不能拿风控/统计 Cookie 当判据：`arms_uid`、`isg`、`acw_tc`、`cna`、`tfstk`
   * 在**未登录**的匿名上下文里也会出现（实测 `arms_uid` 3 秒内就有），
   * 只有服务端下发的会话 Cookie 才能证明登录成功。
   * 留空表示「该站点登录态 Cookie 名未确认」——此时仅靠功能性判据
   * （页面自身请求 `/api/v1/me` 得到 2xx）兜底。
   */
  loginCookieNames: string[];
}

/**
 * 站点表：origin / 面板页 / 用量页 / 语言集中在这里维护。
 * 若实测国际站的接口路径与国内站不同，只需在 QODER_PATHS 里补一处站点差异，
 * 解析逻辑（parseQoderUsage 等）不受影响。
 */
const QODER_SITES: Record<QoderSiteId, QoderSiteMeta> = {
  cn: {
    id: 'cn',
    label: '国内站',
    origin: 'https://qoder.com.cn',
    dashboardUrl: 'https://qoder.com.cn/account/usage',
    usageUrl: 'https://qoder.cn/account/usage?client=qoder&sourceType=IDE',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    // 实测（2026-10-18，Chrome 155）：登录态独有 `qoder_session_cookie`（httpOnly、secure、
    // 域 .qoder.com.cn）；匿名上下文 25 秒窗口内从未出现。`yunpk` 只出现在第三方域
    // gm.mmstat.com，永远不会进入 qoder 域的 Cookie 头，因此不作为判据。
    loginCookieNames: ['qoder_session_cookie'],
  },
  global: {
    id: 'global',
    label: '国际站',
    origin: 'https://qoder.com',
    dashboardUrl: 'https://qoder.com/account/usage',
    usageUrl: 'https://qoder.com/account/usage',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.8',
    // 待确认：国际站登录态 Cookie 名未实测。留空 → 只走功能性判据（/api/v1/me 2xx），
    // 避免用一个没验证过的名字把国际站用户永久卡在 waiting。
    loginCookieNames: [],
  },
};

const OTHER_SITE: Record<QoderSiteId, QoderSiteId> = { cn: 'global', global: 'cn' };

/** 上游接口路径（两侧站点共用；如有差异在此按站点分解） */
const QODER_PATHS = {
  usage: '/api/v2/me/usages/big_model_credits',
  plan: '/api/v1/me/userplan',
  usageHistory: '/api/v1/me/usages/big_model_credits/histories',
  quotaHistory: '/api/v1/me/quotas/big_model_credits/histories',
} as const;

export interface QoderSitePlan {
  /** 允许尝试的站点顺序，首个 = 首选（快照的 region / 链接都按首选站点写） */
  candidates: QoderSiteMeta[];
  /** 候选链由 auto 或 fallbackSite 扩展而来：生效站点可能不是首选 */
  allowFallback: boolean;
  /** true 表示 options.site === "auto"（note 里标注自动探测） */
  auto: boolean;
  /** options.site 里无法识别的取值（有值时在 note / 失败文案中提示） */
  invalidSetting: string | null;
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 从域名反推站点：qoder.com.cn / qoder.cn 属国内站，其余（含 qoder.com）按国际站 */
function siteIdFromOrigin(origin: string): QoderSiteId {
  const hostname = hostnameOf(origin);
  return /(^|\.)qoder\.com\.cn$|(^|\.)qoder\.cn$/.test(hostname) ? 'cn' : 'global';
}

/**
 * 解析账号的站点计划。规则（详见 docs/plans/平台适配器-接入Qoder国际站-开发设计方案.md §4.2）：
 *   - `options.origin` 覆盖 → 单候选（自定义域名/代理不参与站点切换），站点由域名推断；
 *   - `site: "cn" | "global"` → 单候选；`fallbackSite: true` 时追加另一站；
 *   - `site: "auto"` → 候选链 [cn, global]，首个能取到数的站点生效；
 *   - 取值非法 → 按国内站处理（与历史默认一致）并回传非法值用于提示。
 */
export function resolveSitePlan(account: AccountConfig): QoderSitePlan {
  const override = optString(account, 'origin');
  if (override) {
    const site = siteIdFromOrigin(override);
    return {
      candidates: [{ ...QODER_SITES[site], origin: override.replace(/\/+$/, '') }],
      allowFallback: false,
      auto: false,
      invalidSetting: null,
    };
  }

  const raw = (optString(account, 'site') || 'cn').toLowerCase();
  if (raw === 'auto') {
    return {
      candidates: [QODER_SITES.cn, QODER_SITES.global],
      allowFallback: true,
      auto: true,
      invalidSetting: null,
    };
  }
  if (raw === 'cn' || raw === 'global') {
    const primary = raw as QoderSiteId;
    const fallback = optBool(account, 'fallbackSite');
    return {
      candidates: fallback
        ? [QODER_SITES[primary], QODER_SITES[OTHER_SITE[primary]]]
        : [QODER_SITES[primary]],
      allowFallback: fallback,
      auto: false,
      invalidSetting: null,
    };
  }
  return {
    candidates: [QODER_SITES.cn],
    allowFallback: false,
    auto: false,
    invalidSetting: raw,
  };
}

/** 按生效站点覆盖快照里的 region / 面板页 / 用量页（与 probe 内覆盖 region 同一手法） */
function adapterForSite(site: QoderSiteMeta): ProviderAdapter {
  return {
    ...qoderAdapter,
    region: site.id,
    dashboardUrl: site.dashboardUrl,
    usageUrl: site.usageUrl,
  };
}

/** 失败状态优先级：越靠前越「可操作」，多站点都失败时据此挑选最终状态 */
const STATUS_PRIORITY: ProviderStatus[] = [
  'unauthorized',
  'forbidden',
  'rateLimited',
  'notFound',
  'unavailable',
  'error',
];

function statusOfError(error: unknown): ProviderStatus {
  // 令牌分支把真实错误包在 QoderTokenFailure 里（用于记住失败站点），先解开
  if (error instanceof QoderTokenFailure) return statusOfError(error.original);
  if (error instanceof HttpError) return error.kind;
  if (/Unauthorized/i.test((error as Error).message)) return 'unauthorized';
  return 'error';
}

function pickStatus(errors: unknown[]): ProviderStatus {
  const found = errors.map(statusOfError);
  for (const status of STATUS_PRIORITY) {
    if (found.includes(status)) return status;
  }
  return 'error';
}

/** 站点请求头：Origin / Referer / 语言都跟着站点走（国际站用 en 优先，避免被网关判定为跨区流量） */
function headersForSite(site: QoderSiteMeta, cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: site.origin,
    Referer: `${site.origin}/account/usage`,
    'Accept-Language': site.acceptLanguage,
    'x-requested-with': 'XMLHttpRequest',
  };
}

interface QoderSiteUsage {
  parsed: QoderUsage;
  plan: string;
}

/** 在指定站点取「用量 + 套餐」（套餐失败不影响余额），解析失败即抛错交给候选链 */
async function fetchUsageAtSite(
  site: QoderSiteMeta,
  cookie: string,
  ctx: ProbeContext,
  timeoutMs: number,
): Promise<QoderSiteUsage> {
  const headers = headersForSite(site, cookie);
  const usage = await fetchJson(`${site.origin}${QODER_PATHS.usage}`, { headers, timeoutMs });
  assertBusinessOk(usage.body);
  const parsed = parseQoderUsage(usage.body);

  let plan = '';
  try {
    const planResponse = await fetchJson(`${site.origin}${QODER_PATHS.plan}`, {
      headers,
      timeoutMs: Math.min(timeoutMs, 6_000),
    });
    plan = parsePlanLabel(planResponse.body);
  } catch (error) {
    ctx.log(`Qoder ${site.label}套餐信息获取失败（不影响余额）：${(error as Error).message}`);
  }
  return { parsed, plan };
}

/**
 * 在指定站点拉取「逐笔用量 / 获取明细」：
 *   - 用量：`/api/v1/me/usages/big_model_credits/histories` 逐笔（`time` + `credits`），
 *     与页面「使用记录」同源；
 *   - 获取：`/api/v1/me/quotas/big_model_credits/histories` 额度变更流水
 *     （`change_amount` + `effective_at`，如资源包激活/发放），与页面「个人资源包 / 获取」同源。
 */
async function fetchLedgerAtSite(
  site: QoderSiteMeta,
  cookie: string,
  ctx: ProbeContext,
  timeoutMs: number,
): Promise<UsageLedger> {
  const headers = headersForSite(site, cookie);

  // 时间窗：昨日 00:00（本地时区）至今；用量数据量大，按页拉取（上限 5 页 × 200）
  const startMs = startOfDay(ctx.now) - 86_400_000;
  const records: UsageRecord[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const { body } = await fetchJson(
      `${site.origin}${QODER_PATHS.usageHistory}` +
        `?page=${page}&page_size=200&start_time=${startMs}&end_time=${ctx.now}` +
        `&order_by=begin_at&order=-1`,
      { headers, timeoutMs },
    );
    assertBusinessOk(body);
    const list = isRecord(body) ? pick(body, 'data') : undefined;
    if (!Array.isArray(list) || list.length === 0) break;
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const at = toIso(pick(raw, 'time', 'begin_at', 'beginAt'));
      const amount = firstNumber(pick(raw, 'credits', 'original_credits', 'originalCredits'));
      if (!at || amount === null || amount <= 0) continue;
      records.push({ at: Date.parse(at), kind: 'use', amount });
    }
    const pageResult = isRecord(body) ? pick(body, 'page_result', 'pageResult') : undefined;
    const lastPage =
      firstNumber(isRecord(pageResult) ? pick(pageResult, 'last_page', 'lastPage') : undefined) ?? page;
    if (list.length < 200 || page >= lastPage) break;
  }

  // 获取明细：quota 变更流水（资源包激活/发放等，页面「获取」页签同源）。
  // 只取增加方向（DECREMENT/EXPIRE 之类不计），amount 用 change_amount、时间用 effective_at。
  for (let page = 1; page <= 5; page += 1) {
    const { body } = await fetchJson(
      `${site.origin}${QODER_PATHS.quotaHistory}` +
        `?page=${page}&page_size=100&start_time=${startMs}&end_time=${ctx.now}` +
        `&order_by=begin_at&order=-1`,
      { headers, timeoutMs },
    );
    assertBusinessOk(body);
    const list = isRecord(body) ? pick(body, 'quota_histories', 'quotaHistories') : undefined;
    if (!Array.isArray(list) || list.length === 0) break;
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const changeType = firstString(pick(raw, 'change_type', 'changeType'));
      if (/DECREMENT|EXPIRE/i.test(changeType)) continue;
      const at = toIso(pick(raw, 'effective_at', 'effectiveAt', 'created_at', 'createdAt'));
      const amount = firstNumber(pick(raw, 'change_amount', 'changeAmount'));
      if (!at || amount === null || amount <= 0) continue;
      records.push({ at: Date.parse(at), kind: 'grant', amount });
    }
    const pageResult = isRecord(body) ? pick(body, 'page_result', 'pageResult') : undefined;
    const lastPage =
      firstNumber(isRecord(pageResult) ? pick(pageResult, 'last_page', 'lastPage') : undefined) ?? page;
    if (list.length < 100 || page >= lastPage) break;
  }
  return { records, covers: { use: true, grant: true } };
}

/** 全站点失败的合并文案：逐站原因 + 可操作的下一步（站点不匹配 / 非法取值各给专项提示） */
function buildFailureMessage(
  sitePlan: QoderSitePlan,
  failures: Array<{ site: QoderSiteMeta; error: Error }>,
): string {
  const causes = failures.map(({ site, error }) => `${site.label}：${error.message}`);
  const shapeMismatch = failures.some(({ error }) => /缺少 total_quota/.test(error.message));
  const primary = sitePlan.candidates[0];

  let hint: string | null = null;
  if (sitePlan.invalidSetting) {
    hint =
      `options.site 取值「${sitePlan.invalidSetting}」无法识别（可用 cn / global / auto），` +
      '本次按国内站处理';
  } else if (!sitePlan.allowFallback) {
    hint = shapeMismatch
      ? '站点可能与 Cookie 不匹配：请把 options.site 改为 "auto"，' +
        `或改为 ${primary.id === 'cn' ? '"global"' : '"cn"'} 后重试`
      : '若该 Cookie 属于另一站点，可把 options.site 改为 "auto" 自动探测，或加 "fallbackSite": true 开启回退';
  }
  return joinNotes(...causes, hint) ?? '取数失败';
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
    const expiresAt = qoderExpiry(pick(raw, 'expiresAt', 'expires_at'));
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

/**
 * 是否属于「永不过期」的占位到期值。
 *
 * CN 账号的 `expires_at` 常为 `253402214400`（= 9999 年，秒）。
 * 若直接交给 `toIso()`，它会按「秒」换算——但该值同时满足 `> 1e11`，
 * 会被误当成毫秒，解析成 1978 年，随后被 `splitByExpiry()` 判成已过期批次。
 * 因此这里先把秒级的大值换算成毫秒，再统一按 9000 年封顶判占位。
 */
export function isQoderPlaceholderExpiry(raw: unknown): boolean {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw >= 1e12 ? raw : raw * 1000;
    return ms >= Date.UTC(9000, 0, 1);
  }
  const iso = toIso(raw);
  return iso !== null && Date.parse(iso) >= Date.UTC(9000, 0, 1);
}

/** 批次到期：占位值 / 缺失都归一成 null（不过期） */
function qoderExpiry(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === 0) return null;
  return isQoderPlaceholderExpiry(raw) ? null : toIso(raw);
}

interface QoderQuotaBlock {
  used: number;
  total: number;
  remaining: number;
  unit: string;
}

/**
 * 扁平结构的账户级额度桶（`user_quota` / `add_on_quota`）。
 * 与旧版 `quota_summary` 的区别只是字段名：`total|used|remaining` 对
 * `limit_value|used_value|remaining_value`。
 */
function readQuotaBlock(source: unknown): QoderQuotaBlock | null {
  if (!isRecord(source)) return null;
  const total = firstNumber(pick(source, 'total', 'cap', 'limitValue', 'limit_value'));
  const used = firstNumber(pick(source, 'used', 'usedValue', 'used_value'));
  const explicitRemaining = firstNumber(
    pick(source, 'remaining', 'remainingValue', 'remaining_value'),
  );
  if (total === null && used === null && explicitRemaining === null) return null;
  const limit = Math.max(0, total ?? (used ?? 0) + (explicitRemaining ?? 0));
  const consumed = Math.max(0, used ?? Math.max(0, limit - (explicitRemaining ?? 0)));
  return {
    used: consumed,
    total: limit,
    remaining: Math.max(0, explicitRemaining ?? limit - consumed),
    unit: firstString(pick(source, 'unit')),
  };
}

/**
 * 团队共享额度：两种报文形态都要认——
 *   - 旧版网页报文：`sharedQuota.quotaSummary.{usedValue,limitValue,remainingValue}`
 *   - 扁平报文：`org_resource_package.{cap,used,remaining}` / `shared_quota`
 */
function readSharedBlock(body: unknown): QoderQuotaBlock | null {
  const legacy = readSummary(pick(body, 'sharedQuota', 'shared_quota'));
  if (legacy) return legacy;
  return readQuotaBlock(pick(body, 'orgResourcePackage', 'org_resource_package'));
}

const DEDICATED_INACTIVE_STATUS = /EXPIRED|INVALID|INACTIVE|DISABLED|CANCELLED?/i;
/** 专属资源包批次 id 前缀：令牌模式 note 据此统计「真正的逐包批次」 */
const QODER_PACKAGE_LOT_PREFIX = 'qoder-pkg-';

/**
 * 专属资源包的展示名：网页优先取 `display_labels` 里维度为 `title` 的项
 * （带 `value_i18n` 时按语言取值），其次 `name` / `description`。
 */
function dedicatedPackageLabel(item: Record<string, unknown>): string {
  const labels = pick(item, 'displayLabels', 'display_labels');
  if (Array.isArray(labels)) {
    const title = labels.find(
      (entry) => isRecord(entry) && firstString(pick(entry, 'dimension')).toLowerCase() === 'title',
    );
    if (isRecord(title)) {
      const i18n = pick(title, 'valueI18n', 'value_i18n');
      const localized = isRecord(i18n)
        ? firstString(pick(i18n, 'zh-CN', 'zh_CN', 'zh', 'en', 'en-US'))
        : '';
      const label = localized || firstString(pick(title, 'value'));
      if (label) return label;
    }
  }
  return firstString(pick(item, 'name'), pick(item, 'description')) || '专属资源包';
}

/**
 * 把 `dedicated_resource_packages[]` 拆成批次。
 *
 * 字段契约（qodercli 1.1.63 内嵌 schema / QoderBridge 协议参考）：
 *   `id / name / description / total / used / remaining / unit / expires_at /
 *    available / status / model_families / model_keys`
 *
 * 该数组按上游注释「excluded from total_remaining」，即**不参与**账户级额度汇总，
 * 但每个包自身带剩余与到期时间——正是「最快到期」需要的粒度。
 */
function readDedicatedPackages(body: unknown): CreditLot[] {
  const raw = pick(body, 'dedicatedResourcePackages', 'dedicated_resource_packages');
  if (!Array.isArray(raw)) return [];

  const lots: CreditLot[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    // 与 qodercli 的 Kg() 同口径：remaining 缺失时用 total - used 兜底
    const total = firstNumber(pick(item, 'total', 'limit', 'limit_value', 'limitValue')) ?? 0;
    const used = firstNumber(pick(item, 'used', 'used_value', 'usedValue')) ?? 0;
    const remaining =
      firstNumber(pick(item, 'remaining', 'remainingValue', 'remaining_value')) ??
      Math.max(0, total - used);
    if (remaining <= 0) continue;
    if (pick(item, 'available') === false) continue;
    const status = firstString(pick(item, 'status'));
    if (status && DEDICATED_INACTIVE_STATUS.test(status)) continue;

    const expiresAt = qoderExpiry(pick(item, 'expiresAt', 'expires_at'));
    const id = firstString(pick(item, 'id')) || `pkg-${index}`;
    const label = dedicatedPackageLabel(item);
    // 包总量与剩余都给出来，否则「剩 200」无法判断是刚发还是快用完
    const amountNote = total > 0 ? `共 ${total} ${firstString(pick(item, 'unit')) || 'CREDITS'}` : '';
    lots.push(
      makeLot({
        id: `${QODER_PACKAGE_LOT_PREFIX}${id}`,
        label,
        amount: remaining,
        currency: 'CREDITS',
        expiresAt,
        note: joinNotes(amountNote, expiresAt ? null : '无独立过期时间，随本期重置作废') ?? '',
      }),
    );
  }
  return lots;
}

export function parseQoderUsage(body: unknown): QoderUsage {
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(payload)) throw new Error('响应结构无法识别，Cookie 可能已失效或站点选择错误');

  // 旧版网页报文：total_quota.{quota_summary,quota_detail[]}
  const container = pick(payload, 'totalQuota', 'total_quota');
  const legacyTotal = readSummary(container);
  /**
   * 逐包明细的兜底容器（Cookie 模式的网页报文）。
   *
   * 网页 AddOnCredits / DedicatedResourcePackages 消费的都是
   * `{ quota_summary, quota_detail[] }`，容器键可能是
   * `resource_package_quota`（赠送/购买包）或 `dedicated_resource_package_quota`
   * （模型专属包），不一定挂在 `total_quota` 下。
   * 仅在 `total_quota.quota_detail[]` 为空时启用，避免同一笔额度算两次。
   */
  const detailContainer =
    parseQuotaDetail(container).length === 0
      ? pick(
          payload,
          'resourcePackageQuota',
          'resource_package_quota',
          'dedicatedResourcePackageQuota',
          'dedicated_resource_package_quota',
        )
      : undefined;
  const detailSummary = readSummary(detailContainer);

  // 新版扁平报文（openapi /api/v2/quota/usage 与新版网页接口）：
  // user_quota / add_on_quota / org_resource_package / dedicated_resource_packages[]
  const userBlock = readQuotaBlock(pick(payload, 'userQuota', 'user_quota'));
  const addOnBlock = readQuotaBlock(pick(payload, 'addOnQuota', 'add_on_quota'));
  const shared = readSharedBlock(payload);
  const dedicatedLots = readDedicatedPackages(payload);

  /**
   * 只在「既没有 total_quota 也没有任何账户级分桶」时，才把兜底容器的
   * `quota_summary` 当汇总——否则它会与 `total_quota.quota_summary` 重复计数。
   */
  const summaryFallback = !legacyTotal && !userBlock && !addOnBlock && !shared ? detailSummary : null;

  if (
    !legacyTotal &&
    !summaryFallback &&
    !userBlock &&
    !addOnBlock &&
    !shared &&
    dedicatedLots.length === 0
  ) {
    // 保留 `缺少 total_quota` 子串：buildFailureMessage() 依赖它给出「站点可能不匹配」的提示
    throw new Error(
      '响应缺少 total_quota.quota_summary（也未找到 user_quota / add_on_quota），' +
        'Cookie 或令牌可能已失效、站点选择错误',
    );
  }

  // 退化响应守卫：已超额但总额度为 0 = 「从没有过额度」，不能写 0 冒充「用完了」
  // `totalUsagePercentage` 上游可能给 0~1 的小数（qodercli 同样先归一化到百分数）
  const rawPercentage = firstNumber(
    pick(payload, 'totalUsagePercentage', 'total_usage_percentage'),
  );
  const percentage =
    rawPercentage === null
      ? null
      : rawPercentage > 0 && rawPercentage <= 1
        ? rawPercentage * 100
        : rawPercentage;
  const exceeded =
    pick(payload, 'isQuotaExceeded', 'is_quota_exceeded') === true ||
    (percentage !== null && percentage >= 100);
  const blocks: QoderQuotaBlock[] = [legacyTotal, summaryFallback, userBlock, addOnBlock, shared].filter(
    (block): block is QoderQuotaBlock => block !== null,
  );
  const blockTotal = blocks.reduce((sum, block) => sum + block.total, 0);
  const blockRemaining = blocks.reduce((sum, block) => sum + block.remaining, 0);
  if (
    exceeded &&
    blockTotal === 0 &&
    blockRemaining === 0 &&
    dedicatedLots.every((lot) => lot.amount === 0)
  ) {
    throw new Error('额度接口返回「已超额但总额度为 0」的退化数据，无法采信');
  }

  const usedCredits = blocks.reduce((sum, block) => sum + block.used, 0);
  const totalCredits = blockTotal;
  const remainingCredits = blockRemaining;
  const usagePercentage = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0;
  const unit = blocks.map((block) => block.unit).find((value) => value) ?? '';

  // 重置时间优先级：旧版 nextResetAt > 账户级 expires_at（9999 占位按「不过期」忽略）
  const resetsAt =
    toIso(
      pick(payload, 'nextResetAt', 'next_reset_at', 'resetAt', 'reset_at') ??
        pick(container, 'nextResetAt', 'next_reset_at') ??
        pick(detailContainer, 'nextResetAt', 'next_reset_at'),
    ) ?? qoderExpiry(pick(payload, 'expiresAt', 'expires_at'));

  const lots = legacyTotal
    ? parseQoderLots(container, legacyTotal.unit)
    : detailSummary
      ? parseQoderLots(detailContainer, detailSummary.unit)
      : [];
  const resetNote = resetsAt ? '随本期重置作废' : '';
  const pushBlockLot = (id: string, label: string, block: QoderQuotaBlock | null): void => {
    if (!block || block.remaining <= 0) return;
    lots.push(
      makeLot({
        id,
        label,
        amount: block.remaining,
        currency: 'CREDITS',
        expiresAt: resetsAt,
        note: resetNote,
      }),
    );
  };

  // 旧结构：sharedQuota 是独立块；扁平结构的 org_resource_package 也走这里
  if (legacyTotal) {
    pushBlockLot('qoder-shared', '团队共享额度', shared);
  }
  // 扁平结构：账户级额度桶各拆一个批次，保证「批次之和 = 余额」
  // （summaryFallback 已把兜底容器当汇总，此时不能再按分桶拆）
  if (!legacyTotal && !summaryFallback) {
    pushBlockLot('qoder-plan', '套餐额度', userBlock);
    pushBlockLot('qoder-addon', '赠送/活动额度', addOnBlock);
    pushBlockLot('qoder-shared', '团队共享额度', shared);
  }
  lots.push(...dedicatedLots);

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
    const label = raw
      .replace(/^ORGANIZATION_PLAN_TIER_/i, '')
      .replace(/^PLAN_TIER_/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\bpro\s+plus\b/i, 'Pro+')
      .replace(/\b\w/g, (char) => char.toUpperCase());

    // 免费档不展示：没有套餐名本身就说明是免费，多一行反而让卡片与其它平台不一致
    if (FREE_TIER_LABELS.has(label.trim().toLowerCase())) return '';
    return label;
  }
  return '';
}

/**
 * 「网页端登录」（Qoder 第二个登录方法，`loginMethods` 的第二项）：
 * 服务端驱动本机调试 Chrome 打开 Qoder 用量页，用户在那个窗口里自己完成登录，
 * 我们只**旁听浏览器真实发出的 Cookie 请求头**（不注入、不代填、不拼 cookie jar——
 * jar 拼装会超上游 header 上限而 401，见 `src/cli/capture.ts:445-452` 的踩坑记录）。
 *
 * 抓到 Cookie 后走同一个登录会话层落库：probe 验证、去重、`.env` 槽位、备份全部复用。
 * 令牌模式拿不到逐包批次明细，Cookie 模式才能拿到——这是本方法存在的理由。
 */
const qoderWebLogin: ProviderLogin = {
  id: 'web',
  kind: 'web',
  label: '网页端登录',
  hint: '自动打开调试 Chrome 的 Qoder 用量页；你在那个窗口登录后，本页面自动完成添加。',
  qr: false,
  intervalMs: QODER_WEB_POLL_INTERVAL_MS,
  async start(input) {
    const site = input.options.site === 'global' ? 'global' : 'cn';
    const siteMeta = QODER_SITES[site];

    // ① 确保调试 Chrome 在跑（没跑就按 tools/chrome-debug.sh 同款参数拉起）
    const chrome = await ensureDebugChrome();
    input.log(
      `Qoder 调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
    );

    // ② 打开用量页并开始旁听请求头；采集器挂在 secret 里，cleanup 时释放
    const collector = await openCookieCollector({ url: siteMeta.dashboardUrl });
    input.log(`Qoder ${siteMeta.label}用量页已打开，等待登录`);

    const startedAt = Date.now();
    return {
      authUrl: siteMeta.dashboardUrl,
      qr: false,
      ttlMs: QODER_WEB_LOGIN_TTL_MS,
      hint: `请在刚打开的 Chrome 窗口里登录${siteMeta.label}（${siteMeta.origin}）；登录后本页面会自动完成添加。`,
      secret: { site, collector, startedAt, reloads: 0, lastReloadAt: 0 },
    };
  },
  async poll(secret, ctx) {
    if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少采集器参数，请重新发起。' };
    const collector = pick(secret, 'collector') as CookieCollector | undefined;
    const site = firstString(pick(secret, 'site')) === 'global' ? 'global' : 'cn';
    const startedAt = Number(pick(secret, 'startedAt')) || Date.now();
    if (!collector || typeof collector.cookieFor !== 'function') {
      return { status: 'failed', message: '登录会话缺少采集器，请重新发起。' };
    }

    const siteMeta = QODER_SITES[site];
    // 目标域清单：origin 与用量页的主机（qoder.com.cn / qoder.cn；国际站 qoder.com），
    // 采集到的 Cookie 头只要落在这些域上就算命中
    const hosts = [...new Set([hostnameOf(siteMeta.origin), hostnameOf(siteMeta.dashboardUrl)])].filter(
      Boolean,
    );
    const raw = collector.cookieFor(hosts);

    /**
     * 登录态判据：**不能**只看「抓到了 Cookie」。
     *
     * 采集修好后，未登录页面同样会带访客 Cookie 发请求（acw_tc / cna / tfstk /
     * qoder_visitor_id / arms_uid / isg 等）。若此时直接报 ready，会话层会拿这串
     * 访客 Cookie 去 probe，必然 401 → 直接判 failed，比「一直等待」更糟。
     *
     * 两条判据取「或」：
     *   ① 站点声明的登录态 Cookie 名出现（国内站：qoder_session_cookie）；
     *   ② 功能性证据：页面**自己**请求身份接口 `/api/v1/me` 拿到 2xx
     *      （实测登录态 200、匿名态 401）。站点无关，登录态 Cookie 名随上游改版时仍成立。
     */
    const names = collector.cookieNamesFor(hosts);
    const hasLoginCookie = siteMeta.loginCookieNames.some((name) => names.includes(name));
    const identityOk = collector.sawSuccessfulRequest(QODER_WEB_IDENTITY_PATH);
    const loggedIn = Boolean(raw) && (hasLoginCookie || identityOk);

    if (!loggedIn) {
      // 刷新策略：只在页面**确实空闲**时刷新，且限次 + 最小间隔。
      // 旧实现是「20 秒后每轮（2 秒）刷新」，会反复重置用户正在填写的登录页。
      const reloads = Number(pick(secret, 'reloads')) || 0;
      const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
      const now = Date.now();
      const idle = collector.idleMs();
      const idleLongEnough = idle >= QODER_WEB_RELOAD_IDLE_MS || idle === 0;
      if (
        reloads < QODER_WEB_RELOAD_MAX &&
        idleLongEnough &&
        now - lastReloadAt >= QODER_WEB_RELOAD_MIN_INTERVAL_MS
      ) {
        await collector.reload();
        if (isRecord(secret)) {
          secret.reloads = reloads + 1;
          secret.lastReloadAt = now;
        }
      }
      const waitedSec = Math.round((now - startedAt) / 1000);
      return {
        status: 'waiting',
        message: raw
          ? `已抓到 ${siteMeta.label}的页面 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
          : `正在等待你在调试 Chrome 窗口里登录（已等待 ${waitedSec} 秒）…`,
      };
    }

    const cookie = normalizeCookieHeader(raw ?? '') ?? '';
    if (!cookie) return { status: 'waiting', message: '抓到的 Cookie 头为空，继续等待页面发起新请求…' };

    // 账号身份：网页侧没有权威 uid（openapi /userinfo 要 Bearer，Cookie 拿不到），
    // 用「Cookie 指纹」做去重键：同一账号的登录态 Cookie 相对稳定，
    // 重新登录 → 指纹一致 → 更新原条目；不同账号 → 指纹不同 → 新建卡片。
    // 平台侧若有更权威的 uid 字段，只需改这一处（方案 §3.6 待确认项）。
    const accountId = createHash('sha256').update(cookie).digest('hex').slice(0, 16);
    ctx.log(`Qoder 网页端登录已抓到 Cookie（指纹 ${accountId}），开始验证落库`);

    return {
      status: 'ready',
      account: { id: accountId, name: '' },
      credentials: { cookie },
      options: { site },
      message: '已抓到登录 Cookie，正在验证取数并写入本机配置…',
    };
  },
  async cleanup(secret) {
    // 释放我们开出的标签页与 WebSocket；浏览器本体不关（用户可能还在用）
    const collector = isRecord(secret)
      ? (pick(secret, 'collector') as CookieCollector | undefined)
      : undefined;
    await collector?.close().catch(() => {});
  },
};

export const qoderAdapter: ProviderAdapter = {
  id: 'qoder',
  displayName: 'Qoder',
  // 以下三项是国内站（默认站点）的取值；探测时由 adapterForSite() 按实际生效站点覆盖
  region: 'cn',
  dashboardUrl: QODER_SITES.cn.dashboardUrl,
  usageUrl: QODER_SITES.cn.usageUrl,
  requiredCredentialKeys: ['cookie'],
  /**
   * 两种凭证形态：手工 Cookie（保留批次到期）或设备流登录令牌。
   *
   * 变量前缀按站点分开——两个站点的登录态互不通用，混用同一个变量会让后添加的
   * 账号覆盖前一个：
   *   - 国内站：`QODER_COOKIE` / `QODER_ACCESS_TOKEN` / `QODER_REFRESH_TOKEN`
   *   - 国际站：`QODER_GLOBAL_COOKIE` / `QODER_GLOBAL_ACCESS_TOKEN` /
   *     `QODER_GLOBAL_REFRESH_TOKEN`（第 N 个账号仍加 `_N` 后缀）
   */
  envNames: (options) => {
    const isGlobal = String(options.site ?? '').trim().toLowerCase() === 'global';
    if (!isGlobal) {
      return {
        cookie: 'QODER_COOKIE',
        accessToken: 'QODER_ACCESS_TOKEN',
        refreshToken: 'QODER_REFRESH_TOKEN',
      };
    }
    return {
      cookie: 'QODER_GLOBAL_COOKIE',
      accessToken: 'QODER_GLOBAL_ACCESS_TOKEN',
      refreshToken: 'QODER_GLOBAL_REFRESH_TOKEN',
    };
  },
  // accessToken 是取数必需；refreshToken 只影响续期
  isConfigured: (account) =>
    Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken),
  credentialHint:
    '登录 qoder.com.cn（国际站为 qoder.com）后，从 DevTools 的 Network 里复制任意 /api/ 请求的 Cookie 头，' +
    '填入 credentials.cookie；国际站账号请把站点选为 global（或在登录块先切到「国际站」再扫码），' +
    '也可用 npm run capture -- qoder --site global 自动抓取。' +
    '国际站的凭证写入 QODER_GLOBAL_* 变量，与国内站互不覆盖。',
  /** 站点可在看板上直接切换（见 manageFields 的 site 下拉），增删账号走通用实现 */
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '从 DevTools 的 Network 复制任意 /api/ 请求的 Cookie 头',
      hint: '站点要与 Cookie 的来源一致（qoder.com.cn 或 qoder.com）',
      multiline: true,
    },
    {
      key: 'site',
      label: '站点',
      target: 'option',
      choices: ['cn', 'global', 'auto'],
      defaultValue: 'cn',
      required: false,
      secret: false,
      hint: 'cn 国内站（默认）· global 国际站 · auto 自动探测并回退',
    },
  ],
  manageHint: 'Cookie 会先按所选站点真实验证，通过了才写入本机配置；写入前自动备份到 .run/。',
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：`/api/v1/me/usages/big_model_credits/histories` 逐笔（`time` + `credits`），
   *     与页面「使用记录」同源；
   *   - 获取：`/api/v1/me/quotas/big_model_credits/histories` 额度变更流水
   *     （`change_amount` + `effective_at`，如资源包激活/发放），与页面「个人资源包 / 获取」同源。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    // 登录令牌模式暂不接逐笔用量（明细接口只对网页会话开放），由本地采样兜底
    if (!cred(account, ctx, ['cookie', 'cookieHeader'])) return null;
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return null;
    const sitePlan = resolveSitePlan(account);
    const timeoutMs = ctx.timeoutMs || QODER_TIMEOUT_FALLBACK;

    // 明细与探测同源：沿同一候选链取数，首个能通的站点胜出（失败由编排层降级到本地采样）
    let lastError: unknown = null;
    for (const site of sitePlan.candidates) {
      try {
        return await fetchLedgerAtSite(site, cookie, ctx, timeoutMs);
      } catch (error) {
        lastError = error;
        ctx.log(`Qoder ${site.label}用量明细获取失败：${(error as Error).message}`);
      }
    }
    if (lastError) {
      ctx.log(`Qoder 用量明细全部失败，已回退本地采样：${(lastError as Error).message}`);
    }
    return null;
  },

  /**
   * 「扫码登录」：Qoder 设备流（qodercli 同款）。
   *
   * 授权页是 `{website}/device/selectAccounts?...`，手机扫码确认后，
   * 服务端用 `nonce + verifier` 轮询 `/api/v1/deviceToken/poll` 拿令牌。
   * 设备流只支持国内站（国际站主机未验证），与 `.env.example` 的说明一致。
   */
  login: {
    label: '扫码登录',
    hint: '用 Qoder 手机 App 扫码，或在浏览器里打开链接完成授权。',
    qr: true,
    intervalMs: QODER_POLL_INTERVAL_MS,
    async start(input) {
      const site = input.options.site === 'global' ? 'global' : 'cn';
      const target = QODER_LOGIN[site];
      const { verifier, challenge } = pkcePair();
      const nonce = randomUUID();
      const machineId = randomUUID();
      const query = new URLSearchParams({
        challenge,
        challenge_method: 'S256',
        nonce,
        machine_id: machineId,
        client_id: QODER_CLIENT_ID,
      });
      input.log('Qoder 设备流已创建，等待扫码授权');
      return {
        authUrl: `${target.website}/device/selectAccounts?${query.toString()}`,
        qr: true,
        ttlMs: QODER_LOGIN_TTL_MS,
        hint: '扫码后在手机上确认；本页面会自动完成添加。',
        // verifier 只留在服务端内存，绝不写日志
        secret: { nonce, verifier, site, machineId },
      };
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少设备流参数，请重新发起。' };
      const nonce = firstString(pick(secret, 'nonce'));
      const verifier = firstString(pick(secret, 'verifier'));
      const site = firstString(pick(secret, 'site')) === 'global' ? 'global' : 'cn';
      const machineId = firstString(pick(secret, 'machineId'));
      if (!nonce || !verifier) {
        return { status: 'failed', message: '登录会话缺少 nonce / verifier，请重新发起。' };
      }
      const query = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
      const url = `${QODER_LOGIN[site].openapi}/api/v1/deviceToken/poll?${query.toString()}`;

      let body: unknown;
      try {
        ({ body } = await fetchJson(url, {
          headers: { Accept: 'application/json' },
          timeoutMs: ctx.timeoutMs || QODER_TIMEOUT_FALLBACK,
        }));
      } catch (error) {
        // 404 = 用户还没确认，继续等待；其余错误交给会话层记为 failed
        if (error instanceof HttpError && error.status === 404) return { status: 'waiting' };
        throw error;
      }

      const payload = qoderPayload(body);
      const token = firstString(isRecord(payload) ? pick(payload, 'token') : undefined);
      if (!token) return { status: 'waiting' };

      const refreshToken = firstString(
        isRecord(payload) ? pick(payload, 'refresh_token', 'refreshToken') : undefined,
      );
      const userId = firstString(
        isRecord(payload) ? pick(payload, 'user_id', 'userId', 'uid') : undefined,
      );
      if (!userId) {
        return {
          status: 'failed',
          message: '已拿到设备令牌，但上游没有返回用户 ID，无法安全落库。请重试或改用 Cookie。',
        };
      }
      // 设备流响应不一定带昵称；缺了就用 userinfo 补一次（卡片标题要显示账号名）
      const userName =
        firstString(isRecord(payload) ? pick(payload, 'user_name', 'userName', 'name') : undefined) ||
        (await qoderUserInfo(site, token, ctx))?.name ||
        '';

      return {
        status: 'ready',
        account: { id: userId, name: userName },
        credentials: {
          accessToken: token,
          ...(refreshToken ? { refreshToken } : {}),
        },
        options: {
          userId,
          site,
          ...(machineId ? { machineId } : {}),
        },
        message: '登录成功，正在验证取数并写入本机配置…',
      };
    },
  },


  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    // 令牌分支：手工 Cookie 优先（保留批次到期），没有 Cookie 才走设备令牌
    if (!cookie) {
      const accessToken = cred(account, ctx, ['accessToken', 'token']);
      if (!accessToken) {
        return notConfigured(qoderAdapter, account, ctx, ['cookie 或 accessToken+refreshToken']);
      }
      try {
        return await qoderProbeWithToken(account, ctx, accessToken);
      } catch (error) {
        // 失败站点由 QoderTokenFailure 携带：国际站令牌失效时，卡片链接不能回落成国内站
        const failedSite =
          error instanceof QoderTokenFailure
            ? error.site
            : resolveSitePlan(account).candidates[0];
        return failure(
          adapterForSite(failedSite),
          account,
          ctx,
          statusOfError(error),
          (error as Error).message,
        );
      }
    }

    const sitePlan = resolveSitePlan(account);
    const primary = sitePlan.candidates[0];
    const timeoutMs = ctx.timeoutMs || QODER_TIMEOUT_FALLBACK;
    const failures: Array<{ site: QoderSiteMeta; error: Error }> = [];

    // 沿候选链串行探测：显式站点只有一条候选（除非开了 fallbackSite），auto 则是 [cn, global]。
    // 首个能取到数的站点即生效站点，region / 面板链接 / 用量链接都跟着它走。
    for (const [index, site] of sitePlan.candidates.entries()) {
      try {
        const { parsed, plan } = await fetchUsageAtSite(site, cookie, ctx, timeoutMs);

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

        const siteNote = sitePlan.auto
          ? `站点：${site.label}（${site.origin}，自动探测）`
          : `站点：${site.label}（${site.origin}）`;
        const fallbackNote =
          index > 0
            ? `已回退到${site.label}：首选${primary.label}不可用（${failures[0]?.error.message ?? '原因未知'}）`
            : null;
        const invalidNote = sitePlan.invalidSetting
          ? `options.site 取值「${sitePlan.invalidSetting}」无法识别（可用 cn / global / auto），已按国内站处理`
          : null;

        return buildSnapshot({
          adapter: adapterForSite(site),
          account,
          status: 'ok',
          now: ctx.now,
          plan: plan || null,
          balance: { amount: parsed.remainingCredits, currency: 'CREDITS' },
          credits: active,
          windows: [window],
          note: joinNotes(
            invalidNote,
            siteNote,
            fallbackNote,
            hiddenLotsNote(expired),
            datedLots === 0 && resetsAt
              ? '未返回独立过期时间，未用完的积分将在本期重置时作废'
              : null,
            parsed.resetsAt && !resetsAt ? '上游返回的重置时间早于当前时间，已忽略' : null,
          ),
        });
      } catch (error) {
        failures.push({ site, error: error as Error });
        ctx.log(
          `Qoder ${site.label}取数失败：${(error as Error).message}` +
            (sitePlan.candidates.length > 1 ? '（继续尝试下一站点）' : ''),
        );
      }
    }

    // 全部候选站点都失败：状态取最可操作的那个，文案逐站列出原因并给下一步建议
    return failure(
      adapterForSite(primary),
      account,
      ctx,
      pickStatus(failures.map((item) => item.error)),
      buildFailureMessage(sitePlan, failures),
    );
  },
};

/**
 * 登录方法清单：`login`（扫码，默认方法）+ `webLogin`（网页端抓 Cookie）。
 *
 * 声明后前端按清单渲染两个按钮，会话层按 `method` 路由；
 * `login` 仍保留在适配器上（不传 method 时走它），行为向后兼容。
 * 放在对象外组装：两个方法都引用 `qoderAdapter` 定义时的上下文，
 * 对象字面量内部无法安全自引用。
 */
qoderAdapter.loginMethods = [qoderAdapter.login, qoderWebLogin].filter(
  (method): method is ProviderLogin => Boolean(method),
);
