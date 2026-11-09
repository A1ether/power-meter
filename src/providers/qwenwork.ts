import { createHash } from 'node:crypto';
import { endOfBeijingDay, endOfBeijingMonth } from '../lib/beijing-time.js';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages } from '../lib/pagination.js';
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
 * 千问办公（qwenwork.cn/app/settings/usage）
 *
 * 官方没有任何公开查询接口。这里复刻的是网页端自己的内部接口，证据见
 * docs/plans/平台适配器-接入千问办公积分-开发设计方案.md：
 *
 *   GET /user/balance   → { balance }                       账户级「剩余可用」
 *   GET /user/wallets   → { balance,
 *                           daily_credits{total_balance},
 *                           monthly_credits{total_balance},
 *                           longterm_credits{total_balance} }
 *   GET /user/info      → { nickname, username, email,
 *                           plan{ pid, name, next_due_date, next_refresh_date,
 *                                 subscription_status }, is_biz }
 *   GET /user/billings  → { items[{ amount(有符号), created_at, detail{title},
 *                                  transaction_id }], has_more, next_cursor }
 *   GET /user/billings/expirations?limit=&cursor= → { items[], has_more, next_cursor }
 *        （「过期积分」历史；只用于诊断，本轮不参与取数——见方案 §5.4）
 *   注：`/user/plan` 在前端产物里**不存在**（只有 `/user/plans` 公开定价表），
 *   套餐与刷新时间只从 `/user/info` 的 `plan` 拿。
 *
 * 鉴权：**网页登录态 Cookie**（前端 axios `withCredentials: true`；生产环境没有
 * `VITE_DEV_JWT`，因此不会额外带 `Authorization`）。未登录实测：
 *   - `/user/balance` → 401 `{ code:"invalid-credential", msg:"Missing or invalid token" }`
 *   - `/user/billings/expirations` → 404（该前缀在另一套网关，带任意 Bearer 才进入业务路由）
 * 因此适配器只认 Cookie，不做令牌续期。
 *
 * 口径（见方案 §5.4）：
 *   - 余额 = `/user/balance` 的 `balance`（页面「剩余可用」用的就是它）；
 *   - 三个桶 daily / monthly / longterm 各拆一条 `CreditLot`，金额取
 *     `/user/wallets` 里对应 `total_balance`，到期时间按各自规则推算；
 *   - 上游文案：「每日赠送积分，每天 00:00 刷新」「订阅套餐内的积分，当月有效」
 *     「长期积分：通过充值或活动获取，有效期以具体规则为准」——
 *     长期积分拿不到明确日期时**不标日期**，也不编。
 */

const QWENWORK_TIMEOUT_FALLBACK = 12_000;
const QWENWORK_ORIGIN = 'https://qwenwork.cn';
/** 用量页：卡片「每日用量」跳转与网页端登录打开的都是它 */
const QWENWORK_USAGE_URL = 'https://qwenwork.cn/app/settings/usage';
/** 登录态判据：页面自己会用 Cookie 请求这个接口（登录 200 / 访客 401） */
const QWENWORK_IDENTITY_PATH = '/user/balance';

/** 逐笔流水：单页 20 条（与用量页一致）× 10 页，够覆盖「昨日 00:00 至今」 */
const BILLINGS_PAGE_SIZE = 20;
const BILLINGS_MAX_PAGES = 10;

/** 网页端登录（CDP 抓取）节奏：与商汤小浣熊 / CodeBuddy 同一套常量 */
const QW_WEB_POLL_INTERVAL_MS = 2_000;
const QW_WEB_RELOAD_IDLE_MS = 20_000;
const QW_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
const QW_WEB_RELOAD_MAX = 2;
const QW_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 鉴权失败的业务码（实测：`invalid-credential` 表示 Cookie 会话缺失 / 失效） */
const AUTH_CODES = new Set(['invalid-credential', 'unauthorized']);

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  return (override || QWENWORK_ORIGIN).replace(/\/+$/, '');
}

function resolveCookie(account: AccountConfig, ctx: ProbeContext): string {
  return normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
}

/**
 * 响应信封：`{ code: 'ok' | 'SUCCESS', data }` 才取 data，其余视为失败。
 *
 * 前端 `Xe()` 对「没有 code 的裸对象」直接返回原体，因此这里同样允许无 code
 * 的响应（返回体本身）——避免「响应里没有 code」被误判成「响应里没有 data」。
 */
function unwrap(body: unknown, fallback: string): unknown {
  if (!isRecord(body)) return body;
  const rawCode = body.code;
  if (rawCode === undefined || rawCode === null) return body;
  const code = String(rawCode);
  if (code === 'ok' || code === 'SUCCESS') return body.data ?? null;
  const message = firstString(pick(body, 'msg', 'message'));
  const detail = message ? `：${message}` : '';
  // 业务层的登录态失效：与 HTTP 401 同等对待，交给调用方统一降级。
  // 只认上游明确的鉴权错误码，避免把「token 用量超额」之类的业务码误判成登录失效。
  if (AUTH_CODES.has(code) || /missing or invalid token|_unauthorized$/i.test(message)) {
    throw new HttpError(`${fallback}${detail}（code=${code}，登录态可能已失效）`, 401);
  }
  throw new Error(`${fallback}${detail}（code=${code}）`);
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  return /invalid-credential|unauthorized|登录态|未登录|missing or invalid token|jwt/i.test(
    (error as Error)?.message ?? '',
  );
}

function qwenWorkHeaders(cookie: string): Record<string, string> {
  return {
    Accept: 'application/json',
    // 前端是同源请求，浏览器会自动带 Referer；服务端补上更贴近真实流量
    Referer: QWENWORK_USAGE_URL,
    Origin: QWENWORK_ORIGIN,
    Cookie: cookie,
  };
}

/** 统一的 GET + 解信封；返回解包后的 data */
async function qwenWorkGet(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  label: string,
): Promise<unknown> {
  const cookie = resolveCookie(account, ctx);
  const { body } = await fetchJson(`${resolveOrigin(account)}${path}`, {
    method: 'GET',
    headers: qwenWorkHeaders(cookie),
    timeoutMs: ctx.timeoutMs || QWENWORK_TIMEOUT_FALLBACK,
  });
  return unwrap(body, label);
}

/* ------------------------------------------------------------------ *
 * 余额 / 三桶
 * ------------------------------------------------------------------ */

/**
 * `/user/wallets` 的三个积分桶。
 *
 * 不取该接口自己的 `balance`：余额主数字统一用 `/user/balance` 的 `balance`
 * （页面「剩余可用」用的就是它），两处各取一个会让卡片出现两个来源的数字。
 */
export interface QwWallet {
  daily: number;
  monthly: number;
  longterm: number;
}

export function parseQwWallet(data: unknown): QwWallet {
  const source = isRecord(data) ? data : {};
  const bucket = (key: string): number => {
    const node = pick(source, key);
    if (isRecord(node)) {
      return Math.max(0, firstNumber(pick(node, 'total_balance', 'totalBalance')) ?? 0);
    }
    // 兼容「直接把桶拍平成数字」的返回形态
    return Math.max(0, firstNumber(node) ?? 0);
  };
  return {
    daily: bucket('daily_credits'),
    monthly: bucket('monthly_credits'),
    longterm: bucket('longterm_credits'),
  };
}

/* ------------------------------------------------------------------ *
 * 账号 / 套餐
 * ------------------------------------------------------------------ */

export interface QwPlan {
  /** 卡片上的套餐标签；取不到为 null */
  plan: string | null;
  pid: string;
  /** 订阅到期（next_due_date） */
  subscriptionExpiresAt: string | null;
  /** 积分刷新时间（next_refresh_date）：每月订阅积分的到期来源 */
  creditsRefreshAt: string | null;
  /** 企业账号：口径不同，需要在 note 里说明 */
  isBiz: boolean;
}

export function parseQwPlan(userInfo: unknown): QwPlan {
  const info = isRecord(userInfo) ? userInfo : {};
  const nested = pick(info, 'plan');
  const plan = isRecord(nested) ? nested : {};

  const name = firstString(pick(plan, 'name'));
  const pid = firstString(pick(plan, 'pid'));
  const label = name || pid;

  return {
    plan: label || null,
    pid,
    subscriptionExpiresAt: toIso(pick(plan, 'next_due_date', 'nextDueDate')),
    creditsRefreshAt: toIso(pick(plan, 'next_refresh_date', 'nextRefreshDate')),
    // 企业账号的判定只认 is_biz（用量页组件：`is_biz === true`）；
    // subscription_status=false 只说明没有订阅，「个人免费版」也是 false
    isBiz: pick(info, 'is_biz') === true,
  };
}

export interface QwIdentity {
  id: string;
  name: string;
}

export function parseQwIdentity(data: unknown): QwIdentity {
  if (!isRecord(data)) return { id: '', name: '' };
  return {
    id: firstString(pick(data, 'id', 'user_id', 'userId', 'username')),
    name: firstString(pick(data, 'nickname', 'display_name', 'displayName', 'username')),
  };
}

/* ------------------------------------------------------------------ *
 * 逐笔流水
 * ------------------------------------------------------------------ */

export interface QwBill {
  id: string;
  /** 有符号：> 0 到账，< 0 消耗 */
  amount: number;
  /** 发生时间（epoch ms） */
  at: number;
  title: string;
}

function parseBill(raw: unknown): QwBill | null {
  if (!isRecord(raw)) return null;
  const amount = firstNumber(pick(raw, 'amount'));
  if (amount === null) return null;
  const atIso = toIso(pick(raw, 'created_at', 'createdAt'));
  const at = atIso ? Date.parse(atIso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const detail = pick(raw, 'detail');
  return {
    id: firstString(pick(raw, 'transaction_id', 'transactionId', 'id')) || `${at}-${amount}`,
    amount,
    at,
    title: isRecord(detail) ? firstString(pick(detail, 'title')) : '',
  };
}

/**
 * 拉取逐笔流水（新→旧，游标分页）。
 *
 * 翻页交给 `fetchAllPages()`（见 src/lib/pagination.ts 的硬约束），这里只负责
 * 「上一页的 next_cursor → 本页查询参数」这一层映射，以及把上游的 `has_more`
 * 翻译成 `fetchAllPages` 认得的 `total`：
 *
 *   - `has_more=false` ⇒ 本页即末页，total = 已取条数（`reachedTotal` 成立 → 取全）；
 *   - `has_more=true`  ⇒ total = 已取条数 + 1（「上游声称还有」）。这样即使本页不满，
 *     `fetchAllPages` 也不会把「短页」当成末页而静默判取全——与
 *     `src/lib/pagination.ts` 里「短页与 total 矛盾时视为未取全」的既有语义一致。
 *
 * `stopBefore` 给定时，结果里已包含早于该时刻的记录即视为「窗口已覆盖」——
 * `fetchAllPages` 不支持提前中断，因此覆盖判定放在取回之后做。
 */
export async function fetchQwBillings(
  account: AccountConfig,
  ctx: ProbeContext,
  options: { maxPages?: number; stopBefore?: number } = {},
): Promise<{ items: QwBill[]; complete: boolean }> {
  const origin = resolveOrigin(account);
  const cookie = resolveCookie(account, ctx);
  /** 第 N 页（从 1 起）要用的游标；由上一页响应写入 */
  const cursors: string[] = [];
  /**
   * 已解析出的**去重**条数。
   *
   * 必须与 `fetchAllPages` 的计数口径一致（它按 `keyOf` 去重后累加）：
   *   - 解析层丢弃的无效条目（缺 amount / 缺时间）两边都不计；
   *   - 跨页重复的 `transaction_id` 两边都只算一次。
   * 口径不一致会让 total 永远达不到，把已经取全的结果误判成未取全。
   */
  const seenIds = new Set<string>();

  const result = await fetchAllPages<QwBill>({
    pageSize: BILLINGS_PAGE_SIZE,
    maxPages: options.maxPages ?? BILLINGS_MAX_PAGES,
    keyOf: (bill) => bill.id,
    label: '千问办公积分流水',
    fetchPage: async (page) => {
      const params = new URLSearchParams({
        limit: String(BILLINGS_PAGE_SIZE),
        source: 'all',
      });
      const cursor = cursors[page - 1];
      if (cursor) params.set('cursor', cursor);

      const { body } = await fetchJson(`${origin}/user/billings?${params.toString()}`, {
        method: 'GET',
        headers: qwenWorkHeaders(cookie),
        timeoutMs: ctx.timeoutMs || QWENWORK_TIMEOUT_FALLBACK,
      });
      const data = unwrap(body, '积分流水请求失败');
      const payload = isRecord(data) ? data : {};
      const list = pick(payload, 'items');
      if (!Array.isArray(list)) {
        throw new Error('积分流水响应缺少 items 字段（登录态可能已失效）');
      }

      const parsed = list.map(parseBill).filter((bill): bill is QwBill => bill !== null);
      for (const bill of parsed) seenIds.add(bill.id);
      const nextCursor = firstString(pick(payload, 'next_cursor', 'nextCursor'));
      const hasMore = pick(payload, 'has_more', 'hasMore') === true;
      if (hasMore && nextCursor) cursors[page] = nextCursor;

      return { items: parsed, total: hasMore ? seenIds.size + 1 : seenIds.size };
    },
  });

  if (options.stopBefore !== undefined && result.items.length > 0) {
    const oldest = result.items.reduce(
      (min, bill) => Math.min(min, bill.at),
      Number.POSITIVE_INFINITY,
    );
    if (oldest < options.stopBefore) {
      return { items: result.items, complete: true };
    }
  }

  return { items: result.items, complete: result.complete };
}

/* ------------------------------------------------------------------ *
 * 批次构建
 * ------------------------------------------------------------------ */

interface LotSpec {
  key: 'daily' | 'monthly' | 'longterm';
  label: string;
  amount: number;
  expiresAt: string | null;
  note: string;
}

/**
 * 只接受**未来**的时间当作到期。
 *
 * 上游的 `next_refresh_date` / `next_due_date` 在续费当天可能还是上一周期的旧值；
 * 拿它当到期会把还有余额的桶判成「已过期」并从列表里隐藏——宁可退回规则推算，
 * 也不能把能用的额度藏起来。
 */
function futureOrNull(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now ? iso : null;
}

function buildLots(input: {
  wallet: QwWallet;
  plan: QwPlan;
  now: number;
}): { lots: CreditLot[]; notes: string[] } {
  const notes: string[] = [];

  // 每月积分：优先上游给的「下次刷新时间」；取不到（或已是过去）时按
  // 「北京时间本月末 24:00」推算，并在 note 里说明这是推算值（不冒充上游返回值）。
  let monthlyExpiry =
    futureOrNull(input.plan.creditsRefreshAt, input.now) ??
    futureOrNull(input.plan.subscriptionExpiresAt, input.now);
  if (!monthlyExpiry && input.wallet.monthly > 0) {
    monthlyExpiry = new Date(endOfBeijingMonth(input.now)).toISOString();
    notes.push(
      '每月订阅积分的刷新时间由规则推算（北京时间本月末 24:00），上游未返回有效的 next_refresh_date',
    );
  }

  const dailyExpiry =
    input.wallet.daily > 0 ? new Date(endOfBeijingDay(input.now)).toISOString() : null;

  const specs: LotSpec[] = [
    {
      key: 'daily',
      label: '每日刷新积分',
      amount: input.wallet.daily,
      expiresAt: dailyExpiry,
      note: '每天 00:00（北京时间）刷新，当日未用完失效',
    },
    {
      key: 'monthly',
      label: '每月订阅积分',
      amount: input.wallet.monthly,
      expiresAt: monthlyExpiry,
      note: '订阅套餐内积分，当月有效',
    },
    {
      key: 'longterm',
      label: '长期积分',
      amount: input.wallet.longterm,
      // 「有效期以具体规则为准」：拿不到确切日期就留空，不编
      expiresAt: null,
      note: '充值包 / 活动赠送，有效期以具体规则为准（未返回到期时间，不参与「最快到期」）',
    },
  ];

  const lots: CreditLot[] = [];
  for (const spec of specs) {
    if (spec.amount <= 0) continue;
    lots.push(
      makeLot({
        id: `qwenwork-${spec.key}`,
        label: spec.label,
        amount: spec.amount,
        currency: 'CREDITS',
        expiresAt: spec.expiresAt,
        note: spec.note,
      }),
    );
  }
  return { lots, notes };
}

/* ------------------------------------------------------------------ *
 * 网页端登录（CDP 旁听真实 Cookie 头）
 * ------------------------------------------------------------------ */

/**
 * 账号去重键兜底：Cookie 没有自解释的用户标识时用指纹（稳定、不可逆）。
 *
 * 注意指纹会随重新登录轮换，只能当兜底——登录成功时应优先用
 * `/user/info` 返回的稳定用户 id（见 makeQwenWorkWebLogin 的 ready 分支）。
 */
function accountIdOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex').slice(0, 16);
}

function makeQwenWorkWebLogin(usageUrl: string): ProviderLogin {
  return {
    id: 'web',
    kind: 'web',
    label: '网页端登录',
    hint: '自动打开调试 Chrome 的千问办公「用量明细」页；你在那个窗口登录后，本页面自动完成添加。',
    qr: false,
    intervalMs: QW_WEB_POLL_INTERVAL_MS,
    async start(input) {
      const chrome = await ensureDebugChrome();
      input.log(
        `调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
      );
      const collector = await openCookieCollector({ url: usageUrl });
      input.log('千问办公用量明细页已打开，等待登录');

      return {
        authUrl: usageUrl,
        qr: false,
        ttlMs: QW_WEB_LOGIN_TTL_MS,
        hint: '请在刚打开的 Chrome 窗口里登录千问办公（qwenwork.cn）；登录后本页面会自动完成添加。',
        secret: { collector, startedAt: Date.now(), reloads: 0, lastReloadAt: 0 },
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

      const hosts = ['qwenwork.cn'];
      const raw = collector.cookieFor(hosts);
      // 千问办公的登录态 Cookie 名随登录方式（手机 / Google / 钉钉 / SSO）而变，
      // 因此判据取「页面自己请求 /user/balance 拿到 2xx」这条功能性证据。
      const identityOk = collector.sawSuccessfulRequest(QWENWORK_IDENTITY_PATH);
      const loggedIn = Boolean(raw) && identityOk;

      if (!loggedIn) {
        const reloads = Number(pick(secret, 'reloads')) || 0;
        const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
        const now = Date.now();
        const idle = collector.idleMs();
        const idleLongEnough = idle >= QW_WEB_RELOAD_IDLE_MS || idle === 0;
        if (
          reloads < QW_WEB_RELOAD_MAX &&
          idleLongEnough &&
          now - lastReloadAt >= QW_WEB_RELOAD_MIN_INTERVAL_MS
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
            ? `已抓到千问办公页面 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
            : `正在等待你在调试 Chrome 窗口里登录千问办公（已等待 ${waitedSec} 秒）…`,
        };
      }

      const cookie = normalizeCookieHeader(raw ?? '');
      // 身份优先用 /user/info 的稳定用户 id：Cookie 会随重新登录轮换，
      // 指纹去重会「重新登录 → 新建卡片」。身份接口失败才退回指纹。
      let identity = { id: '', name: '' };
      try {
        const { body } = await fetchJson(`${QWENWORK_ORIGIN}/user/info`, {
          method: 'GET',
          headers: qwenWorkHeaders(cookie),
          timeoutMs: ctx.timeoutMs || QWENWORK_TIMEOUT_FALLBACK,
        });
        identity = parseQwIdentity(unwrap(body, '账号信息请求失败'));
      } catch (error) {
        ctx.log(`千问办公账号身份获取失败（改用 Cookie 指纹去重）：${(error as Error).message}`);
      }
      const accountId = identity.id || accountIdOf(cookie);
      ctx.log(`千问办公网页端登录已抓到 Cookie（账号键 ${accountId}），开始验证落库`);

      return {
        status: 'ready',
        // 昵称为空时用占位名「千问办公 · 登录账号」，探测时由 adoptResolvedAccountName 补
        account: { id: accountId, name: identity.name },
        credentials: { cookie },
        options: {},
        message: '已抓到登录态 Cookie，正在验证取数并写入本机配置…',
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

const qwenWorkWebLogin = makeQwenWorkWebLogin(QWENWORK_USAGE_URL);

export const qwenworkAdapter: ProviderAdapter = {
  id: 'qwenwork',
  displayName: '千问办公',
  region: 'cn',
  dashboardUrl: QWENWORK_USAGE_URL,
  usageUrl: QWENWORK_USAGE_URL,
  requiredCredentialKeys: ['cookie'],
  envNames: { cookie: 'QWENWORK_COOKIE' },
  credentialHint:
    '登录 https://qwenwork.cn 后，推荐直接用卡片上的「网页端登录」，' +
    '或跑 npm run capture -- qwenwork 自动抓取（写入 QWENWORK_COOKIE）；' +
    '也可以从 DevTools 里复制任意 qwenwork.cn 请求的 Cookie 头整段粘贴。',
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '登录 qwenwork.cn → DevTools → 任意请求 → Headers → 复制 Cookie 整段值',
      hint: '需包含登录态 Cookie（手机验证码 / Google / 钉钉登录都会写入）。',
      multiline: true,
    },
  ],
  manageHint:
    '凭证会先真实调用一次余额接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',
  login: qwenWorkWebLogin,
  loginMethods: [qwenWorkWebLogin],

  /**
   * 用量 + 增量：逐笔流水（`/user/billings`）。
   *   - `amount < 0` → use，`amount > 0` → grant；
   *   - 只覆盖到「昨日 00:00」才算取全，否则整份退回本地采样
   *     （与 minimax.ts / xiaohuanxiong.ts 同一策略：宁可退，也不给一半数据还标 upstream）。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    if (!resolveCookie(account, ctx)) return null;
    try {
      const windowStart = startOfDay(ctx.now) - 86_400_000;
      const result = await fetchQwBillings(account, ctx, {
        maxPages: BILLINGS_MAX_PAGES,
        stopBefore: windowStart,
      });
      if (!result.complete) {
        ctx.log('千问办公积分流水超过翻页上限，用量与增量退回本地采样');
        return null;
      }
      const records: UsageRecord[] = [];
      for (const bill of result.items) {
        if (bill.at < windowStart || bill.at > ctx.now + 3_600_000) continue;
        if (bill.amount === 0) continue;
        records.push({
          at: bill.at,
          kind: bill.amount < 0 ? 'use' : 'grant',
          amount: Math.abs(bill.amount),
        });
      }
      return { records, covers: { use: true, grant: true } };
    } catch (error) {
      ctx.log(`千问办公积分流水获取失败（退回本地采样）：${(error as Error).message}`);
      return null;
    }
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const adapter = qwenworkAdapter;
    if (!resolveCookie(account, ctx)) {
      return notConfigured(adapter, account, ctx, ['cookie']);
    }

    try {
      const balanceData = await qwenWorkGet(account, ctx, '/user/balance', '余额请求失败');
      const totalBalance = Math.max(
        0,
        firstNumber(isRecord(balanceData) ? pick(balanceData, 'balance') : null) ?? 0,
      );

      // 三桶构成：失败不影响总额展示（总额是权威数字），只是无法拆批次
      let wallet: QwWallet = { daily: 0, monthly: 0, longterm: 0 };
      let walletFailed = false;
      try {
        const walletData = await qwenWorkGet(account, ctx, '/user/wallets', '积分构成请求失败');
        wallet = parseQwWallet(walletData);
      } catch (error) {
        walletFailed = true;
        ctx.log(`千问办公积分构成获取失败（不影响总额）：${(error as Error).message}`);
      }

      // 账号信息：昵称（仅占位名时补查）+ 套餐 / 订阅到期 / 每月刷新时间。
      // 失败不影响余额，只是批次到期时间退化到规则推算。
      let plan: QwPlan = {
        plan: null,
        pid: '',
        subscriptionExpiresAt: null,
        creditsRefreshAt: null,
        isBiz: false,
      };
      let displayName: string | null = null;
      try {
        const info = await qwenWorkGet(account, ctx, '/user/info', '账号信息请求失败');
        plan = parseQwPlan(info);
        const identity = parseQwIdentity(info);
        if (
          identity.name &&
          ctx.persistAccountName &&
          isPlaceholderAccountName(adapter.displayName, account.displayName ?? '')
        ) {
          displayName = await ctx.persistAccountName(identity.name).catch((error: unknown) => {
            ctx.log(`千问办公账号昵称写回失败（不影响取数）：${(error as Error).message}`);
            return null;
          });
        }
      } catch (error) {
        ctx.log(`千问办公账号信息获取失败（不影响余额）：${(error as Error).message}`);
      }

      const { lots, notes } = buildLots({ wallet, plan, now: ctx.now });
      const { active, expired } = splitByExpiry(lots, ctx.now);

      // 三桶之和与可用总额对不上时如实说明：可能有未入桶的额度（企业共享 / 试算），
      // 也可能上游改了口径——两种都值得第一眼看到
      const composed = lots.reduce((sum, lot) => sum + lot.amount, 0);
      const mismatch =
        !walletFailed && Math.abs(composed - totalBalance) > 0.5
          ? `积分构成合计 ${round2(composed)} 与剩余可用 ${round2(totalBalance)} 不一致，余额以「剩余可用」为准`
          : null;

      return buildSnapshot({
        adapter,
        account,
        status: 'ok',
        now: ctx.now,
        displayName,
        accountId: displayName,
        plan: plan.plan,
        balance: { amount: round2(totalBalance), currency: 'CREDITS' },
        credits: active,
        // 平台没有「周期上限」概念（积分不按窗口封顶），不画假进度条
        windows: [],
        note: joinNotes(
          plan.isBiz ? '企业账号：个人积分仍按三桶展示，企业配额未纳入' : null,
          ...notes,
          mismatch,
          walletFailed ? '积分构成请求失败，仅显示可用总额，未拆分批次' : null,
          expired.length > 0
            ? `另有 ${expired.length} 个批次已过期（共 ${round2(expired.reduce((sum, lot) => sum + lot.amount, 0))} 积分），未在列表中展示`
            : null,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      const message = isAuthFailure(error)
        ? `${(error as Error).message}（登录态 Cookie 可能已过期，请重新「网页端登录」或重跑 npm run capture -- qwenwork）`
        : (error as Error).message;
      return failure(adapter, account, ctx, status, message);
    }
  },
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
