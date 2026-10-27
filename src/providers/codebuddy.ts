import { createHash } from 'node:crypto';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { clamp, firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages, incompleteNote } from '../lib/pagination.js';
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
  type ProviderLogin,
} from './base.js';

/**
 * CodeBuddy（国内版 www.codebuddy.cn / 国际版 codebuddy.ai，即 WorkBuddy）
 *
 * 接口是通过 npm run capture 抓包定位的（GitHub 上没有任何现成实现），已实测：
 *   ① POST {billing}/billing/meter/get-user-resource-summary
 *      → data.Packages[]: CycleTotalCapacity / CycleRemainCapacity / CycleUsedCapacity
 *        （字符串形式的数字，容量单位 capacityUnit 通常为 credits）
 *   ② POST {billing}/billing/meter/get-user-resource-free-packages
 *      → data.Accounts[]: PackageName / CycleStartTime / CycleEndTime / DeductionEndTime
 *        / CycleCapacitySize / CycleCapacityRemain（含 Precise 精确值）
 *
 * 必需请求头：Cookie（**必须包含计费域 www 子域下的会话 Cookie**）、
 *            x-client-platform: web。
 * 只发送父域 Cookie 会得到 401——这是实测踩过的坑。
 *
 * 口径：①给账户级汇总（余额取它），②给各资源包的周期与到期时间。
 * 两者粒度不同（②是包内某个子资源的周期额度），因此批次标记 basis='granted'，
 * 只用于「最快到期」，不参与汇总，避免与余额重复计算。
 *
 * 站点拆分（2026-10-25）：国内版 `codebuddy` 与国际版 `codebuddy-intl` 是两个
 * 独立平台，账号体系、登录态、`.env` 变量完全隔离（与 Qoder 国内版 / 国际版
 * 同一拆分思路）。差异收敛在 CODEBUDDY_SITES 元信息表，解析逻辑全站共用。
 */

/* ------------------------------ 站点体系 ------------------------------ */

export type CodeBuddySiteId = 'cn' | 'global';

interface CodeBuddySiteMeta {
  id: CodeBuddySiteId;
  /** 站点中文名（note / 失败文案里给人看） */
  label: string;
  /** 计费域（网页端接口 Origin / Referer / Cookie 域判定都按它） */
  billingOrigin: string;
  /** 插件后端（登录认证 + 令牌模式明细的首选主机） */
  pluginBase: string;
  /**
   * 扫码登录 `/v2/plugin/auth/state` 的 `platform` 参数。
   * 国内版桌面端当前取 `workbuddy`，国际版取 `workbuddy-ai`
   * （多个独立实现交叉验证：yetone/magpie、token-monitor、workbuddy-switch-plus 等）。
   */
  platform: string;
  /** 用量页（卡片「每日用量」跳转 + 网页端登录打开的页面） */
  usageUrl: string;
  /** 该站点偏好的 Accept-Language：国际站以英文优先 */
  acceptLanguage: string;
  /**
   * 该站点的**登录态** Cookie 名（网页端登录判据之一）。
   *
   * 留空 = 「未实测」：此时仅靠功能性判据（页面自身请求身份接口得到 2xx）兜底，
   * 避免用一个没验证过的名字把用户永久卡在 waiting（与 Qoder 国际站同一策略）。
   */
  loginCookieNames: string[];
  /** `.env` 变量名（第 N 个账号由 account-store 追加 `_N` 后缀） */
  envNames: Record<string, string>;
}

const CODEBUDDY_SITES: Record<CodeBuddySiteId, CodeBuddySiteMeta> = {
  cn: {
    id: 'cn',
    label: '国内站',
    billingOrigin: 'https://www.codebuddy.cn',
    pluginBase: 'https://copilot.tencent.com',
    platform: 'workbuddy',
    usageUrl: 'https://www.codebuddy.cn/profile/plans-usage',
    acceptLanguage: 'zh-CN',
    loginCookieNames: [],
    envNames: {
      cookie: 'CODEBUDDY_COOKIE',
      accessToken: 'CODEBUDDY_ACCESS_TOKEN',
      refreshToken: 'CODEBUDDY_REFRESH_TOKEN',
    },
  },
  global: {
    id: 'global',
    label: '国际站',
    billingOrigin: 'https://www.codebuddy.ai',
    // 国际版认证主机与国内版完全分离（多个独立实现实测一致）；
    // 若国际站后续换域名，用 CODEBUDDY_GLOBAL_PLUGIN_BASE 覆盖
    pluginBase: process.env.CODEBUDDY_GLOBAL_PLUGIN_BASE?.trim() || 'https://www.workbuddy.ai',
    platform: 'workbuddy-ai',
    usageUrl: 'https://www.codebuddy.ai/profile/plans-usage',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.8',
    loginCookieNames: [],
    envNames: {
      cookie: 'CODEBUDDY_GLOBAL_COOKIE',
      accessToken: 'CODEBUDDY_GLOBAL_ACCESS_TOKEN',
      refreshToken: 'CODEBUDDY_GLOBAL_REFRESH_TOKEN',
    },
  },
};

/** 把 URL 解析成主机名；解析失败返回空串 */
function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 登录（腾讯插件认证）与令牌取数的路径模板。
 *
 * 协议来自官方 WorkBuddy 客户端的实测行为（workbuddy2api 的 Go 实现与
 * workbuddy-manager 的 Python 实现一致）：
 *   ① POST {chat}/v2/plugin/auth/state?platform=<站点 platform> → { state, authUrl }
 *   ② GET  {chat}/v2/plugin/auth/token?state=       → { accessToken, refreshToken, expiresIn, domain }
 *   ③ GET  {chat}/v2/plugin/login/account?state=    → { uid, nickname, enterpriseId }
 *   ④ POST {chat}/v2/plugin/auth/token/refresh      → 新 accessToken（refreshToken 走 X-Refresh-Token 头）
 *   ⑤ POST {billing}/v2/billing/meter/get-user-resource → Accounts[]（余额 + 周期到期）
 *
 * 版本号集中在这里：上游改版时只需要改这两个常量或设环境变量覆盖。
 */
const CB_TIMEOUT_FALLBACK = 12_000;
const CB_LOGIN_TTL_MS = 15 * 60 * 1000;
/** 网页端登录（CDP 抓取）：与 Qoder 同一套节奏常量 */
const CB_WEB_POLL_INTERVAL_MS = 2_000;
const CB_WEB_RELOAD_IDLE_MS = 20_000;
const CB_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
const CB_WEB_RELOAD_MAX = 2;
const CB_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
/**
 * 网页端登录的功能性身份判据：页面自己请求该路径拿到 2xx 即视为已登录。
 * 待确认：国际站的身份接口路径若与国内站不同，需在站点表里按站点分解。
 */
const CB_WEB_IDENTITY_PATH = '/billing/meter/get-user-resource-summary';

function cbClientVersion(): string {
  return process.env.CODEBUDDY_CLIENT_VERSION?.trim() || '5.5.4';
}

function cbCliVersion(): string {
  return process.env.CODEBUDDY_CLI_VERSION?.trim() || '2.137.1';
}

/** chat / 登录域 UA：三段式（WorkBuddy 客户端形态） */
function cbChatUserAgent(): string {
  const override = process.env.CODEBUDDY_CLIENT_UA?.trim();
  if (override) return override;
  const version = cbClientVersion();
  return `WorkBuddy/${version} WorkBuddy/${version} CLI/${cbCliVersion()}`;
}

/** billing 域 UA：单段（官方客户端在白名单接口显式覆写成这个形态） */
function cbBillingUserAgent(): string {
  return process.env.CODEBUDDY_CLIENT_UA?.trim() || `WorkBuddy/${cbClientVersion()}`;
}

/**
 * 账号级设备指纹头（与官方客户端派生方式一致）：
 * sha256("wb2a:" + purpose + ":" + uid) 的前 36 个 hex 字符。
 * 每个账号一台固定虚拟设备，缺失会被当作「形态不像官方客户端」。
 */
function cbDeviceHeaders(uid: string): Record<string, string> {
  const value = uid.trim();
  if (!value) return {};
  const derive = (purpose: string): string =>
    createHash('sha256').update(`wb2a:${purpose}:${value}`).digest('hex').slice(0, 36);
  return {
    'X-Machine-ID': derive('machine'),
    'X-Session-ID': derive('session'),
  };
}

/** 登录 / 刷新接口的通用头（Origin / Referer / Accept-Language 跟着站点走） */
function cbPluginHeaders(site: CodeBuddySiteMeta, token = '', uid = ''): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': site.acceptLanguage,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'User-Agent': cbChatUserAgent(),
    Origin: site.billingOrigin,
    Referer: `${site.billingOrigin}/`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...cbDeviceHeaders(uid),
  };
}

/** billing 域头：在通用头之上补身份字段与单段 UA */
function cbBillingHeaders(
  site: CodeBuddySiteMeta,
  token: string,
  identity: { uid?: string; enterpriseId?: string; domain?: string },
): Record<string, string> {
  const headers = cbPluginHeaders(site, token, identity.uid ?? '');
  headers['User-Agent'] = cbBillingUserAgent();
  if (identity.uid) headers['X-User-Id'] = identity.uid;
  if (identity.enterpriseId) {
    headers['X-Enterprise-Id'] = identity.enterpriseId;
    headers['X-Tenant-Id'] = identity.enterpriseId;
  }
  if (identity.domain) headers['X-Domain'] = identity.domain;
  return headers;
}

/** 本机时区墙钟 `YYYY-MM-DD HH:mm:ss`（billing 的时间窗参数照抄官方客户端，用本机时区） */
function cbLocalStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 腾讯统一信封：{ code, msg, data }；HTTP 4xx 也可能带业务信封 */
function cbEnvelope(body: unknown): { code: number; data: unknown } {
  if (isRecord(body) && body.code !== undefined) {
    return { code: Number(body.code), data: pick(body, 'data') };
  }
  return { code: 0, data: body };
}

/**
 * 登录态失效：HTTP 401/403，或业务码 12153（session dead） / 10085（令牌失效，
 * 见 buddyToken 实测），以及 "Unauthorized" 这类文案。
 */
function cbIsAuthError(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  return /12153|10085|session dead|unauthorized|登录态|未登录/i.test((error as Error).message ?? '');
}

/** 账号级身份字段（uid / enterpriseId / domain），令牌模式的各接口共用 */
function cbIdentity(account: AccountConfig): {
  uid?: string;
  enterpriseId?: string;
  domain?: string;
} {
  const uid = optString(account, 'uid');
  const enterpriseId = optString(account, 'enterpriseId');
  const domain = optString(account, 'domain');
  return {
    ...(uid ? { uid } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(domain ? { domain } : {}),
  };
}

/**
 * 网页域（billingOrigin）的令牌头：Bearer + 身份头 + X-Client-Platform。
 *
 * 形态对齐 buddyToken 的实测实现（`workbuddy-api.js` 的 authHeaders）：
 * 网页域这组接口既接受会话 Cookie，也接受插件签发的 Bearer 令牌。
 */
function cbWebTokenHeaders(
  site: CodeBuddySiteMeta,
  account: AccountConfig,
  token: string,
): Record<string, string> {
  const { uid, enterpriseId, domain } = cbIdentity(account);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Platform': 'web',
    Origin: site.billingOrigin,
    Referer: `${site.billingOrigin}/profile/plans-usage`,
  };
  if (uid) headers['X-User-Id'] = uid;
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId;
    headers['X-Tenant-Id'] = enterpriseId;
  }
  if (domain) headers['X-Domain'] = domain;
  return headers;
}

/**
 * 套餐到期时间：腾讯给的是 **UTC+8 墙钟**，与容器时区无关。
 * 必须显式按 +08:00 解析，否则在西半球 / UTC 机器上会整体偏移数小时。
 */
function cbParseUtc8(value: unknown): string | null {
  if (typeof value !== 'string') return toIso(value);
  const raw = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return toIso(raw);
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s));
  return new Date(ms).toISOString();
}

/**
 * 从 `get-user-resource` 的响应里挖出 Accounts[]。
 *
 * 两种信封都要兼容：网页域是 `data.Accounts`，插件后端是
 * `data.Response.Data.Accounts`（buddyToken 实测的嵌套形态）。
 */
function cbExtractTokenAccounts(body: unknown): unknown[] | null {
  let current: unknown = cbEnvelope(body).data;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!isRecord(current)) break;
    const direct = pick(current, 'Accounts', 'accounts');
    if (Array.isArray(direct)) return direct;
    const nested = pick(current, 'Response', 'Data', 'data', 'response');
    if (!isRecord(nested) && !Array.isArray(nested)) break;
    current = nested;
  }
  return null;
}

interface CbTokenPack {
  label: string;
  size: number;
  remain: number;
  expiresAt: string | null;
}

/**
 * 解析 `get-user-resource` 的 Accounts[]（令牌模式的余额来源）。
 *
 * 剩余口径与官方客户端逐条对齐：
 *   - 有周期额度（CycleCapacitySize > 0）时只看 Cycle 三字段：
 *     remain 先钳进 [0, size]，再用 CycleCapacityUsed 反修正；
 *   - 没有周期额度时回退 CapacityRemain。
 * 钳位不是洁癖：上游偶发 remain > size 的脏数据，只钳负值会高估余额。
 */
export function parseCodeBuddyTokenPacks(body: unknown): CbTokenPack[] {
  const accounts = cbExtractTokenAccounts(body);
  if (!accounts) {
    throw new Error('响应缺少 Accounts（登录令牌可能已失效）');
  }

  const packs: CbTokenPack[] = [];
  for (const raw of accounts) {
    if (!isRecord(raw)) continue;
    const cycleSize = firstNumber(pick(raw, 'CycleCapacitySize')) ?? 0;
    const capacitySize = firstNumber(pick(raw, 'CapacitySize')) ?? 0;
    const size = cycleSize > 0 ? cycleSize : capacitySize;
    let remain: number;
    if (cycleSize > 0) {
      remain = clamp(firstNumber(pick(raw, 'CycleCapacityRemain')) ?? 0, 0, cycleSize);
      const used = cycleSize - remain;
      const cycleUsed = firstNumber(pick(raw, 'CycleCapacityUsed')) ?? 0;
      if (cycleUsed > used) {
        remain = cycleSize >= cycleUsed ? cycleSize - cycleUsed : 0;
      }
    } else {
      remain = Math.max(0, firstNumber(pick(raw, 'CapacityRemain')) ?? 0);
    }
    if (size <= 0 && remain <= 0) continue;
    packs.push({
      label:
        firstString(pick(raw, 'SubProductName', 'subProductName')) ||
        firstString(pick(raw, 'PackageName', 'packageName')) ||
        '资源包',
      size,
      remain: Math.round(remain * 100) / 100,
      expiresAt: cbParseUtc8(pick(raw, 'CycleEndTime', 'cycleEndTime')),
    });
  }
  if (packs.length === 0) throw new Error('Accounts 为空，没有可统计的资源包');
  return packs;
}

/** 用 refreshToken 换新令牌；新值由调用方写回 `.env` */
async function cbRefreshToken(
  site: CodeBuddySiteMeta,
  account: AccountConfig,
  ctx: ProbeContext,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const accessToken = cred(account, ctx, ['accessToken', 'token']);
  const uid = optString(account, 'uid');
  const headers = cbPluginHeaders(site, accessToken, uid);
  headers['X-Refresh-Token'] = refreshToken;
  headers['X-Auth-Refresh-Source'] = 'plugin';
  const enterpriseId = optString(account, 'enterpriseId');
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId;
  if (uid) headers['X-User-Id'] = uid;

  const { body } = await fetchJson(`${site.pluginBase}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers,
    timeoutMs: ctx.timeoutMs || CB_TIMEOUT_FALLBACK,
  });
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const next = firstString(isRecord(payload) ? pick(payload, 'accessToken', 'access_token') : undefined);
  if (!next) throw new Error('刷新响应里没有 accessToken，需重新扫码或登录');
  const nextRefresh = firstString(
    isRecord(payload) ? pick(payload, 'refreshToken', 'refresh_token') : undefined,
  );
  return { accessToken: next, refreshToken: nextRefresh || null };
}

/**
 * 令牌模式取数：`get-user-resource` 返回套餐列表（含余额与周期到期）。
 *
 * 时间窗参数照抄官方客户端：本机时区格式化、从「现在」到 101 年后。
 * 这个窗口只是粗过滤（真实到期时间离边界有 101 年余量），
 * 与下面「按 UTC+8 解析到期时刻」的口径不同是**有意为之**——
 * 前者对齐上游请求形态，后者要对账展示，不能互相统一。
 */
async function cbFetchTokenPacks(
  site: CodeBuddySiteMeta,
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): Promise<CbTokenPack[]> {
  const now = ctx.now;
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: cbLocalStamp(now),
    PackageEndTimeRangeEnd: cbLocalStamp(now + 101 * 365 * 86_400_000),
  });
  const { body: responseBody } = await fetchJson(
    optString(account, 'billingEndpoint') || `${site.billingOrigin}/v2/billing/meter/get-user-resource`,
    {
      method: 'POST',
      headers: cbBillingHeaders(site, token, {
        uid: optString(account, 'uid'),
        enterpriseId: optString(account, 'enterpriseId'),
        domain: optString(account, 'domain'),
      }),
      body,
      timeoutMs: ctx.timeoutMs || CB_TIMEOUT_FALLBACK,
    },
  );
  const { code } = cbEnvelope(responseBody);
  if (code !== 0) throw new Error(`上游返回业务错误 code=${code}`);
  // 传完整响应体：cbExtractTokenAccounts 自己会解信封，兼容网页域与插件后端两种嵌套
  return parseCodeBuddyTokenPacks(responseBody);
}

/**
 * 本轮刷新结果（按账号对象缓存，`WeakMap` 不阻止回收）。
 *
 * 同一轮取数里 `probe()` 与 `fetchUsageLedger()` 是两个独立调用：若各自刷新，
 * 第二个调用仍可能拿着已轮换的旧 refreshToken 再刷一次，把刚写入的新令牌刷废。
 * 这里让第二个调用直接复用第一次刷新出的 accessToken。
 * 配置热加载会重建 account 对象，缓存随之自然失效。
 */
const cbRefreshCache = new WeakMap<AccountConfig, { accessToken: string }>();

/**
 * 令牌调用包装：先试当前令牌，登录态失效则用 refreshToken 续期一次并重试。
 *
 * 刷新结果写回 `.env`（`ctx.persistCredentials` 缺失时只用于本次请求）；
 * 写回失败不阻断取数，只是下次刷新会再试。
 */
async function cbWithToken<T>(
  site: CodeBuddySiteMeta,
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
  run: (accessToken: string) => Promise<T>,
): Promise<T> {
  const cached = cbRefreshCache.get(account)?.accessToken || token;
  try {
    return await run(cached);
  } catch (error) {
    if (!cbIsAuthError(error)) throw error;
    const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);
    if (!refreshToken) throw error;

    ctx.log(`${adapter.displayName} 登录令牌已失效，尝试用 refreshToken 续期`);
    const refreshed = await cbRefreshToken(site, account, ctx, refreshToken);
    cbRefreshCache.set(account, { accessToken: refreshed.accessToken });
    if (ctx.persistCredentials) {
      const patch: Record<string, string> = { accessToken: refreshed.accessToken };
      if (refreshed.refreshToken) patch.refreshToken = refreshed.refreshToken;
      try {
        await ctx.persistCredentials(patch);
      } catch (persistError) {
        ctx.log(
          `${adapter.displayName} 新令牌写回 .env 失败（不影响本次取数）：${(persistError as Error).message}`,
        );
      }
    }
    return run(refreshed.accessToken);
  }
}

/**
 * 令牌模式的完整探测：失效时刷新一次并写回 `.env`，再重试一次。
 * 刷新写回失败不阻断本次取数（只是下次刷新会再试）。
 */
async function cbProbeWithToken(
  site: CodeBuddySiteMeta,
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): Promise<ProviderSnapshot> {
  const packs = await cbWithToken(site, adapter, account, ctx, token, (accessToken) =>
    cbFetchTokenPacks(site, account, ctx, accessToken),
  );

  const limit = Math.round(packs.reduce((sum, pack) => sum + Math.max(0, pack.size), 0) * 100) / 100;
  const remaining = Math.round(packs.reduce((sum, pack) => sum + Math.max(0, pack.remain), 0) * 100) / 100;
  const used = Math.max(0, Math.round((limit - remaining) * 100) / 100);

  const lots: CreditLot[] = packs
    .filter((pack) => pack.remain > 0)
    .map((pack, index) =>
      makeLot({
        id: `cb-token-pack-${index}`,
        label: pack.label,
        amount: pack.remain,
        currency: 'CREDITS',
        expiresAt: pack.expiresAt,
        note: pack.size > 0 ? `本周期额度 ${pack.size}` : '',
      }),
    );
  const { active, expired } = splitByExpiry(lots, ctx.now);
  const earliest =
    active
      .map((lot) => lot.expiresAt)
      .filter((value): value is string => typeof value === 'string')
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

  const window = makeWindow({
    kind: 'billing',
    label: `积分额度（${packs.length} 个资源包）`,
    used,
    limit,
    remaining,
    boundary: earliest ? 'expiry' : 'reset',
    expiresAt: earliest,
  });

  return buildSnapshot({
    adapter,
    account,
    status: 'ok',
    now: ctx.now,
    balance: { amount: remaining, currency: 'CREDITS' },
    credits: active,
    windows: [window],
    note: joinNotes(
      '登录令牌模式，用量/获取明细取自同一令牌的网页域接口',
      hiddenLotsNote(expired),
      active.length > 0 && active.some((lot) => lot.expiresAt)
        ? null
        : '上游未返回套餐周期结束时间，无法给出批次到期日',
    ),
    fallbackExpiryFromWindow: false,
  });
}

/**
 * 资源包列表 → 「获取」记录：每个包的当前周期发放时间（CycleStartTime）
 * 与周期额度（CycleCapacitySizePrecise），即页面资源包列表里的发放口径。
 *
 * 兼容两种信封：网页域 `data.Accounts` 与插件后端 `data.Response.Data.Accounts`。
 */
function parsePackageGrants(body: unknown): UsageRecord[] {
  const accounts = cbExtractTokenAccounts(body);
  if (!accounts) return [];
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

/**
 * 令牌模式的逐笔用量：从「昨日 00:00:00」到「今日 23:59:59」（本机时区）。
 *
 * 令牌走网页域接口时既接受 Cookie 也接受 Bearer（buddyToken 实测），
 * 插件后端（copilot.tencent.com）同样提供该路径（workbuddy2api 实测）。
 * 先用插件后端——它与余额接口同主机、身份头齐全；若判定为鉴权失败或该主机
 * 没有这个路径（404/405），再按网页域形态试一次。
 */
async function cbTokenRequestUsage(
  site: CodeBuddySiteMeta,
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): Promise<UsageRecord[]> {
  const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;
  const startDay = localDateKey(startOfDay(ctx.now) - 86_400_000);
  const endDay = localDateKey(ctx.now);
  const pageSize = 500;
  const tokenHeaders = cbWebTokenHeaders(site, account, token);

  const fetchPages = async (base: string): Promise<UsageRecord[]> => {
    const url = `${base}/billing/meter/get-user-request-usage`;
    const result = await fetchAllPages<UsageRecord>({
      pageSize,
      maxPages: 10,
      label: `${site.label} 令牌模式用量明细`,
      fetchPage: async (pageNum) => {
        const { body } = await fetchJson(url, {
          method: 'POST',
          headers: tokenHeaders,
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
        const list = isRecord(data) ? pick(data, 'data', 'Data') : undefined;
        const total = isRecord(data) ? firstNumber(pick(data, 'total', 'totalCount')) : null;
        const items: UsageRecord[] = [];
        if (Array.isArray(list)) {
          for (const raw of list) {
            if (!isRecord(raw)) continue;
            const at = toIso(pick(raw, 'requestTime', 'request_time'));
            const amount = firstNumber(pick(raw, 'credit', 'credits'));
            if (!at || amount === null || amount <= 0) continue;
            items.push({ at: Date.parse(at), kind: 'use', amount });
          }
        }
        return { items, total };
      },
    });
    if (!result.complete) {
      // 未取全就不能当作「该日用量已覆盖」——由调用方把 use 维度退回本地采样
      throw new Error(`用量明细分页未取全（${incompleteNote(result)}）`);
    }
    return result.items;
  };

  try {
    return await fetchPages(site.pluginBase);
  } catch (error) {
    const missingPath = error instanceof HttpError && (error.status === 404 || error.status === 405);
    if (!cbIsAuthError(error) && !missingPath) throw error;
    ctx.log('插件后端用量明细不可用，改试网页域形态');
    return fetchPages(site.billingOrigin);
  }
}

/**
 * 令牌模式的用量 + 获取明细（Cookie 模式的对称实现）。
 *
 * 口径与 Cookie 模式一致：
 *   - 用量：`get-user-request-usage` 逐笔，覆盖 `use`；
 *   - 获取：资源包当前周期发放（与探针同一 `get-user-resource`）+ 礼包；
 *     任一来源失败即整体放弃 `grant` 覆盖，避免「只统计一半还标 upstream」。
 */
async function cbTokenLedger(
  site: CodeBuddySiteMeta,
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): Promise<UsageLedger> {
  return cbWithToken(site, adapter, account, ctx, token, async (accessToken) => {
    const records = await cbTokenRequestUsage(site, account, ctx, accessToken);

    // 资源包发放：与 probe 的令牌模式同一接口、同一时间窗
    let grantCovered = true;
    try {
      const response = await fetchJson(
        optString(account, 'billingEndpoint') || `${site.billingOrigin}/v2/billing/meter/get-user-resource`,
        {
          method: 'POST',
          headers: cbBillingHeaders(site, accessToken, cbIdentity(account)),
          body: JSON.stringify({
            PageNumber: 1,
            PageSize: 100,
            ProductCode: 'p_tcaca',
            Status: [0, 3],
            PackageEndTimeRangeBegin: cbLocalStamp(ctx.now),
            PackageEndTimeRangeEnd: cbLocalStamp(ctx.now + 101 * 365 * 86_400_000),
          }),
          timeoutMs: ctx.timeoutMs || CB_TIMEOUT_FALLBACK,
        },
      );
      const { code } = cbEnvelope(response.body);
      if (code !== 0) throw new Error(`上游返回业务错误 code=${code}`);
      records.push(...parsePackageGrants(response.body));
    } catch (error) {
      grantCovered = false;
      ctx.log(`${adapter.displayName} 令牌模式资源包发放明细获取失败（退回本地采样）：${(error as Error).message}`);
    }

    // 礼包只对网页会话开放：令牌被拒时同样只放弃 grant 覆盖
    try {
      const { body } = await fetchJson(`${site.billingOrigin}/billing/meter/check-gift-claimed`, {
        method: 'POST',
        headers: cbWebTokenHeaders(site, account, accessToken),
        body: '{}',
        timeoutMs: ctx.timeoutMs || CB_TIMEOUT_FALLBACK,
      });
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
      ctx.log(`${adapter.displayName} 令牌模式礼包明细获取失败（退回本地采样）：${(error as Error).message}`);
    }

    return { records, covers: { use: true, grant: grantCovered } };
  });
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

/**
 * 「扫码登录」（腾讯插件认证，默认方法）：站点差异收敛在 CODEBUDDY_SITES。
 *
 * 流程：申请 state + authUrl → 用户在浏览器/手机授权 → 轮询 token 接口拿令牌
 * → 用令牌查账号信息（uid / nickname）→ 返回给会话层落库。
 * 二维码由前端本地渲染 authUrl，不经过任何第三方服务。
 */
function makeCodeBuddyScanLogin(site: CodeBuddySiteMeta): ProviderLogin {
  return {
    label: '扫码登录',
    hint:
      site.id === 'cn'
        ? '用手机 CodeBuddy / 微信扫码，或在新窗口打开链接完成授权。'
        : '用手机 WorkBuddy / 微信扫码，或在新窗口打开链接完成授权。',
    qr: true,
    intervalMs: 2_000,
    async start(input) {
      const { body } = await fetchJson(
        `${site.pluginBase}/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`,
        {
          method: 'POST',
          headers: cbPluginHeaders(site),
          body: '{}',
          timeoutMs: input.timeoutMs || CB_TIMEOUT_FALLBACK,
        },
      );
      const { code, data } = cbEnvelope(body);
      if (code !== 0 || !isRecord(data)) {
        throw new Error(`申请授权链接失败（code=${code}）`);
      }
      const state = firstString(pick(data, 'state'));
      const authUrl = firstString(pick(data, 'authUrl', 'auth_url'));
      if (!state || !authUrl) throw new Error('授权接口没有返回 state / authUrl');
      return {
        authUrl,
        qr: true,
        ttlMs: CB_LOGIN_TTL_MS,
        hint: '扫码后在手机上确认授权；本页面会自动完成添加。',
        secret: { state },
      };
    },
    async poll(secret, ctx) {
      const state = firstString(isRecord(secret) ? pick(secret, 'state') : undefined);
      if (!state) return { status: 'failed', message: '登录会话缺少 state，请重新发起。' };
      const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;

      let tokenData: Record<string, unknown> | null = null;
      try {
        const { body } = await fetchJson(
          `${site.pluginBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
          { headers: cbPluginHeaders(site), timeoutMs },
        );
        const { code, data } = cbEnvelope(body);
        if (code === 0 && isRecord(data) && firstString(pick(data, 'accessToken', 'access_token'))) {
          tokenData = data;
        }
      } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 400)) {
          return { status: 'waiting' };
        }
        throw error;
      }
      if (!tokenData) return { status: 'waiting' };

      const accessToken = firstString(pick(tokenData, 'accessToken', 'access_token'));
      const refreshToken = firstString(pick(tokenData, 'refreshToken', 'refresh_token'));
      const domain = firstString(pick(tokenData, 'domain'));

      // 令牌已到手，再取账号身份（uid 用于去重，昵称用于卡片名）
      let account: Record<string, unknown> = {};
      try {
        const { body } = await fetchJson(
          `${site.pluginBase}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
          { headers: cbPluginHeaders(site, accessToken), timeoutMs },
        );
        const { data } = cbEnvelope(body);
        if (isRecord(data)) account = data;
      } catch (error) {
        ctx.log(`登录令牌已获取，但账号信息查询失败：${(error as Error).message}`);
      }
      const uid = firstString(pick(account, 'uid', 'userId', 'user_id'));
      if (!uid) {
        return {
          status: 'failed',
          message: '已拿到登录令牌，但上游没有返回账号 ID，无法安全落库。请重试或改用手工 Cookie。',
        };
      }

      return {
        status: 'ready',
        account: {
          id: uid,
          name: firstString(pick(account, 'nickname', 'userName', 'user_name')),
        },
        credentials: {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
        },
        options: {
          uid,
          ...(firstString(pick(account, 'enterpriseId', 'enterprise_id'))
            ? { enterpriseId: firstString(pick(account, 'enterpriseId', 'enterprise_id')) }
            : {}),
          ...(domain ? { domain } : {}),
        },
        message: '登录成功，正在验证取数并写入本机配置…',
      };
    },
  };
}

/**
 * 「网页端登录」：服务端驱动本机调试 Chrome 打开本平台站点的用量页，
 * 用户在那个窗口里自己完成登录，我们只**旁听浏览器真实发出的 Cookie 请求头**
 * （不注入、不代填、不拼 cookie jar）。
 *
 * 抓到 Cookie 后走同一个登录会话层落库：probe 验证、去重、`.env` 槽位、备份全部复用。
 * 令牌模式拿不到逐包批次明细，Cookie 模式才能拿到——这是本方法存在的理由。
 *
 * 站点由工厂参数固定：国内版开 www.codebuddy.cn，国际版开 www.codebuddy.ai。
 */
function makeCodeBuddyWebLogin(site: CodeBuddySiteMeta): ProviderLogin {
  return {
    id: 'web',
    kind: 'web',
    label: '网页端登录',
    hint: `自动打开调试 Chrome 的${site.label}用量页；你在那个窗口登录后，本页面自动完成添加。`,
    qr: false,
    intervalMs: CB_WEB_POLL_INTERVAL_MS,
    async start(input) {
      // ① 确保调试 Chrome 在跑（没跑就按 tools/chrome-debug.sh 同款参数拉起）
      const chrome = await ensureDebugChrome();
      input.log(
        `CodeBuddy 调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
      );

      // ② 打开用量页并开始旁听请求头；采集器挂在 secret 里，cleanup 时释放
      const collector = await openCookieCollector({ url: site.usageUrl });
      input.log(`CodeBuddy ${site.label}用量页已打开，等待登录`);

      const startedAt = Date.now();
      return {
        authUrl: site.usageUrl,
        qr: false,
        ttlMs: CB_WEB_LOGIN_TTL_MS,
        hint: `请在刚打开的 Chrome 窗口里登录${site.label}（${hostnameOf(site.billingOrigin)}）；登录后本页面会自动完成添加。`,
        secret: { collector, startedAt, reloads: 0, lastReloadAt: 0 },
      };
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少采集器参数，请重新发起。' };
      const collector = pick(secret, 'collector') as CookieCollector | undefined;
      const startedAt = Number(pick(secret, 'startedAt')) || Date.now();
      if (!collector || typeof collector.cookieFor !== 'function') {
        return { status: 'failed', message: '登录会话缺少采集器，请重新发起。' };
      }

      // 目标域清单：计费域与用量页的主机（www.codebuddy.cn / www.codebuddy.ai）
      const hosts = [...new Set([hostnameOf(site.billingOrigin), hostnameOf(site.usageUrl)])].filter(
        Boolean,
      );
      const raw = collector.cookieFor(hosts);

      /**
       * 登录态判据：**不能**只看「抓到了 Cookie」。
       *
       * 两条判据取「或」：
       *   ① 站点声明的登录态 Cookie 名出现（`loginCookieNames`，未实测的站点留空）；
       *   ② 功能性证据：页面**自己**请求身份接口 `CB_WEB_IDENTITY_PATH` 拿到 2xx。
       */
      const names = collector.cookieNamesFor(hosts);
      const hasLoginCookie = site.loginCookieNames.some((name) => names.includes(name));
      const identityOk = collector.sawSuccessfulRequest(CB_WEB_IDENTITY_PATH);
      const loggedIn = Boolean(raw) && (hasLoginCookie || identityOk);

      if (!loggedIn) {
        // 刷新策略：只在页面确实空闲时刷新，且限次 + 最小间隔
        const reloads = Number(pick(secret, 'reloads')) || 0;
        const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
        const now = Date.now();
        const idle = collector.idleMs();
        const idleLongEnough = idle >= CB_WEB_RELOAD_IDLE_MS || idle === 0;
        if (
          reloads < CB_WEB_RELOAD_MAX &&
          idleLongEnough &&
          now - lastReloadAt >= CB_WEB_RELOAD_MIN_INTERVAL_MS
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
            ? `已抓到${site.label}的页面 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
            : `正在等待你在调试 Chrome 窗口里登录（已等待 ${waitedSec} 秒）…`,
        };
      }

      const cookie = normalizeCookieHeader(raw ?? '') ?? '';
      if (!cookie) return { status: 'waiting', message: '抓到的 Cookie 头为空，继续等待页面发起新请求…' };

      // 账号身份：去重键用「Cookie 指纹」，与 Qoder 同一策略
      const accountId = createHash('sha256').update(cookie).digest('hex').slice(0, 16);
      ctx.log(`CodeBuddy 网页端登录已抓到 Cookie（指纹 ${accountId}），开始验证落库`);

      return {
        status: 'ready',
        // 昵称为空时用占位名「平台 · 登录账号」，探测时由 adoptResolvedAccountName 补
        account: { id: accountId, name: '' },
        credentials: { cookie },
        options: {},
        message: '已抓到登录 Cookie，正在验证取数并写入本机配置…',
      };
    },
    async cleanup(secret) {
      const collector = isRecord(secret)
        ? (pick(secret, 'collector') as CookieCollector | undefined)
        : undefined;
      await collector?.close().catch(() => {});
    },
  };
}

/**
 * 按站点产出一个完整的 CodeBuddy 适配器：站点在闭包内固定，登录、探测、失败文案、
 * `.env` 变量前缀全部跟着它走（与 Qoder 的 createQoderAdapter 同一工厂思路）。
 */
function createCodeBuddyAdapter(siteId: CodeBuddySiteId): ProviderAdapter {
  const site = CODEBUDDY_SITES[siteId];
  const scanLogin = makeCodeBuddyScanLogin(site);
  const webLogin = makeCodeBuddyWebLogin(site);

  const adapter: ProviderAdapter = {
    id: siteId === 'cn' ? 'codebuddy' : 'codebuddy-intl',
    displayName: siteId === 'cn' ? 'CodeBuddy' : 'WorkBuddy 国际版',
    region: site.id,
    dashboardUrl: site.usageUrl,
    usageUrl: site.usageUrl,
    requiredCredentialKeys: ['cookie'],
    /**
     * 两种凭证形态并存：手工 Cookie（历史路径）或插件登录令牌。
     * 登录产出的变量名由站点 envNames 固定；第 2 个账号自动用 `_2` 槽位。
     */
    envNames: site.envNames,
    // accessToken 是取数必需；refreshToken 只影响续期，缺失时仍可工作到令牌过期
    isConfigured: (account) =>
      Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken),
    credentialHint:
      `登录 ${hostnameOf(site.billingOrigin)} 后，在 DevTools 里复制任意 ${hostnameOf(site.billingOrigin)} 请求的 Cookie 头` +
      `（务必包含 ${hostnameOf(site.billingOrigin)} 子域下的会话 Cookie），填入 credentials.cookie（也可用 npm run capture -- ${siteId === 'cn' ? 'codebuddy' : 'codebuddy-intl'} 自动抓取）；` +
      '或在看板上点「扫码登录」自动写入插件令牌。',
    /**
     * 多账号：一个账号一份 Cookie，各自独立取数、各自一张卡片。
     *
     * 不声明 `groupAccounts`：合并卡片会把 `credits/windows/nextExpiryAt` 清空
     * （见 src/aggregate.ts 的 finalizeCard），而 CodeBuddy 的积分包带真实到期时间，
     * 合并后会从「最快到期」时间线与卡片批次列表里消失——与项目核心目标相悖。
     *
     * 第二个账号的 Cookie 抓取：`npm run capture -- <platform> --slot 2`。
     */
    manageAccounts: true,
    manageFields: [
      {
        key: 'cookie',
        label: 'Cookie',
        placeholder: `登录 ${hostnameOf(site.billingOrigin)} → DevTools → 任意 ${hostnameOf(site.billingOrigin)} 请求 → Headers → 复制 Cookie 整段值`,
        hint: `必须是 ${hostnameOf(site.billingOrigin)} 子域下的会话 Cookie，只复制父域会得到 401。`,
        multiline: true,
      },
    ],
    manageHint:
      'Cookie 会先真实调用一次用量接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',
    /**
     * 用量 + 获取明细（v2）：
     *   - 用量：`get-user-request-usage` 逐笔（`requestTime` + `credit`，支持日期区间与翻页），
     *     与页面「使用明细」同源；
     *   - 获取：资源包当前周期发放（`CycleStartTime` + `CycleCapacitySizePrecise`）+
     *     礼包（`claimed_at` + `credit_num`，只回最近一次领取）。任一获取来源失败即整体
     *     退回本地采样（不标 upstream），避免「只统计了一半还说完整」。
     *
     * 凭证分派：有 Cookie 走会话路径（历史行为不变）；否则走令牌路径
     * （与 `probe` 的令牌分支一致，接口同时接受 Bearer）。
     */
    async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
      const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
      if (!cookie) {
        const accessToken = cred(account, ctx, ['accessToken', 'token']);
        if (!accessToken) return null;
        return cbTokenLedger(site, adapter, account, ctx, accessToken);
      }
      const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;
      const headers: Record<string, string> = {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: site.billingOrigin,
        Referer: site.usageUrl,
        'x-client-platform': 'web',
      };
      const records: UsageRecord[] = [];

      // ① 逐笔用量：本地日区间，按页拉取（上限 10 页 × 100）
      const startDay = localDateKey(startOfDay(ctx.now) - 86_400_000);
      const endDay = localDateKey(ctx.now);
      const pageSize = 100;
      const requestUsageUrl = `${site.billingOrigin}/billing/meter/get-user-request-usage`;
      const usePages = await fetchAllPages<UsageRecord>({
        pageSize,
        maxPages: 10,
        label: `${adapter.displayName} 用量明细`,
        fetchPage: async (pageNum) => {
          const { body } = await fetchJson(requestUsageUrl, {
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
          const total = isRecord(data) ? firstNumber(pick(data, 'total', 'totalCount')) : null;
          const items: UsageRecord[] = [];
          if (Array.isArray(list)) {
            for (const raw of list) {
              if (!isRecord(raw)) continue;
              const at = toIso(pick(raw, 'requestTime', 'request_time'));
              const amount = firstNumber(pick(raw, 'credit', 'credits'));
              if (!at || amount === null || amount <= 0) continue;
              items.push({ at: Date.parse(at), kind: 'use', amount });
            }
          }
          return { items, total };
        },
      });
      records.push(...usePages.items);
      // 翻到上限仍没取全时**不能声明覆盖**：否则「缺记录 = 0」会把没取到的用量压成 0。
      // （与 CodeArts 活动逐笔截断同源，见 docs/fixes/CodeArts-活动奖励逐笔分页截断-修复方案.md）
      const useCovered = usePages.complete;
      if (!useCovered) {
        ctx.log(`${adapter.displayName} 用量明细分页未取全（${incompleteNote(usePages)}），该维度退回本地采样`);
      }

      // ②③ 获取记录：任一步失败即放弃覆盖声明（grant 回退本地采样）
      let grantCovered = true;
      try {
        const summaryResponse = await fetchJson(
          optString(account, 'endpoint') || `${site.billingOrigin}/billing/meter/get-user-resource-summary`,
          {
            method: 'POST',
            headers,
            body: '{}',
            timeoutMs,
          },
        );
        assertBusinessOk(summaryResponse.body);
        const summary = parseCodeBuddySummary(summaryResponse.body);
        const packageBody = JSON.stringify({
          PageNumber: 1,
          PageSize: 200,
          Status: [0],
          PackageCodes: summary.packageCodes,
          NeedInUsage: true,
        });
        for (const path of [
          '/billing/meter/get-user-resource-free-packages',
          '/billing/meter/get-user-resource-paid-packages',
        ]) {
          try {
            const { body } = await fetchJson(`${site.billingOrigin}${path}`, {
              method: 'POST',
              headers,
              body: packageBody,
              timeoutMs,
            });
            records.push(...parsePackageGrants(body));
          } catch (error) {
            grantCovered = false;
            ctx.log(`${adapter.displayName} 资源包发放明细获取失败（退回本地采样）：${(error as Error).message}`);
          }
        }
      } catch (error) {
        grantCovered = false;
        ctx.log(`${adapter.displayName} 资源包清单获取失败（退回本地采样）：${(error as Error).message}`);
      }
      try {
        const { body } = await fetchJson(`${site.billingOrigin}/billing/meter/check-gift-claimed`, {
          method: 'POST',
          headers,
          body: '{}',
          timeoutMs,
        });
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
        ctx.log(`${adapter.displayName} 礼包明细获取失败（退回本地采样）：${(error as Error).message}`);
      }

      return { records, covers: { use: useCovered, grant: grantCovered } };
    },

    /** 默认登录方法（扫码）；完整清单在对象外组装成 `loginMethods` */
    login: scanLogin,

    async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
      const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
      // 令牌分支：手工 Cookie 优先（历史账号行为完全不变），没有 Cookie 才走插件令牌
      if (!cookie) {
        const accessToken = cred(account, ctx, ['accessToken', 'token']);
        if (!accessToken) {
          return notConfigured(adapter, account, ctx, ['cookie 或 accessToken+refreshToken']);
        }
        try {
          return await cbProbeWithToken(site, adapter, account, ctx, accessToken);
        } catch (error) {
          const status = error instanceof HttpError ? error.kind : 'error';
          return failure(adapter, account, ctx, status, (error as Error).message);
        }
      }

      const timeoutMs = ctx.timeoutMs || CB_TIMEOUT_FALLBACK;
      const headers: Record<string, string> = {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: site.billingOrigin,
        Referer: site.usageUrl,
        'x-client-platform': 'web',
      };
      const summaryUrl =
        optString(account, 'endpoint') || `${site.billingOrigin}/billing/meter/get-user-resource-summary`;

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
            const packagesResponse = await fetchJson(
              `${site.billingOrigin}/billing/meter/get-user-resource-free-packages`,
              {
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
              },
            );
            assertBusinessOk(packagesResponse.body);
            packs = parseCodeBuddyPackages(packagesResponse.body);
          } catch (error) {
            ctx.log(`${adapter.displayName} 资源包详情获取失败（不影响余额）：${(error as Error).message}`);
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
          adapter,
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
        return failure(adapter, account, ctx, status, (error as Error).message);
      }
    },
  };

  /**
   * 登录方法清单：`login`（扫码，默认方法）+ `webLogin`（网页端抓 Cookie）。
   *
   * 声明后前端按清单渲染两个按钮，会话层按 `method` 路由；
   * `login` 仍保留在适配器上（不传 method 时走它），行为向后兼容。
   */
  adapter.loginMethods = [scanLogin, webLogin];
  return adapter;
}

/** 国内站（www.codebuddy.cn）：凭证写 `CODEBUDDY_*`，与既有行为一致 */
export const codebuddyAdapter: ProviderAdapter = createCodeBuddyAdapter('cn');

/**
 * 国际站（www.codebuddy.ai，即 WorkBuddy）：独立 provider id，凭证写 `CODEBUDDY_GLOBAL_*`。
 *
 * 站点是**平台身份**的一部分（与 Qoder 国内版 / 国际版同一拆分思路）：
 * 账号列表、卡片、登录入口、缓存键都按 provider 分开。
 */
export const codebuddyIntlAdapter: ProviderAdapter = createCodeBuddyAdapter('global');
