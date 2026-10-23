import { isRecord } from './json.js';
import { describeNetworkError, directFetch } from './direct-egress.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * 用哪个 User-Agent 请求上游。
 *
 * 这不是可选项：部分平台（实测 CodeBuddy）的 WAF 会校验 UA，
 * 缺失或版本过旧会直接返回 401。因此 `npm run capture` 会把本机浏览器的
 * 真实 UA 写进 .env 的 HTTP_USER_AGENT，这里优先使用它。
 *
 * 采用惰性读取而不是模块级常量：config.ts 里的 .env 解析要等到
 * loadConfig() 才执行，早于它的模块初始化读不到变量。
 */
export function browserUserAgent(): string {
  const override = process.env.HTTP_USER_AGENT?.trim();
  return override || DEFAULT_USER_AGENT;
}

export class HttpError extends Error {
  readonly status: number;
  readonly kind:
    | 'unauthorized'
    | 'forbidden'
    | 'rateLimited'
    | 'notFound'
    | 'unavailable';

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.kind =
      status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'notFound'
            : status === 429
              ? 'rateLimited'
              : 'unavailable';
  }
}

export interface JsonRequestInit {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  /** 排查用：直连兜底被触发时写日志（不传则不产生任何日志） */
  log?: (message: string) => void;
}

export interface JsonResult {
  status: number;
  body: unknown;
  text: string;
  url: string;
}

/**
 * 直连兜底开关（`DIRECT_EGRESS_RETRY`）：
 *   - `auto`（默认）：`fetch` 因网络层原因失败（没有任何 HTTP 响应）时，
 *     用「物理网卡源地址 + DoH 真实 IP」再发一次同样的请求；
 *   - `off`：完全关闭，行为与引入本开关前一致。
 *
 * 为什么需要它：本机以 TUN 代理出网时，个别站点会被出口节点在 TLS 握手阶段
 * 重置（`fetch failed` / `ECONNRESET`），而物理网卡直连同一站点正常。
 * 详见 docs/fixes/Qoder-国际站fetch-failed-修复方案.md。
 */
export function directRetryEnabled(): boolean {
  const raw = (process.env.DIRECT_EGRESS_RETRY || 'auto').trim().toLowerCase();
  return !['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw);
}

/**
 * 记住「默认出口会失败」的主机（10 分钟）：
 * 命中后**先**走直连、不再白等一次必败的 `fetch`。
 * 这对每轮刷新都要打 5+ 次历史明细的站点意义很大——
 * 否则每次刷新都要先吃一遍 TLS 重置（每次约 100~300ms）。
 */
const directOnlyHosts = new Map<string, number>();
const DIRECT_ONLY_TTL_MS = 10 * 60_000;

function markDirectOnly(host: string): void {
  directOnlyHosts.set(host, Date.now() + DIRECT_ONLY_TTL_MS);
}

function preferDirect(host: string): boolean {
  const expires = directOnlyHosts.get(host);
  if (!expires) return false;
  if (expires > Date.now()) return true;
  directOnlyHosts.delete(host);
  return false;
}

/** 每台主机只记一次兜底日志：调用方每轮会发多条请求，逐条记录只会把日志刷满 */
const directLoggedHosts = new Set<string>();

/** 该 URL 是否值得尝试直连：只处理 https 域名，本机/ IP 字面量没意义 */
function directEligible(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 带超时与统一错误映射的 JSON 请求。
 * 用 AbortSignal.timeout 实现硬截止，避免慢接口拖垮整个看板刷新。
 *
 * 网络层失败（没有拿到 Response）时，若直连兜底开启则换通道重发一次；
 * 拿到任意 HTTP 状态都不重试——业务 4xx/5xx 换通道重放既无意义也会掩盖真实原因。
 */
export async function fetchJson(
  url: string,
  init: JsonRequestInit = {},
): Promise<JsonResult> {
  const timeoutMs = init.timeoutMs ?? 12_000;
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': browserUserAgent(),
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };

  const host = new URL(url).hostname.toLowerCase();
  const canFallBack = directRetryEnabled() && directEligible(url);

  /** 用直连通道重发；成功返回 Response，失败抛原给调用方的 HttpError */
  const viaDirect = async (defaultFailure: string | null): Promise<Response> => {
    try {
      const direct = await directFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ?? null,
        timeoutMs,
      });
      // 每台主机只留一条日志：调用方一轮会发多条请求，逐条记录只会刷屏
      if (!directLoggedHosts.has(host)) {
        directLoggedHosts.add(host);
        init.log?.(
          (defaultFailure ? `请求失败（${defaultFailure}），` : '') +
            `已改直连（${direct.via}）→ HTTP ${direct.status}` +
            (defaultFailure ? '；后续同类请求优先走直连（10 分钟）' : ''),
        );
      }
      if (defaultFailure) markDirectOnly(host);
      // 204/205/304 属于「无正文状态」，Response 构造器不接受非 null body
      const nullBodyStatus = direct.status === 204 || direct.status === 205 || direct.status === 304;
      return new Response(nullBodyStatus ? null : direct.text, {
        status: direct.status,
        statusText: direct.statusText,
      });
    } catch (directError) {
      throw new HttpError(
        defaultFailure
          ? `请求失败：${defaultFailure}；直连重试也失败：${(directError as Error).message}`
          : `请求失败：${(directError as Error).message}`,
        0,
      );
    }
  };

  let response: Response;
  if (canFallBack && preferDirect(host)) {
    // 该主机已确认默认出口不通：直接走直连，不再白等一次必败的 fetch
    response = await viaDirect(null);
  } else {
    try {
      response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ?? undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = describeNetworkError(error);
      if (!canFallBack) throw new HttpError(`请求失败：${reason}`, 0);
      response = await viaDirect(reason);
    }
  }

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `HTTP ${response.status} ${snippet(text) || response.statusText}`,
      response.status,
    );
  }

  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(`响应不是合法 JSON：${snippet(text)}`, response.status);
  }
  return { status: response.status, body, text, url };
}

/** 从响应体里再兜一层业务错误码（不少国内平台用 200 + code!=0 表达失败） */
export function assertBusinessOk(body: unknown): void {
  if (!isRecord(body)) return;
  const code = body.code ?? body.errorCode ?? body.error_code;
  const success = body.success ?? body.ok;
  const message =
    (typeof body.message === 'string' && body.message) ||
    (typeof body.errorMessage === 'string' && body.errorMessage) ||
    (typeof body.error_msg === 'string' && body.error_msg) ||
    '';
  if (success === false) throw new Error(message || '上游返回 success=false');
  if (code === undefined || code === null || code === 0 || code === '0' || code === 'OK') return;
  if (typeof code === 'string' && /^(ok|success)$/i.test(code)) return;
  throw new Error(`上游返回业务错误 code=${String(code)}${message ? ` ${message}` : ''}`);
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
