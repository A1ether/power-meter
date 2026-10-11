import { createHash, createHmac } from 'node:crypto';

/**
 * 华为云 AK/SK 请求签名（SDK-HMAC-SHA256）。
 *
 * 实现与码道 CLI（agentkernel，26.9.12）内置的华为 SDK 签名器逐行对齐：
 *   canonicalURI      —— 逐段 urlEncode，末尾补 "/"
 *   canonicalQuery    —— 来自 queryParams，键排序 + urlEncode
 *   canonicalHeaders  —— 键（小写）排序，每项 `${k}:${v} `（空格分隔、带尾空格）
 *   payloadHash       —— 有 X-Sdk-Content-Sha256 头就用它，否则空 body 哈希
 *   canonicalRequest  —— [method, uri, query, headers, signedHeaders, payloadHash].join(' ')
 *   stringToSign      —— [算法, X-Sdk-Date, sha256Hex(canonicalRequest)].join(' ')
 *   Authorization     —— SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=<...>, Signature=<...>
 *
 * 之所以不直接用官方 SDK：本仓库运行时零第三方依赖（见 AGENTS.md），
 * 且该算法已由 CLI 二进制静态取证（见 docs/fixes/CodeArts-华为云登录态频繁失效-修复方案.md）。
 */

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SDK_SIGNING_ALGORITHM = 'SDK-HMAC-SHA256';

/** RFC3986 unreserved 之外全部转义（encodeURIComponent 会漏掉 ! ' ( ) *） */
export function huaweiUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSHA256Hex(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** YYYYMMDDTHHmmssZ（UTC） */
export function huaweiSdkDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalUri(pathname: string): string {
  const encoded = pathname.split('/').map((segment) => huaweiUrlEncode(segment)).join('/');
  return encoded.endsWith('/') ? encoded : `${encoded}/`;
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const [key, value] of params) pairs.push({ key, value });
  pairs.sort((a, b) => (a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key)));
  return pairs.map((pair) => `${huaweiUrlEncode(pair.key)}=${huaweiUrlEncode(pair.value)}`).join('&');
}

function canonicalHeaders(headers: Record<string, string>, separator: ' ' | '\n'): string {
  const entries = Object.keys(headers)
    .map((key) => ({ key: key.toLowerCase(), value: headers[key] ?? '' }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const tail = separator === '\n' ? '\n' : ' ';
  return entries
    .map((entry) => `${entry.key}:${entry.value.replace(/[\r\n]/g, ' ').trim()}${tail}`)
    .join('');
}

/**
 * 签名风格。码道 CLI 二进制与华为 SDK 里并存多种实现，三代差异在「分隔符」与
 * 「StringToSign 是否带日期」：
 *   - `legacy`（新 SDK，空格分隔 + 带日期）：`SDK-HMAC-SHA256 <date> <sha256(CR)>`
 *   - `legacy-no-date`（老 SDK，空格分隔、只拼两段）：`SDK-HMAC-SHA256 <sha256(CR)>`
 *   - `newline`（华为 API 网关标准/文档格式，\\n 分隔 + 带日期）：
 *       CR = `Method\\nURI\\nQuery\\nHeaders\\nSignedHeaders\\nPayloadHash`
 *       STS = `SDK-HMAC-SHA256\\n<date>\\n<sha256(CR)>`
 */
export type HuaweiSignatureStyle = 'legacy' | 'legacy-no-date' | 'newline';

export interface HuaweiSignInput {
  accessKey: string;
  secretKey: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 完整 URL（可带 query，query 会一并参与签名） */
  url: string;
  /** 业务请求头（不含 host / x-sdk-date，函数自行补齐） */
  headers?: Record<string, string>;
  /** 临时安全凭证（STS）的 X-Security-Token，可选 */
  securityToken?: string;
  /**
   * true 时携带 `X-Sdk-Content-Sha256: UNSIGNED-PAYLOAD`（CLI 的 signSimple 就这么做），
   * 适合 GET / 大 body；false 时按空 body 哈希签名。
   */
  unsignedPayload?: boolean;
  /** 待签字符串风格，默认 legacy（带日期） */
  signatureStyle?: HuaweiSignatureStyle;
  /** 便于复现相同签名（默认当前时间） */
  date?: Date;
}

/** 计算并返回「可直接交给 fetch 的完整请求头」 */
export function signHuaweiRequest(input: HuaweiSignInput): Record<string, string> {
  const url = new URL(input.url);
  const headers: Record<string, string> = { ...(input.headers ?? {}) };

  if (input.securityToken) headers['X-Security-Token'] = input.securityToken;
  if (input.unsignedPayload !== false) headers['X-Sdk-Content-Sha256'] = 'UNSIGNED-PAYLOAD';

  const sdkDate = huaweiSdkDate(input.date);
  headers['X-Sdk-Date'] = sdkDate;
  headers.Host = url.host;

  const signedHeaders = Object.keys(headers)
    .map((key) => key.toLowerCase())
    .sort((a, b) => a.localeCompare(b))
    .join(';');

  const style = input.signatureStyle ?? 'legacy';
  const separator = style === 'newline' ? '\n' : ' ';
  const payloadHash = input.unsignedPayload !== false ? 'UNSIGNED-PAYLOAD' : EMPTY_BODY_SHA256;
  const canonicalRequest = [
    input.method,
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders(headers, separator),
    signedHeaders,
    payloadHash,
  ].join(separator);

  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign =
    style === 'legacy-no-date'
      ? `${SDK_SIGNING_ALGORITHM} ${hashedCanonicalRequest}`
      : [SDK_SIGNING_ALGORITHM, sdkDate, hashedCanonicalRequest].join(separator);
  const signature = hmacSHA256Hex(input.secretKey, stringToSign);

  return {
    ...headers,
    Authorization:
      `${SDK_SIGNING_ALGORITHM} Access=${input.accessKey}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface HuaweiFetchResult {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  durationMs: number;
}

/** 带签名的只读请求；不做重试，错误交给调用方判断 */
export async function huaweiSignedFetch(
  input: HuaweiSignInput & { timeoutMs?: number },
): Promise<HuaweiFetchResult> {
  const headers = signHuaweiRequest(input);
  const started = Date.now();
  const response = await fetch(input.url, {
    method: input.method,
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, text, json, durationMs: Date.now() - started };
}
