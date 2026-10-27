import { createHash } from 'node:crypto';
import { endOfBeijingDay } from '../lib/beijing-time.js';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  failure,
  isPlaceholderAccountName,
  joinNotes,
  makeLot,
  normalizeCookieHeader,
  notConfigured,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
  type ProviderLogin,
} from './base.js';

/**
 * 商汤小浣熊（xiaohuanxiong.com/work/home）
 *
 * 官方文档只说明「账户区域 / 设置 → 资源用量」可以看余额、构成与明细，
 * **没有公开任何查询接口**。这里复刻的是网页端自身的内部接口（静态取证自
 * /Applications/商汤小浣熊.app/Contents/Resources/app.asar 的 webpack 产物，
 * 并用未登录请求实测过路由与错误形态），设计见
 * docs/plans/平台适配器-接入商汤小浣熊积分-开发设计方案.md：
 *
 *   GET  /api/web/points/v1/balance
 *        → { data: { available_points, daily_points, monthly_points,
 *                    reward_points, topup_points, topup_frozen,
 *                    enterprise_topup_points } }
 *   GET  /api/web/points/v2/bills?paging.limit=&type=all|income|expense&cursor=
 *        → { data: { items: [{ bill_id, biz_type, biz_id, event_name,
 *                             points(有符号), created_at, grant_at, expire_at }],
 *                    next_cursor|cursor, has_more } }
 *   GET  /api/web/auth/v1/entitlement_info
 *        → { data: { office: { active_plan: { type, subscription_expired_at,
 *                          one_time_purchase_expired_at }, pro_enable, ... } } }
 *   GET  /api/web/auth/v1/user_info   → { id, name, office_identity, orgs[] }
 *   POST /api/web/auth/v1/refresh     ← { refresh_token } → { access_token, refresh_token }
 *
 * 鉴权：**只认 `Authorization: Bearer <token>`**（实测只发 Cookie 会得到
 * `200001 authorization_empty_error`，只发错误 Bearer 会得到 `200003`）。
 * 令牌来自网页登录态 Cookie：优先 `xhx_token`（IAM 签发的 JWT，带 exp），
 * 其次 `raccoon_token`；续期用 `raccoon_refresh_token`。Electron 客户端那套
 * 带 `electron_` 前缀的 Cookie 名不属于网页端，这里不认。
 *
 * 口径（见方案文档 §5）：
 *   - 余额 = `available_points`（账户级权威数字）；
 *   - 四类积分（每日 / 每月 / 加油包 / 奖励）各拆成一条 `CreditLot`，
 *     金额取账户级各桶剩余、到期时间取「积分明细」里同类发放记录的 `expire_at`
 *     （每月缺失时退回订阅到期；每日缺失时退回北京时间当日 24:00）；
 *   - 加油包永久有效 → `expiresAt = null`，不参与「最快到期」；
 *   - 明细流水里 `points < 0` 记 `use`、`> 0` 记 `grant`，`biz_type` 含 expire
 *     的过期记录两边都不计（过期既不是花掉的、也不是到账的）。
 */

const XHX_TIMEOUT_FALLBACK = 12_000;
const XHX_ORIGIN = 'https://xiaohuanxiong.com';
/** 「资源用量」页：卡片「每日用量」跳转与网页端登录打开的都是它 */
const XHX_USAGE_URL = 'https://xiaohuanxiong.com/work/settings/resource';
/** 明细分页：50 条 × 10 页，够覆盖「昨日 00:00 至今」；超出即退回本地采样 */
const BILLS_PAGE_SIZE = 50;
const BILLS_MAX_PAGES = 10;
/** 网页端登录（CDP 抓取）节奏：与 CodeBuddy 同一套常量 */
const XHX_WEB_POLL_INTERVAL_MS = 2_000;
const XHX_WEB_RELOAD_IDLE_MS = 20_000;
const XHX_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
const XHX_WEB_RELOAD_MAX = 2;
const XHX_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
/** 功能性登录判据：页面自己请求余额接口拿到 2xx 即视为已登录 */
const XHX_WEB_IDENTITY_PATH = '/api/web/points/v1/balance';

/** 网页端登录态 Cookie 名（不含 Electron 的 `electron_` 前缀） */
const COOKIE_TOKEN_NAMES = ['xhx_token', 'raccoon_token'] as const;
const COOKIE_REFRESH_TOKEN = 'raccoon_refresh_token';

/** 鉴权失败的业务码：令牌为空 / 校验失败 / 令牌过期 */
const AUTH_CODES = new Set([200001, 200003, 200009]);

/**
 * 「积分明细」里各类积分的判定关键字。
 * 上游 `biz_type` 枚举未穷举（实测到 `daily_grant` / `daily_expire`），
 * 因此用关键字匹配，认不出的一律归 `other`——只影响批次到期时间的精细度，
 * 不影响余额。
 */
const BUCKET_KEYWORDS: Array<{ bucket: XhxBucket; pattern: RegExp }> = [
  { bucket: 'daily', pattern: /daily|day_/i },
  // 加油包排在「每月」之前：购买类记录的 biz_type 里常带 subscription，
  // 若先匹配 monthly 会被误归到「每月赠送」上，到期时间就错了。
  // 反过来误归到加油包无害——加油包按规则永久有效，不从明细取到期时间。
  { bucket: 'topup', pattern: /topup|top_up|booster|recharge|purchase/i },
  { bucket: 'reward', pattern: /reward|activity|campaign|redeem|gift|promo|invite/i },
  { bucket: 'monthly', pattern: /monthly|month_|subscription/i },
];

export type XhxBucket = 'daily' | 'monthly' | 'topup' | 'reward' | 'other';

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  return (override || XHX_ORIGIN).replace(/\/+$/, '');
}

/** 从 Cookie 头里取单个 Cookie 值（不区分大小写、忽略空白） */
export function cookieValueOf(header: string, name: string): string {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    return trimmed.slice(eq + 1).trim();
  }
  return '';
}

/**
 * 从网页登录态 Cookie 里推导访问令牌。
 *
 * 顺序与客户端一致：`xhx_token`（IAM JWT）优先，其次 `raccoon_token`。
 * 两者都缺失时返回空串——调用方据此判 `notConfigured`。
 */
export function tokenFromCookie(header: string): string {
  for (const name of COOKIE_TOKEN_NAMES) {
    const value = cookieValueOf(header, name);
    if (value) return value;
  }
  return '';
}

function resolveCookie(account: AccountConfig, ctx: ProbeContext): string {
  return normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
}

function resolveRefreshToken(account: AccountConfig, ctx: ProbeContext): string {
  const explicit = cred(account, ctx, ['refreshToken', 'refresh_token']);
  if (explicit) return explicit.replace(/^Bearer\s+/i, '').trim();
  return cookieValueOf(resolveCookie(account, ctx), COOKIE_REFRESH_TOKEN);
}

/** 访问令牌：显式配置优先，缺失时从 Cookie 推导 */
function resolveToken(account: AccountConfig, ctx: ProbeContext): string {
  const explicit = cred(account, ctx, ['token', 'accessToken', 'access_token']);
  if (explicit) return explicit.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
  return tokenFromCookie(resolveCookie(account, ctx));
}

/**
 * 统一信封：{ code, message, details, data }。
 *
 * 没有业务码时（裸对象响应）取 `body.data` 优先、缺失才用响应体本身——
 * 避免「响应里没有 code」被误判成「响应里没有 data」。
 */
function xhxEnvelope(body: unknown): { code: number | null; message: string; data: unknown } {
  if (!isRecord(body)) return { code: null, message: '', data: body };
  const raw = pick(body, 'code', 'biz_code');
  const code =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : null;
  const message = firstString(pick(body, 'message', 'details', 'msg'));
  const nested = pick(body, 'data');
  return { code, message, data: code === null ? (nested ?? body) : nested };
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  return /200001|200003|200009|authorization|unauthorized|登录态|未登录/i.test(
    (error as Error)?.message ?? '',
  );
}

/** 业务失败：把上游 message / details 原样带出，便于排查改版 */
function assertXhxOk(body: unknown, fallback: string): unknown {
  const { code, message, data } = xhxEnvelope(body);
  if (code === null || code === 0) return data;
  const detail = message ? `：${message}` : '';
  if (AUTH_CODES.has(code)) {
    throw new HttpError(`${fallback}${detail}（code=${code}，登录态可能已失效）`, 401);
  }
  throw new Error(`${fallback}${detail}（code=${code}）`);
}

function xhxHeaders(token: string, cookie: string, account: AccountConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const orgCode = optString(account, 'orgCode');
  if (orgCode) headers['X-Org-Code'] = orgCode;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * 本轮刷新出来的令牌（按账号对象缓存，`WeakMap` 不阻止回收）。
 *
 * 一次 `probe()` 会连着打余额、明细、订阅、身份四个接口；若各自拿着过期令牌
 * 各刷一次，会把刚轮换出来的令牌刷废（与 codebuddy.ts 的 `cbRefreshCache` 同一动机）。
 * 配置热加载会重建 account 对象，缓存随之自然失效。
 */
const tokenCache = new WeakMap<AccountConfig, string>();

/**
 * 带令牌续期的请求：先试当前令牌，鉴权失败（HTTP 401/403 或业务码
 * `200001/200003/200009`）且存在 refreshToken 时续期一次并重放。
 *
 * 返回的是**解信封后的 `data`**——鉴权判断要在这一层做，才能覆盖「HTTP 200 +
 * 业务码表示令牌失效」的情形。续期结果通过 `ctx.persistCredentials` 写回 `.env`
 * （与 codebuddy.ts 同一范式）；写回失败只记日志，不阻断本次取数。
 */
async function xhxRequest(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  label: string,
  options: { method?: 'GET' | 'POST'; body?: string } = {},
): Promise<unknown> {
  const origin = resolveOrigin(account);
  const cookie = resolveCookie(account, ctx);
  const method = options.method ?? 'GET';
  const timeoutMs = ctx.timeoutMs || XHX_TIMEOUT_FALLBACK;

  const run = async (token: string): Promise<unknown> => {
    const { body } = await fetchJson(`${origin}${path}`, {
      method,
      headers: xhxHeaders(token, cookie, account),
      body: options.body ?? null,
      timeoutMs,
    });
    // 业务码也可能表示令牌失效（HTTP 200 + code=200003），统一在这一层抛成 401
    return assertXhxOk(body, label);
  };

  const token = tokenCache.get(account) ?? resolveToken(account, ctx);
  try {
    return await run(token);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;
    const refreshToken = resolveRefreshToken(account, ctx);
    if (!refreshToken) throw error;

    ctx.log('小浣熊登录令牌已失效，尝试用 refreshToken 续期');
    const refreshed = await xhxRefresh(account, ctx, refreshToken, token);
    tokenCache.set(account, refreshed.accessToken);
    if (ctx.persistCredentials) {
      const patch: Record<string, string> = { token: refreshed.accessToken };
      if (refreshed.refreshToken) patch.refreshToken = refreshed.refreshToken;
      try {
        await ctx.persistCredentials(patch);
      } catch (persistError) {
        ctx.log(`小浣熊新令牌写回 .env 失败（不影响本次取数）：${(persistError as Error).message}`);
      }
    }
    return run(refreshed.accessToken);
  }
}

/**
 * 令牌续期；响应里没有 access_token 即视为需要重新登录。
 *
 * 请求头与客户端一致：带当前令牌的 `Authorization`（上游可能拿它做会话旁证），
 * 不带 Cookie——续期只需要 `refresh_token` 这一件事。
 *
 * 注意：续期结果只有在账号的 `credentials.token` 是 `${VAR}` 引用时才会写回 `.env`；
 * 只配了 Cookie（没有独立 token 字段）的账号续期后无法持久化，下次刷新仍会拿
 * Cookie 里的旧令牌——这类账号建议改用 `npm run capture` 或网页端登录，
 * 让三个变量一起落盘。
 */
async function xhxRefresh(
  account: AccountConfig,
  ctx: ProbeContext,
  refreshToken: string,
  currentToken = '',
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const origin = resolveOrigin(account);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  const { body } = await fetchJson(`${origin}/api/web/auth/v1/refresh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refresh_token: refreshToken }),
    timeoutMs: ctx.timeoutMs || XHX_TIMEOUT_FALLBACK,
  });
  const payload = assertXhxOk(body, '令牌续期失败');
  const source = isRecord(payload) ? payload : {};
  const accessToken = firstString(pick(source, 'access_token', 'accessToken'));
  if (!accessToken) throw new Error('续期响应里没有 access_token，需重新登录小浣熊');
  return {
    accessToken,
    refreshToken: firstString(pick(source, 'refresh_token', 'refreshToken')) || null,
  };
}

/* ------------------------------------------------------------------ *
 * 余额
 * ------------------------------------------------------------------ */

export interface XhxBalance {
  available: number;
  daily: number;
  monthly: number;
  reward: number;
  topup: number;
  /** 加油包是否被冻结（升级版到期 / 降级后冻结，重新升级可恢复） */
  topupFrozen: boolean;
  /** 企业共享加油包（企业成员才有） */
  enterpriseTopup: number;
}

export function parseXhxBalance(data: unknown): XhxBalance {
  const source = isRecord(data) ? data : {};
  const num = (key: string): number => Math.max(0, firstNumber(pick(source, key)) ?? 0);
  return {
    available: num('available_points'),
    daily: num('daily_points'),
    monthly: num('monthly_points'),
    reward: num('reward_points'),
    topup: num('topup_points'),
    topupFrozen: pick(source, 'topup_frozen') === true,
    enterpriseTopup: num('enterprise_topup_points'),
  };
}

/* ------------------------------------------------------------------ *
 * 积分明细
 * ------------------------------------------------------------------ */

export interface XhxBill {
  id: string;
  bizType: string;
  eventName: string;
  /** 有符号：> 0 发放，< 0 消耗 / 退款扣除 */
  points: number;
  /** 发生时间（epoch ms） */
  at: number;
  /** 该笔的到期时间（epoch ms），无 / 哨兵值（1970）时为 null */
  expiresAt: number | null;
}

/** 客户端把 `1971-01-01` 之前的 expire_at 当作「无到期时间」 */
const EXPIRY_SENTINEL_MS = Date.parse('1971-01-01T00:00:00Z');

function parseBill(raw: unknown): XhxBill | null {
  if (!isRecord(raw)) return null;
  const points = firstNumber(pick(raw, 'points'));
  if (points === null) return null;
  const at =
    Date.parse(toIso(pick(raw, 'created_at', 'createdAt', 'grant_at', 'grantAt')) ?? '') ||
    Number.NaN;
  if (!Number.isFinite(at)) return null;
  const expiryIso = toIso(pick(raw, 'expire_at', 'expireAt'));
  const expiryMs = expiryIso ? Date.parse(expiryIso) : Number.NaN;
  return {
    id: firstString(pick(raw, 'bill_id', 'billId')) || `${at}-${points}`,
    bizType: firstString(pick(raw, 'biz_type', 'bizType')),
    eventName: firstString(pick(raw, 'event_name', 'eventName')),
    points,
    at,
    expiresAt:
      Number.isFinite(expiryMs) && expiryMs > EXPIRY_SENTINEL_MS ? expiryMs : null,
  };
}

export interface XhxBillsResult {
  items: XhxBill[];
  /** 是否已取全（翻到窗口边界或没有下一页） */
  complete: boolean;
}

/**
 * 拉取积分明细（新→旧，游标分页）。
 *
 * `stopBefore` 给定时，遇到早于该时刻的记录即停止并判定「已取全」——
 * 用量统计只需要「昨日 00:00 之后」这一段。
 */
export async function fetchXhxBills(
  account: AccountConfig,
  ctx: ProbeContext,
  options: { type?: 'all' | 'income' | 'expense'; maxPages?: number; stopBefore?: number } = {},
): Promise<XhxBillsResult> {
  const items: XhxBill[] = [];
  const maxPages = options.maxPages ?? BILLS_MAX_PAGES;
  let cursor = '';
  let complete = false;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      'paging.limit': String(BILLS_PAGE_SIZE),
      type: options.type ?? 'all',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await xhxRequest(
      account,
      ctx,
      `/api/web/points/v2/bills?${params.toString()}`,
      '积分明细请求失败',
    );
    const payload = isRecord(data) ? data : {};
    const list = pick(payload, 'items');
    if (!Array.isArray(list)) throw new Error('积分明细响应缺少 items 字段（令牌可能已失效）');

    for (const raw of list) {
      const bill = parseBill(raw);
      if (bill) items.push(bill);
    }

    const nextCursor = firstString(
      pick(payload, 'next_cursor', 'nextCursor'),
      isRecord(pick(payload, 'paging'))
        ? firstString(pick(pick(payload, 'paging'), 'next_cursor', 'cursor'))
        : '',
      pick(payload, 'cursor'),
    );
    const hasMoreFlag = pick(payload, 'has_more');
    const hasMore =
      hasMoreFlag === true || (hasMoreFlag === undefined && Boolean(nextCursor));

    if (options.stopBefore !== undefined) {
      const oldest = items.reduce((min, bill) => Math.min(min, bill.at), Number.POSITIVE_INFINITY);
      if (oldest < options.stopBefore) {
        complete = true;
        break;
      }
    }
    // 没有下一页 / 空页 = 取到尽头
    if (!hasMore || list.length === 0) {
      complete = true;
      break;
    }
    // 上游说还有、却没给游标：无法继续翻页，如实标记「未取全」
    // （否则会静默把「只拿到前 N 条」当成完整记录集，让日级用量偏小）
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return { items, complete };
}

function bucketOf(bill: XhxBill): XhxBucket {
  const haystack = `${bill.bizType} ${bill.eventName}`;
  for (const { bucket, pattern } of BUCKET_KEYWORDS) {
    if (pattern.test(haystack)) return bucket;
  }
  return 'other';
}

function isExpiryBill(bill: XhxBill): boolean {
  return /expire/i.test(bill.bizType);
}

/* ------------------------------------------------------------------ *
 * 订阅 / 身份
 * ------------------------------------------------------------------ */

export interface XhxEntitlement {
  /** 卡片上的套餐标签；取不到为 null */
  plan: string | null;
  /** 订阅到期时间（ISO）；每月积分的到期兜底 */
  subscriptionExpiresAt: string | null;
}

export function parseXhxEntitlement(data: unknown): XhxEntitlement {
  if (!isRecord(data)) return { plan: null, subscriptionExpiresAt: null };
  const office = isRecord(pick(data, 'office')) ? (pick(data, 'office') as Record<string, unknown>) : {};
  const plan = isRecord(pick(office, 'active_plan', 'activePlan'))
    ? (pick(office, 'active_plan', 'activePlan') as Record<string, unknown>)
    : {};

  const type = firstString(pick(plan, 'type'));
  const expiresAt =
    toIso(pick(plan, 'subscription_expired_at', 'subscriptionExpiredAt')) ??
    toIso(pick(plan, 'one_time_purchase_expired_at', 'oneTimePurchaseExpiredAt')) ??
    toIso(pick(office, 'pro_expired_time', 'proExpiredTime'));

  const planLabel =
    type === 'subscription'
      ? '个人升级版（订阅）'
      : type === 'one_time'
        ? '个人升级版（一次性）'
        : type
          ? type
          : null;

  return { plan: planLabel, subscriptionExpiresAt: expiresAt };
}

export interface XhxIdentity {
  id: string;
  name: string;
}

export function parseXhxIdentity(data: unknown): XhxIdentity {
  if (!isRecord(data)) return { id: '', name: '' };
  return {
    id: firstString(pick(data, 'id', 'user_id', 'userId')),
    name: firstString(pick(data, 'name', 'nickname', 'nick_name', 'display_name')),
  };
}

/* ------------------------------------------------------------------ *
 * 批次构建
 * ------------------------------------------------------------------ */

/**
 * 北京时间「今天 24:00」（= 明天 00:00）已抽到 `src/lib/beijing-time.ts`
 * （千问办公的每日 / 每月积分要用同一份规则）。这里保留具名导出，
 * 避免既有调用方与外部引用失效；本文件内的使用见文件头 import。
 */
export { endOfBeijingDay };

/**
 * 各桶最早的有效到期时间：只看「发放类」记录（`points > 0`），且只要未来的。
 * 过期的发放记录说明那笔额度已经作废，不能拿来当当前批次的到期时间。
 */
function earliestExpiryByBucket(bills: XhxBill[], now: number): Map<XhxBucket, number> {
  const out = new Map<XhxBucket, number>();
  for (const bill of bills) {
    if (bill.points <= 0 || isExpiryBill(bill) || bill.expiresAt === null) continue;
    if (bill.expiresAt < now) continue;
    const bucket = bucketOf(bill);
    const current = out.get(bucket);
    if (current === undefined || bill.expiresAt < current) out.set(bucket, bill.expiresAt);
  }
  return out;
}

interface BucketSpec {
  bucket: XhxBucket;
  label: string;
  amount: number;
  /** 永久有效：显式声明，不参与「最快到期」 */
  permanent?: boolean;
  /** 备注（如加油包冻结） */
  note?: string;
}

function buildLots(input: {
  balance: XhxBalance;
  bills: XhxBill[];
  entitlement: XhxEntitlement;
  now: number;
}): { lots: CreditLot[]; notes: string[] } {
  const expiries = earliestExpiryByBucket(input.bills, input.now);
  const notes: string[] = [];

  const specs: BucketSpec[] = [
    {
      bucket: 'daily',
      label: '每日赠送积分',
      amount: input.balance.daily,
      note: '当日 24:00 失效（当天登录延长至 7 天）',
    },
    {
      bucket: 'monthly',
      label: '每月赠送积分',
      amount: input.balance.monthly,
      note: '仅限当前订阅周期',
    },
    {
      bucket: 'topup',
      label: '加油包积分',
      amount: input.balance.topup,
      permanent: true,
      note: input.balance.topupFrozen ? '已冻结（升级版到期或降级）' : undefined,
    },
    {
      bucket: 'reward',
      label: '奖励积分',
      amount: input.balance.reward,
      note: '到账后 1 年内有效',
    },
  ];
  if (input.balance.enterpriseTopup > 0) {
    specs.push({
      bucket: 'other',
      label: '企业加油包（共享）',
      amount: input.balance.enterpriseTopup,
      permanent: true,
    });
  }

  const lots: CreditLot[] = [];
  for (const spec of specs) {
    if (spec.amount <= 0) continue;
    let expiresAt: string | null = null;
    if (!spec.permanent) {
      const fromBills = expiries.get(spec.bucket);
      if (fromBills !== undefined) {
        expiresAt = new Date(fromBills).toISOString();
      } else if (spec.bucket === 'monthly' && input.entitlement.subscriptionExpiresAt) {
        // 每月积分的到期时间与订阅周期一致；明细取不到时退回订阅到期
        expiresAt = input.entitlement.subscriptionExpiresAt;
      } else if (spec.bucket === 'daily') {
        // 每日积分：明细取不到时按「当日 24:00（北京时间）」兜底
        expiresAt = new Date(endOfBeijingDay(input.now)).toISOString();
        notes.push('每日积分的到期时间由规则推算（当日 24:00 北京时间），明细未返回 expire_at');
      } else {
        notes.push(`${spec.label}的到期时间未取到，未参与「最快到期」`);
      }
    }
    lots.push(
      makeLot({
        id: `xhx-${spec.bucket}`,
        label: spec.label,
        amount: spec.amount,
        currency: 'CREDITS',
        expiresAt,
        note: spec.note ?? '',
      }),
    );
  }

  return { lots, notes };
}

/* ------------------------------------------------------------------ *
 * 网页端登录（CDP 旁听真实 Cookie 头）
 * ------------------------------------------------------------------ */

/** 解析 JWT payload（只读，不验签）；失败返回 null */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 账号去重键：优先令牌里的 `sub` / `sid`，缺失时退回令牌指纹 */
function accountIdOf(token: string): string {
  const payload = decodeJwtPayload(token);
  const subject = payload ? firstString(pick(payload, 'sub', 'sid', 'user_id', 'uid')) : '';
  if (subject) return subject;
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function makeXhxWebLogin(usageUrl: string): ProviderLogin {
  return {
    id: 'web',
    kind: 'web',
    label: '网页端登录',
    hint: '自动打开调试 Chrome 的小浣熊「资源用量」页；你在那个窗口登录后，本页面自动完成添加。',
    qr: false,
    intervalMs: XHX_WEB_POLL_INTERVAL_MS,
    async start(input) {
      const chrome = await ensureDebugChrome();
      input.log(
        `小浣熊调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
      );
      const collector = await openCookieCollector({ url: usageUrl });
      input.log('小浣熊资源用量页已打开，等待登录');

      return {
        authUrl: usageUrl,
        qr: false,
        ttlMs: XHX_WEB_LOGIN_TTL_MS,
        hint: '请在刚打开的 Chrome 窗口里登录小浣熊（xiaohuanxiong.com）；登录后本页面会自动完成添加。',
        secret: { collector, startedAt: Date.now(), reloads: 0, lastReloadAt: 0 },
      };
    },
    async poll(secret, ctx) {
      if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少采集器参数，请重新发起。' };
      const collector = pick(secret, 'collector') as CookieCollector | undefined;
      const startedAt = Number(pick(secret, 'startedAt')) || Date.now();
      if (!collector || typeof collector.cookieFor !== 'function') {
        return { status: 'failed', message: '登录会话缺少采集器，请重新发起。' };
      }

      const hosts = ['xiaohuanxiong.com'];
      const raw = collector.cookieFor(hosts);
      const names = collector.cookieNamesFor(hosts);
      // 登录态判据取「或」：登录态 Cookie 名出现，或页面自己请求余额接口拿到 2xx
      const hasLoginCookie = COOKIE_TOKEN_NAMES.some((name) => names.includes(name));
      const identityOk = collector.sawSuccessfulRequest(XHX_WEB_IDENTITY_PATH);
      const loggedIn = Boolean(raw) && (hasLoginCookie || identityOk);

      if (!loggedIn) {
        const reloads = Number(pick(secret, 'reloads')) || 0;
        const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
        const now = Date.now();
        const idle = collector.idleMs();
        const idleLongEnough = idle >= XHX_WEB_RELOAD_IDLE_MS || idle === 0;
        if (
          reloads < XHX_WEB_RELOAD_MAX &&
          idleLongEnough &&
          now - lastReloadAt >= XHX_WEB_RELOAD_MIN_INTERVAL_MS
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
            ? `已抓到小浣熊页面 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
            : `正在等待你在调试 Chrome 窗口里登录小浣熊（已等待 ${waitedSec} 秒）…`,
        };
      }

      const cookie = normalizeCookieHeader(raw ?? '');
      const token = tokenFromCookie(cookie);
      if (!token) {
        return { status: 'waiting', message: '已抓到页面 Cookie，但里面还没有登录令牌，继续等待…' };
      }
      const refreshToken = cookieValueOf(cookie, COOKIE_REFRESH_TOKEN);
      ctx.log(`小浣熊网页端登录已抓到令牌（账号键 ${accountIdOf(token)}），开始验证落库`);

      return {
        status: 'ready',
        // 昵称为空时用占位名「商汤小浣熊 · 登录账号」，探测时由 adoptResolvedAccountName 补
        account: { id: accountIdOf(token), name: '' },
        credentials: {
          token,
          cookie,
          ...(refreshToken ? { refreshToken } : {}),
        },
        options: {},
        message: '已抓到登录令牌，正在验证取数并写入本机配置…',
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

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

/** 网页端登录方法（`login` 是默认方法，`loginMethods` 把它列全给前端渲染按钮） */
const xhxWebLogin = makeXhxWebLogin(XHX_USAGE_URL);

export const xiaohuanxiongAdapter: ProviderAdapter = {
  id: 'xiaohuanxiong',
  displayName: '商汤小浣熊',
  region: 'cn',
  dashboardUrl: XHX_USAGE_URL,
  usageUrl: XHX_USAGE_URL,
  requiredCredentialKeys: ['token'],
  envNames: {
    token: 'XIAOHUANXIONG_TOKEN',
    refreshToken: 'XIAOHUANXIONG_REFRESH_TOKEN',
    cookie: 'XIAOHUANXIONG_COOKIE',
  },
  // 两种凭证形态：直接贴令牌，或贴整段 Cookie（令牌从中推导）
  isConfigured: (account) =>
    Boolean(account.credentials.token) ||
    Boolean(account.credentials.accessToken) ||
    Boolean(account.credentials.cookie) ||
    Boolean(account.credentials.cookieHeader),
  credentialHint:
    '登录 https://xiaohuanxiong.com 后，推荐直接用卡片上的「网页端登录」，' +
    '或跑 npm run capture -- xiaohuanxiong 自动抓取（写入 XIAOHUANXIONG_COOKIE / XIAOHUANXIONG_TOKEN）；' +
    '也可以从 DevTools 里复制任意 xiaohuanxiong.com 请求的 Cookie 头整段粘贴。',
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '登录 xiaohuanxiong.com → DevTools → 任意请求 → Headers → 复制 Cookie 整段值',
      hint: '必须包含 xhx_token 或 raccoon_token；令牌会从中自动推导。',
      multiline: true,
      required: false,
    },
    {
      key: 'token',
      label: '访问令牌（可选，Cookie 里已含时可留空）',
      placeholder: 'Authorization: Bearer 后面的那串',
      hint: '单独粘贴令牌时使用；与 Cookie 二选一即可。',
      required: false,
    },
    {
      key: 'refreshToken',
      label: '刷新令牌（可选）',
      placeholder: 'raccoon_refresh_token 的值',
      hint: '用于令牌过期后自动续期；留空则过期后需重新登录。',
      required: false,
    },
  ],
  manageHint:
    '凭证会先真实调用一次余额接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',
  login: xhxWebLogin,
  loginMethods: [xhxWebLogin],

  /**
   * 用量 + 增量：积分明细逐笔。
   *   - `points < 0` → use；`points > 0` → grant；
   *   - `biz_type` 含 expire 的过期记录两边都不计；
   *   - 只覆盖到「昨日 00:00」才算取全，否则整份退回本地采样
   *     （与 minimax.ts 同一策略：宁可退，也不给一半数据还标 upstream）。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    if (!resolveToken(account, ctx)) return null;
    try {
      const windowStart = startOfDay(ctx.now) - 86_400_000;
      const result = await fetchXhxBills(account, ctx, {
        type: 'all',
        maxPages: BILLS_MAX_PAGES,
        stopBefore: windowStart,
      });
      if (!result.complete) {
        ctx.log('小浣熊积分明细超过翻页上限，用量与增量退回本地采样');
        return null;
      }
      const records: UsageRecord[] = [];
      for (const bill of result.items) {
        if (bill.at < windowStart || bill.at > ctx.now + 3_600_000) continue;
        if (bill.points === 0 || isExpiryBill(bill)) continue;
        records.push({
          at: bill.at,
          kind: bill.points < 0 ? 'use' : 'grant',
          amount: Math.abs(bill.points),
        });
      }
      return { records, covers: { use: true, grant: true } };
    } catch (error) {
      ctx.log(`小浣熊积分明细获取失败（退回本地采样）：${(error as Error).message}`);
      return null;
    }
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const adapter = xiaohuanxiongAdapter;
    // 令牌可以由 Cookie 推导，因此「有令牌」等价于「凭证可用」
    const token = resolveToken(account, ctx);
    if (!token) {
      return notConfigured(adapter, account, ctx, ['token 或 cookie（需含 xhx_token / raccoon_token）']);
    }

    try {
      const balanceData = await xhxRequest(
        account,
        ctx,
        '/api/web/points/v1/balance',
        '余额请求失败',
      );
      if (!isRecord(balanceData)) throw new Error('余额响应缺少 data 字段（令牌可能已失效）');
      const balance = parseXhxBalance(balanceData);

      // 明细与订阅都是「让到期时间更准」的增强项：失败不影响余额展示。
      // 探针只要最近几页（拿到各桶最近发放的 expire_at 即可），不必翻到底，
      // 因此这里**不**因为「没翻完」而提示「未取全」——那只会在每张卡片上制造噪音；
      // 真正要提示的是「明细请求失败」，此时到期时间只能靠规则/订阅兜底。
      let bills: XhxBill[] = [];
      let billsFailed = false;
      try {
        const result = await fetchXhxBills(account, ctx, { type: 'all', maxPages: 3 });
        bills = result.items;
      } catch (error) {
        billsFailed = true;
        ctx.log(`小浣熊积分明细获取失败（不影响余额）：${(error as Error).message}`);
      }

      let entitlement: XhxEntitlement = { plan: null, subscriptionExpiresAt: null };
      try {
        entitlement = parseXhxEntitlement(
          await xhxRequest(account, ctx, '/api/web/auth/v1/entitlement_info', '订阅信息请求失败'),
        );
      } catch (error) {
        ctx.log(`小浣熊订阅信息获取失败（不影响余额）：${(error as Error).message}`);
      }

      const { lots, notes } = buildLots({ balance, bills, entitlement, now: ctx.now });
      const { active, expired } = splitByExpiry(lots, ctx.now);

      // 构成合计与可用总额对不上时如实说明，便于上游改口径时第一时间发现
      const composed = lots.reduce((sum, lot) => sum + lot.amount, 0);
      const mismatch =
        Math.abs(composed - balance.available) > 0.5
          ? `积分构成合计 ${round2(composed)} 与可用总额 ${round2(balance.available)} 不一致，余额以可用总额为准`
          : null;

      // 昵称：仅当卡片名还是「登录账号」占位名时补查一次，改完就不再打这个接口
      let displayName: string | null = null;
      if (
        ctx.persistAccountName &&
        isPlaceholderAccountName(adapter.displayName, account.displayName ?? '')
      ) {
        try {
          const identity = parseXhxIdentity(
            await xhxRequest(account, ctx, '/api/web/auth/v1/user_info', '账号信息请求失败'),
          );
          if (identity.name) {
            displayName = await ctx.persistAccountName(identity.name).catch((error: unknown) => {
              ctx.log(`小浣熊账号昵称写回失败（不影响取数）：${(error as Error).message}`);
              return null;
            });
          }
        } catch (error) {
          ctx.log(`小浣熊账号昵称获取失败（不影响取数）：${(error as Error).message}`);
        }
      }

      return buildSnapshot({
        adapter,
        account,
        status: 'ok',
        now: ctx.now,
        displayName,
        accountId: displayName,
        plan: entitlement.plan,
        balance: { amount: round2(balance.available), currency: 'CREDITS' },
        credits: active,
        // 平台没有「周期上限」概念，不画假进度条
        windows: [],
        note: joinNotes(
          balance.topupFrozen ? '加油包已冻结（升级版到期或降级，重新升级可恢复）' : null,
          ...notes,
          mismatch,
          expired.length > 0
            ? `另有 ${expired.length} 个批次已过期（共 ${round2(expired.reduce((sum, lot) => sum + lot.amount, 0))} 积分作废），未在列表中展示`
            : null,
          billsFailed ? '积分明细请求失败，批次到期时间由规则 / 订阅信息兜底' : null,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(adapter, account, ctx, status, (error as Error).message);
    }
  },
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
