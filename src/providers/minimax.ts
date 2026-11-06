import { createHash, randomBytes } from 'node:crypto';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { asNumber, firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages } from '../lib/pagination.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
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
  optBool,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
  type ProviderLogin,
} from './base.js';

/**
 * MiniMax Code（agent.minimax.cn / agent.minimax.io）
 *
 * 目标：把「签到积分」接入看板。官方文档只说明在 MiniMax Code 设置里查看，
 * 没有公开 API；这里复刻的是 **客户端自身的内部云接口**（静态取证自
 * /Applications/MiniMax Code.app 的 app.asar，见
 * docs/plans/平台适配器-接入MiniMax-Code积分-开发设计方案.md）：
 *
 *   GET /minimax-cloud/api/v1/credit/details
 *       ?page_number=&page_size=&include_expired=true
 *       → { details: [{ credit_type(1=购买,2=签到), granted_amount,
 *                       remaining_amount, consumed_amount,
 *                       granted_at_ms, expire_at_ms }], total_count }
 *   GET /minimax-cloud/api/v1/signin/status        （可选，仅读状态不签到）
 *       → { data: { days: [{ day_no, points, is_today, status }] } }
 *
 * 鉴权（复刻 Web 端）：
 *   请求头 `token`（浏览器 localStorage 的 `_token`）+ **SSO 会话 Cookie** +
 *   公共查询参数里的**真实登录身份**（user_id / op_ticket / uuid，由 capture 从
 *   localStorage 的 user_detail_agent / UNIQUE_USER_ID 抓取；写死 0 会被 401 拒绝）+
 *   三个防爬签名头：
 *     x-timestamp = Unix 秒
 *     x-signature = md5(秒 + "I*7Cf%WZ#S&%1RlZJ&C2" + body)
 *     yy          = md5(encodeURIComponent(带查询串的路径) + "_" + body + md5(毫秒) + "ooui")
 *   公共参数的顺序要与签名时的序列化完全一致（见 buildSignedRequest）。
 *
 *   Cookie 不能省：真实客户端都带（浏览器同源请求自动携带；桌面端 main 进程
 *   走 Electron session 的 net.fetch），只发 token 实测会 401。
 *
 * 口径：余额 = 仍在有效期的批次剩余之和（签到 + 购买）；批次过期时间
 * 直接来自 expire_at_ms（签到到账 30 天）。「用量」维度不覆盖 → 由本地采样兜底，
 * 「增量」维度用明细里的到账记录（covers.grant = true）。
 */

const MINIMAX_TIMEOUT_FALLBACK = 12_000;
/** x-signature 的固定盐（客户端硬编码，用于请求签名） */
const SIGNATURE_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const APP_ID = '3001';
const BIZ_ID = 3;
const VERSION_CODE = '22201';
/** 明细分页上限：10 页 × 100 条，超出时界面会显式声明统计未覆盖全部 */
const MAX_PAGES = 10;
const DETAILS_PAGE_SIZE = 100;
/** 积分类型：1=购买（Purchased），2=签到（Free）；与客户端枚举一致 */
const CREDIT_TYPE_PURCHASED = 1;
const CREDIT_TYPE_CHECKIN = 2;

/* ------------------------------------------------------------------ *
 * OAuth 设备码登录（MiniMax Code CLI / 扫码）
 * ------------------------------------------------------------------ */

const MINIMAX_ORIGIN_CN = 'https://agent.minimax.cn';
const MINIMAX_ORIGIN_GLOBAL = 'https://agent.minimax.io';
const MINIMAX_ACCOUNT_CN = 'https://account.minimax.cn';
const MINIMAX_ACCOUNT_GLOBAL = 'https://account.minimax.io';
/** 客户端硬编码的 OAuth 客户端与授权范围（见 app.asar @mavis/oauth-core/contracts.js） */
const OAUTH_CLIENT_ID = 'mcode-public';
const OAUTH_SCOPE = 'agent.default';
const OAUTH_AUDIENCE = 'agent-backend';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** 扫码登录会话上限（设备码本身可能更短；取二者较小值） */
const SCAN_LOGIN_MAX_TTL_MS = 15 * 60_000;
/** 网页端登录：等待用户在调试 Chrome 里完成登录的总时长 */
const WEB_LOGIN_TTL_MS = 10 * 60_000;
const WEB_POLL_INTERVAL_MS = 2_000;
const WEB_RELOAD_IDLE_MS = 4_000;
const WEB_RELOAD_MIN_INTERVAL_MS = 10_000;
const WEB_RELOAD_MAX = 3;

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function resolveSite(account: AccountConfig): 'cn' | 'global' {
  return (optString(account, 'site') || 'cn').toLowerCase() === 'global' ? 'global' : 'cn';
}

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  if (override) return override.replace(/\/+$/, '');
  return resolveSite(account) === 'global' ? MINIMAX_ORIGIN_GLOBAL : MINIMAX_ORIGIN_CN;
}

/** OAuth 的账号域名与业务域名不同：cn 是 account.minimax.cn，global 是 account.minimax.io */
function resolveAccountOrigin(account: AccountConfig): string {
  const override = optString(account, 'accountOrigin');
  if (override) return override.replace(/\/+$/, '');
  return resolveSite(account) === 'global' ? MINIMAX_ACCOUNT_GLOBAL : MINIMAX_ACCOUNT_CN;
}

/** OAuth 模式：显式选项优先；未写时仍走既有 Web 分支，保证历史账号行为不变 */
function isOauthAccount(account: AccountConfig): boolean {
  return optString(account, 'authMode').toLowerCase() === 'oauth';
}

function normalizeToken(raw: string): string {
  return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/** 取 Web 登录态 token；兼容粘贴了 `Bearer xxx` / 带引号的情况 */
function resolveWebToken(account: AccountConfig, ctx: ProbeContext): string {
  const raw =
    cred(account, ctx, ['token']) ||
    // 历史兼容：旧版本把 Web token 也允许写在 accessToken 里；OAuth 账号由 authMode 分流
    (isOauthAccount(account) ? '' : cred(account, ctx, ['accessToken', 'access_token']));
  return normalizeToken(raw);
}

/** 取 OAuth access token；与 Web 的 `token` 刻意分开，避免把旧账号的 accessToken 误当请求头 */
function resolveAccessToken(account: AccountConfig, ctx: ProbeContext): string {
  return normalizeToken(cred(account, ctx, ['accessToken', 'access_token']));
}

/** SSO 会话 Cookie（真实客户端必带；兼容粘贴整段 cURL / `Cookie:` 头） */
function resolveCookie(account: AccountConfig, ctx: ProbeContext): string {
  return normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
}

/**
 * 公共参数里的登录身份值。
 *
 * 服务端会把 user_id 与 token 身份做交叉校验：写死 0 / 臆造 uuid 都会被 401 拒绝。
 * 注意 **user_id 必须全程按字符串处理**——MiniMax 的 user id 是 18 位数字
 * （远超 JS 安全整数 2^53），转 Number 会改变末几位、校验必挂。
 * 这些值由 `npm run capture` 从 localStorage 一并抓取（user_detail_agent / UNIQUE_USER_ID）。
 */
function resolveIdentity(
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
): { userId: string; paramToken: string; opTicket: string; uuid: string } {
  return {
    userId: cred(account, ctx, ['userId', 'user_id']).replace(/[^\d]/g, ''),
    // 客户端查询串里的 token 优先取 user_detail_agent.token，缺失时与请求头一致
    paramToken: cred(account, ctx, ['paramToken', 'param_token']) || token,
    opTicket: cred(account, ctx, ['opTicket', 'op_ticket']),
    uuid: cred(account, ctx, ['uuid', 'deviceUuid']),
  };
}

/**
 * 复刻客户端请求拦截器：构造带签名的完整 URL 与请求头。
 *
 * 注意：`yy` 里的查询串必须与真正发出的 URL **逐字节一致**，
 * 因此两边共用同一个 URLSearchParams 序列化结果。
 */
function buildSignedRequest(input: {
  origin: string;
  path: string;
  params: Array<[string, string | number]>;
  token: string;
  /** 查询串里的 token（客户端优先取 user_detail_agent.token，缺失时与请求头一致） */
  paramToken: string;
  /** 真实登录 user_id（18 位字符串，禁止转 Number；服务端会与 token 身份交叉校验） */
  userId: string;
  /** op_ticket（客户端从 user_detail_agent 读取，有则带） */
  opTicket: string;
  /** 设备 uuid（客户端为 localStorage 持久值；缺失时由 token 哈希派生兜底） */
  uuid: string;
  method: 'GET' | 'POST';
  body?: string;
  /** 排查开关：不发送签名头，用于定位 401 是否由签名引起（默认关闭） */
  skipSignature?: boolean;
}): { url: string; headers: Record<string, string> } {
  const nowMs = Date.now();
  const unixSec = Math.floor(nowMs / 1000);
  const body = input.body ?? '';

  // device_id 在客户端是「每个标签页随机会话值」，服务端无法校验，由 token 派生保证稳定
  const fingerprint = md5(`minimax-device:${input.token}`);
  const deviceId = String(Number.parseInt(fingerprint.slice(0, 8), 16) % 90_000_000 + 10_000_000);
  const uuid =
    input.uuid ||
    `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-${fingerprint.slice(12, 16)}-${fingerprint.slice(16, 20)}-${fingerprint.slice(20, 32)}`;

  const identity: Array<[string, string | number]> = [['user_id', input.userId || '0']];
  if (input.opTicket) identity.push(['op_ticket', input.opTicket]);
  // 客户端会把屏幕尺寸塞进公共参数（screen?.width / screen?.height），这里给一个固定值保持形态一致
  identity.push(['screen_width', 1920], ['screen_height', 1080]);

  const merged: Array<[string, string | number]> = [
    ...input.params,
    ['device_platform', 'web'],
    ['biz_id', BIZ_ID],
    ['app_id', APP_ID],
    ['version_code', VERSION_CODE],
    ['unix', unixSec],
    ['timezone_offset', -60 * new Date().getTimezoneOffset()],
    ['sys_language', 'zh'],
    ['lang', 'zh'],
    ['uuid', uuid],
    ['device_id', deviceId],
    ['os_name', process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'macOS'],
    ['browser_name', 'Chrome'],
    ['browser_language', 'zh-CN'],
    ['browser_platform', 'MacIntel'],
    ...identity,
    ['token', input.paramToken],
    ['client', 'web'],
  ];

  const query = new URLSearchParams(
    merged.map(([key, value]): [string, string] => [key, String(value)]),
  ).toString();
  const pathWithQuery = `${input.path}?${query}`;

  const headers: Record<string, string> = {
    token: input.token,
    'Content-Type': 'application/json',
    Origin: input.origin,
    Referer: `${input.origin}/`,
  };
  if (!input.skipSignature) {
    const bodyForSignature = input.method === 'POST' && body ? body : '{}';
    headers.yy = md5(
      `${encodeURIComponent(pathWithQuery)}_${bodyForSignature}${md5(String(nowMs))}ooui`,
    );
    headers['x-timestamp'] = String(unixSec);
    headers['x-signature'] = md5(`${unixSec}${SIGNATURE_SALT}${body}`);
  }

  return { url: `${input.origin}${pathWithQuery}`, headers };
}

/* ------------------------------------------------------------------ *
 * OAuth（扫码）请求与令牌
 * ------------------------------------------------------------------ */

/** 刚续期/刚登录的 accessToken 缓存：分页与同轮多次请求共用，避免重复续期 */
const OAUTH_TOKENS = new Map<string, { accessToken: string; expiresAt: number }>();
/** 已解析到的 realUserID：OAuth 身份接口在每轮探测里最多调用一次 */
const OAUTH_USER_IDS = new Map<string, string>();

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function tokenExpiryMs(token: string): number {
  const claims = decodeJwtClaims(token);
  const exp = claims ? firstNumber(pick(claims, 'exp')) : null;
  return exp !== null ? exp * 1000 : 0;
}

function oauthCacheKey(account: AccountConfig, storedToken: string): string {
  // 存储里的 token 换了（重新登录）就换 key，避免继续使用旧缓存
  return `${account.provider}\u0000${account.displayName ?? ''}\u0000${md5(storedToken)}`;
}

/**
 * OAuth 模式请求：复刻 MiniMax Code 桌面端（`client=mcode`）的公共参数与签名头。
 *
 * 与 Web 模式的差别：
 *   - 鉴权头是 `Authorization: Bearer`，不发送 `token` 请求头，也不依赖 SSO Cookie；
 *   - 公共参数带 `is_desktop=1` / `desktop_version` / `browser_name=mcode`；
 *   - 身份接口（`/v1/api/user/info`）用 `device_platform=mcode`。
 */
function buildOauthRequest(input: {
  origin: string;
  path: string;
  params?: Array<[string, string | number]>;
  accessToken: string;
  userId: string;
  identity?: boolean;
  body?: string;
}): { url: string; headers: Record<string, string> } {
  const nowMs = Date.now();
  const unixSec = Math.floor(nowMs / 1000);

  const base: Array<[string, string | number]> = [
    ['device_platform', input.identity ? 'mcode' : 'web'],
    ['biz_id', BIZ_ID],
    ['app_id', APP_ID],
    ['version_code', VERSION_CODE],
  ];
  if (!input.identity) base.push(['is_desktop', '1'], ['desktop_version', '0.6.5']);
  base.push(
    ['unix', nowMs],
    ['timezone_offset', -60 * new Date().getTimezoneOffset()],
    ['sys_language', 'zh'],
    ['lang', 'zh'],
    ['device_id', '0'],
    ['os_name', process.platform],
    ['browser_name', 'mcode'],
    ['user_id', input.userId || '0'],
    ['client', 'mcode'],
  );

  const merged = [...(input.params ?? []), ...base];
  const query = new URLSearchParams(
    merged.map(([key, value]): [string, string] => [key, String(value)]),
  ).toString();
  const pathWithQuery = `${input.path}?${query}`;
  // 客户端对 GET 的两个签名口径不同：yy 用 `{}`，x-signature 用空串。
  const body = input.body ?? '';
  const yyBody = body || '{}';

  return {
    url: `${input.origin}${pathWithQuery}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'MiniMaxCode',
      Authorization: `Bearer ${input.accessToken}`,
      yy: md5(`${encodeURIComponent(pathWithQuery)}_${yyBody}${md5(String(nowMs))}ooui`),
      'x-timestamp': String(unixSec),
      'x-signature': md5(`${unixSec}${SIGNATURE_SALT}${body}`),
    },
  };
}

/** OAuth token 端点：非 2xx 也要读 JSON（设备码 pending / slow_down 走 400/200 都见过） */
async function postOauthForm(
  url: string,
  values: Record<string, string | number>,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.set(key, String(value));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: isRecord(parsed) ? parsed : {} };
}

interface OauthGrant {
  accessToken: string;
  refreshToken: string;
  /** epoch ms；无法判断时按 JWT `exp`，仍未知则 0 */
  expiresAt: number;
}

function oauthErrorText(body: Record<string, unknown>): string {
  return (
    firstString(pick(body, 'error_description', 'errorDescription', 'error', 'message')) ||
    '未知错误'
  );
}

function parseOauthGrant(body: Record<string, unknown>, previousRefreshToken = ''): OauthGrant {
  const accessToken = firstString(pick(body, 'access_token', 'accessToken'));
  const tokenType = firstString(pick(body, 'token_type', 'tokenType')).toLowerCase();
  const refreshToken =
    firstString(pick(body, 'refresh_token', 'refreshToken')) || previousRefreshToken || '';
  const expiresIn = firstNumber(pick(body, 'expires_in', 'expiresIn'));
  if (!accessToken) throw new Error(`OAuth 授权响应缺少 access_token：${oauthErrorText(body)}`);
  if (tokenType && tokenType !== 'bearer') {
    throw new Error(`OAuth 授权类型异常（${tokenType}），请重新扫码登录。`);
  }
  return {
    accessToken,
    refreshToken,
    expiresAt:
      expiresIn !== null && expiresIn > 0 ? Date.now() + expiresIn * 1000 : tokenExpiryMs(accessToken),
  };
}

/** OAuth 身份：`/v1/api/user/info` 里的 `data.userInfo.realUserID` */
async function fetchOauthIdentity(
  account: AccountConfig,
  ctx: ProbeContext,
  accessToken: string,
): Promise<{ userId: string; name: string }> {
  const request = buildOauthRequest({
    origin: resolveOrigin(account),
    path: '/v1/api/user/info',
    accessToken,
    userId: '0',
    identity: true,
  });
  const { body } = await fetchJson(request.url, {
    headers: request.headers,
    timeoutMs: ctx.timeoutMs || MINIMAX_TIMEOUT_FALLBACK,
  });

  const baseResp = pick(body, 'base_resp', 'baseResp');
  if (isRecord(baseResp)) {
    const code = firstNumber(pick(baseResp, 'status_code', 'statusCode'));
    if (code !== null && code !== 0) {
      const message = `OAuth 身份查询失败：${String(
        pick(baseResp, 'status_msg', 'statusMsg') ?? `status_code=${code}`,
      )}`;
      throw code === 1000048 ? new HttpError(message, 401) : new Error(message);
    }
  }
  const statusInfo = pick(body, 'statusInfo');
  if (isRecord(statusInfo)) {
    const code = firstNumber(pick(statusInfo, 'code'));
    if (code !== null && code !== 0) {
      const message = `OAuth 身份查询失败：${String(pick(statusInfo, 'message') ?? `code=${code}`)}`;
      throw code === 1000048 ? new HttpError(message, 401) : new Error(message);
    }
  }

  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  const user = isRecord(data) ? pick(data, 'userInfo', 'user_info') : undefined;
  const record = isRecord(user) ? user : isRecord(data) ? data : {};
  const userId = firstString(pick(record, 'realUserID', 'real_user_id', 'userId', 'user_id')).replace(
    /[^\d]/g,
    '',
  );
  const name = firstString(
    pick(record, 'nickname', 'nickName', 'name', 'userName', 'user_name', 'displayName'),
  );
  if (!userId) throw new Error('MiniMax 未返回账号标识（realUserID），无法安全落库。');
  return { userId, name };
}

/** OAuth 的 user_id 公共参数：显式配置 > 本轮缓存 > JWT claims */
function resolveOauthUserId(
  account: AccountConfig,
  ctx: ProbeContext,
  accessToken: string,
): string {
  const explicit = cred(account, ctx, ['userId', 'user_id'], ['userId', 'user_id']).replace(
    /[^\d]/g,
    '',
  );
  if (explicit) return explicit;
  const cached = OAUTH_USER_IDS.get(md5(accessToken));
  if (cached) return cached;
  const claims = decodeJwtClaims(accessToken);
  const subject = claims ? firstString(pick(claims, 'sub', 'account_id', 'accountId', 'uid')) : '';
  return subject && /^\d+$/.test(subject) ? subject : '';
}

async function ensureOauthUserId(
  account: AccountConfig,
  ctx: ProbeContext,
  accessToken: string,
): Promise<string> {
  const existing = resolveOauthUserId(account, ctx, accessToken);
  if (existing) return existing;
  const identity = await fetchOauthIdentity(account, ctx, accessToken);
  OAUTH_USER_IDS.set(md5(accessToken), identity.userId);
  return identity.userId;
}

async function refreshOauthGrant(
  account: AccountConfig,
  refreshToken: string,
  ctx: ProbeContext,
): Promise<OauthGrant> {
  const response = await postOauthForm(
    `${resolveAccountOrigin(account)}/oauth2/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPE,
      audience: OAUTH_AUDIENCE,
    },
    ctx.timeoutMs || MINIMAX_TIMEOUT_FALLBACK,
  );
  if (response.status < 200 || response.status >= 300 || response.body.error) {
    throw new Error(`OAuth 令牌续期失败：${oauthErrorText(response.body)}`);
  }
  return parseOauthGrant(response.body, refreshToken);
}

/**
 * 取一个可用 accessToken：临近过期时用 refreshToken 续期，并通过
 * `ctx.persistCredentials` 把轮换后的令牌写回 `.env`（下一轮刷新直接复用）。
 *
 * `force` 用于请求已经 401 的兜底：即使 JWT 没有 `exp`，也尝试续期一次。
 */
async function ensureOauthAccessToken(
  account: AccountConfig,
  ctx: ProbeContext,
  force = false,
): Promise<string> {
  const stored = resolveAccessToken(account, ctx);
  if (!stored) throw new Error('缺少 OAuth accessToken，请重新扫码登录。');

  const key = oauthCacheKey(account, stored);
  const cached = OAUTH_TOKENS.get(key);
  if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken;

  const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);
  const expiresAt = tokenExpiryMs(stored) || Number(optString(account, 'expiresAt')) || 0;
  const expiring = expiresAt > 0 && expiresAt - Date.now() <= 60_000;
  if (!force && !expiring) return stored;
  if (!refreshToken) {
    if (force) throw new Error('OAuth 登录已过期且没有 refreshToken，请重新扫码登录。');
    return stored;
  }

  const grant = await refreshOauthGrant(account, refreshToken, ctx);
  OAUTH_TOKENS.set(key, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
  try {
    await ctx.persistCredentials?.({
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
    });
  } catch {
    // 写回失败不阻断本次取数：下一次探测会再尝试续期
  }
  return grant.accessToken;
}

async function minimaxGet(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  params: Array<[string, string | number]> = [],
): Promise<unknown> {
  if (isOauthAccount(account)) {
    let accessToken = await ensureOauthAccessToken(account, ctx);
    const userId = await ensureOauthUserId(account, ctx, accessToken);

    const send = async (token: string): Promise<unknown> => {
      const request = buildOauthRequest({
        origin: resolveOrigin(account),
        path,
        params,
        accessToken: token,
        userId,
      });
      const { body } = await fetchJson(request.url, {
        headers: request.headers,
        timeoutMs: ctx.timeoutMs || MINIMAX_TIMEOUT_FALLBACK,
      });
      return body;
    };

    try {
      return await send(accessToken);
    } catch (error) {
      // accessToken 可能已失效但 JWT 没有 exp：401 时强续期一次再重放
      if (error instanceof HttpError && error.status === 401) {
        const refreshed = await ensureOauthAccessToken(account, ctx, true);
        if (refreshed !== accessToken) {
          accessToken = refreshed;
          return await send(accessToken);
        }
      }
      throw error;
    }
  }

  const token = resolveWebToken(account, ctx);
  const origin = resolveOrigin(account);
  const identity = resolveIdentity(account, ctx, token);
  const request = buildSignedRequest({
    origin,
    path,
    params,
    token,
    paramToken: identity.paramToken,
    userId: identity.userId,
    opTicket: identity.opTicket,
    uuid: identity.uuid,
    method: 'GET',
    skipSignature: optBool(account, 'skipSignature'),
  });
  const cookie = resolveCookie(account, ctx);
  const { body } = await fetchJson(request.url, {
    headers: cookie ? { ...request.headers, Cookie: cookie } : request.headers,
    timeoutMs: ctx.timeoutMs || MINIMAX_TIMEOUT_FALLBACK,
  });
  return body;
}

/** 业务错误：客户端统一看 base_resp（缺省视为成功） */
function assertBaseResp(body: unknown, fallbackMessage: string): void {
  const baseResp = pick(body, 'base_resp', 'baseResp');
  if (!isRecord(baseResp)) {
    assertBusinessOk(body);
    return;
  }
  const code = firstNumber(pick(baseResp, 'status_code', 'statusCode'));
  if (code !== null && code !== 0) {
    throw new Error(
      `${fallbackMessage}：${String(pick(baseResp, 'status_msg', 'statusMsg') ?? `status_code=${code}`)}`,
    );
  }
}

export interface MinimaxCreditDetail {
  /** 1=购买 2=签到 */
  creditType: number;
  granted: number;
  remaining: number;
  consumed: number;
  /** epoch ms */
  grantedAt: number;
  /** epoch ms */
  expiresAt: number;
}

/** 金额可能是 "1,000" 这样的字符串，负数按 0 处理（与客户端一致） */
function parseAmount(raw: unknown): number | null {
  const value = asNumber(raw);
  if (value === null) return null;
  return Math.max(0, value);
}

function parseDetail(raw: unknown): MinimaxCreditDetail | null {
  if (!isRecord(raw)) return null;
  const creditType = firstNumber(pick(raw, 'credit_type', 'creditType'));
  const granted = parseAmount(pick(raw, 'granted_amount', 'grantedAmount'));
  const remaining = parseAmount(pick(raw, 'remaining_amount', 'remainingAmount'));
  const consumed = parseAmount(pick(raw, 'consumed_amount', 'consumedAmount')) ?? 0;
  const grantedAt = firstNumber(pick(raw, 'granted_at_ms', 'grantedAtMs'));
  const expiresAt = firstNumber(pick(raw, 'expire_at_ms', 'expireAtMs'));
  if (creditType === null || granted === null || remaining === null) return null;
  if (grantedAt === null || expiresAt === null) return null;
  return { creditType, granted, remaining, consumed, grantedAt, expiresAt };
}

export interface MinimaxDetailsResult {
  items: MinimaxCreditDetail[];
  totalCount: number;
  /** 是否已取全（items 覆盖 total_count） */
  complete: boolean;
}

/** 拉取积分明细（新到旧分页），最多 MAX_PAGES 页 */
export async function fetchMinimaxCreditDetails(
  account: AccountConfig,
  ctx: ProbeContext,
  maxPages = MAX_PAGES,
): Promise<MinimaxDetailsResult> {
  let totalCount: number | null = null;
  const result = await fetchAllPages<MinimaxCreditDetail>({
    pageSize: DETAILS_PAGE_SIZE,
    maxPages,
    label: 'MiniMax 积分明细',
    fetchPage: async (page) => {
      const body = await minimaxGet(account, ctx, '/minimax-cloud/api/v1/credit/details', [
        ['page_number', page],
        ['page_size', DETAILS_PAGE_SIZE],
        ['include_expired', 'true'],
      ]);
      assertBaseResp(body, '积分明细请求失败');
      const source = isRecord(body) && isRecord(body.data) ? body.data : body;
      const list = pick(source, 'details');
      if (!Array.isArray(list)) {
        throw new Error('积分明细响应缺少 details 字段（token 可能已失效）');
      }
      const total = firstNumber(pick(source, 'total_count', 'totalCount'));
      if (total !== null) totalCount = total;
      return {
        // parseDetail 会跳过无法解析的条目：跳过项不参与翻页判据，但会体现在 total 差额里
        items: list.map(parseDetail).filter((item): item is MinimaxCreditDetail => item !== null),
        total,
      };
    },
  });

  /**
   * 历史缺陷：`totalCount` 缺省为 0 时 `items.length >= totalCount` 恒真，
   * 「翻页到上限被截断」会被判成 complete —— 恰好会放过「只取到一半」的情况。
   * 现在由 `fetchAllPages` 给出 complete（无 total 时用短页判据，与 total 矛盾则不判取全）。
   */
  return { items: result.items, totalCount: totalCount ?? 0, complete: result.complete };
}

export interface MinimaxSigninState {
  /** 今日是否已领取 */
  todayStatus: number | null;
  /** 本周期（7 天）已领取天数 */
  cycleClaimed: number;
}

/** 签到面板（可选）：只读状态，绝不调用领取接口 */
export async function fetchMinimaxSigninState(
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<MinimaxSigninState | null> {
  const body = await minimaxGet(account, ctx, '/minimax-cloud/api/v1/signin/status');
  assertBaseResp(body, '签到状态请求失败');
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const days = pick(payload, 'days');
  if (!Array.isArray(days)) return null;
  let todayStatus: number | null = null;
  let cycleClaimed = 0;
  for (const raw of days) {
    if (!isRecord(raw)) continue;
    const status = firstNumber(pick(raw, 'status'));
    if (status === 3) cycleClaimed += 1;
    if (pick(raw, 'is_today', 'isToday') === true) todayStatus = status;
  }
  return { todayStatus, cycleClaimed };
}

/** 客户端「类别」列的同类判定：非购买即签到 */
function creditLabel(creditType: number): string {
  return creditType === CREDIT_TYPE_PURCHASED ? '购买积分' : '签到积分';
}

function formatAmount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function signinNote(state: MinimaxSigninState | null): string | null {
  if (!state) return null;
  const today =
    state.todayStatus === 3
      ? '今日签到：已领取'
      : state.todayStatus === 2
        ? '今日签到：可领取'
        : state.todayStatus === 4
          ? '今日签到：不可用'
          : state.todayStatus === 1
            ? '今日签到：未开始'
            : null;
  const cycle = state.cycleClaimed > 0 ? `本周期已签到 ${state.cycleClaimed}/7 天` : null;
  return joinNotes(today, cycle);
}

/* ------------------------------------------------------------------ *
 * 登录方法
 * ------------------------------------------------------------------ */

const SCAN_DEFAULT_INTERVAL_MS = 5_000;
const SCAN_SLOW_DOWN_STEP_MS = 5_000;
/** 设备码授权页只接受这些域名，防止上游返回一个外部链接被前端渲染成二维码 */
const SCAN_VERIFICATION_HOSTS = new Set([
  'account.minimax.cn',
  'agent.minimax.cn',
  'agent.minimaxi.com',
]);

interface ScanSecret {
  verifier: string;
  /** 轮询令牌时提交的 code：标准设备码是 `device_code`，账号侧变体是 `user_code` */
  pollingCode: string;
  pollingParam: 'device_code' | 'user_code';
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  /** 拿到令牌后暂存，身份查询失败时下一轮直接复用，不重复消费设备码 */
  grant?: OauthGrant;
}

/** 登录方法没有真实账号上下文：用一个最小配置指向国内站即可 */
function loginAccountConfig(): AccountConfig {
  return {
    provider: 'minimax',
    enabled: true,
    displayName: null,
    credentials: {},
    options: { site: 'cn' },
  };
}

/** `expired_in` 可能是秒也可能是毫秒（客户端两种都处理），统一成秒 */
function normalizeExpirySeconds(value: number | null, now: number): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1_000_000_000_000) return value;
  const remainingMs = value - now;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null;
}

/**
 * 「扫码登录」：MiniMax Code 的 OAuth 2.0 设备码流程。
 *
 * 前端把 `verification_uri_complete` 画成本地二维码；用户在手机 / 浏览器确认后，
 * 服务端后台轮询 `/oauth2/token` 拿 Bearer 令牌，再用 `/v1/api/user/info`
 * 取 `realUserID`，交给登录会话层验证与落库。
 */
function makeMinimaxScanLogin(): ProviderLogin {
  return {
    id: 'scan',
    label: '扫码登录',
    hint: '用手机扫码，或在新窗口打开链接确认登录；确认后本页面自动完成添加。',
    qr: true,
    intervalMs: 2_000,
    async start(input) {
      const now = input.now || Date.now();
      const timeoutMs = input.timeoutMs || MINIMAX_TIMEOUT_FALLBACK;
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');

      const response = await postOauthForm(
        `${MINIMAX_ACCOUNT_CN}/oauth2/device/code`,
        {
          client_id: OAUTH_CLIENT_ID,
          scope: OAUTH_SCOPE,
          audience: OAUTH_AUDIENCE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
        timeoutMs,
      );
      if (response.status < 200 || response.status >= 300 || response.body.error) {
        throw new Error(`申请扫码登录失败：${oauthErrorText(response.body)}`);
      }

      const body = response.body;
      const userCode = firstString(pick(body, 'user_code', 'userCode'));
      const standardDeviceCode = firstString(pick(body, 'device_code', 'deviceCode'));
      const accountExpiredAt = firstNumber(pick(body, 'expired_in', 'expiredIn'));
      const accountVariant = !standardDeviceCode && Boolean(userCode) && accountExpiredAt !== null;
      const pollingCode = standardDeviceCode || (accountVariant ? userCode : '');
      const verificationUri = firstString(
        pick(body, 'verification_uri', 'verification_url', 'verificationUri'),
      );
      const verificationComplete =
        firstString(pick(body, 'verification_uri_complete', 'verificationUriComplete')) ||
        verificationUri;

      const expiresIn =
        firstNumber(pick(body, 'expires_in', 'expiresIn')) ??
        normalizeExpirySeconds(accountExpiredAt, now);
      const rawInterval = firstNumber(pick(body, 'interval'));
      const intervalMs = accountVariant
        ? rawInterval ?? SCAN_DEFAULT_INTERVAL_MS
        : (rawInterval ?? 5) * 1000;

      if (!pollingCode || !userCode || !verificationComplete || expiresIn === null || expiresIn <= 0) {
        throw new Error('扫码登录响应不完整（缺少设备码 / 授权链接 / 有效期），请稍后重试。');
      }

      let verificationUrl: URL;
      try {
        verificationUrl = new URL(verificationComplete);
      } catch {
        throw new Error('扫码登录返回的授权链接不是合法 URL，请稍后重试。');
      }
      if (
        verificationUrl.protocol !== 'https:' ||
        !SCAN_VERIFICATION_HOSTS.has(verificationUrl.hostname) ||
        verificationUrl.username ||
        verificationUrl.password
      ) {
        throw new Error(`扫码登录返回了非预期授权域名（${verificationUrl.hostname}），已拒绝。`);
      }

      const ttlMs = Math.min(expiresIn * 1000, SCAN_LOGIN_MAX_TTL_MS);
      input.log(`已申请 MiniMax Code 设备码（有效期 ${Math.round(ttlMs / 1000)} 秒）`);

      const secret: ScanSecret = {
        verifier,
        pollingCode,
        pollingParam: accountVariant ? 'user_code' : 'device_code',
        intervalMs: Math.max(3_000, Math.min(60_000, intervalMs)),
        nextPollAt: now + Math.max(3_000, Math.min(60_000, intervalMs)),
        expiresAt: now + ttlMs,
      };

      return {
        authUrl: verificationUrl.toString(),
        qr: true,
        ttlMs,
        hint:
          '用手机扫码，或打开链接在 MiniMax 账号页确认登录' +
          (userCode ? `（确认码：${userCode}）` : '') +
          '；确认后本页面会自动完成添加。',
        secret,
      };
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) {
        return { status: 'failed', message: '登录会话缺少设备码参数，请重新发起。' };
      }
      const state = secret as unknown as ScanSecret;
      if (Date.now() >= state.expiresAt) {
        return { status: 'failed', message: '扫码登录已过期，请重新获取二维码。' };
      }
      if (Date.now() < state.nextPollAt) {
        return { status: 'waiting', message: '等待手机确认登录…' };
      }
      state.nextPollAt = Date.now() + state.intervalMs;

      let grant = state.grant;
      if (!grant) {
        const response = await postOauthForm(
          `${MINIMAX_ACCOUNT_CN}/oauth2/token`,
          {
            grant_type: DEVICE_GRANT_TYPE,
            [state.pollingParam]: state.pollingCode,
            client_id: OAUTH_CLIENT_ID,
            code_verifier: state.verifier,
          },
          ctx.timeoutMs || MINIMAX_TIMEOUT_FALLBACK,
        );
        const body = response.body;
        const status = firstString(pick(body, 'status')).toLowerCase();
        const error = firstString(pick(body, 'error')).toLowerCase();

        if (status === 'slow_down' || error === 'slow_down') {
          state.intervalMs += SCAN_SLOW_DOWN_STEP_MS;
          return { status: 'waiting', message: '上游要求降低轮询频率，继续等待确认…' };
        }
        if (status === 'pending' || error === 'authorization_pending') {
          return { status: 'waiting', message: '等待手机确认登录…' };
        }
        if (['denied', 'access_denied'].includes(status) || error === 'access_denied') {
          return { status: 'failed', message: '登录授权已被拒绝，请重新获取二维码。' };
        }
        if (
          ['expired', 'expired_token'].includes(status) ||
          ['expired_token', 'invalid_grant'].includes(error)
        ) {
          return { status: 'failed', message: '授权码已过期，请重新获取二维码。' };
        }
        if (error || response.status < 200 || response.status >= 300) {
          return {
            status: 'failed',
            message: `扫码登录失败：${oauthErrorText(body)}${error ? '' : `（HTTP ${response.status}）`}`,
          };
        }
        grant = parseOauthGrant(body);
        state.grant = grant;
      }

      // 令牌已到手：再读账号身份（realUserID 是公共参数与落库去重的必需值）
      try {
        const identity = await fetchOauthIdentity(loginAccountConfig(), ctx, grant.accessToken);
        ctx.log(`MiniMax 扫码登录已拿到 OAuth 令牌（账号键 ${identity.userId}），开始验证落库`);
        return {
          status: 'ready',
          account: { id: identity.userId, name: identity.name },
          credentials: {
            accessToken: grant.accessToken,
            ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
          },
          options: {
            authMode: 'oauth',
            userId: identity.userId,
            ...(grant.expiresAt > 0 ? { expiresAt: String(grant.expiresAt) } : {}),
          },
          message: '登录成功，正在验证取数并写入本机配置…',
        };
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          return { status: 'failed', message: `OAuth 令牌无法读取账号身份：${error.message}` };
        }
        return {
          status: 'waiting',
          message: `已拿到登录令牌，正在读取账号身份…（${(error as Error).message}）`,
        };
      }
    },
  };
}

/**
 * 「网页端登录」：服务端拉起调试 Chrome 打开 agent.minimax.cn，
 * 用户在那个窗口登录后，从页面 localStorage 与浏览器真实请求头抓取：
 *
 *   `_token`              → 请求头 token
 *   `user_detail_agent`   → realUserID / op_ticket / param token
 *   `UNIQUE_USER_ID`      → uuid
 *   真实 Cookie 头         → SSO 会话
 *
 * 这些值缺一不可（只发 token 或 user_id=0 都会被上游 401 拒绝）。
 */
function makeMinimaxWebLogin(): ProviderLogin {
  return {
    id: 'web',
    kind: 'web',
    label: '网页端登录',
    hint: '自动打开调试 Chrome 的 MiniMax Code 页面；你在那个窗口登录后，本页面自动完成添加。',
    qr: false,
    intervalMs: WEB_POLL_INTERVAL_MS,
    async start(input) {
      const chrome = await ensureDebugChrome();
      input.log(
        `MiniMax Code 调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
      );
      const collector = await openCookieCollector({ url: MINIMAX_ORIGIN_CN });
      input.log('MiniMax Code 页面已打开，等待登录');

      return {
        authUrl: MINIMAX_ORIGIN_CN,
        qr: false,
        ttlMs: WEB_LOGIN_TTL_MS,
        hint: '请在刚打开的 Chrome 窗口里登录 MiniMax Code（agent.minimax.cn）；登录后本页面会自动完成添加。',
        secret: { collector, startedAt: Date.now(), reloads: 0, lastReloadAt: 0, tokenReloaded: false },
      };
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) {
        return { status: 'failed', message: '登录会话缺少采集器参数，请重新发起。' };
      }
      const collector = pick(secret, 'collector') as CookieCollector | undefined;
      const startedAt = Number(pick(secret, 'startedAt')) || Date.now();
      if (!collector || typeof collector.cookieFor !== 'function') {
        return { status: 'failed', message: '登录会话缺少采集器，请重新发起。' };
      }

      const hosts = ['agent.minimax.cn', 'minimax.cn'];
      const rawCookie = collector.cookieFor(hosts);
      const token = (await collector.localStorageItem('_token')).trim();
      const profile = await collector.localStorageObject('user_detail_agent');
      const deviceUuid = (await collector.localStorageItem('UNIQUE_USER_ID')).trim();

      const rawUserId = profile ? pick(profile, 'realUserID', 'real_user_id', 'userId') : undefined;
      const userId =
        typeof rawUserId === 'number' && Number.isFinite(rawUserId)
          ? String(rawUserId)
          : typeof rawUserId === 'string' && /^\d+$/.test(rawUserId.trim())
            ? rawUserId.trim()
            : '';
      const profileOpTicket = profile ? pick(profile, 'op_ticket') : undefined;
      const opTicket = typeof profileOpTicket === 'string' ? profileOpTicket.trim() : '';
      const profileToken = profile ? pick(profile, 'token') : undefined;
      const paramToken =
        typeof profileToken === 'string' && profileToken.trim() ? profileToken.trim() : token;
      const profileName = profile
        ? firstString(pick(profile, 'nickname', 'nickName', 'name', 'userName', 'user_name'))
        : '';

      /**
       * 刚登录完时页面可能只写了 localStorage、还没发出带新 Cookie 的请求：
       * 第一次看到 token 后主动刷新一次，确保采集到的是登录态之后真实发出的 Cookie，
       * 而不是登录前的访客 Cookie。只做一次，避免与用户的页面操作互相打断。
       */
      if (token && !pick(secret, 'tokenReloaded')) {
        secret.tokenReloaded = true;
        await collector.reload();
        return {
          status: 'waiting',
          message: '已检测到登录令牌，正在刷新页面以采集 SSO Cookie…',
        };
      }

      const loggedIn = Boolean(token) && Boolean(rawCookie) && Boolean(userId);
      if (!loggedIn) {
        // 刷新策略：只在页面确实空闲时刷新，且限次 + 最小间隔
        const reloads = Number(pick(secret, 'reloads')) || 0;
        const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
        const now = Date.now();
        const idle = collector.idleMs();
        const idleLongEnough = idle >= WEB_RELOAD_IDLE_MS || idle === 0;
        if (
          reloads < WEB_RELOAD_MAX &&
          idleLongEnough &&
          now - lastReloadAt >= WEB_RELOAD_MIN_INTERVAL_MS
        ) {
          await collector.reload();
          if (isRecord(secret)) {
            secret.reloads = reloads + 1;
            secret.lastReloadAt = now;
          }
        }

        const waitedSec = Math.round((now - startedAt) / 1000);
        let detail = '';
        if (token && !rawCookie) detail = '（已拿到登录令牌，等待页面发出带 Cookie 的请求）';
        else if (token && rawCookie && !userId) detail = '（已拿到登录态，但还没读到 userId）';
        return {
          status: 'waiting',
          message: `正在等待你在调试 Chrome 窗口里登录 MiniMax Code${detail}（已等待 ${waitedSec} 秒）…`,
        };
      }

      const cookie = normalizeCookieHeader(rawCookie ?? '');
      ctx.log(`MiniMax 网页端登录已抓到 token / Cookie（账号键 ${userId}），开始验证落库`);
      return {
        status: 'ready',
        account: { id: userId, name: profileName },
        credentials: {
          token,
          cookie,
          userId,
          ...(opTicket ? { opTicket } : {}),
          ...(paramToken ? { paramToken } : {}),
          ...(deviceUuid ? { uuid: deviceUuid } : {}),
        },
        // 显式写 web：如果这个账号此前是扫码（OAuth）登录，必须把 authMode 覆盖回来
        options: { authMode: 'web', userId },
        message: '已抓到登录态，正在验证取数并写入本机配置…',
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

const scanLogin = makeMinimaxScanLogin();
const webLogin = makeMinimaxWebLogin();

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  displayName: 'MiniMax Code',
  region: 'cn',
  dashboardUrl: 'https://agent.minimax.cn',
  usageUrl: 'https://platform.minimaxi.com/console/usage',
  requiredCredentialKeys: ['token', 'cookie', 'userId'],
  /**
   * 两种登录形态：Web（token + Cookie + 真实身份参数）与 OAuth（accessToken，
   * 扫码登录写入）。`requiredCredentialKeys` 表达不了「A 或 B」，由这里判断。
   */
  isConfigured: (account) => {
    if (isOauthAccount(account)) {
      return Boolean(account.credentials.accessToken || account.credentials.access_token);
    }
    const token = account.credentials.token || account.credentials.accessToken;
    return Boolean(token) && Boolean(account.credentials.cookie);
  },
  credentialHint:
    '推荐直接用卡片上的「扫码登录」或「网页端登录」：扫码走 MiniMax Code 的 OAuth 设备码，' +
    '网页端会打开调试 Chrome 并在登录后自动抓取 token / SSO Cookie / 真实身份参数。' +
    '也可以跑 npm run capture -- minimax 手工抓取；手工填写的凭证须同时包含 ' +
    'token（localStorage `_token`）、SSO Cookie 与 user_id（user_detail_agent.realUserID）。',
  manageAccounts: true,
  manageFields: [
    {
      key: 'token',
      label: '登录令牌（_token）',
      placeholder: '登录 agent.minimax.cn → DevTools → Application → Local Storage → _token',
      hint: '请求头 token 的来源；与 SSO Cookie 必须同时提供。',
      multiline: true,
    },
    {
      key: 'cookie',
      label: 'SSO Cookie',
      placeholder: '登录 agent.minimax.cn 后，从任意请求的 Headers → Cookie 整段复制',
      hint: '缺了它只发 token 会被上游 401 拒绝。',
      multiline: true,
    },
    {
      key: 'userId',
      label: '用户 ID（realUserID）',
      placeholder: 'localStorage 的 user_detail_agent.realUserID（18 位，按字符串原样粘贴）',
      hint: '公共参数 user_id，服务端会与 token 身份交叉校验，不能写 0。',
      secret: false,
    },
    {
      key: 'opTicket',
      label: 'op_ticket（可选）',
      placeholder: 'user_detail_agent.op_ticket',
      hint: '多数账号为空；有则填，缺省时不带该参数。',
      required: false,
    },
    {
      key: 'paramToken',
      label: 'param token（可选）',
      placeholder: 'user_detail_agent.token（通常与 _token 相同）',
      hint: '留空时使用上面的登录令牌。',
      required: false,
    },
    {
      key: 'uuid',
      label: '设备 uuid（可选）',
      placeholder: 'localStorage 的 UNIQUE_USER_ID',
      hint: '留空时由 token 派生一个稳定值。',
      required: false,
      secret: false,
    },
  ],
  manageHint:
    '凭证会先真实调用一次积分明细接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；' +
    '写入前自动备份到 .run/。扫码 / 网页端登录写入的是同一份配置，不需要手工再填。',
  envNames: {
    token: 'MINIMAX_CODE_TOKEN',
    cookie: 'MINIMAX_COOKIE',
    userId: 'MINIMAX_USER_ID',
    opTicket: 'MINIMAX_OP_TICKET',
    paramToken: 'MINIMAX_PARAM_TOKEN',
    uuid: 'MINIMAX_UUID',
    accessToken: 'MINIMAX_ACCESS_TOKEN',
    refreshToken: 'MINIMAX_REFRESH_TOKEN',
  },
  /** 默认方法 = 扫码；完整清单给前端渲染两个按钮（扫码 / 网页端） */
  login: scanLogin,
  loginMethods: [scanLogin, webLogin],
  /**
   * 获取明细：积分到账记录（签到 / 购买）都带精确的 granted_at_ms，
   * 因此「增量」走上游；「用量」没有逐日粒度（只有每批次的累计消耗），
   * 声明为未覆盖，由本地采样兜底。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const credential = isOauthAccount(account)
      ? resolveAccessToken(account, ctx)
      : resolveWebToken(account, ctx);
    if (!credential) return null;
    try {
      // 明细按「新→旧」返回：取到昨日之前的记录（或已取全）才算窗口完整，
      // 否则宁可退回本地采样，避免「只给了一半、另一半静默为 0」
      const startMs = startOfDay(ctx.now) - 86_400_000;
      const result = await fetchMinimaxCreditDetails(account, ctx, 5);
      const oldestSeen = result.items.reduce(
        (min, detail) => Math.min(min, detail.grantedAt),
        Number.POSITIVE_INFINITY,
      );
      if (!result.complete && oldestSeen >= startMs) {
        ctx.log('MiniMax 积分明细超过翻页上限，增量退回本地采样');
        return null;
      }
      const records: UsageRecord[] = [];
      for (const detail of result.items) {
        if (detail.grantedAt < startMs || detail.grantedAt > ctx.now + 3_600_000) continue;
        if (detail.granted <= 0) continue;
        records.push({ at: detail.grantedAt, kind: 'grant', amount: detail.granted });
      }
      return { records, covers: { use: false, grant: true } };
    } catch (error) {
      ctx.log(`MiniMax 积分明细获取失败（增量退回本地采样）：${(error as Error).message}`);
      return null;
    }
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    if (isOauthAccount(account)) {
      if (!resolveAccessToken(account, ctx)) {
        return notConfigured(minimaxAdapter, account, ctx, ['accessToken']);
      }
    } else {
      const missing: string[] = [];
      if (!resolveWebToken(account, ctx)) missing.push('token');
      if (!resolveCookie(account, ctx)) missing.push('cookie');
      if (!cred(account, ctx, ['userId', 'user_id'])) missing.push('userId');
      if (missing.length > 0) return notConfigured(minimaxAdapter, account, ctx, missing);
    }

    try {
      const result = await fetchMinimaxCreditDetails(account, ctx);

      // 卡片的「额度进度条」：由明细推导（平台没有账户级汇总接口）——
      // 统计仍在有效期内的批次（含已用尽），limit=授予量之和、remaining=剩余之和。
      // 已过期批次的剩余已作废、消耗属历史，计入只会稀释当前进度，故排除。
      let windowGranted = 0;
      let windowRemaining = 0;
      let windowEarliestExpiry: number | null = null;
      let usedUpCount = 0;
      const entries: Array<{ detail: MinimaxCreditDetail; lot: CreditLot }> = [];
      for (const [index, detail] of result.items.entries()) {
        if (detail.expiresAt >= ctx.now) {
          windowGranted += detail.granted;
          windowRemaining += detail.remaining;
          windowEarliestExpiry =
            windowEarliestExpiry === null
              ? detail.expiresAt
              : Math.min(windowEarliestExpiry, detail.expiresAt);
        }
        if (detail.remaining <= 0) {
          usedUpCount += 1;
          continue;
        }
        entries.push({
          detail,
          lot: makeLot({
            id: `minimax-${detail.creditType}-${detail.grantedAt}-${index}`,
            label: creditLabel(detail.creditType),
            amount: detail.remaining,
            granted: detail.granted,
            currency: 'CREDITS',
            expiresAt: toIso(detail.expiresAt),
            note: detail.consumed > 0 ? `已用 ${formatAmount(detail.consumed)}` : '',
          }),
        });
      }

      const { active, expired } = splitByExpiry(entries.map((entry) => entry.lot), ctx.now);
      const balance = Math.round(active.reduce((sum, lot) => sum + lot.amount, 0) * 100) / 100;

      // 「签到 + 购买」拆分只统计仍在有效期内的批次，口径与 balance 保持一致
      const activeIds = new Set(active.map((lot) => lot.id));
      let checkinRemaining = 0;
      let purchasedRemaining = 0;
      for (const entry of entries) {
        if (!activeIds.has(entry.lot.id)) continue;
        if (entry.detail.creditType === CREDIT_TYPE_PURCHASED) purchasedRemaining += entry.lot.amount;
        else checkinRemaining += entry.lot.amount;
      }

      // 签到状态是锦上添花，失败不影响余额展示
      let signin: MinimaxSigninState | null = null;
      try {
        signin = await fetchMinimaxSigninState(account, ctx);
      } catch (error) {
        ctx.log(`MiniMax 签到状态获取失败（不影响余额）：${(error as Error).message}`);
      }

      const splitNote =
        checkinRemaining > 0 || purchasedRemaining > 0
          ? `签到积分 ${formatAmount(checkinRemaining)} · 购买积分 ${formatAmount(purchasedRemaining)}`
          : null;

      // 没有有效期内授予量时不伪造窗口：不画进度条，好过画一条无意义的空条
      const window =
        windowGranted > 0
          ? makeWindow({
              kind: 'billing',
              label: '积分额度（有效期内）',
              used: Math.max(0, windowGranted - windowRemaining),
              limit: windowGranted,
              remaining: windowRemaining,
              boundary: 'expiry',
              expiresAt: toIso(windowEarliestExpiry),
            })
          : null;

      return buildSnapshot({
        adapter: minimaxAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: balance, currency: 'CREDITS' },
        credits: active,
        windows: window ? [window] : [],
        note: joinNotes(
          splitNote,
          signinNote(signin),
          hiddenLotsNote(expired, usedUpCount),
          result.complete
            ? null
            : `积分批次超过 ${result.items.length} 条，当前统计未覆盖全部（建议核对 App 内积分总额）`,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(minimaxAdapter, account, ctx, status, (error as Error).message);
    }
  },
};