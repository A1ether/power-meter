/**
 * 直连出网通道（绕过 TUN / 系统代理）。
 *
 * 背景：本机以 FlClash TUN（fake-ip + 全局路由劫持）出网时，个别海外站点
 * 会被出口节点在 **TLS 握手阶段** 直接重置（实测 `qoder.com`：`fetch` 抛
 * `TypeError: fetch failed` / `cause.code = ECONNRESET`，一个字节都拿不到），
 * 而同一台机器用物理网卡直连该站点却完全可达。
 *
 * 这条通道做的就是「换一条路把同一个请求发出去」：
 *   1. 用 DoH 拿**真实** A 记录（TUN 下系统 DNS 返回的是 fake-ip，无法直连）；
 *   2. socket 绑定**物理网卡**的 IPv4 源地址（绑定后内核会绕开 TUN 的默认路由）；
 *   3. 用 `node:https` 原生请求补上 SNI 与 `Host`，语义与 `fetch` 一致。
 *
 * 只用于「没有拿到任何 HTTP 响应」的网络层失败；业务 4xx/5xx 不重放。
 */
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { networkInterfaces } from 'node:os';

/**
 * 不可用于直连的 IPv4：
 *   - `0.0.0.0/8`、回环、链路本地（169.254）、组播/保留段；
 *   - `198.18.0.0/15`：Clash/mihomo 的 fake-ip 段，只在隧道内有意义。
 * 注意**不能**排除 10./172.16-31./192.168.——那正是物理网卡的私网地址，
 * 恰恰是本方案要绑定过去绕开 TUN 的源地址。
 */
const UNUSABLE_IPV4 =
  /^(0\.|127\.|169\.254\.|198\.1[89]\.|22[4-9]\.|2[3-5]\d\.)/;

/** 隧道 / 点对点 / 无线直连等虚拟网卡：绑它们的源地址绕不开 TUN */
const VIRTUAL_IFACE = /^(utun|tun|tap|ppp|ipsec|gif|stf|awdl|llw|bridge|lo|docker|vmenet|vnic)/i;

/** 优先物理网卡：en0 通常排在前面；其余按编号/系统顺序兜底 */
function ifaceRank(name: string): number {
  return /^en\d+$/.test(name) ? Number(name.slice(2)) : 1000;
}

export interface EgressAddress {
  iface: string;
  address: string;
}

/** 本机可用于「绕开隧道」的源地址候选（物理网卡的 IPv4，不含 internal / 保留段） */
export function physicalAddresses(): EgressAddress[] {
  const out: EgressAddress[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const info of infos ?? []) {
      // Node 18.0-18.3 用数字 4 表示 IPv4，之后用 'IPv4'，两种都认
      if (!(info.family === 'IPv4' || (info.family as unknown) === 4)) continue;
      if (info.internal) continue;
      if (UNUSABLE_IPV4.test(info.address)) continue;
      out.push({ iface: name, address: info.address });
    }
  }
  return out.sort((a, b) => ifaceRank(a.iface) - ifaceRank(b.iface));
}

interface DohEndpoint {
  url: (host: string) => string;
  headers: Record<string, string>;
}

const DOH_HEADERS = { accept: 'application/dns-json' };
const DOH_ENDPOINTS: DohEndpoint[] = [
  { url: (host) => `https://1.1.1.1/dns-query?name=${host}&type=A`, headers: DOH_HEADERS },
  { url: (host) => `https://dns.google/resolve?name=${host}&type=A`, headers: DOH_HEADERS },
  { url: (host) => `https://223.5.5.5/resolve?name=${host}&type=A`, headers: DOH_HEADERS },
];

const DNS_TTL_MS = 10 * 60_000;
const DOH_TIMEOUT_MS = 4_000;
const dnsCache = new Map<string, { expires: number; ips: string[] }>();

/** 从 DoH 应答里挑出可用 IPv4（`Answer[]` 里 type=1；CNAME 链后的最终 A 记录也在这里） */
function usableIps(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const answer = (payload as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return [];
  const ips: string[] = [];
  for (const record of answer) {
    if (typeof record !== 'object' || record === null) continue;
    const item = record as { type?: unknown; data?: unknown };
    if (Number(item.type) !== 1) continue;
    if (typeof item.data !== 'string') continue;
    const ip = item.data.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    if (UNUSABLE_IPV4.test(ip)) continue;
    if (!ips.includes(ip)) ips.push(ip);
  }
  return ips;
}

/**
 * 解析域名的真实 A 记录（缓存 10 分钟）。
 * 走 DoH 而不是 `dns.lookup`：TUN 环境下系统 DNS 给的是 fake-ip，绑物理网卡连不上。
 */
export async function resolveRealAddresses(host: string): Promise<string[]> {
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.ips;

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.url(host), {
        headers: endpoint.headers,
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const ips = usableIps(await response.json());
      if (ips.length > 0) {
        dnsCache.set(host, { expires: Date.now() + DNS_TTL_MS, ips });
        return ips;
      }
    } catch {
      // 单个 DoH 端点不可达就换下一个；全部失败由调用方按「无法直连」处理
    }
  }
  return [];
}

export interface DirectRequestInit {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface DirectResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  text: string;
  /** 实际使用的源地址 → 目标 IP，用于日志留痕 */
  via: string;
}

/** 单次直连请求（已绑定源地址），不处理重定向 */
function once(
  host: string,
  ip: string,
  localAddress: string,
  path: string,
  init: DirectRequestInit,
  timeoutMs: number,
): Promise<DirectResponse> {
  return new Promise<DirectResponse>((resolve, reject) => {
    const httpHeaders: Record<string, string> = {
      // 连的是 IP，Host 必须回填域名，否则虚拟主机路由不到目标
      Host: host,
      ...(init.headers ?? {}),
    };
    const options: RequestOptions = {
      host: ip,
      port: 443,
      path,
      method: init.method ?? 'GET',
      servername: host, // SNI 用域名，证书校验才通过
      localAddress,
      headers: httpHeaders,
      timeout: timeoutMs,
    };

    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          via: `${localAddress}→${ip}`,
        }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`直连超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export interface DirectFetchResult extends DirectResponse {
  url: string;
}

/** 只跟随同源重定向（最多 3 跳）；跨域重定向原样返回，交回调用方判定 */
function sameOriginLocation(current: URL, location: string | undefined): URL | null {
  if (!location) return null;
  try {
    const next = new URL(location, current);
    if (next.origin !== current.origin) return null;
    return next;
  } catch {
    return null;
  }
}

/**
 * 用直连通道发请求：绑定物理网卡源地址 + DoH 真实 IP。
 * 依次尝试「每个源地址 × 每个解析结果」，全部失败才抛出最后一次错误。
 */
export async function directFetch(
  url: string,
  init: DirectRequestInit = {},
): Promise<DirectFetchResult> {
  const timeoutMs = init.timeoutMs ?? 12_000;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`直连通道只支持 https：${parsed.protocol}`);

  const addresses = physicalAddresses();
  if (addresses.length === 0) throw new Error('本机没有可用的物理网卡 IPv4 地址');
  const ips = await resolveRealAddresses(parsed.hostname);
  if (ips.length === 0) throw new Error(`DoH 未解析到 ${parsed.hostname} 的可用 A 记录`);

  let target = parsed;
  let lastError: Error | null = null;

  for (let hop = 0; hop <= 3; hop += 1) {
    const path = `${target.pathname}${target.search}`;
    let response: DirectResponse | null = null;
    for (const source of addresses) {
      for (const ip of ips) {
        try {
          response = await once(target.hostname, ip, source.address, path, init, timeoutMs);
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }
      if (response) break;
    }
    if (!response) break;

    const location = response.headers.location;
    const next = sameOriginLocation(target, typeof location === 'string' ? location : undefined);
    // 同源重定向继续跟（GET 才有意义），跨域或 4xx/5xx 原样返回
    if (!next || (init.method ?? 'GET') !== 'GET') {
      return { ...response, url: target.toString() };
    }
    target = next;
  }

  throw lastError ?? new Error('直连失败');
}

/** 从原生错误里榨出可读信息：`fetch failed` 本身没有信息量 */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const parts: string[] = [error.message];
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const detail = typeof code === 'string' && code ? `${code} ${cause.message}` : cause.message;
    if (detail.trim() && !parts.includes(detail)) parts.push(detail);
  } else if (typeof cause === 'string' && cause.trim()) {
    parts.push(cause);
  }
  return parts.join('：');
}
