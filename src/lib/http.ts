import { isRecord } from './json.js';

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
}

export interface JsonResult {
  status: number;
  body: unknown;
  text: string;
  url: string;
}

/**
 * 带超时与统一错误映射的 JSON 请求。
 * 用 AbortSignal.timeout 实现硬截止，避免慢接口拖垮整个看板刷新。
 */
export async function fetchJson(
  url: string,
  init: JsonRequestInit = {},
): Promise<JsonResult> {
  const timeoutMs = init.timeoutMs ?? 12_000;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': browserUserAgent(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body ?? undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(`请求失败：${reason}`, 0);
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
