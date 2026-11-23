import { createHash } from 'node:crypto';
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
  hiddenLotsNote,
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
  type CheckinRemoteState,
  type CheckinResult,
} from './base.js';

/**
 * WPS 灵犀（lingxi.kdocs.cn）智点。
 *
 * 官方没有公开查询 API；这里复刻的是网页端自己的内部接口，证据见
 * docs/plans/平台适配器-接入WPS灵犀智点-开发设计方案.md：
 *
 *   GET  /api/public/v1/credits/balance
 *        → { data: {
 *              total_balance,                      账户级可用智点
 *              bonus_credits[], purchased_credits[]  逐批剩余 + expire_time
 *              bonus_summary{total_value,total_consumed},
 *              purchased_summary{...},
 *              active_entitlement, active_subscription,
 *              team_credits{name,member_available},
 *              extra_grant_status
 *          } }
 *   GET  /api/public/v1/credits/transaction/list?type=all&limit=&income_cursor=&expense_cursor=
 *        → { data: { list[], income_cursor, expense_cursor, has_more } }
 *   GET  /api/aigc/v3/assistant/identity   → 账号身份（昵称 / id，可选）
 *
 * 鉴权：WPS 网页登录态 Cookie（前端所有请求 `credentials: "include"`）。
 * 未登录实测：
 *   - `/api/public/v1/credits/balance` → 401
 *     `{"result":"UserUnauthorized","v7code":401020001,"hint":"用户无权限"}`
 *   - `https://account.kdocs.cn/api/v3/islogin` → 403 `{"result":"userNotLogin"}`
 *
 * 口径（见方案 §5.2）：
 *   - 余额 = `total_balance`，单位智点（POINTS）；
 *   - 只有 `bonus_credits[]` / `purchased_credits[]` 逐批建 `CreditLot`，
 *     `active_entitlement` 只取套餐名——它对应的智点已经计入活动赠送桶，
 *     再建一条会重复计算；
 *   - 团队智点与个人智点不通用，只在 note 提示，不计入余额；
 *   - 本轮只读：不领取 `/extra_grant/claim`、不领任务奖励、不修改消耗顺序。
 */

const LINGXI_TIMEOUT_FALLBACK = 12_000;
const LINGXI_ORIGIN = 'https://lingxi.kdocs.cn';
/** 卡片「每日用量」跳转与网页端登录打开的都是灵犀首页（设置 → 智点详情在其内） */
const LINGXI_USAGE_URL = 'https://lingxi.kdocs.cn/';
/** 登录判据 / 余额接口（网页端自己会请求它） */
const LINGXI_BALANCE_PATH = '/api/public/v1/credits/balance';
const LINGXI_IDENTITY_PATH = '/api/aigc/v3/assistant/identity';
/**
 * 任务中心：每日签到是其中的 `daily_check_in` 任务（前端 TaskCenter 的 taskKey）。
 *
 *   GET  /api/public/v1/tasks                     → { tasks[], total_claimed_credits }
 *   POST /api/public/v1/tasks/daily_check_in/claim → { extra, total_claimed_credits }
 *
 * 每日任务的 `extra` 里带 `today_day` 与 `check_in_days[]`（`{day,status}`），
 * 今天那一项 `status === "claimed"` 就是「已签到」——只看这一项，
 * 不拿任务级 `status` 反推，避免一次性任务的状态串味。
 */
const LINGXI_TASKS_PATH = '/api/public/v1/tasks';
const LINGXI_SIGNIN_TASK_KEY = 'daily_check_in';

/**
 * 逐笔流水的单页条数。
 *
 * 网页端固定用 10，这里保持一致：既不会因为上游忽略 limit 而把「短页」误判成末页，
 * 也能覆盖「昨日 00:00 至今」的常见条数。20 页 = 200 条，足够两天。
 */
const TX_PAGE_SIZE = 10;
const TX_MAX_PAGES = 20;

/** 网页端登录（CDP 抓取）节奏：与千问办公 / 小浣熊同一套常量 */
const LX_WEB_POLL_INTERVAL_MS = 2_000;
const LX_WEB_RELOAD_IDLE_MS = 20_000;
const LX_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
const LX_WEB_RELOAD_MAX = 2;
const LX_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 上游表示「没登录 / 没权限」的 result 值（实测 UserUnauthorized / userNotLogin） */
const AUTH_RESULTS = new Set(['UserUnauthorized', 'userNotLogin', 'NotLogin', 'Unauthorized']);
/** 智点接口未登录时的 v7code（实测 401020001） */
const AUTH_V7CODES = new Set([401020001]);

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  return (override || LINGXI_ORIGIN).replace(/\/+$/, '');
}

function resolveCookie(account: AccountConfig, ctx: ProbeContext): string {
  return normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
}

function lingxiHeaders(cookie: string, origin = LINGXI_ORIGIN): Record<string, string> {
  return {
    Accept: 'application/json',
    // 前端是同源请求，浏览器自带 Referer / Origin；服务端补上更贴近真实流量
    Referer: `${origin.replace(/\/+$/, '')}/`,
    Origin: origin.replace(/\/+$/, ''),
    Cookie: cookie,
  };
}

/**
 * 解 WPS 响应信封：`{ v7code: 0, result: "ok", data }`。
 *
 * 成功一定有 `result: "ok"`；`v7code` 在部分接口上缺省，因此只在它存在且非 0 时判错。
 * 鉴权失败归为 HTTP 401，交给 probe 的统一降级分支处理。
 */
function unwrap(body: unknown, fallback: string): unknown {
  if (!isRecord(body)) {
    throw new Error(`${fallback}：响应不是 JSON 对象`);
  }
  const rawResult = body.result;
  const result = typeof rawResult === 'string' ? rawResult : '';
  const v7code = firstNumber(body.v7code, body.v7Code);
  const message = firstString(pick(body, 'hint', 'msg', 'message'));
  const detail = message ? `：${message}` : '';

  if (AUTH_RESULTS.has(result) || (v7code !== null && AUTH_V7CODES.has(v7code))) {
    throw new HttpError(`${fallback}${detail}（登录态可能已失效）`, 401);
  }
  if (result && result !== 'ok') {
    throw new Error(`${fallback}${detail}（result=${result}）`);
  }
  if (v7code !== null && v7code !== 0) {
    throw new Error(`${fallback}${detail}（v7code=${v7code}）`);
  }
  return body.data ?? body;
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  return /UserUnauthorized|userNotLogin|用户无权限|未登录|登录态|401020001/i.test(
    (error as Error)?.message ?? '',
  );
}

async function lingxiGet(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  label: string,
): Promise<unknown> {
  const cookie = resolveCookie(account, ctx);
  const origin = resolveOrigin(account);
  const { body } = await fetchJson(`${origin}${path}`, {
    method: 'GET',
    headers: lingxiHeaders(cookie, origin),
    timeoutMs: ctx.timeoutMs || LINGXI_TIMEOUT_FALLBACK,
  });
  return unwrap(body, label);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function lingxiPost(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  label: string,
): Promise<unknown> {
  const cookie = resolveCookie(account, ctx);
  const origin = resolveOrigin(account);
  const { body } = await fetchJson(`${origin}${path}`, {
    method: 'POST',
    headers: lingxiHeaders(cookie, origin),
    timeoutMs: ctx.timeoutMs || LINGXI_TIMEOUT_FALLBACK,
  });
  return unwrap(body, label);
}

function fmtAmount(value: number | null): string {
  return value === null ? '—' : String(round2(value));
}

/* ------------------------------------------------------------------ *
 * 余额 / 批次
 * ------------------------------------------------------------------ */

export interface LingxiBatch {
  id: string;
  /** 该批次当前剩余智点 */
  amount: number;
  expiresAt: string | null;
}

export interface LingxiSummary {
  total: number | null;
  consumed: number | null;
}

export interface LingxiBalance {
  total: number | null;
  bonus: LingxiBatch[];
  purchased: LingxiBatch[];
  bonusSummary: LingxiSummary;
  purchasedSummary: LingxiSummary;
  plan: string | null;
  teamName: string | null;
  teamAvailable: number | null;
  extraGrantStatus: string;
}

/**
 * 解析一个批次数组（`bonus_credits` / `purchased_credits`）。
 *
 * 前端产物只读取了 `balance` 与 `expire_time`；这里额外兼容
 * `value - consumed` 的形态，避免上游把「授予量 + 已用」作为字段时整条丢失。
 */
export function parseLingxiBatches(
  value: unknown,
  kind: 'bonus' | 'purchased',
): LingxiBatch[] {
  if (!Array.isArray(value)) return [];
  const out: LingxiBatch[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const balance = firstNumber(pick(raw, 'balance', 'remaining', 'amount'));
    const total = firstNumber(pick(raw, 'value', 'total'));
    const consumed = firstNumber(pick(raw, 'consumed', 'used'));
    const amount =
      balance ?? (total !== null ? Math.max(0, total - (consumed ?? 0)) : null);
    if (amount === null || amount <= 0) return;

    const expiresAt = toIso(
      pick(
        raw,
        'expire_time',
        'expireTime',
        'expires_at',
        'expiresAt',
        'valid_until',
        'validUntil',
        'end_time',
        'endTime',
      ),
    );
    const id =
      firstString(pick(raw, 'id', 'batch_id', 'batchId', 'transaction_id', 'transactionId')) ||
      `lingxi-${kind}-${expiresAt ?? 'no-expiry'}-${index}`;
    out.push({ id, amount, expiresAt });
  });
  return out;
}

export function parseLingxiSummary(value: unknown): LingxiSummary {
  if (!isRecord(value)) return { total: null, consumed: null };
  return {
    total: firstNumber(pick(value, 'total_value', 'totalValue', 'total')),
    consumed: firstNumber(pick(value, 'total_consumed', 'totalConsumed', 'consumed')),
  };
}

export function parseLingxiBalance(data: unknown): LingxiBalance {
  const root = isRecord(data) ? data : {};
  const entitlement = pick(root, 'active_entitlement', 'activeEntitlement');
  const subscription = pick(root, 'active_subscription', 'activeSubscription');
  const team = pick(root, 'team_credits', 'teamCredits');

  return {
    total: firstNumber(pick(root, 'total_balance', 'totalBalance')),
    bonus: parseLingxiBatches(pick(root, 'bonus_credits', 'bonusCredits'), 'bonus'),
    purchased: parseLingxiBatches(pick(root, 'purchased_credits', 'purchasedCredits'), 'purchased'),
    bonusSummary: parseLingxiSummary(pick(root, 'bonus_summary', 'bonusSummary')),
    purchasedSummary: parseLingxiSummary(pick(root, 'purchased_summary', 'purchasedSummary')),
    // 权益只用于套餐标签：它对应的智点已经计入活动赠送桶，不能再建一条批次
    plan:
      firstString(pick(entitlement, 'name', 'title')) ||
      firstString(pick(subscription, 'name', 'plan_name', 'product_name', 'merchandise_name')) ||
      null,
    teamName: isRecord(team) ? firstString(pick(team, 'name', 'team_name')) || null : null,
    teamAvailable: isRecord(team)
      ? firstNumber(pick(team, 'member_available', 'memberAvailable', 'available'))
      : null,
    extraGrantStatus: firstString(pick(root, 'extra_grant_status', 'extraGrantStatus')),
  };
}

/** 把上游批次转成统一 `CreditLot`；`basis` 固定为 remaining（上游给的就是剩余） */
function buildLots(parsed: LingxiBalance): CreditLot[] {
  const lots = new Map<string, CreditLot>();
  const push = (batch: LingxiBatch, kind: 'bonus' | 'purchased'): void => {
    const label = kind === 'bonus' ? '活动赠送' : '加量包';
    const note =
      kind === 'bonus'
        ? '活动赠送批次（含任务奖励 / 权益发放）'
        : '加量包有效期自购买生效起 372 天';
    lots.set(
      batch.id,
      makeLot({
        id: batch.id,
        label,
        amount: batch.amount,
        currency: 'POINTS',
        expiresAt: batch.expiresAt,
        note,
      }),
    );
  };
  for (const batch of parsed.bonus) push(batch, 'bonus');
  for (const batch of parsed.purchased) push(batch, 'purchased');
  return [...lots.values()];
}

/* ------------------------------------------------------------------ *
 * 账号身份
 * ------------------------------------------------------------------ */

export interface LingxiIdentity {
  id: string;
  name: string;
}

export function parseLingxiIdentity(data: unknown): LingxiIdentity {
  const root = isRecord(data) ? data : {};
  const nested = pick(root, 'user', 'profile', 'account');
  const source = isRecord(nested) ? { ...root, ...nested } : root;
  return {
    id: firstString(pick(source, 'user_id', 'userId', 'uid', 'id', 'userid')),
    name: firstString(
      pick(source, 'nickname', 'name', 'display_name', 'displayName', 'username', 'user_name'),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * 逐笔流水
 * ------------------------------------------------------------------ */

export interface LingxiTransaction {
  id: string;
  kind: 'use' | 'grant';
  /** 发生时间（epoch ms） */
  at: number;
  /** 非负金额 */
  amount: number;
}

function parseTransaction(raw: unknown, index: number): LingxiTransaction | null {
  if (!isRecord(raw)) return null;
  const type = firstString(pick(raw, 'type')).toLowerCase();
  // 前端自己会把「每日重置」过滤掉：它不是真实增减，计入会让用量/增量失真
  if (type === 'daily_reset') return null;
  if (type !== 'income' && type !== 'expense') return null;

  const atIso = toIso(pick(raw, 'time', 'created_at', 'createdAt'));
  const at = atIso ? Date.parse(atIso) : Number.NaN;
  if (!Number.isFinite(at)) return null;

  const rawAmount = firstNumber(pick(raw, 'amount', 'delta'));
  const actualDeducted = firstNumber(
    pick(raw, 'actual_deducted', 'actualDeducted'),
  );
  const taskConsumed = firstNumber(pick(raw, 'task_consumed', 'taskConsumed'));

  let amount = 0;
  if (type === 'income') {
    amount = Math.abs(rawAmount ?? 0);
  } else {
    // 消耗优先取「实际扣减」，其次「任务积分抵扣」，最后才退回有符号金额；
    // 允许负数是因为上游可能把 expense 的 amount 直接写成负值
    const candidate = [actualDeducted, taskConsumed, rawAmount].find(
      (value): value is number => value !== null && value !== 0,
    );
    amount = Math.abs(candidate ?? 0);
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // 收入 / 支出可能共用同一套数字 id，加类型前缀避免跨流去重时互相吞掉
  const rawId = firstString(pick(raw, 'id', 'transaction_id', 'transactionId'));
  const id = `${type}-${rawId || `${at}-${index}`}`;
  return { id, kind: type === 'income' ? 'grant' : 'use', at, amount };
}

/**
 * 拉取逐笔流水（新→旧，双游标分页）。
 *
 * 翻页交给 `fetchAllPages()`（AGENTS §9 的硬约束），这里只负责：
 *   ① 上一页的 `income_cursor` / `expense_cursor` → 本页查询参数；
 *   ② 把上游 `has_more` 翻译成 `fetchAllPages` 认得的 `total`
 *      （「还有」⇒ 已取条数 + 1，避免短页被当成末页而静默判取全；与 qwenwork.ts 同一范式）。
 *
 * 收入 / 支出是两条独立游标，必须**同时**带回去；只带一条会重复取另一条的前几页。
 */
export async function fetchLingxiTransactions(
  account: AccountConfig,
  ctx: ProbeContext,
  options: { maxPages?: number; stopBefore?: number } = {},
): Promise<{ items: LingxiTransaction[]; complete: boolean }> {
  const origin = resolveOrigin(account);
  const cookie = resolveCookie(account, ctx);
  /**
   * 第 N 页要用的双游标；由上一页响应写入。
   *
   * 初值用 `"0"` 而不是空串：网页端首屏就是 `income_cursor=0&expense_cursor=0`，
   * 跟它保持一致，避免服务端对「缺参数」与「游标 0」的解释不同。
   */
  const cursors: Array<{ income: string; expense: string }> = [
    { income: '0', expense: '0' },
  ];
  /**
   * 已解析出的**去重**条数，口径必须与 `fetchAllPages` 的 `keyOf` 一致：
   * 解析层丢弃的无效行（缺时间 / 金额 0 / daily_reset）两边都不计。
   */
  const seen = new Set<string>();

  const result = await fetchAllPages<LingxiTransaction>({
    pageSize: TX_PAGE_SIZE,
    maxPages: options.maxPages ?? TX_MAX_PAGES,
    keyOf: (tx) => tx.id,
    label: 'WPS 灵犀智点流水',
    fetchPage: async (page) => {
      const cursor = cursors[page - 1] ?? { income: '0', expense: '0' };
      const params = new URLSearchParams({ type: 'all', limit: String(TX_PAGE_SIZE) });
      params.set('income_cursor', cursor.income || '0');
      params.set('expense_cursor', cursor.expense || '0');

      const { body } = await fetchJson(
        `${origin}/api/public/v1/credits/transaction/list?${params.toString()}`,
        {
          method: 'GET',
          headers: lingxiHeaders(cookie, origin),
          timeoutMs: ctx.timeoutMs || LINGXI_TIMEOUT_FALLBACK,
        },
      );
      const data = unwrap(body, '智点流水请求失败');
      const payload = isRecord(data) ? data : {};
      const list = pick(payload, 'list', 'items');
      if (!Array.isArray(list)) {
        throw new Error('智点流水响应缺少 list 字段（登录态可能已失效）');
      }

      const parsed = list
        .map((item, index) => parseTransaction(item, index))
        .filter((tx): tx is LingxiTransaction => tx !== null);
      for (const tx of parsed) seen.add(tx.id);

      const income = firstString(pick(payload, 'income_cursor', 'incomeCursor'));
      const expense = firstString(pick(payload, 'expense_cursor', 'expenseCursor'));
      // 上游可能给 true / 1 / "1"；只认严格 true 会在字段形态变化时静默漏页
      const rawHasMore = pick(payload, 'has_more', 'hasMore');
      const hasMore =
        rawHasMore === true || rawHasMore === 1 || rawHasMore === '1' || rawHasMore === 'true';
      if (hasMore) {
        cursors[page] = {
          income: income || cursor.income,
          expense: expense || cursor.expense,
        };
      }

      return {
        items: parsed,
        total: hasMore ? seen.size + 1 : seen.size,
        rawCount: list.length,
      };
    },
  });

  // 时间倒序时，已出现早于窗口的记录即可判定「需要的窗口已覆盖」；
  // 排序异常时这条判据只会少判取全，不会把缺数据当成完整。
  if (options.stopBefore !== undefined && result.items.length > 0) {
    const oldest = result.items.reduce(
      (min, tx) => Math.min(min, tx.at),
      Number.POSITIVE_INFINITY,
    );
    if (oldest < options.stopBefore) {
      return { items: result.items, complete: true };
    }
  }

  return { items: result.items, complete: result.complete };
}

/* ------------------------------------------------------------------ *
 * 网页端登录（CDP 旁听真实 Cookie 头）
 * ------------------------------------------------------------------ */

function accountIdOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex').slice(0, 16);
}

function makeLingxiWebLogin(usageUrl: string): ProviderLogin {
  return {
    id: 'web',
    kind: 'web',
    label: '网页端登录',
    hint: '自动打开调试 Chrome 的灵犀首页；你在那个窗口登录 WPS 账号后，本页面自动完成添加。',
    qr: false,
    intervalMs: LX_WEB_POLL_INTERVAL_MS,
    async start(input) {
      const chrome = await ensureDebugChrome();
      input.log(
        `调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
      );
      const collector = await openCookieCollector({ url: usageUrl });
      input.log('灵犀首页已打开，等待登录');

      return {
        authUrl: usageUrl,
        qr: false,
        ttlMs: LX_WEB_LOGIN_TTL_MS,
        hint: '请在刚打开的 Chrome 窗口里登录 WPS 账号（lingxi.kdocs.cn）；登录后本页面会自动完成添加。',
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

      // 灵犀登录态可能同时落在 .kdocs.cn 与 .wps.cn；优先取页面自己请求过的
      // lingxi.kdocs.cn 主机头（一定包含 `.kdocs.cn` 父域 Cookie），再退到任意 kdocs / wps 主机。
      const raw =
        collector.cookieFor(['lingxi.kdocs.cn']) ??
        collector.cookieFor(['kdocs.cn']) ??
        collector.cookieFor(['wps.cn']);
      // 功能性判据：页面自己请求余额接口拿到 2xx（访客是 401）
      const identityOk = collector.sawSuccessfulRequest(LINGXI_BALANCE_PATH);
      const loggedIn = Boolean(raw) && identityOk;

      if (!loggedIn) {
        const reloads = Number(pick(secret, 'reloads')) || 0;
        const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
        const now = Date.now();
        const idle = collector.idleMs();
        const idleLongEnough = idle >= LX_WEB_RELOAD_IDLE_MS || idle === 0;
        if (
          reloads < LX_WEB_RELOAD_MAX &&
          idleLongEnough &&
          now - lastReloadAt >= LX_WEB_RELOAD_MIN_INTERVAL_MS
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
            ? `已抓到灵犀页面 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
            : `正在等待你在调试 Chrome 窗口里登录 WPS 账号（已等待 ${waitedSec} 秒）…`,
        };
      }

      const cookie = normalizeCookieHeader(raw ?? '');
      // 身份优先用稳定 user id：Cookie 会随重新登录轮换，指纹去重会「重新登录 → 新建卡片」
      let identity: LingxiIdentity = { id: '', name: '' };
      try {
        const { body } = await fetchJson(`${LINGXI_ORIGIN}${LINGXI_IDENTITY_PATH}`, {
          method: 'GET',
          headers: lingxiHeaders(cookie),
          timeoutMs: ctx.timeoutMs || LINGXI_TIMEOUT_FALLBACK,
        });
        identity = parseLingxiIdentity(unwrap(body, '账号信息请求失败'));
      } catch (error) {
        ctx.log(`WPS 灵犀账号身份获取失败（改用 Cookie 指纹去重）：${(error as Error).message}`);
      }
      const accountId = identity.id || accountIdOf(cookie);
      ctx.log(`WPS 灵犀网页端登录已抓到 Cookie（账号键 ${accountId}），开始验证落库`);

      return {
        status: 'ready',
        // 昵称为空时用占位名「WPS 灵犀 · 登录账号」，探测时由 adoptResolvedAccountName 补
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
 * 每日签到（任务中心的 daily_check_in）
 * ------------------------------------------------------------------ */

export interface LingxiSigninDay {
  /** 周期内第几天（上游从 1 开始） */
  day: number;
  /** `available` / `claimed` / 其它（未开放、已错过） */
  status: string;
}

export interface LingxiDailyTask {
  taskKey: string;
  /** 任务级状态：`incomplete` / `claimable` / `claimed` */
  taskStatus: string;
  rewardAmount: number | null;
  /** 当前是周期里的第几天 */
  todayDay: number | null;
  /** 今天这一签的奖励 */
  todayReward: number | null;
  days: LingxiSigninDay[];
  totalClaimed: number | null;
}

/** 从 `GET /tasks` 的 data 里取每日签到任务；没有则 null */
export function parseLingxiDailyTask(data: unknown): LingxiDailyTask | null {
  const tasks = isRecord(data) && Array.isArray(data.tasks) ? (data.tasks as unknown[]) : [];
  const records = tasks.filter(isRecord);
  const daily =
    records.find((item) => String(pick(item, 'task_key', 'taskKey') ?? '') === LINGXI_SIGNIN_TASK_KEY) ??
    records.find((item) => String(pick(item, 'type') ?? '') === 'daily');
  if (!daily) return null;

  const extra = isRecord(daily.extra) ? daily.extra : {};
  const rawDays = Array.isArray(extra.check_in_days) ? (extra.check_in_days as unknown[]) : [];
  const days: LingxiSigninDay[] = [];
  for (const raw of rawDays) {
    if (!isRecord(raw)) continue;
    const day = firstNumber(pick(raw, 'day'));
    if (day === null) continue;
    days.push({ day, status: firstString(pick(raw, 'status')) ?? '' });
  }

  return {
    taskKey: firstString(pick(daily, 'task_key', 'taskKey')) ?? LINGXI_SIGNIN_TASK_KEY,
    taskStatus: firstString(pick(daily, 'status')) ?? '',
    rewardAmount: firstNumber(pick(daily, 'reward_amount', 'rewardAmount')),
    todayDay: firstNumber(pick(extra, 'today_day', 'todayDay')),
    todayReward: firstNumber(pick(extra, 'today_reward', 'todayReward')),
    days,
    totalClaimed: isRecord(data) ? firstNumber(pick(data, 'total_claimed_credits', 'totalClaimedCredits')) : null,
  };
}

/** 今天是否已签到：以 `check_in_days` 里今天那一项为准 */
export function lingxiSignedToday(task: LingxiDailyTask): boolean {
  const today = task.todayDay === null
    ? null
    : task.days.find((item) => item.day === task.todayDay) ?? null;
  if (today) return today.status === 'claimed';
  // 没有天维度（上游改版）时退回任务级状态；`claimable` 仍算未签
  return task.taskStatus === 'claimed';
}

function lingxiSigninCredit(task: LingxiDailyTask): number | undefined {
  const credit = task.todayReward ?? task.rewardAmount;
  return credit !== null && credit > 0 ? credit : undefined;
}

/** 只读：今天签没签、今天这一签值多少 */
export async function lingxiCheckinStatus(
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<CheckinRemoteState> {
  const data = await lingxiGet(account, ctx, LINGXI_TASKS_PATH, '任务面板请求失败');
  const task = parseLingxiDailyTask(data);
  if (!task) return { signedToday: false, inactive: true, message: '当前没有每日签到活动' };

  if (lingxiSignedToday(task)) {
    const credit = lingxiSigninCredit(task);
    return {
      signedToday: true,
      ...(credit !== undefined ? { credit } : {}),
      message: credit !== undefined ? `今日已签到（${credit} 智点）` : '今日已签到',
    };
  }

  const today = task.todayDay === null
    ? null
    : task.days.find((item) => item.day === task.todayDay) ?? null;
  if (today && today.status !== 'available') {
    return {
      signedToday: false,
      inactive: true,
      message: `今天不可签到（status=${today.status || 'unknown'}）`,
    };
  }
  return { signedToday: false, message: '今天未签到' };
}

/** 每日签到：先读只读状态，已签 / 无活动不重复领 */
export async function lingxiCheckin(
  account: AccountConfig,
  ctx: ProbeContext,
): Promise<CheckinResult> {
  try {
    const before = await lingxiCheckinStatus(account, ctx);
    if (before.signedToday) {
      return {
        outcome: 'done',
        ...(before.credit !== undefined ? { credit: before.credit } : {}),
        message: before.message ?? '今日已签到',
      };
    }
    if (before.inactive) {
      return { outcome: 'inactive', message: before.message ?? '当前没有每日签到活动' };
    }
  } catch (error) {
    // 状态接口失败不阻断签到：直接尝试领取，失败原因如实返回
    ctx.log(`WPS 灵犀签到状态读取失败（继续尝试签到）：${(error as Error).message}`);
  }

  try {
    const data = await lingxiPost(
      account,
      ctx,
      `${LINGXI_TASKS_PATH}/${LINGXI_SIGNIN_TASK_KEY}/claim`,
      '签到失败',
    );
    const extra = isRecord(data) && isRecord(data.extra) ? data.extra : {};
    const credit = firstNumber(pick(extra, 'today_reward', 'todayReward'));
    return {
      outcome: 'claimed',
      ...(credit !== null && credit > 0 ? { credit } : {}),
      message: credit !== null && credit > 0 ? `签到成功 +${credit} 智点` : '签到成功',
    };
  } catch (error) {
    // 领取失败后再核对一次：可能是「已在别处签过」，避免误报失败
    try {
      const after = await lingxiCheckinStatus(account, ctx);
      if (after.signedToday) {
        return {
          outcome: 'done',
          ...(after.credit !== undefined ? { credit: after.credit } : {}),
          message: after.message ?? '今日已签到',
        };
      }
    } catch {
      // 状态也查不到：保留原始错误
    }
    return { outcome: 'failed', message: `签到失败：${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

const lingxiWebLogin = makeLingxiWebLogin(LINGXI_USAGE_URL);

export const lingxiAdapter: ProviderAdapter = {
  id: 'lingxi',
  displayName: 'WPS 灵犀',
  region: 'cn',
  dashboardUrl: LINGXI_USAGE_URL,
  usageUrl: LINGXI_USAGE_URL,
  requiredCredentialKeys: ['cookie'],
  envNames: { cookie: 'LINGXI_COOKIE' },
  credentialHint:
    '登录 https://lingxi.kdocs.cn 后，推荐直接用卡片上的「网页端登录」，' +
    '或跑 npm run capture -- lingxi 自动抓取（写入 LINGXI_COOKIE）；' +
    '也可以从 DevTools 里复制任意 lingxi.kdocs.cn 请求的 Cookie 头整段粘贴。',
  manageAccounts: true,
  manageFields: [
    {
      key: 'cookie',
      label: 'Cookie',
      placeholder: '登录 lingxi.kdocs.cn → DevTools → 任意请求 → Headers → 复制 Cookie 整段值',
      hint: '需包含 WPS 登录态 Cookie（kdocs.cn / wps.cn 域）。',
      multiline: true,
    },
  ],
  manageHint:
    '凭证会先真实调用一次余额接口验证，通过了才写入本机 .env（新槽位）与 accounts.json；写入前自动备份到 .run/。',
  login: lingxiWebLogin,
  loginMethods: [lingxiWebLogin],

  /**
   * 用量 + 增量：逐笔流水（`/credits/transaction/list`）。
   *   - `type === "expense"` → use，`type === "income"` → grant；
   *   - 只覆盖到「昨日 00:00」才算取全，否则整份退回本地采样
   *     （与 minimax / qwenwork / 小浣熊同一策略：宁可退，也不给一半数据还标 upstream）。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    if (!resolveCookie(account, ctx)) return null;
    try {
      const windowStart = startOfDay(ctx.now) - 86_400_000;
      const result = await fetchLingxiTransactions(account, ctx, {
        maxPages: TX_MAX_PAGES,
        stopBefore: windowStart,
      });
      if (!result.complete) {
        ctx.log('WPS 灵犀智点流水超过翻页上限，用量与增量退回本地采样');
        return null;
      }
      const records: UsageRecord[] = [];
      for (const tx of result.items) {
        if (tx.at < windowStart || tx.at > ctx.now + 3_600_000) continue;
        records.push({ at: tx.at, kind: tx.kind, amount: tx.amount });
      }
      return { records, covers: { use: true, grant: true } };
    } catch (error) {
      ctx.log(`WPS 灵犀智点流水获取失败（退回本地采样）：${(error as Error).message}`);
      return null;
    }
  },

  checkin: {
    support: (account) =>
      Boolean(account.credentials.cookie || account.credentials.cookieHeader)
        ? { ok: true }
        : { ok: false, reason: '需要 WPS 网页登录态 Cookie 才能签到' },
    status: (account, ctx) => lingxiCheckinStatus(account, ctx),
    run: (account, ctx) => lingxiCheckin(account, ctx),
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const adapter = lingxiAdapter;
    if (!resolveCookie(account, ctx)) {
      return notConfigured(adapter, account, ctx, ['cookie']);
    }

    try {
      const balanceData = await lingxiGet(
        account,
        ctx,
        LINGXI_BALANCE_PATH,
        '智点余额请求失败',
      );
      const parsed = parseLingxiBalance(balanceData);
      const lots = buildLots(parsed);

      // 批次缺失但账户仍有余额：只显示总额，不编造到期时间
      const fallbackLot =
        lots.length === 0 && (parsed.total ?? 0) > 0
          ? [
              makeLot({
                id: 'lingxi-total',
                label: '智点余额',
                amount: parsed.total ?? 0,
                currency: 'POINTS',
                expiresAt: null,
                note: '上游未返回批次明细，仅显示总额，不参与「最快到期」',
              }),
            ]
          : [];
      const allLots = [...lots, ...fallbackLot];

      if (parsed.total === null && allLots.length === 0) {
        // 「没有字段」与「确实是 0」必须区分：前者说明上游改口径或登录态异常
        throw new Error('智点余额响应缺少 total_balance（登录态可能已失效或上游接口已变更）');
      }

      const totalBalance = round2(
        parsed.total ?? allLots.reduce((sum, lot) => sum + lot.amount, 0),
      );
      const { active, expired } = splitByExpiry(allLots, ctx.now);

      // 批次合计与账户余额对不上时如实说明：可能有过期批次 / 未入桶额度，
      // 也可能上游改了口径——两种都值得第一眼看到。汇总字段能进一步说明差在哪。
      const composed = round2(active.reduce((sum, lot) => sum + lot.amount, 0));
      const summaryDetail =
        parsed.bonusSummary.total !== null || parsed.purchasedSummary.total !== null
          ? `（活动赠送授予 ${fmtAmount(parsed.bonusSummary.total)} / 已用 ${fmtAmount(
              parsed.bonusSummary.consumed,
            )}；加量包授予 ${fmtAmount(parsed.purchasedSummary.total)} / 已用 ${fmtAmount(
              parsed.purchasedSummary.consumed,
            )}）`
          : '';
      const mismatch =
        fallbackLot.length === 0 && Math.abs(composed - totalBalance) > 0.5
          ? `批次合计 ${composed} 与智点余额 ${totalBalance} 不一致，余额以「当前智点余额」为准${summaryDetail}`
          : null;

      // 账号身份：仅用于占位名补昵称，失败不影响余额
      let displayName: string | null = null;
      try {
        const identityData = await lingxiGet(
          account,
          ctx,
          LINGXI_IDENTITY_PATH,
          '账号信息请求失败',
        );
        const identity = parseLingxiIdentity(identityData);
        if (
          identity.name &&
          ctx.persistAccountName &&
          isPlaceholderAccountName(adapter.displayName, account.displayName ?? '')
        ) {
          displayName = await ctx.persistAccountName(identity.name).catch((error: unknown) => {
            ctx.log(`WPS 灵犀账号昵称写回失败（不影响取数）：${(error as Error).message}`);
            return null;
          });
        }
      } catch (error) {
        ctx.log(`WPS 灵犀账号信息获取失败（不影响余额）：${(error as Error).message}`);
      }

      const teamNote =
        parsed.teamAvailable !== null && parsed.teamAvailable > 0
          ? `团队智点可用 ${round2(parsed.teamAvailable)}（${parsed.teamName ?? '团队'}），与个人智点不通用，未计入余额`
          : null;
      const grantNote =
        parsed.extraGrantStatus === 'can_claim'
          ? '上游显示有可领取的智点（本轮只读，未代领）'
          : parsed.extraGrantStatus === 'can_form'
            ? '上游要求填写资料申请智点（本轮只读，未代申请）'
            : parsed.extraGrantStatus === 'reviewing'
              ? '智点申请审核中'
              : null;
      const hiddenNote = hiddenLotsNote(expired);

      return buildSnapshot({
        adapter,
        account,
        status: 'ok',
        now: ctx.now,
        displayName,
        accountId: displayName,
        plan: parsed.plan,
        balance: { amount: totalBalance, currency: 'POINTS' },
        credits: active,
        // 智点不是「周期上限」：上游进度条只是某个桶的剩余/授予，
        // 用 windows 会画出一条与真实配额无关的 quota，容易误导
        windows: [],
        note: joinNotes(
          fallbackLot.length > 0
            ? '上游未返回批次明细，仅显示总额，无法判断到期时间'
            : null,
          mismatch,
          teamNote,
          grantNote,
          hiddenNote,
        ),
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      const message = isAuthFailure(error)
        ? `${(error as Error).message}（登录态 Cookie 可能已过期，请重新「网页端登录」或重跑 npm run capture -- lingxi）`
        : (error as Error).message;
      return failure(adapter, account, ctx, status, message);
    }
  },
};
