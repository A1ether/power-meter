import { createHash } from 'node:crypto';
import { endOfBeijingDay } from '../lib/beijing-time.js';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages, incompleteNote } from '../lib/pagination.js';
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
 * 口径（见 docs/fixes/商汤小浣熊-每日积分到期时间批次缺失-修复方案.md）：
 *   - 余额 = `available_points`（账户级权威数字）；
 *   - **逐批建模**：每日 / 每月 / 奖励三类，把「账户级桶剩余」按平台公布的消耗顺序
 *     （同类内先到期先消耗）分摊到**每一笔发放记录**上，一笔发放一条 `CreditLot`，
 *     到期时间用该笔自己的 `expire_at`（上游原值，不做推算）；
 *     分摊差额（明细未覆盖）出「未明细部分」调节项并注明；
 *   - 加油包永久有效 → `expiresAt = null`，不参与「最快到期」；
 *   - 明细流水里 `points < 0` 记 `use`、`> 0` 记 `grant`，`biz_type` 含 expire
 *     的过期记录两边都不计（过期既不是花掉的、也不是到账的）。
 */

const XHX_TIMEOUT_FALLBACK = 12_000;
const XHX_ORIGIN = 'https://xiaohuanxiong.com';
/** 「资源用量」页：卡片「每日用量」跳转与网页端登录打开的都是它 */
const XHX_USAGE_URL = 'https://xiaohuanxiong.com/work/settings/resource';
/**
 * 明细每页要几条：往大了要——服务端支持就少翻几页（这也是修复前一直在用的值）。
 * 桌面端 bundle 里客户端固定传 20，服务端**可能封顶 20**。
 */
const BILLS_REQUEST_LIMIT = 50;
/**
 * 短页判据阈值：按客户端实测的 20 判定。
 *
 * `fetchAllPages()` 用「本页条数 < pageSize」判末页；若拿 50 当阈值而服务端封顶 20，
 * 每一页都会被当成「短页 + 上游声称还有 = 未取全」而在第 1 页停下。
 * 因此「请求 50 / 阈值 20」：服务端封顶 20 时页页满页、正常翻到底；
 * 服务端支持 50 时页更大，同样不会被误判。
 * 10 页覆盖「昨日 00:00 至今」；超出即退回本地采样。
 */
const BILLS_PAGE_SIZE = 20;
const BILLS_MAX_PAGES = 10;
/**
 * 发放流水（`type=income`）翻页上限：15 页（每页 20–50 条）。
 *
 * 逐批建模要一直翻到「各桶剩余被这些发放记录覆盖」为止。**不能**再用 `type=all`
 * 只翻 3 页：消耗流水（桌面端一次对话就一条 -4）会把窗口挤到只剩近一小时，
 * 于是只能看到当天那一笔发放，到期时间退化成「最晚到期」——这正是本次修复的问题。
 * 日常账号 1–2 页即可（每天 1 笔每日发放）；上限只是防御（奖励积分 1 年有效期）。
 */
const GRANT_BILLS_MAX_PAGES = 15;
/** 发放流水不可用（参数被上游改版拒绝）时退回全量流水的页数 */
const BILLS_FALLBACK_MAX_PAGES = 4;
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
 *
 * 对 app.asar 的静态取证（见修复方案 §2.2）只能确认 `daily_grant` /
 * `daily_expire` 两个 `biz_type`，`monthly_*` / `reward_*` / `topup_*` 在客户端
 * bundle 里根本不存在；而 **`event_name` 是服务端下发的中文字符串**（客户端直接渲染，
 * 没有 biz_type→中文的字典）。所以匹配必须「英文 biz_type + 中文 event_name」一起覆盖，
 * 认不出的一律归 `other`——只影响批次精细度，不影响余额。
 */
const BUCKET_BIZ_KEYWORDS: Array<{ bucket: XhxBucket; pattern: RegExp }> = [
  { bucket: 'daily', pattern: /daily|day_/i },
  // 加油包排在「每月」之前：购买类记录的 biz_type 里常带 subscription，
  // 若先匹配 monthly 会被误归到「每月赠送」上，到期时间就错了。
  // 反过来误归到加油包无害——加油包按规则永久有效，不从明细取到期时间。
  { bucket: 'topup', pattern: /topup|top_up|booster|recharge|purchase/i },
  { bucket: 'reward', pattern: /reward|activity|campaign|redeem|gift|promo|invite/i },
  { bucket: 'monthly', pattern: /monthly|month_|subscription/i },
];

/**
 * `event_name` 里的中文关键字（**服务端下发**，客户端没有 `biz_type` → 中文的字典）。
 *
 * 顺序有意为之：`签到` 归**奖励**（「活动签到奖励」「每日签到领积分」在产品里都是奖励类），
 * 每月 / 奖励排在每日之前 —— 否则「每月签到礼包」会先命中 daily，被当成最晚到期的
 * 每日批次、反把真实每日批次挤掉，正是本次要修的那个形状。
 */
const BUCKET_EVENT_KEYWORDS: Array<{ bucket: XhxBucket; pattern: RegExp }> = [
  // `每日` / `每天` 必须排最前：「每日签到奖励」是每日额度（7 天），
  // 若被 reward 的 `签到` 抢先，daily 桶会整桶丢发放、reward 反被短效批次填满。
  { bucket: 'daily', pattern: /每日|每天/ },
  { bucket: 'topup', pattern: /加油包|增购|充值|购买/ },
  { bucket: 'reward', pattern: /奖励|活动|兑换|新人|回馈|礼包|签到/ },
  { bucket: 'monthly', pattern: /每月|月度|订阅|会员/ },
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
  /** 未取全时可直接放进卡片 note 的说明（取全为 null） */
  incompleteNote: string | null;
}

/**
 * 拉取积分明细（新→旧，游标分页）。
 *
 * 翻页交给 `fetchAllPages()`（AGENTS §9 的硬约束：列表型接口不得手写翻页循环），
 * 这里只做两件事：
 *   ① 上一页 `next_cursor` → 本页查询参数；
 *   ② 把上游 `has_more` 翻译成 `fetchAllPages` 认得的 `total`
 *      （「还有」⇒ 已取条数 + 1，避免短页被当成末页而静默判取全；与 qwenwork.ts 同一范式）。
 *
 * `stopBefore` / `stopWhen` 表达的是「需要的窗口已被覆盖」：命中即停并判取全，
 * 由 `fetchAllPages` 的 `stopWhen` 钩子实现（用量统计只需要「昨日 00:00 之后」，
 * 逐批建模只需要「各桶剩余被发放覆盖」——更早的记录按先到期先消耗已无剩余）。
 */
export async function fetchXhxBills(
  account: AccountConfig,
  ctx: ProbeContext,
  options: {
    type?: 'all' | 'income' | 'expense';
    maxPages?: number;
    stopBefore?: number;
    /** 「需要的窗口已覆盖」判定，命中即停并判取全（见 lib/pagination.ts 的 stopWhen） */
    stopWhen?: (bills: XhxBill[]) => boolean;
  } = {},
): Promise<XhxBillsResult> {
  const type = options.type ?? 'all';
  /** 第 N 页（从 1 起）要用的游标；由上一页响应写入 */
  const cursors: string[] = [];
  /**
   * 已解析出的**去重**条数：必须与 `fetchAllPages` 的 keyOf 计数口径一致
   * （无效条目两边都不计、跨页重复的 bill_id 两边都只算一次），
   * 否则翻译出的 total 永远达不到，会把取全误判成未取全。
   */
  const seenIds = new Set<string>();
  /** 已取到的最早一条流水时间（`stopBefore` 覆盖判定用，避免每页重算） */
  let oldestSeen = Number.POSITIVE_INFINITY;
  /** 上一次 `stopWhen` 调用时的累计条数：用来判断「本次新增的这页是不是满页」 */
  let lastCount = 0;
  /** 观测到的首页新增条数：作为「满页」的动态基线（服务端可能支持 50，也可能封顶 20） */
  let observedPageLength = 0;
  const stopBefore = options.stopBefore;

  const result = await fetchAllPages<XhxBill>({
    pageSize: BILLS_PAGE_SIZE,
    maxPages: options.maxPages ?? BILLS_MAX_PAGES,
    keyOf: (bill) => bill.id,
    label: '小浣熊积分明细',
    stopWhen: (items) => {
      const pageLength = items.length - lastCount;
      lastCount = items.length;
      if (observedPageLength === 0) observedPageLength = pageLength;
      for (const bill of items) {
        if (bill.at < oldestSeen) oldestSeen = bill.at;
      }
      // 时间窗覆盖只认「满页且已跨过边界」：上游若按 `expire_at` 排序（或插了一条补发），
      // 短页里出现一条很老的 `created_at` 并不代表窗口记录都在手里；此时判取全，
      // 用量台账会少算还把来源标成 upstream。
      // 「满页」以观测到的首页页长为基线：请求 50 但服务端支持 50 时，一个被过滤到
      // 20 条的中间页也不算满页（否则这里等于没门槛）。
      const fullPage = Math.max(BILLS_PAGE_SIZE, observedPageLength);
      if (stopBefore !== undefined && oldestSeen < stopBefore && pageLength >= fullPage) {
        return true;
      }
      return options.stopWhen ? options.stopWhen(items) : false;
    },
    fetchPage: async (page) => {
      const params = new URLSearchParams({
        'paging.limit': String(BILLS_REQUEST_LIMIT),
        type,
      });
      const cursor = cursors[page - 1];
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

      const parsed = list.map(parseBill).filter((bill): bill is XhxBill => bill !== null);
      for (const bill of parsed) seenIds.add(bill.id);

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
      // 上游说还有、却没给游标：下一页会重复请求第 1 页，由 fetchAllPages 的
      // 「本页零新增」判据收口，并如实标记「未取全」。
      if (hasMore) cursors[page] = nextCursor;

      return { items: parsed, total: hasMore ? seenIds.size + 1 : seenIds.size };
    },
  });

  return {
    items: result.items,
    complete: result.complete,
    incompleteNote: incompleteNote(result),
  };
}

/**
 * 桶归属：**先按 `biz_type`**（英文、精确），判不出再看中文 `event_name`。
 *
 * 这个顺序是复核时定下的：中文是模糊匹配，先命中会把「活动签到奖励」误判成每日批次；
 * 而 `biz_type` 是上游枚举，`daily_grant` 这类字面量一旦出现就是确定的。
 */
function bucketOf(bill: XhxBill): XhxBucket {
  for (const { bucket, pattern } of BUCKET_BIZ_KEYWORDS) {
    if (pattern.test(bill.bizType)) return bucket;
  }
  for (const { bucket, pattern } of BUCKET_EVENT_KEYWORDS) {
    if (pattern.test(bill.eventName)) return bucket;
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

/** 逐批建模的三类桶（加油包永久有效，不拆批） */
const BATCH_BUCKETS = ['daily', 'monthly', 'reward'] as const;
type BatchBucket = (typeof BATCH_BUCKETS)[number];

/** 各桶展示名：批次标题与「未明细部分」调节项共用 */
const BUCKET_LABEL: Record<XhxBucket, string> = {
  daily: '每日赠送积分',
  monthly: '每月赠送积分',
  reward: '奖励积分',
  topup: '加油包积分',
  other: '其他积分',
};

/** 一笔「发放」按消耗顺序反推出来的当前剩余 */
export interface XhxGrantBatch {
  /** 上游 `bill_id`（批次稳定标识） */
  billId: string;
  bucket: BatchBucket;
  /** 发放时间（epoch ms） */
  grantedAt: number;
  /** 该笔的到期时间（epoch ms，上游 `expire_at` 原值） */
  expiresAt: number;
  /** 该笔授予量（上游 `points`） */
  granted: number;
  /** 按「同类内先到期先消耗」反推出来的剩余 */
  remaining: number;
}

export interface XhxAllocation {
  batches: XhxGrantBatch[];
  /** 某一个桶里「账户级剩余」没能归到任何发放笔上的差额（明细未覆盖） */
  gaps: Array<{ bucket: BatchBucket; amount: number }>;
}

/**
 * 把「账户级桶剩余」分摊到逐笔发放，得到每条批次的到期时间与剩余。
 *
 * 依据是平台自己公布的消耗顺序：**同类内按到期日 / 入账时间先后消耗**
 * （「资源用量」页原文：「消耗顺序：每日额度 → 每月额度 → 奖励积分 → 加油包
 * （同类内按到期日/入账时间排序）」）。因此同一桶内，先到期的先被吃掉，
 * **剩余额度必然集中在最晚到期的若干笔上**——从最晚一笔往前填满桶剩余，
 * 就能还原逐批剩余，不需要逐笔对账、也不会被退款 / 并发写入的顺序干扰。
 *
 * 三条硬约束：
 *   1. 只用 `points > 0` 的发放记录（过期流水既不是发放也不是消耗）；
 *   2. 只认 `expiresAt >= now` 的发放（已作废的批次不参与分配）；
 *   3. 发放合计 < 桶剩余时**不硬凑**：差额进 `gaps`，由调用方出「未明细部分」
 *      调节项并注明，绝不把没取到的批次合并进某一笔真实批次里。
 */
export function allocateXhxBatches(input: {
  bills: XhxBill[];
  balances: Record<BatchBucket, number>;
  now: number;
}): XhxAllocation {
  const batches: XhxGrantBatch[] = [];
  const gaps: Array<{ bucket: BatchBucket; amount: number }> = [];

  for (const bucket of BATCH_BUCKETS) {
    const total = round2(Math.max(0, input.balances[bucket]));
    if (total <= 0) continue;

    // 候选：同类、发放、未过期、有明确 expire_at；同 bill_id 去重（翻页错位会重复）
    const grants = new Map<string, XhxGrantBatch>();
    for (const bill of input.bills) {
      if (bill.points <= 0 || isExpiryBill(bill)) continue;
      if (bill.expiresAt === null || bill.expiresAt < input.now) continue;
      if (bucketOf(bill) !== bucket) continue;
      const existing = grants.get(bill.id);
      if (existing && existing.granted >= bill.points) continue;
      grants.set(bill.id, {
        billId: bill.id,
        bucket,
        grantedAt: bill.at,
        expiresAt: bill.expiresAt,
        granted: round2(bill.points),
        remaining: 0,
      });
    }

    const ordered = [...grants.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt || a.grantedAt - b.grantedAt,
    );
    let left = total;
    for (let i = ordered.length - 1; i >= 0 && left > 0; i -= 1) {
      const take = round2(Math.min(ordered[i].granted, left));
      if (take <= 0) continue;
      batches.push({ ...ordered[i], remaining: take });
      left = round2(left - take);
    }
    if (left > 0) gaps.push({ bucket, amount: left });
  }

  batches.sort((a, b) => a.expiresAt - b.expiresAt || a.grantedAt - b.grantedAt);
  return { batches, gaps };
}

/** 北京时间的「MM-DD」标签（批次标题用；不依赖本机时区） */
function beijingDayLabel(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${month}-${day}`;
}

/** 批次备注（卡片上作悬停说明）：授予量、已用量与有效期规则 */
function batchNote(batch: XhxGrantBatch): string {
  const parts = [`发放 ${round2(batch.granted)}`];
  const used = round2(batch.granted - batch.remaining);
  if (used > 0.005) parts.push(`已用 ${used}`);
  if (batch.bucket === 'daily') parts.push('当天登录后到期延长至 7 天');
  if (batch.bucket === 'reward') parts.push('到账后 1 年内有效');
  if (batch.bucket === 'monthly') parts.push('仅限当前订阅周期');
  return parts.join(' · ');
}

/**
 * 桶内「没能归属到具体批次」的部分（或整桶）的到期兜底。
 *
 * - 每月：与订阅周期一致，退回 `entitlement_info` 的到期时间；
 * - 每日：缺失的批次一定早于「今天 24:00 + 7 天」的那几笔，取「已知最早批次」
 *   与「今天 24:00」中更早的一个 —— 宁可低估可用时间，也不谎报能用到 7 天后；
 * - 奖励：**返回 null（不编时间）**。差额只会在「桶剩余 > 已知发放合计」时出现，
 *   而按先到期先消耗，已知且拿到剩余的一定是**最晚到期**的那些；缺失的是更早发放、
 *   更早到期的批次，所以「已知最早」对缺失部分而言是**上界**、不是保守值——
 *   拿它填日期等于让「最快到期」再一次偏晚（复核指出的坑）。
 */
function gapExpiry(
  bucket: BatchBucket,
  knownExpiries: number[],
  entitlement: XhxEntitlement,
  now: number,
): string | null {
  if (bucket === 'monthly') return entitlement.subscriptionExpiresAt;
  if (bucket === 'daily') {
    const earliestKnown = knownExpiries.length > 0 ? Math.min(...knownExpiries) : null;
    const todayEnd = endOfBeijingDay(now);
    const chosen = earliestKnown === null ? todayEnd : Math.min(earliestKnown, todayEnd);
    return new Date(chosen).toISOString();
  }
  return null;
}

function gapNote(bucket: BatchBucket, amount: number, partial: boolean): string {
  const value = `${round2(amount)} 积分`;
  if (partial) {
    if (bucket === 'daily') {
      return `每日赠送积分有 ${value}未取到逐笔明细（发放流水合计小于账户级剩余），已单列并按「今天 24:00 北京时间」保守估算`;
    }
    if (bucket === 'monthly') {
      return `每月赠送积分有 ${value}未取到逐笔明细，已单列并按订阅到期时间估算`;
    }
    return `奖励积分有 ${value}未取到逐笔明细（发放流水合计小于账户级剩余），到期时间未知，未参与「最快到期」`;
  }
  if (bucket === 'daily') {
    return `每日赠送积分的发放流水未取到，${value}按规则兜底（当日 24:00 北京时间）`;
  }
  if (bucket === 'monthly') {
    return `每月赠送积分的发放流水未取到，${value}按订阅到期时间兜底`;
  }
  return `奖励积分的逐笔发放未取到，${value}未参与「最快到期」`;
}

/**
 * 「各桶剩余是否已被这些发放记录覆盖」——发放流水翻页的提前停判据。
 *
 * 与 `allocateXhxBatches()` 的候选过滤保持一致：先到期先消耗 ⇒ 某桶的有效发放
 * 合计 ≥ 桶剩余时，更早的发放必然已经被吃光，再翻也不会有剩余，可以停。
 *
 * 注意：这里只用于**取数提前停**，不参与建模；若上游某天停了「先到期先消耗」，
 * 先坏的也是批次剩余（已在卡片 note 标注为反推值），不是余额。
 */
export function grantsCoverBalances(
  bills: XhxBill[],
  balances: Record<BatchBucket, number>,
  now: number,
): boolean {
  const totals: Record<BatchBucket, number> = { daily: 0, monthly: 0, reward: 0 };
  /** 同 bill_id 只算一次（与 `allocateXhxBatches()` 一致）：重复流水会虚增覆盖、导致提前停 */
  const seen = new Map<string, XhxBill>();
  for (const bill of bills) {
    if (bill.points <= 0 || isExpiryBill(bill)) continue;
    if (bill.expiresAt === null || bill.expiresAt < now) continue;
    const existing = seen.get(bill.id);
    if (!existing || existing.points < bill.points) seen.set(bill.id, bill);
  }
  for (const bill of seen.values()) {
    const bucket = bucketOf(bill);
    if (bucket === 'daily' || bucket === 'monthly' || bucket === 'reward') {
      totals[bucket] += bill.points;
    }
  }
  return BATCH_BUCKETS.every(
    (bucket) => balances[bucket] <= 0 || totals[bucket] >= balances[bucket],
  );
}

export function buildXhxLots(input: {
  balance: XhxBalance;
  bills: XhxBill[];
  /** 发放明细是否可用：请求失败时退回「桶级聚合 + 规则 / 订阅兜底」 */
  billsAvailable: boolean;
  entitlement: XhxEntitlement;
  now: number;
}): { lots: CreditLot[]; notes: string[] } {
  const lots: CreditLot[] = [];
  const notes: string[] = [];
  const balances: Record<BatchBucket, number> = {
    daily: input.balance.daily,
    monthly: input.balance.monthly,
    reward: input.balance.reward,
  };

  if (input.billsAvailable) {
    const { batches, gaps } = allocateXhxBatches({
      bills: input.bills,
      balances,
      now: input.now,
    });

    for (const batch of batches) {
      lots.push(
        makeLot({
          id: `xhx-${batch.bucket}-${batch.billId}`,
          label: `${BUCKET_LABEL[batch.bucket]} · ${beijingDayLabel(batch.grantedAt)}`,
          amount: batch.remaining,
          granted: batch.granted,
          currency: 'CREDITS',
          expiresAt: toIso(batch.expiresAt),
          note: batchNote(batch),
        }),
      );
    }
    if (batches.length > 0) {
      notes.push('逐批剩余按「同类内先到期先消耗」从账户级剩余反推（平台不提供逐批剩余）');
    }

    for (const gap of gaps) {
      const known = batches
        .filter((batch) => batch.bucket === gap.bucket)
        .map((batch) => batch.expiresAt);
      const partial = known.length > 0;
      const expiresAt = gapExpiry(gap.bucket, known, input.entitlement, input.now);
      lots.push(
        makeLot({
          id: `xhx-${gap.bucket}-unitemized`,
          label: (partial
            ? `${BUCKET_LABEL[gap.bucket]}（未明细部分`
            : `${BUCKET_LABEL[gap.bucket]}（合计，未取到逐笔`) +
            // 到期为 null 时前端会显示「不过期」，正文必须说清「到期未知」
            (expiresAt === null ? ' · 到期未知）' : '）'),
          amount: gap.amount,
          currency: 'CREDITS',
          expiresAt,
          note:
            expiresAt === null
              ? '上游只给账户级剩余与逐笔发放，明细未覆盖；到期时间未取到，不代表永久有效'
              : '上游只给账户级剩余与逐笔发放，明细未覆盖的部分单列于此',
        }),
      );
      notes.push(gapNote(gap.bucket, gap.amount, partial));
    }
  } else {
    // 明细不可用：退回修复前的桶级聚合口径（到期靠规则 / 订阅兜底）
    for (const bucket of BATCH_BUCKETS) {
      const amount = balances[bucket];
      if (amount <= 0) continue;
      lots.push(
        makeLot({
          id: `xhx-${bucket}`,
          label: BUCKET_LABEL[bucket],
          amount,
          currency: 'CREDITS',
          expiresAt: gapExpiry(bucket, [], input.entitlement, input.now),
          note:
            bucket === 'daily'
              ? '当日 24:00 失效（当天登录延长至 7 天）'
              : bucket === 'monthly'
                ? '仅限当前订阅周期'
                : '到账后 1 年内有效',
        }),
      );
    }
    notes.push('发放明细请求失败，批次到期时间由规则 / 订阅信息兜底');
  }

  // 加油包 / 企业加油包：永久有效 → 一条聚合批次，不参与「最快到期」
  if (input.balance.topup > 0) {
    lots.push(
      makeLot({
        id: 'xhx-topup',
        label: BUCKET_LABEL.topup,
        amount: input.balance.topup,
        currency: 'CREDITS',
        expiresAt: null,
        note: input.balance.topupFrozen ? '已冻结（升级版到期或降级）' : '永久有效',
      }),
    );
  }
  if (input.balance.enterpriseTopup > 0) {
    lots.push(
      makeLot({
        id: 'xhx-enterprise-topup',
        label: '企业加油包（共享）',
        amount: input.balance.enterpriseTopup,
        currency: 'CREDITS',
        expiresAt: null,
        note: '永久有效',
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
      //
      // 取的是**发放流水**（`type=income`）而不是全量流水：全量流水里消耗记录会
      // 把窗口挤满（桌面端一次对话就一条 -4），只翻几页时往往只剩「今天这一笔」
      // 发放，逐批到期就退化成「最晚到期」。发放流水稀少，翻到「各桶剩余被覆盖」
      // 即可停；取不全时由 `incompleteNote` 如实说明，并让没覆盖到的部分落成
      // 「未明细部分」调节项，不冒充真实批次。
      let bills: XhxBill[] = [];
      let billsAvailable = false;
      let billsNote: string | null = null;
      try {
        const result = await fetchXhxBills(account, ctx, {
          type: 'income',
          maxPages: GRANT_BILLS_MAX_PAGES,
          // 各桶剩余已被这批发放覆盖就没必要继续翻（更早的发放按先到期先消耗已无剩余），
          // 否则每个缓存周期都会把 7–15 页顺序打一遍，还可能误挂「未取全」提示。
          stopWhen: (items) =>
            grantsCoverBalances(
              items,
              { daily: balance.daily, monthly: balance.monthly, reward: balance.reward },
              ctx.now,
            ),
        });
        bills = result.items;
        billsAvailable = true;
        billsNote = result.incompleteNote;
      } catch (error) {
        if (isAuthFailure(error)) {
          // 鉴权失败时退化成一堆二次请求没有意义，直接按「明细不可用」处理
          ctx.log(`小浣熊发放流水获取失败（不影响余额）：${(error as Error).message}`);
        } else {
          ctx.log(`小浣熊发放流水（type=income）获取失败，退回全量流水口径：${(error as Error).message}`);
          try {
            const fallback = await fetchXhxBills(account, ctx, {
              type: 'all',
              maxPages: BILLS_FALLBACK_MAX_PAGES,
            });
            bills = fallback.items.filter((bill) => bill.points > 0);
            billsAvailable = true;
            billsNote = [
              fallback.incompleteNote,
              '发放流水（type=income）不可用，已退回全量流水口径（消耗记录会挤占窗口，批次可能不全）',
            ]
              .filter((note): note is string => Boolean(note))
              .join('；');
          } catch (fallbackError) {
            ctx.log(`小浣熊积分明细获取失败（不影响余额）：${(fallbackError as Error).message}`);
          }
        }
      }

      let entitlement: XhxEntitlement = { plan: null, subscriptionExpiresAt: null };
      try {
        entitlement = parseXhxEntitlement(
          await xhxRequest(account, ctx, '/api/web/auth/v1/entitlement_info', '订阅信息请求失败'),
        );
      } catch (error) {
        ctx.log(`小浣熊订阅信息获取失败（不影响余额）：${(error as Error).message}`);
      }

      const { lots, notes } = buildXhxLots({
        balance,
        bills,
        billsAvailable,
        entitlement,
        now: ctx.now,
      });
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
          billsNote,
          expired.length > 0
            ? `另有 ${expired.length} 个批次已过期（共 ${round2(expired.reduce((sum, lot) => sum + lot.amount, 0))} 积分作废），未在列表中展示`
            : null,
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
