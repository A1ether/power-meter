import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import { resolveRuntimeDir } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractHeaderValue,
  failure,
  hiddenLotsNote,
  joinNotes,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  type CheckinResult,
  type CheckinRemoteState,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * Trae（trae.cn）
 *
 * 关键点一：网页版接口用 `Cloud-IDE-JWT`，而该 Token **只有效约 1 天**。
 * 实测 `GetUserToken` 可以用登录态 Cookie 换取新 Token，
 * 因此这里只要求用户提供 Cookie，Token 每次刷新自动续签。
 *
 * 关键点二：**`usage.credits_amount` 是「已用量」而不是「授予量」**。
 * 实测 `Σ usage.credits_amount === usage_summary.consumed_amount`
 * （1361.5476 === 1361.55），因此每个包的剩余 = credits_limit - credits_amount。
 * 用完的包会被过滤掉，不再展示。
 *
 * 请求链路（均已实测）：
 *   ① POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken      （Cookie 鉴权）
 *      → { Result: { Token, ExpiredAt, TenantID } }
 *   ② POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list
 *      Authorization: Cloud-IDE-JWT <Token>
 *      → { usage_summary: { consumed_amount, total_amount },
 *          user_entitlement_pack_list: [ { display_desc, expire_time, usage,
 *            entitlement_base_info: { quota: { credits_limit } } } ] }
 */

const TRAE_TOKEN_URL = 'https://api.trae.cn/cloudide/api/v3/common/GetUserToken';
const TRAE_USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list';
const TRAE_TIMEOUT_FALLBACK = 12_000;

/* ------------------------------------------------------------------ *
 * 登录（OAuth + 本地回调）与 DeviceProof 刷新
 * ------------------------------------------------------------------ */

/**
 * Trae CN 的 OAuth 常量（从 `Trae CN 1.107.1` 的 `out/main.js` 提取）：
 *   - client_id：TRAE 稳定版固定 `ono9krqynydwx5`（SOLO 为 `en1oxy7wnw8j9n`）
 *   - 回调：`http://127.0.0.1:<port>/authorize`，只认 `/authorize` 路径
 *   - 换令牌：`POST {apiHost}/trae/api/v3/oauth/ExchangeToken`
 *       `{ ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion }`
 *   - 刷新：同一端点，body 带 `RefreshToken` + `DeviceProof{Signature,Timestamp,Nonce}`；
 *       签名内容 `[method, path, clientId, refreshToken, timestamp, nonce].join('\n')`
 *   - 取用户：`POST {apiHost}/cloudide/api/v3/trae/GetUserInfo`，头 `x-cloudide-token`
 *
 * 扫码不可行：回调固定落到 127.0.0.1，手机扫码后回调会打到手机自己。
 */
const TRAE_CONSOLE_HOST = 'https://www.trae.cn';
const TRAE_API_HOST = 'https://api.trae.cn';
const TRAE_CLIENT_ID = 'ono9krqynydwx5';
const TRAE_LOGIN_TTL_MS = 5 * 60 * 1000;
/** 与官方 IDE 的 `appVersion` 同形；上游只做展示/兼容，不参与签名 */
const TRAE_IDE_VERSION = '1.107.1';

/**
 * 设备密钥对（EC P-256）。
 *
 * 国内版与国际版（`trae-global.ts`）共用同一套 OAuth / DeviceProof 密码学，
 * 因此这里连同下面的工具函数一起导出；国际版只换主机与计费面，不复制实现。
 */
export interface TraeDeviceKey {
  /** PKCS8 PEM（base64 后写进 .env，避免多行变量） */
  privateKeyPem: string;
  publicKeyPem: string;
}

export function traeDeviceKeyFromPem(privateKeyPem: string): TraeDeviceKey {
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  return { privateKeyPem, publicKeyPem };
}

/** 生成 EC P-256 密钥对（与官方 `Oxe()` 同一参数） */
export function traeGenerateDeviceKey(): TraeDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: String(privateKey), publicKeyPem: String(publicKey) };
}

/** 登录设备身份：同一台机器重复登录时必须复用，不能每次生成新设备 */
export interface TraeLoginDeviceIdentity {
  deviceId: string;
  machineId: string;
  privateKeyPem: string;
}

/**
 * 取（必要时创建）某平台的登录设备身份。
 *
 * Trae 的 `ExchangeToken` 会按设备签发令牌，并对同账号的设备数量设上限；
 * 每次登录都 `traeGenerateDeviceKey() + randomUUID()` 会被上游当成一台新设备，
 * 多次重试后直接返回 `040034 Device limit reached`。官方 IDE 在本地固定一份
 * 设备身份，这里同样把 `{ deviceId, machineId, privateKeyPem }` 落到
 * `<cwd>/.run/login-device/<provider>.json`（`.run/` 已 gitignore，桌面端 cwd
 * 是配置目录），后续每次登录复用同一份。
 *
 * 私钥只在服务端用于 DeviceInfo / DeviceProof，不写日志、不下发前端。
 */
export function traeLoginDeviceIdentity(providerId: string): TraeLoginDeviceIdentity {
  const file = resolve(resolveRuntimeDir(), 'login-device', `${providerId}.json`);
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(raw)) {
      const deviceId = firstString(pick(raw, 'deviceId'));
      const machineId = firstString(pick(raw, 'machineId'));
      const privateKeyPem = firstString(pick(raw, 'privateKeyPem'));
      if (deviceId && machineId && privateKeyPem) {
        // 校验私钥可解析；损坏时走下面的重建分支
        traeDeviceKeyFromPem(privateKeyPem);
        return { deviceId, machineId, privateKeyPem };
      }
    }
  } catch {
    // 文件不存在 / JSON 损坏 / 私钥不可解析：重建一份
  }
  const key = traeGenerateDeviceKey();
  const identity: TraeLoginDeviceIdentity = {
    deviceId: randomUUID(),
    machineId: randomUUID(),
    privateKeyPem: key.privateKeyPem,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // 落盘失败不影响本次登录，只是下次会重新生成（并再占一个设备位）
  }
  return identity;
}

/**
 * 重新登录**已有账号**时优先复用该账号已注册的设备身份。
 *
 * 为什么不能只用 `.run/login-device/<provider>.json`：Trae 按账号限制设备数，
 * 并向每台设备签发凭证。若本机身份文件在历史登录之后被重建（换机器、删 `.run`、
 * 桌面端与 Web 端配置目录不同），它与账号里保存的 `deviceKey/deviceId/machineId`
 * 就不是同一台设备；再次登录会被上游按**新设备**计数，直接返回
 * `040034 Device limit reached`。
 *
 * 判定：三件套齐全且私钥可解析才复用；否则退回本机持久化身份（新设备场景）。
 */
export function traeReusableDeviceIdentity(
  existing: AccountConfig | undefined,
  providerId: string,
): TraeLoginDeviceIdentity {
  const rawKey = existing
    ? (existing.credentials.deviceKey ?? existing.credentials.devicePrivateKey ?? '')
    : '';
  const deviceId =
    existing && typeof existing.options.deviceId === 'string' ? existing.options.deviceId.trim() : '';
  const machineId =
    existing && typeof existing.options.machineId === 'string'
      ? existing.options.machineId.trim()
      : '';
  if (rawKey && deviceId && machineId) {
    const pem = rawKey.includes('BEGIN') ? rawKey : Buffer.from(rawKey, 'base64').toString('utf8');
    try {
      traeDeviceKeyFromPem(pem); // 私钥损坏时不带病复用
      return { deviceId, machineId, privateKeyPem: pem };
    } catch {
      // 退回本机身份
    }
  }
  return traeLoginDeviceIdentity(providerId);
}

/**
 * 把上游的「设备数量已达上限」翻译成可操作的中文提示。
 * 其他错误返回 null，交给登录会话层按网络抖动继续重试。
 */
export function traeDeviceLimitMessage(error: unknown, siteLabel: string): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!/040034|20401|Device limit reached/i.test(message)) return null;
  return (
    `${siteLabel}拒绝了本次登录：设备数量已达上限（Device limit reached / 040034）。` +
    'Trae 官方建议等待 24 小时后从原设备重试；若仍失败，请联系平台支持重置设备限制，' +
    '也可以改用 Cookie 方式添加。'
  );
}

/** PKCE：verifier = base64url(random 48 bytes)，challenge = base64url(sha256(verifier)) */
export function traePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * DeviceProof：时间戳用**秒**，nonce 16 字节 hex，
 * 签名内容逐行拼接后 ECDSA-SHA256，再 base64。
 */
export function traeDeviceProof(
  method: string,
  path: string,
  clientId: string,
  refreshToken: string,
  privateKeyPem: string,
): { signature: string; timestamp: number; nonce: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const payload = [method, path, clientId, refreshToken, String(timestamp), nonce].join('\n');
  const signature = sign('sha256', Buffer.from(payload), privateKeyPem).toString('base64');
  return { signature, timestamp, nonce };
}

/** `DeviceInfo`：字段名是协议事实，不能改风格（PascalCase） */
export function traeDeviceInfo(account: AccountConfig, key: TraeDeviceKey): Record<string, string> {
  return {
    DeviceID: optString(account, 'deviceId') || randomUUID(),
    MachineID: optString(account, 'machineId') || randomUUID(),
    PlatformCode: 'IDE_PC',
    DeviceType: 'PC',
    DeviceName: optString(account, 'deviceName') || 'power-meter',
    DeviceModel: '',
    ClientVersion: TRAE_IDE_VERSION,
    DevicePublicKey: key.publicKeyPem,
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: '',
    OSVersion: '',
  };
}

/** 解出账号的 deviceKey（`.env` 里存的是 PKCS8 PEM 的 base64） */
function traeDeviceKeyOf(account: AccountConfig, ctx: ProbeContext): TraeDeviceKey | null {
  const raw = cred(account, ctx, ['deviceKey', 'devicePrivateKey']);
  if (!raw) return null;
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    return traeDeviceKeyFromPem(pem);
  } catch {
    return null;
  }
}

/** ExchangeToken 的响应信封：{ Result: { Token, RefreshToken, ... } } */
function traeExchangeResult(body: unknown): Record<string, unknown> {
  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  if (!isRecord(result)) throw new Error('ExchangeToken 响应缺少 Result');
  return result;
}

/**
 * 用 refreshToken + DeviceProof 换新 JWT。
 * 新值由调用方写回 `.env`（accessToken 每次探测都会变，必须落盘避免重复刷新）。
 */
async function traeRefreshJwt(
  account: AccountConfig,
  ctx: ProbeContext,
  refreshToken: string,
  key: TraeDeviceKey,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAtMs: number }> {
  const apiHost = optString(account, 'apiHost') || TRAE_API_HOST;
  const path = '/trae/api/v3/oauth/ExchangeToken';
  const proof = traeDeviceProof('POST', path, TRAE_CLIENT_ID, refreshToken, key.privateKeyPem);
  const { body } = await fetchJson(`${apiHost}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
    body: JSON.stringify({
      ClientID: TRAE_CLIENT_ID,
      ClientSecret: '',
      RefreshToken: refreshToken,
      DeviceInfo: traeDeviceInfo(account, key),
      DeviceProof: {
        Signature: proof.signature,
        Timestamp: proof.timestamp,
        Nonce: proof.nonce,
      },
      IDEVersion: TRAE_IDE_VERSION,
    }),
    timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
  });
  const result = traeExchangeResult(body);
  const accessToken = firstString(pick(result, 'Token', 'token'));
  if (!accessToken) throw new Error('ExchangeToken 未返回 Token，需重新登录');
  const nextRefresh = firstString(pick(result, 'RefreshToken', 'refreshToken'));
  const expiresAt = toIso(pick(result, 'ExpiredAt', 'expiredAt'));
  return {
    accessToken,
    refreshToken: nextRefresh || null,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : Date.now() + 10 * 60_000,
  };
}

/** 用 JWT 取账号身份（登录落库时用于生成卡片名） */
async function traeFetchUserInfo(
  apiHost: string,
  token: string,
  ctx: ProbeContext,
): Promise<{ id: string; name: string }> {
  const { body } = await fetchJson(`${apiHost}/cloudide/api/v3/trae/GetUserInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': token },
    body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: TRAE_IDE_VERSION }),
    timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
  });
  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  const data = isRecord(result) ? pick(result, 'Data', 'data') : undefined;
  const info = isRecord(data) ? pick(data, 'UserInfo', 'userInfo') ?? data : undefined;
  const id = firstString(isRecord(info) ? pick(info, 'UserID', 'userId', 'uid', 'ID') : undefined);
  const name = firstString(
    isRecord(info) ? pick(info, 'ScreenName', 'screenName', 'UserName', 'userName', 'Name') : undefined,
  );
  return { id, name };
}

/**
 * 回调参数解析：Trae 把 `authCodeInfo`（JSON）、`userInfo`（用户 JSON）与
 * `host` / `consoleHost` 追加到 `auth_callback_url`。`authCodeInfo` 可能是
 * URL 编码的 JSON，也可能被拆成 `authCodeInfo[AuthCode]=...` 形式，两种都兼容。
 */
export function traeReadCallback(query: URLSearchParams): {
  authCode: string;
  userJwt: string;
  userInfo: string;
  consoleHost: string;
  apiHost: string;
} {
  const authCodeInfo = query.get('authCodeInfo') ?? '';
  let authCode = '';
  if (authCodeInfo) {
    try {
      const parsed = JSON.parse(authCodeInfo);
      if (isRecord(parsed)) authCode = firstString(pick(parsed, 'AuthCode', 'authCode'));
    } catch {
      // 不是 JSON：可能被上游直接放成裸 AuthCode
      authCode = authCodeInfo.trim();
    }
  }
  if (!authCode) authCode = firstString(query.get('AuthCode'), query.get('authCode'));
  if (!authCode) {
    // `authCodeInfo[AuthCode]=...` 形式（部分版本用 qs 风格序列化）
    authCode = firstString(query.get('authCodeInfo[AuthCode]'), query.get('authCodeInfo[authCode]'));
  }
  return {
    authCode,
    userJwt: firstString(query.get('userJwt'), query.get('user_jwt')),
    // 官方授权页回跳时写的是 userInfo（授权页 chunk 里 `userInfo: ea`）；
    // `userJwt` 只用于兼容旧版。两者都是 URL 里的 JSON 文本。
    userInfo: firstString(query.get('userInfo'), query.get('user_info')),
    consoleHost: firstString(query.get('consoleHost'), query.get('host')),
    apiHost: firstString(query.get('apiHost'), query.get('host')),
  };
}

/**
 * 生成 `auth_callback_url`：官方授权页只接受 `http://127.0.0.1:<port>/authorize`
 * （无查询串、主机名必须是字面量 `127.0.0.1`），所以这里把回环主机统一成
 * `127.0.0.1`——它同样能连到监听 `0.0.0.0` 或 `localhost` 的服务。
 */
export function traeCallbackUrl(callbackBase: string): string {
  let port = '';
  try {
    port = new URL(callbackBase).port;
  } catch {
    // 基址不合法时退回调用方给的字符串（服务端自己拼的基址，正常不会走到这里）
  }
  if (!port) return `${callbackBase.replace(/\/+$/, '')}/authorize`;
  return `http://127.0.0.1:${port}/authorize`;
}

/**
 * Trae 回调域名白名单：只接受 Trae 自己的域名及其子域，防止 SSRF/令牌外送。
 *
 * `domainPattern` 让国际版复用同一份校验，只把域名换成 `trae.ai`；
 * 不传时行为与国内版完全一致（`trae.cn` / `trae.com.cn`）。
 */
export function traeHostAllowed(
  value: string,
  fallback: string,
  domainPattern = /(^|\.)trae\.(cn|com\.cn)$/,
): string {
  const candidate = value || fallback;
  let hostname = '';
  try {
    hostname = new URL(candidate).hostname.toLowerCase();
  } catch {
    return fallback;
  }
  return domainPattern.test(hostname) ? candidate.replace(/\/+$/, '') : fallback;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** 按 Cookie 缓存换来的 JWT，避免每次刷新都多打一次接口 */
const tokenCache = new Map<string, CachedToken>();

/**
 * 按 refreshToken 缓存续期得到的 JWT。
 *
 * 场景：一轮刷新里 `probe()` 与 `fetchUsageLedger()` 各解析一次令牌，若第一次
 * 因显式令牌过期而续期，第二次仍拿着旧快照；缓存让两次都用同一枚新令牌
 * （否则明细可能再续期一次，甚至因 refreshToken 轮换而失败）。
 */
const refreshTokenCache = new Map<string, CachedToken>();

function refreshTokenKey(refreshToken: string): string {
  return `refresh-${cookieKey(refreshToken)}`;
}

function cookieKey(cookie: string): string {
  let hash = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    hash = (hash * 31 + cookie.charCodeAt(index)) | 0;
  }
  return `trae-${hash}`;
}

export interface TraePack {
  label: string;
  limit: number;
  used: number;
  remaining: number;
  expiresAt: string | null;
}

export interface TraeUsage {
  packs: TraePack[];
  /** 已用尽的包数量（会被过滤，仅用于提示） */
  usedUpCount: number;
  summaryUsed: number;
  summaryTotal: number;
}

export function parseTraeUsage(body: unknown): TraeUsage {
  if (!isRecord(body)) throw new Error('Trae 返回了非对象响应');
  const summary = pick(body, 'usage_summary', 'usageSummary');
  const packsRaw = pick(body, 'user_entitlement_pack_list', 'userEntitlementPackList');
  if (!Array.isArray(packsRaw)) {
    throw new Error('响应缺少 user_entitlement_pack_list（Token 可能已失效）');
  }

  const packs: TraePack[] = [];
  let usedUpCount = 0;

  for (const raw of packsRaw) {
    if (!isRecord(raw)) continue;
    const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo') ?? raw;
    const quota = isRecord(base) ? pick(base, 'quota') : undefined;
    const limit = firstNumber(
      isRecord(quota) ? pick(quota, 'credits_limit', 'creditsLimit') : undefined,
    );
    // 没有 credits_limit 的是功能权益（免费版的开关项），不是积分
    if (limit === null || limit <= 0) continue;

    const usage = pick(raw, 'usage');
    const used = firstNumber(isRecord(usage) ? pick(usage, 'credits_amount', 'creditsAmount') : undefined) ?? 0;
    const remaining = Math.max(0, limit - Math.max(0, used));
    if (remaining <= 0) {
      usedUpCount += 1;
      continue;
    }

    const label =
      firstString(
        pick(raw, 'display_desc', 'displayDesc'),
        pick(raw, 'group_name', 'groupName'),
        isRecord(base) ? pick(base, 'product_name', 'productName') : undefined,
      ) || '权益包';
    const expiresAt =
      toIso(pick(raw, 'expire_time', 'expireTime')) ??
      toIso(isRecord(base) ? pick(base, 'end_time', 'endTime') : undefined);

    packs.push({ label, limit, used, remaining, expiresAt });
  }

  const summaryUsed = firstNumber(
    isRecord(summary) ? pick(summary, 'consumed_amount', 'consumedAmount') : undefined,
  );
  const summaryTotal = firstNumber(
    isRecord(summary) ? pick(summary, 'total_amount', 'totalAmount') : undefined,
  );

  return {
    packs,
    usedUpCount,
    summaryUsed: summaryUsed ?? 0,
    summaryTotal: summaryTotal ?? 0,
  };
}

/**
 * 把同名且同时到期的包归并成一条，避免签到类平台出现几十条重复批次。
 *
 * `currency` / `idPrefix` 让国际版复用同一份归并逻辑：国际版按美元或次数计量，
 * 批次 id 也必须带自己的前缀，否则两个平台的批次 id 会撞。
 */
export function mergeLots(
  packs: TraePack[],
  options: { currency?: CreditLot['currency']; idPrefix?: string } = {},
): CreditLot[] {
  const currency = options.currency ?? 'CREDITS';
  const idPrefix = options.idPrefix ?? 'trae';
  const grouped = new Map<
    string,
    { label: string; expiresAt: string | null; remaining: number; limit: number; count: number }
  >();
  for (const pack of packs) {
    const key = `${pack.label}|${pack.expiresAt ?? ''}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.remaining += pack.remaining;
      entry.limit += pack.limit;
      entry.count += 1;
    } else {
      grouped.set(key, {
        label: pack.label,
        expiresAt: pack.expiresAt,
        remaining: pack.remaining,
        limit: pack.limit,
        count: 1,
      });
    }
  }

  return [...grouped.entries()]
    .sort((a, b) => {
      const aTime = a[1].expiresAt ? Date.parse(a[1].expiresAt) : Number.POSITIVE_INFINITY;
      const bTime = b[1].expiresAt ? Date.parse(b[1].expiresAt) : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })
    .map(([key, entry]) =>
      makeLot({
        id: `${idPrefix}-${key}`,
        label: entry.label,
        amount: entry.remaining,
        currency,
        expiresAt: entry.expiresAt,
        note:
          entry.count > 1
            ? `${entry.count} 个同类包合计：剩余 ${Math.round(entry.remaining * 100) / 100} / 额度 ${entry.limit}`
            : `额度 ${entry.limit}`,
      }),
    );
}

export interface ResolveJwtOptions {
  /**
   * 只走可续期路径（refreshToken → Cookie）：跳过显式 accessToken 与内存缓存。
   * 用于令牌被上游拒绝后的自愈重试。
   */
  renewOnly?: boolean;
}

/**
 * 解析可用的 Cloud-IDE-JWT。顺序：
 *   ⓪ refreshToken 续期缓存（同一轮刷新里 probe 与明细复用同一枚新令牌）；
 *   ① 显式 accessToken（登录产物或手工粘贴）——直接使用；
 *   ② 登录产物的 refreshToken + deviceKey——刷新一次并写回 `.env`；
 *   ③ Cookie 换 JWT（历史路径，行为不变）。
 *
 * `renewOnly` 跳过 ⓪①：显式令牌刚被上游拒绝时不能再用它。
 */
async function resolveJwt(
  account: AccountConfig,
  ctx: ProbeContext,
  options: ResolveJwtOptions = {},
): Promise<string> {
  const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);
  if (refreshToken && !options.renewOnly) {
    const cached = refreshTokenCache.get(refreshTokenKey(refreshToken));
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;
  }

  const explicit = extractHeaderValue(
    cred(account, ctx, ['accessToken', 'token', 'authorization']),
    'authorization',
  )
    .replace(/^cloud-ide-jwt\s+/i, '')
    .trim();
  if (explicit && !options.renewOnly) return explicit;

  const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
  const key = traeDeviceKeyOf(account, ctx);
  if (refreshToken && key) {
    try {
      ctx.log('Trae 登录令牌缺失或被拒，尝试用 refreshToken + DeviceProof 续期');
      const refreshed = await traeRefreshJwt(account, ctx, refreshToken, key);
      refreshTokenCache.set(refreshTokenKey(refreshToken), {
        token: refreshed.accessToken,
        expiresAtMs: refreshed.expiresAtMs,
      });
      if (ctx.persistCredentials) {
        const patch: Record<string, string> = { accessToken: refreshed.accessToken };
        if (refreshed.refreshToken) patch.refreshToken = refreshed.refreshToken;
        try {
          await ctx.persistCredentials(patch);
        } catch (persistError) {
          ctx.log(`Trae 新令牌写回 .env 失败（不影响本次取数）：${(persistError as Error).message}`);
        }
      }
      return refreshed.accessToken;
    } catch (refreshError) {
      if (!cookie) throw refreshError;
      ctx.log(`Trae refreshToken 续期失败，改用 Cookie：${(refreshError as Error).message}`);
    }
  }

  return resolveTokenFromCookie(account, ctx, { ignoreCache: options.renewOnly === true });
}

/** 用 Cookie 换取（并缓存）Cloud-IDE-JWT */
async function resolveTokenFromCookie(
  account: AccountConfig,
  ctx: ProbeContext,
  options: { ignoreCache?: boolean } = {},
): Promise<string> {
  const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
  if (!cookie) {
    throw new Error('缺少 Trae 登录令牌与 Cookie：请重新登录，或粘贴 Cookie。');
  }

  const key = cookieKey(cookie);
  const cached = tokenCache.get(key);
  if (!options.ignoreCache && cached && cached.expiresAtMs - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const { body } = await fetchJson(TRAE_TOKEN_URL, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'https://www.trae.cn',
      Referer: 'https://www.trae.cn/',
    },
    body: '{}',
    timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
  });

  const result = isRecord(body) ? pick(body, 'Result', 'result') : undefined;
  const token = firstString(isRecord(result) ? pick(result, 'Token', 'token') : undefined);
  if (!token) {
    throw new Error('GetUserToken 未返回 Token，Cookie 可能已失效');
  }
  const expiresAt = toIso(isRecord(result) ? pick(result, 'ExpiredAt', 'expiredAt') : undefined);
  tokenCache.set(key, {
    token,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : Date.now() + 6 * 60 * 60 * 1000,
  });
  ctx.log('已用 Cookie 续签 Trae Token');
  return token;
}

/** 令牌被上游拒绝后清掉缓存，确保下一次解析真的去换新令牌 */
function invalidateJwtCaches(account: AccountConfig, ctx: ProbeContext): void {
  const refreshToken = cred(account, ctx, ['refreshToken', 'refresh_token']);
  if (refreshToken) refreshTokenCache.delete(refreshTokenKey(refreshToken));
  const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
  if (cookie) tokenCache.delete(cookieKey(cookie));
}

const TRAE_CHECKIN_BASE = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits';
/**
 * 成长页（/trae/api/v2/ug/…）的 UA：Trae SOLO CN 的 Electron 外壳。
 * 用脚本类 UA 请求会被上游按 9074（当前参与用户太多）拒绝，见 magpie `trae_checkin.go`。
 */
const TRAE_UG_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) TRAE-SOLO-CN/0.1.69 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36';
const TRAE_UG_BRAND = 'ASUS TUF Gaming A15 FA507RM_FA507RM';
const TRAE_UG_CLIENT_VERSION = '0.1.69';

/**
 * 签到用的设备标识。
 *
 * Trae CN 的领取按设备判定：15 位数字才被接受，16/19 位实测返回 9074。
 * 账号已有 15 位 `deviceId` 时原样使用；否则按「账号设备 + uid」派生一个
 * **稳定**的 15 位数字（同一账号每次相同，不轮换、不冒充他人），
 * 与 magpie 的 `ugDevice()` 同一算法。
 */
function traeCheckinDeviceId(account: AccountConfig): string {
  const own = optString(account, 'deviceId');
  if (/^\d{15}$/.test(own)) return own;
  const uid = optString(account, 'uid');
  const n = BigInt(
    `0x${createHash('sha256').update(`trae-cn-device\0${own}\0${uid}`).digest('hex').slice(0, 30)}`,
  );
  return String(100_000_000_000_000n + (n % 900_000_000_000_000n));
}

interface TraeCheckinAnswer {
  code?: number;
  message?: string;
  enable?: boolean;
  checked_in?: boolean;
  checkedIn?: boolean;
  credits?: number;
  extra_credits?: number;
  extraCredits?: number;
}

/** 成长页请求：固定 IDE 形态的头，body 为 `{req_source:1}`。 */
async function traeCheckinCall(
  account: AccountConfig,
  ctx: ProbeContext,
  token: string,
  action: 'status' | 'claim',
): Promise<TraeCheckinAnswer> {
  const { body } = await fetchJson(`${TRAE_CHECKIN_BASE}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Cloud-IDE-JWT ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': TRAE_UG_USER_AGENT,
      'x-device-id': traeCheckinDeviceId(account),
      'x-device-brand': TRAE_UG_BRAND,
      'x-device-type': 'Windows',
      'x-os-version': '10.0.22631',
      'x-app-version': TRAE_UG_CLIENT_VERSION,
    },
    body: JSON.stringify({ req_source: 1 }),
    timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
  });
  return isRecord(body) ? (body as TraeCheckinAnswer) : {};
}

/** 每日签到（Trae 国内版）：先读状态，仅在开启且今日未签时领取。 */
export async function traeCheckin(
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<CheckinResult> {
  try {
    const token = await resolveJwt(account, ctx);
    return await traeWithAuthRetry({
      label: 'Trae ',
      ctx,
      token,
      resolve: (options) => resolveJwt(account, ctx, options),
      invalidate: () => invalidateJwtCaches(account, ctx),
      run: async (jwt) => {
        const status = await traeCheckinCall(account, ctx, jwt, 'status');
        const code = firstNumber(pick(status, 'code')) ?? 0;
        if (code === 1001) {
          throw new Error('Trae 登录态已失效，请重新登录');
        }
        if (code !== 0) {
          return { outcome: 'failed', message: traeCheckinRefusal(code, status.message) };
        }
        const credits = firstNumber(pick(status, 'credits')) ?? 0;
        if (pick(status, 'checked_in', 'checkedIn') === true) {
          return {
            outcome: 'done',
            credit: credits,
            message: credits > 0 ? `今日已签到（${credits} 积分）` : '今日已签到',
          };
        }
        if (pick(status, 'enable') === false) {
          return { outcome: 'inactive', message: 'Trae 当前没有开启每日签到活动' };
        }

        const claim = await traeCheckinCall(account, ctx, jwt, 'claim');
        const claimCode = firstNumber(pick(claim, 'code')) ?? 0;
        if (claimCode === 9095) {
          return {
            outcome: 'ineligible',
            message: claim.message || '该设备今天已经签到过了',
          };
        }
        if (claimCode === 9074) {
          return {
            outcome: 'ineligible',
            message: claim.message || 'Trae 拒绝了本次领取（9074），请到 Trae 客户端内签到',
          };
        }
        if (claimCode === 1001) {
          throw new Error('Trae 登录态已失效，请重新登录');
        }
        if (claimCode !== 0) {
          return { outcome: 'failed', message: traeCheckinRefusal(claimCode, claim.message) };
        }
        const got =
          (firstNumber(pick(claim, 'credits')) ?? 0) +
          (firstNumber(pick(claim, 'extra_credits', 'extraCredits')) ?? 0);
        const total = got > 0 ? got : credits;
        return {
          outcome: 'claimed',
          credit: total,
          message: total > 0 ? `签到成功 +${total} 积分` : '签到成功',
        };
      },
    });
  } catch (error) {
    return { outcome: 'failed', message: `签到失败：${(error as Error).message}` };
  }
}

/** 只读：今天签了没有（同一个 status 接口，不调 claim） */
export async function traeCheckinStatus(
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<CheckinRemoteState> {
  const token = await resolveJwt(account, ctx);
  return traeWithAuthRetry({
    label: 'Trae ',
    ctx,
    token,
    resolve: (options) => resolveJwt(account, ctx, options),
    invalidate: () => invalidateJwtCaches(account, ctx),
    run: async (jwt) => {
      const status = await traeCheckinCall(account, ctx, jwt, 'status');
      const code = firstNumber(pick(status, 'code')) ?? 0;
      if (code === 1001) throw new Error('Trae 登录态已失效，请重新登录');
      if (code !== 0) throw new Error(traeCheckinRefusal(code, status.message));
      const credits = firstNumber(pick(status, 'credits')) ?? 0;
      if (pick(status, 'checked_in', 'checkedIn') === true) {
        return {
          signedToday: true,
          ...(credits > 0 ? { credit: credits } : {}),
          message: credits > 0 ? `今日已签到（${credits} 积分）` : '今日已签到',
        };
      }
      if (pick(status, 'enable') === false) {
        return { signedToday: false, inactive: true, message: 'Trae 当前没有开启每日签到活动' };
      }
      return { signedToday: false, message: '今天未签到' };
    },
  });
}

function traeCheckinRefusal(code: number, message?: string): string {
  const said = typeof message === 'string' && message.trim() ? `：${message.trim()}` : '';
  return `Trae 返回 code=${code}${said}`;
}

/**
 * 是否为「上游拒绝登录态」。
 *
 * 只认 401/403 与 Trae 的业务码 1001；网络层失败（`HttpError.status === 0`）
 * 与服务端 5xx 不属于登录态问题，不能触发续期重试（否则会把断网误当成过期）。
 */
export function traeIsAuthRejection(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status === 0) return false;
    if (error.status === 401 || error.status === 403) return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /"code"\s*:\s*1001\b|not able to authenticate|未授权|登录态已失效/i.test(message);
}

/**
 * 用「当前令牌」执行一次请求；被上游拒绝登录态时，清缓存 → 只走续期路径
 * 换一枚新令牌 → 重试一次。
 *
 * 两个 Trae 平台共用：国内版与国际版的续期协议相同，只是主机不同。
 */
export async function traeWithAuthRetry<T>(args: {
  label: string;
  ctx: ProbeContext;
  token: string;
  resolve: (options?: ResolveJwtOptions) => Promise<string>;
  invalidate: () => void;
  run: (token: string) => Promise<T>;
}): Promise<T> {
  try {
    return await args.run(args.token);
  } catch (error) {
    if (!traeIsAuthRejection(error)) throw error;
    args.ctx.log(`${args.label}令牌被上游拒绝，尝试自动续期后重试`);
    args.invalidate();
    let renewed: string;
    try {
      renewed = await args.resolve({ renewOnly: true });
    } catch (renewError) {
      throw new Error(
        `${args.label}登录态已失效（${(error as Error).message}），自动续期失败：` +
          `${(renewError as Error).message}。请重新登录，或在「手工填写凭证」里粘贴 Cookie。`,
      );
    }
    if (renewed === args.token) throw error;
    args.ctx.log(`${args.label}续期成功，已用新令牌重试`);
    return await args.run(renewed);
  }
}

export const traeAdapter: ProviderAdapter = {
  id: 'trae',
  displayName: 'Trae',
  region: 'cn',
  dashboardUrl: 'https://www.trae.cn/dashboard#usage',
  usageUrl: 'https://www.trae.cn/dashboard#usage',
  requiredCredentialKeys: ['cookie'],
  /**
   * 两种凭证形态：手工 Cookie（历史路径）或 OAuth 登录产物
   * （accessToken + refreshToken + deviceKey）。第 2 个账号用 `_2` 槽位。
   */
  envNames: {
    accessToken: 'TRAE_ACCESS_TOKEN',
    refreshToken: 'TRAE_REFRESH_TOKEN',
    deviceKey: 'TRAE_DEVICE_KEY',
  },
  // Cookie 可换 JWT；登录产物只要有 accessToken 就能取数，refreshToken+deviceKey 负责续期
  isConfigured: (account) =>
    Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken),
  credentialHint:
    '登录 trae.cn 后从 DevTools 复制任意 api.trae.cn 请求的 Cookie 头，填入 credentials.cookie。' +
    'Token 会自动续签，无需手工维护（也可用 npm run capture 自动抓取）；' +
    '或在看板上点「打开链接登录」自动写入 OAuth 令牌。',
  /** 登录入口与删除按钮走通用账号管理实现；手工表单只保留 Cookie（兜底） */
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '登录 trae.cn → DevTools → 任意 api.trae.cn 请求 → 复制 Cookie 整段值',
      hint: 'Cookie 会自动换取 Cloud-IDE-JWT；也可改用「打开链接登录」。',
      multiline: true,
    },
  ],
  manageHint:
    'Cookie 会先真实调用一次用量接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：`query_user_usage_group_by_session` 逐笔（`usage_time` + `credits_float`），
   *     与页面「使用记录」同源；
   *   - 获取：权益包列表逐笔（`start_time` 发放时间 + `quota.credits_limit` 发放额度），
   *     与页面「奖励积分 / 查看详情」同源——每日签到、每月登录赠送、套餐发放各成一笔。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const hasCookie = Boolean(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasExplicitToken = Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization']));
    const hasLoginTokens = Boolean(cred(account, ctx, ['refreshToken', 'refresh_token']));
    if (!hasCookie && !hasExplicitToken && !hasLoginTokens) return null;

    let token = await resolveJwt(account, ctx);
    // 与页面请求同源同参：usage_type=[7] 对应页面「使用记录」列表；
    // page_size 实测上限 20（再大会返回 400 code 9004），因此按 20 分页、上限 10 页
    const origin = new URL(optString(account, 'usageUrl') || TRAE_USAGE_URL).origin;
    const recordsUrl = `${origin}/trae/api/v1/pay/query_user_usage_group_by_session`;
    const startSec = Math.floor((startOfDay(ctx.now) - 86_400_000) / 1000);
    const endSec = Math.ceil(ctx.now / 1000);
    const pageSize = 20;
    const records: UsageRecord[] = [];

    const send = (jwt: string, pageNum: number) =>
      fetchJson(recordsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${jwt}`,
          'X-User-Region': 'CN',
          'Content-Type': 'application/json',
          Origin: 'https://www.trae.cn',
          Referer: 'https://www.trae.cn/',
        },
        body: JSON.stringify({
          start_time: startSec,
          end_time: endSec,
          page_size: pageSize,
          page_num: pageNum,
          usage_type: [7],
        }),
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });

    for (let pageNum = 1; pageNum <= 10; pageNum += 1) {
      // 首页承担自愈：显式令牌过期时续期一次，后续页与「获取明细」沿用新令牌
      const { body } =
        pageNum === 1
          ? await traeWithAuthRetry({
              label: 'Trae ',
              ctx,
              token,
              resolve: (options) => resolveJwt(account, ctx, options),
              invalidate: () => invalidateJwtCaches(account, ctx),
              run: (jwt) => send(jwt, pageNum),
            })
          : await send(token, pageNum);
      if (pageNum === 1) {
        // 自愈可能已换过新令牌：后续页与「获取明细」沿用（缓存命中，不会重复续期）
        try {
          token = await resolveJwt(account, ctx);
        } catch {
          // 沿用第一次的令牌：首页已经成功，不因二次解析失败丢弃结果
        }
      }
      const list = isRecord(body)
        ? pick(body, 'user_usage_group_by_sessions', 'userUsageGroupBySessions')
        : undefined;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const raw of list) {
        if (!isRecord(raw)) continue;
        const at = firstNumber(pick(raw, 'usage_time', 'usageTime'));
        const amount = firstNumber(pick(raw, 'credits_float', 'creditsFloat', 'credits'));
        if (at === null || amount === null || amount <= 0) continue;
        records.push({ at: at * 1000, kind: 'use', amount });
      }
      const total = firstNumber(isRecord(body) ? pick(body, 'total') : undefined);
      if (list.length < pageSize || (total !== null && pageNum * pageSize >= total)) break;
    }

    // 获取明细：权益包即「发放」逐笔——每个包带 start_time（发放时间）与
    // quota.credits_limit（发放额度），每日签到 / 每月登录赠送 / 套餐发放都会各成一笔
    let grantCovered = false;
    try {
      const { body } = await fetchJson(optString(account, 'usageUrl') || TRAE_USAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${token}`,
          'X-User-Region': 'CN',
          'Content-Type': 'application/json',
          Origin: 'https://www.trae.cn',
          Referer: 'https://www.trae.cn/',
        },
        body: '{}',
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });
      const packs = isRecord(body)
        ? pick(body, 'user_entitlement_pack_list', 'userEntitlementPackList')
        : undefined;
      if (Array.isArray(packs)) {
        for (const raw of packs) {
          if (!isRecord(raw)) continue;
          const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo');
          if (!isRecord(base)) continue;
          const start = firstNumber(pick(base, 'start_time', 'startTime'));
          const quota = pick(base, 'quota');
          const limit = isRecord(quota)
            ? firstNumber(pick(quota, 'credits_limit', 'creditsLimit'))
            : null;
          if (start === null || limit === null || limit <= 0) continue;
          records.push({ at: start * 1000, kind: 'grant', amount: limit });
        }
        grantCovered = true;
      }
    } catch (error) {
      ctx.log(`Trae 权益包发放明细获取失败（增量退回本地采样）：${(error as Error).message}`);
    }
    return { records, covers: { use: true, grant: grantCovered } };
  },

  /**
   * 「打开链接登录」：OAuth + 本地回调。
   *
   * 回调复用主服务端口，且**必须是裸地址** `http://127.0.0.1:<port>/authorize`：
   * 官方授权页对 `auth_callback_url` 做严格正则
   * `^http://127\.0\.0\.1:(\d+)/authorize$`，带任何查询串都会直接进入
   * 「登录失败」并显示兜底文案「网络错误，请刷新页面重试。」。
   * 会话定位因此改用「当前活跃会话」反查（见 `deliverLoginCallbackToActiveProvider`）。
   * `secret` 里保存 PKCE verifier 与设备私钥；`handleCallback` 收到授权码后
   * 由 `poll()` 完成换令牌 + 取用户信息。
   * 扫码不可行（回调固定 127.0.0.1），所以 `qr: false`。
   */
  login: {
    label: '打开链接登录',
    hint: '必须在本机浏览器打开（回调固定 127.0.0.1）；完成后回到本页面。',
    qr: false,
    intervalMs: 1_000,
    async start(input) {
      const consoleHost = TRAE_CONSOLE_HOST;
      const apiHost = TRAE_API_HOST;
      const { verifier, challenge } = traePkce();
      // 卡片级重新登录优先复用该账号已注册的设备：每次生成新密钥会被上游当成新设备，
      // 触发设备上限（040034）
      const identity = traeReusableDeviceIdentity(input.existingAccount, 'trae');
      const key = traeDeviceKeyFromPem(identity.privateKeyPem);
      const traceId = randomUUID();
      const machineId = identity.machineId;
      const deviceId = identity.deviceId;
      const callbackUrl = traeCallbackUrl(input.callbackBase);
      const query = new URLSearchParams({
        login_version: '1',
        auth_from: 'trae',
        login_channel: 'native_ide',
        plugin_version: TRAE_IDE_VERSION,
        auth_type: 'local',
        client_id: TRAE_CLIENT_ID,
        redirect: '0',
        login_trace_id: traceId,
        auth_callback_url: callbackUrl,
        machine_id: machineId,
        device_id: deviceId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      input.log('Trae 登录链接已生成，等待浏览器回调');
      return {
        authUrl: `${consoleHost}/authorization?${query.toString()}`,
        qr: false,
        ttlMs: TRAE_LOGIN_TTL_MS,
        hint: '在本机浏览器完成登录后，这个窗口会自动继续。',
        secret: {
          verifier,
          privateKeyPem: key.privateKeyPem,
          publicKeyPem: key.publicKeyPem,
          consoleHost,
          apiHost,
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
      if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少 OAuth 参数，请重新发起。' };
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
      const consoleHost = traeHostAllowed(firstString(pick(callback, 'consoleHost')), TRAE_CONSOLE_HOST);
      const apiHost = traeHostAllowed(firstString(pick(callback, 'apiHost')), TRAE_API_HOST);

      // ① 授权码换令牌（不需要 DeviceProof）
      let exchangeBody: unknown;
      try {
        ({ body: exchangeBody } = await fetchJson(`${apiHost}/trae/api/v3/oauth/ExchangeToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
          body: JSON.stringify({
            ClientID: TRAE_CLIENT_ID,
            AuthCode: authCode,
            CodeVerifier: verifier,
            DeviceInfo: traeDeviceInfo(
              {
                provider: 'trae',
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
            IDEVersion: TRAE_IDE_VERSION,
          }),
          timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
        }));
      } catch (error) {
        const limited = traeDeviceLimitMessage(error, 'Trae');
        if (limited) return { status: 'failed', message: limited };
        throw error;
      }
      const result = traeExchangeResult(exchangeBody);
      const accessToken = firstString(pick(result, 'Token', 'token'));
      const refreshToken = firstString(pick(result, 'RefreshToken', 'refreshToken'));
      if (!accessToken) return { status: 'failed', message: 'ExchangeToken 未返回 Token，请重试。' };

      // ② 取用户身份：优先回调里带的 userInfo / userJwt（省一次请求），否则用新 Token 查
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
          user = await traeFetchUserInfo(apiHost, accessToken, ctx);
        } catch (error) {
          ctx.log(`Trae 用户信息查询失败：${(error as Error).message}`);
        }
      }
      if (!user.id) {
        return {
          status: 'failed',
          message: '已拿到 Trae 令牌，但上游没有返回用户 ID，无法安全落库。请重试或改用 Cookie。',
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

  checkin: {
    support: (account) =>
      Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken)
        ? { ok: true }
        : { ok: false, reason: '需要 Cookie 或登录令牌才能签到' },
    status: (account, ctx) => traeCheckinStatus(account, ctx),
    run: (account, ctx) => traeCheckin(account, ctx),
  },
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const hasCookie = Boolean(cred(account, ctx, ['cookie', 'cookieHeader']));
    const hasExplicitToken = Boolean(cred(account, ctx, ['accessToken', 'token', 'authorization']));
    const hasLoginTokens = Boolean(cred(account, ctx, ['refreshToken', 'refresh_token']));
    if (!hasCookie && !hasExplicitToken && !hasLoginTokens) {
      return notConfigured(traeAdapter, account, ctx, ['cookie 或 accessToken+refreshToken+deviceKey']);
    }

    const usageUrl = optString(account, 'usageUrl') || TRAE_USAGE_URL;

    try {
      const token = await resolveJwt(account, ctx);
      // 显式 accessToken 只有约 1 天有效期；被上游拒绝时自愈续期一次再重试
      const { body } = await traeWithAuthRetry({
        label: 'Trae ',
        ctx,
        token,
        resolve: (options) => resolveJwt(account, ctx, options),
        invalidate: () => invalidateJwtCaches(account, ctx),
        run: (jwt) =>
          fetchJson(usageUrl, {
            method: 'POST',
            headers: {
              Authorization: `Cloud-IDE-JWT ${jwt}`,
              'X-User-Region': 'CN',
              Origin: 'https://www.trae.cn',
              Referer: 'https://www.trae.cn/',
            },
            body: '{}',
            timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
          }),
      });

      const parsed = parseTraeUsage(body);
      const round = (value: number): number => Math.round(value * 100) / 100;

      // 只统计「仍在有效期内且未用尽」的包，这样与 Trae 页面显示的 剩余/总额 一致
      const alivePacks = parsed.packs.filter(
        (pack) => !pack.expiresAt || Date.parse(pack.expiresAt) >= ctx.now,
      );
      const expiredPacks = parsed.packs.filter(
        (pack) => pack.expiresAt !== null && Date.parse(pack.expiresAt) < ctx.now,
      );

      const active = mergeLots(alivePacks);
      // 余额取「未用尽且未过期」的包之和（这是真正还能用的部分）；
      // 窗口分母用账户级 usage_summary，与 Trae 页面显示的「总可用积分」一致
      const usableRemaining = round(alivePacks.reduce((sum, pack) => sum + pack.remaining, 0));
      const balance =
        alivePacks.length > 0
          ? usableRemaining
          : round(Math.max(0, parsed.summaryTotal - parsed.summaryUsed));
      const expired = expiredPacks.map((pack, index) =>
        makeLot({
          id: `trae-expired-${index}`,
          label: pack.label,
          amount: pack.remaining,
          currency: 'CREDITS',
          expiresAt: pack.expiresAt,
        }),
      );

      const nextExpiry =
        active
          .map((lot) => lot.expiresAt)
          .filter((value): value is string => typeof value === 'string')
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（本期）',
        used: parsed.summaryUsed,
        limit: parsed.summaryTotal,
        remaining: balance,
        boundary: nextExpiry ? 'expiry' : 'mixed',
        expiresAt: nextExpiry,
      });

      return buildSnapshot({
        adapter: traeAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: balance, currency: 'CREDITS' },
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired, parsed.usedUpCount),
          active.length === 0 ? '所有积分包都已用尽或过期' : null,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.kind
        : traeIsAuthRejection(error)
          ? 'unauthorized'
          : 'error';
      return failure(traeAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
