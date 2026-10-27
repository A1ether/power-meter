import { createHash } from 'node:crypto';
import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { asNumber, firstNumber, isRecord, pick, toIso } from '../lib/json.js';
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

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function resolveOrigin(account: AccountConfig): string {
  const override = optString(account, 'origin');
  if (override) return override.replace(/\/+$/, '');
  const site = (optString(account, 'site') || 'cn').toLowerCase();
  return site === 'global' ? 'https://agent.minimax.io' : 'https://agent.minimax.cn';
}

/** 取登录态 token；兼容粘贴了 `Bearer xxx` / 带引号的情况 */
function resolveToken(account: AccountConfig, ctx: ProbeContext): string {
  const raw = cred(account, ctx, ['token', 'accessToken', 'access_token']);
  return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
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

async function minimaxGet(
  account: AccountConfig,
  ctx: ProbeContext,
  path: string,
  params: Array<[string, string | number]> = [],
): Promise<unknown> {
  const token = resolveToken(account, ctx);
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

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  displayName: 'MiniMax Code',
  region: 'cn',
  dashboardUrl: 'https://agent.minimax.cn',
  usageUrl: 'https://platform.minimaxi.com/console/usage',
  requiredCredentialKeys: ['token', 'cookie', 'userId'],
  credentialHint:
    '登录 https://agent.minimax.cn 后，推荐直接跑 npm run capture -- minimax：' +
    '会一次性抓取请求头 token（localStorage `_token`）、SSO 会话 Cookie，' +
    '以及公共参数要求的真实身份 user_id / op_ticket / uuid（来自 user_detail_agent），缺一不可。',
  /**
   * 获取明细：积分到账记录（签到 / 购买）都带精确的 granted_at_ms，
   * 因此「增量」走上游；「用量」没有逐日粒度（只有每批次的累计消耗），
   * 声明为未覆盖，由本地采样兜底。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    if (!resolveToken(account, ctx)) return null;
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
    const missing: string[] = [];
    if (!resolveToken(account, ctx)) missing.push('token');
    if (!resolveCookie(account, ctx)) missing.push('cookie');
    if (!cred(account, ctx, ['userId', 'user_id'])) missing.push('userId');
    if (missing.length > 0) return notConfigured(minimaxAdapter, account, ctx, missing);

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