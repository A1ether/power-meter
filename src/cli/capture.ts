/**
 * 凭证抓取工具：驱动一个「已登录的调试 Chrome」，自动提取各平台登录态并写入 .env。
 *
 * 前置：
 *   1. npm run chrome:debug       启动带 CDP 的独立 Chrome（端口 9222）
 *   2. 在该窗口里登录各平台，并停在各自的「用量 / 账单」页面
 *   3. npm run capture
 *
 * 说明：
 *   - 通过 playwright-cli 与调试 Chrome 通信，不引入任何运行时依赖
 *   - 凭证只写入本地 .env（已 gitignore），终端输出一律脱敏
 *   - 详细报告写入 .playwright-cli/capture-report.md（同样不提交）
 *   - 多账号：`--slot 2` 把抓到的凭证写进带 `_2` 后缀的变量
 *     （如 CODEBUDDY_COOKIE_2），因此不会覆盖槽位 1 的账号；
 *     抓完再用 `npm run account -- --provider <平台> --env <变量名>` 注册成账号。
 *   - 多站点：`--site global` 抓国际站（目前仅 Qoder 支持 cn / global），
 *     国际站凭证写入 QODER_GLOBAL_COOKIE，与国内站的 QODER_COOKIE 互不覆盖；
 *     注册时带上同一参数：npm run account -- --provider qoder --site global。
 *
 * 踩坑记录（务必保留）：
 *   Cookie 必须按「域可覆盖」收集——请求 www.codebuddy.cn 时，
 *   既需要 .codebuddy.cn 的父域 Cookie，也需要 www.codebuddy.cn 自己的 Cookie。
 *   只取父域会得到 401。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPath, isRecord } from '../lib/json.js';

const SESSION = process.env.PW_SESSION ?? 'pm';
const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const REPORT_PATH = resolve(process.cwd(), '.playwright-cli/capture-report.md');
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const DISCOVER = ARGS.includes('--discover');

/**
 * `--slot N`：多账号槽位。缺省 1 = 写原有的 `*_COOKIE`（历史行为不变）；
 * N≥2 = 所有变量名加 `_N` 后缀，用于第二个及以后的账号。
 */
const SLOT_INDEX = ARGS.indexOf('--slot');
/** `--slot` 后面那个数字的位置（没有 --slot 时为 -1，不能误当成普通位置参数） */
const SLOT_VALUE_INDEX = SLOT_INDEX >= 0 ? SLOT_INDEX + 1 : -1;
const SLOT_RAW = SLOT_VALUE_INDEX >= 0 ? Number.parseInt(ARGS[SLOT_VALUE_INDEX] ?? '', 10) : 1;
const SLOT = Number.isFinite(SLOT_RAW) && SLOT_RAW >= 1 ? SLOT_RAW : 1;
/** 槽位 1 沿用原变量名（历史约定），N≥2 追加 `_N` */
const SLOT_SUFFIX = SLOT >= 2 ? `_${SLOT}` : '';

/**
 * `--site <id>`：多站点平台的站点选择（Qoder：cn / global）。
 * 目标声明了 `siteVariants` 且含该站点时，用变体覆盖 envKey / usageUrl / apiHost 等；
 * 未声明变体的平台不受影响（照常抓取）。
 */
const SITE_INDEX = ARGS.indexOf('--site');
const SITE_VALUE_INDEX = SITE_INDEX >= 0 ? SITE_INDEX + 1 : -1;
const SITE = SITE_INDEX >= 0 ? (ARGS[SITE_VALUE_INDEX] ?? '').trim().toLowerCase() : '';

// ---------------------------------------------------------------- playwright-cli 封装

/**
 * 解析 playwright CLI：优先全局 `playwright-cli`；缺失时退回
 * `npx --no-install playwright cli`（Playwright ≥1.56 自带同一套命令）。
 * 这样无需全局安装 @playwright/cli 也能抓取，减少环境依赖带来的失败。
 */
let resolvedCli: { bin: string; prefix: string[] } | null = null;

function resolvePwCli(): { bin: string; prefix: string[] } {
  if (resolvedCli) return resolvedCli;
  const candidates: Array<{ bin: string; prefix: string[] }> = [
    { bin: 'playwright-cli', prefix: [] },
    { bin: 'npx', prefix: ['--no-install', 'playwright', 'cli'] },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.bin, [...candidate.prefix, '--help'], {
        stdio: 'ignore',
        timeout: 30_000,
      });
      resolvedCli = candidate;
      return candidate;
    } catch {
      // 试下一个候选
    }
  }
  throw new Error(
    '未找到 playwright CLI。请任选其一：安装全局 @playwright/cli（npm install -g @playwright/cli@latest），' +
      '或确保本机 `npx playwright cli --help` 可用。',
  );
}

function pw(args: string[], allowFailure = false): string {
  const cli = resolvePwCli();
  try {
    return execFileSync(cli.bin, [...cli.prefix, '-s=' + SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (error) {
    if (allowFailure) return '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`playwright CLI ${args.join(' ')} 失败：${stderr || (error as Error).message}`);
  }
}

function settle(ms: number): void {
  pw(['run-code', `async page => await page.waitForTimeout(${ms})`], true);
}

// ---------------------------------------------------------------- 解析

interface CapturedRequest {
  index: number;
  method: string;
  url: string;
  status: number;
}

function parseRequestList(output: string): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  for (const line of output.split('\n')) {
    const match = /^(\d+)\.\s+\[(\w+)]\s+(\S+)\s+=>\s+\[(\d+)]/.exec(line.trim());
    if (!match) continue;
    requests.push({
      index: Number(match[1]),
      method: match[2] ?? 'GET',
      url: match[3] ?? '',
      status: Number(match[4]),
    });
  }
  return requests;
}

interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

function parseCookieList(output: string): BrowserCookie[] {
  const cookies: BrowserCookie[] = [];
  for (const line of output.split('\n')) {
    const match = /^([^=\s]+)=(.*?)\s+\(domain:\s*([^,]+),\s*path:/.exec(line.trim());
    if (!match) continue;
    cookies.push({ name: match[1] ?? '', value: match[2] ?? '', domain: match[3] ?? '' });
  }
  return cookies;
}

/**
 * Cookie 的 domain 是否能作用于目标站点。
 * 三种情况都要算：同域、子域（cookie 域是站点的子域）、父域（cookie 域是站点的父域）。
 */
export function cookieAppliesTo(cookieDomain: string, site: string): boolean {
  const domain = cookieDomain.replace(/^\./, '');
  return domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`);
}

// ---------------------------------------------------------------- 目标平台

interface Target {
  id: string;
  label: string;
  /** 写进 .env 的变量名 */
  envKey: string;
  /** 请求该站时需要用到的 cookie 所属站点 */
  cookieSites: string[];
  /** 打开这个页面以触发用量接口，同时确保登录态完整 */
  usageUrl: string;
  /** 适配器实际要请求的 API 主机，优先取浏览器对该主机的真实 Cookie 头 */
  apiHost: string;
  /**
   * 从页面 localStorage 读取登录态 token 的键名（MiniMax Code 用 `_token`）。
   * 这类平台的接口要请求头 `token`，但**同样要带 Cookie**（SSO 会话），
   * 因此 token 与 Cookie 一起抓，只是写入的变量名不同（见 tokenEnvKey）。
   */
  tokenStorageKey?: string;
  /** token 写进 .env 的变量名（配合 tokenStorageKey 使用；envKey 留给 Cookie） */
  tokenEnvKey?: string;
  /**
   * 登录身份参数来源（MiniMax Code）：公共查询参数里的 user_id/op_ticket/uuid
   * 必须与真实登录身份一致，写死 0 或臆造值会被服务端 401 拒绝。
   */
  identityStorage?: {
    /** 含 realUserID / op_ticket / token 的 JSON 存储键 */
    profileKey: string;
    /** 存放设备 uuid 的存储键 */
    deviceKey: string;
    /** 各字段写入 .env 的变量名 */
    envKeys: { userId: string; opTicket: string; paramToken: string; uuid: string };
  };
  /**
   * 站点变体（多站点平台）：`--site <id>` 时覆盖 envKey / usageUrl / apiHost / cookieSites / label。
   * Qoder 用它区分国内站（qoder.com.cn）与国际站（qoder.com）——国际站的 Cookie 必须
   * 落到 `QODER_GLOBAL_COOKIE`，且抓取时打开的是 qoder.com 的用量页。
   */
  siteVariants?: Record<string, Partial<Omit<Target, 'id' | 'siteVariants'>>>;
  /**
   * 变体附带的账号注册参数：slot ≥2 抓完后会提示「下一步注册命令」，
   * 这里声明的键值会拼进命令（如 `{ site: "global" }` → `--site global`），
   * 否则国际站账号会被注册成默认的国内站。
   */
  optionFlags?: Record<string, string>;
}

const TARGETS: Target[] = [
  {
    id: 'qoder',
    label: 'Qoder',
    envKey: 'QODER_COOKIE',
    cookieSites: ['qoder.com.cn', 'qoder.cn', 'qoder.com'],
    usageUrl: 'https://qoder.com.cn/account/usage',
    apiHost: 'qoder.com.cn',
    // 国内站 = 上面的默认取值（--site cn 与不带 --site 等价）；
    // 国际站必须把 Cookie 单独放到 QODER_GLOBAL_COOKIE，两个站点的登录态互不覆盖
    siteVariants: {
      global: {
        label: 'Qoder 国际站',
        envKey: 'QODER_GLOBAL_COOKIE',
        cookieSites: ['qoder.com'],
        usageUrl: 'https://qoder.com/account/usage',
        apiHost: 'qoder.com',
        optionFlags: { site: 'global' },
      },
    },
  },
  {
    id: 'trae',
    label: 'Trae',
    envKey: 'TRAE_COOKIE',
    cookieSites: ['trae.cn'],
    usageUrl: 'https://www.trae.cn/dashboard#usage',
    apiHost: 'api.trae.cn',
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    envKey: 'CODEBUDDY_COOKIE',
    cookieSites: ['codebuddy.cn'],
    usageUrl: 'https://www.codebuddy.cn/profile/plans-usage',
    apiHost: 'www.codebuddy.cn',
  },
  {
    id: 'codearts',
    label: 'CodeArts 华为云',
    envKey: 'CODEARTS_COOKIE',
    cookieSites: ['codearts.huaweicloud.com', 'huaweicloud.com'],
    usageUrl: 'https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn',
    apiHost: 'codearts.huaweicloud.com',
  },
  {
    id: 'minimax',
    label: 'MiniMax Code',
    envKey: 'MINIMAX_COOKIE',
    tokenEnvKey: 'MINIMAX_CODE_TOKEN',
    cookieSites: ['agent.minimax.cn', 'minimax.cn'],
    usageUrl: 'https://agent.minimax.cn',
    apiHost: 'agent.minimax.cn',
    tokenStorageKey: '_token',
    identityStorage: {
      profileKey: 'user_detail_agent',
      deviceKey: 'UNIQUE_USER_ID',
      envKeys: {
        userId: 'MINIMAX_USER_ID',
        opTicket: 'MINIMAX_OP_TICKET',
        paramToken: 'MINIMAX_PARAM_TOKEN',
        uuid: 'MINIMAX_UUID',
      },
    },
  },
];

// ---------------------------------------------------------------- .env 读写

function upsertEnvFile(entries: Map<string, string>): {
  path: string;
  added: string[];
  updated: string[];
} {
  const path = resolve(process.cwd(), '.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing ? existing.split('\n') : [];
  const added: string[] = [];
  const updated: string[] = [];
  const seen = new Set<string>();

  const next = lines.map((line) => {
    const match = /^([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1] ?? '';
    if (!entries.has(key)) return line;
    seen.add(key);
    updated.push(key);
    return `${key}=${entries.get(key)}`;
  });

  for (const [key, value] of entries) {
    if (seen.has(key)) continue;
    next.push(`${key}=${value}`);
    added.push(key);
  }

  if (DRY_RUN) return { path, added, updated };
  writeFileSync(path, next.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  return { path, added, updated };
}

function mask(value: string): string {
  if (!value) return '(空)';
  if (value.length <= 16) return `${value.slice(0, 3)}…(len=${value.length})`;
  return `${value.slice(0, 8)}…${value.slice(-4)} (len=${value.length})`;
}

// ---------------------------------------------------------------- 可选的接口发现

interface Candidate {
  url: string;
  method: string;
  score: number;
  topKeys: string[];
  mappingDraft: string[];
  sample: string;
}

function draftMapping(
  payload: unknown,
  hints: string[],
): { keys: string[]; mapping: string[]; score: number } {
  const keys: string[] = [];
  const mapping: string[] = [];
  let score = 0;
  if (!isRecord(payload)) return { keys, mapping, score };
  keys.push(...Object.keys(payload));

  for (const hint of hints) {
    if (typeof getPath(payload, hint) === 'number') {
      mapping.push(`"balance": { "path": "${hint}", "currency": "CREDITS" }`);
      score += 3;
    }
  }
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0])) continue;
    const fields = Object.keys(value[0]);
    const amountField = fields.find((f) => /remain|amount|balance|left|credit/i.test(f));
    const timeField = fields.find((f) => /expire|valid|end|deadline/i.test(f));
    if (amountField && timeField) {
      mapping.push(
        `"creditLots": { "path": "${key}", "amount": "${amountField}", "expiresAt": "${timeField}" }`,
      );
      score += 5;
    }
  }
  return { keys, mapping, score };
}

function discoverEndpoints(target: Target): Candidate[] {
  const hosts = target.cookieSites.join('|').replace(/\./g, '\\.');
  const matcher = new RegExp(`(${hosts})`, 'i');
  const requests = parseRequestList(pw(['requests'], true)).filter(
    (request) => matcher.test(request.url) && request.status === 200,
  );
  const candidates: Candidate[] = [];

  for (const request of requests.slice(0, 40)) {
    if (candidates.length >= 6) break;
    const body = pw(['--raw', 'response-body', String(request.index)], true).trim();
    if (!body.startsWith('{') && !body.startsWith('[')) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      continue;
    }
    const probe = draftMapping(payload, ['balance', 'remaining', 'amount', 'remain', 'credit']);
    const lower = body.toLowerCase();
    const hintHits = ['balance', 'remain', 'credit', 'quota', 'expire'].filter((hint) =>
      lower.includes(hint),
    ).length;
    const score = probe.score + hintHits;
    if (score < 3) continue;
    candidates.push({
      url: request.url,
      method: request.method,
      score,
      topKeys: probe.keys,
      mappingDraft: probe.mapping,
      sample: body.slice(0, 600),
    });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- 主流程

interface Result {
  target: Target;
  status: 'ok' | 'skipped' | 'failed';
  message: string;
  cookieCount: number;
  value?: string;
  /** 同一目标需要写入的额外变量（如 MiniMax 的 token 与 Cookie 并存） */
  extraEnv?: Array<{ key: string; value: string }>;
  candidates?: Candidate[];
}

/** 收集适用于目标站点的全部 Cookie（含子域） */
function collectCookies(sites: string[], pool: BrowserCookie[]): BrowserCookie[] {
  const seen = new Set<string>();
  const selected: BrowserCookie[] = [];
  for (const cookie of pool) {
    if (!sites.some((site) => cookieAppliesTo(cookie.domain, site))) continue;
    const key = `${cookie.domain}|${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(cookie);
  }
  return selected;
}

// 注意：run-code 的执行环境里没有全局 URL，只能用正则解析主机名
const HOOK_SCRIPT = `async page => {
  const store = {};
  const hostOf = (raw) => {
    const matched = /^https?:\\/\\/([^/]+)/.exec(raw);
    return matched ? matched[1] : '';
  };
  const onRequest = async (route) => {
    try {
      const type = route.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const host = hostOf(route.url());
      if (!host || store[host]) return;
      const headers = await route.allHeaders();
      if (headers.cookie) store[host] = headers.cookie;
    } catch (error) {}
  };
  page.on('request', onRequest);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  page.off('request', onRequest);
  return JSON.stringify(store);
}`;

/**
 * 直接读取浏览器真实发出的 Cookie 头。
 *
 * 为什么不能只靠 cookie jar 拼装：CodeBuddy 的 jar 里含 Keycloak 的
 * KEYCLOAK_IDENTITY / KC_RESTART 等超大 Cookie，全部拼上会达到 9KB，
 * 超过 nginx 的 client header 上限而直接返回 401。
 * 浏览器自己只发送当前请求域 + 当前路径真正需要的那部分，这才是对的。
 */
/**
 * playwright-cli 的 run-code 会把返回值以 JSON 字符串形式放在 "### Result" 之后，
 * 因此这里先按段落取出，再解两层 JSON。
 */
export function extractRunCodeResult(output: string): string {
  const marker = '### Result';
  const start = output.indexOf(marker);
  if (start < 0) return '';
  let body = output.slice(start + marker.length);
  const nextSection = body.search(/\n### /);
  if (nextSection >= 0) body = body.slice(0, nextSection);
  try {
    const decoded: unknown = JSON.parse(body.trim());
    return typeof decoded === 'string' ? decoded : '';
  } catch {
    return '';
  }
}

/** 读取本机浏览器的真实 User-Agent（部分平台的 WAF 会校验它） */
function captureUserAgent(): string {
  const output = pw(['--raw', 'eval', 'navigator.userAgent'], true).trim();
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // 非 JSON 输出，按裸字符串处理
  }
  return output.replace(/^"|"$/g, '');
}

/**
 * 从当前页面 localStorage 读取值。
 * 兼容两种存法：裸字符串（MiniMax Code 的 `_token`）与 JSON 编码的字符串。
 */
function readLocalStorageValue(key: string): string {
  const expression =
    `(() => { const raw = localStorage.getItem(${JSON.stringify(key)}); if (!raw) return ''; ` +
    `try { const parsed = JSON.parse(raw); return typeof parsed === 'string' ? parsed : raw; } ` +
    `catch (error) { return raw; } })()`;
  const output = pw(['--raw', 'eval', expression], true).trim();
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'string') return parsed.trim();
  } catch {
    // 非 JSON 输出，按裸字符串处理
  }
  return output.replace(/^"|"$/g, '').trim();
}

/** 读取 localStorage 里的 JSON 对象（如 user_detail_agent），失败返回 null */
function readLocalStorageObject(key: string): Record<string, unknown> | null {
  const raw = readLocalStorageValue(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** --discover 模式下的候选接口打印（Cookie 与 token 两条路径共用） */
function reportCandidates(candidates: Candidate[] | undefined): void {
  if (!candidates) return;
  for (const candidate of candidates) {
    console.log(`  \u001b[36m候选\u001b[0m score=${candidate.score} ${candidate.method} ${candidate.url}`);
  }
  if (candidates.length === 0) console.log('  没有找到像余额接口的响应');
}

function captureRealCookieHeaders(): Record<string, string> {
  const output = pw(['run-code', HOOK_SCRIPT], true);
  const inner = extractRunCodeResult(output);
  if (!inner) return {};
  try {
    const parsed: unknown = JSON.parse(inner);
    if (!isRecord(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [host, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) out[host] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function captureTarget(target: Target, pool: BrowserCookie[]): Result {
  console.log(`\n\u001b[1m▶ ${target.label}\u001b[0m`);
  pw(['goto', target.usageUrl], true);
  settle(2500);

  // ① localStorage token 型平台（MiniMax Code）：`_token` 是请求头 token 的来源
  let token = '';
  if (target.tokenStorageKey) {
    token = readLocalStorageValue(target.tokenStorageKey);
    if (token) {
      console.log(`  token: ${token.length} 字节 ← localStorage.${target.tokenStorageKey}`);
      console.log(`  值：${mask(token)}`);
    } else {
      console.log(`  token: 未找到（localStorage.${target.tokenStorageKey} 为空）`);
    }
  }

  // ①-b 登录身份参数（MiniMax Code）：公共参数 user_id/op_ticket/uuid 必须来自真实身份，
  //      写死 0 或臆造值会被服务端 401 拒绝
  let identityUserId = '';
  let identityOpTicket = '';
  let identityParamToken = '';
  let identityUuid = '';
  if (target.identityStorage) {
    const profile = readLocalStorageObject(target.identityStorage.profileKey);
    if (profile) {
      const rawUserId = profile.realUserID ?? profile.real_user_id ?? profile.userId;
      if (typeof rawUserId === 'number' && Number.isFinite(rawUserId)) {
        identityUserId = String(rawUserId);
      } else if (typeof rawUserId === 'string' && /^\d+$/.test(rawUserId.trim())) {
        identityUserId = rawUserId.trim();
      }
      if (typeof profile.op_ticket === 'string') identityOpTicket = profile.op_ticket.trim();
      if (typeof profile.token === 'string') identityParamToken = profile.token.trim();
    }
    identityUuid = readLocalStorageValue(target.identityStorage.deviceKey);
    console.log(
      `  身份参数: user_id=${identityUserId || '未找到'} · ` +
        `op_ticket=${identityOpTicket ? mask(identityOpTicket) : '无'} · ` +
        `uuid=${identityUuid ? mask(identityUuid) : '未找到'}`,
    );
  }

  // ② 首选：浏览器对该 API 主机真实发送的 Cookie 头
  //    （token 型平台同样要带 Cookie：服务端把它当 SSO 会话一起校验，缺了会 401）
  const realHosts = captureRealCookieHeaders();
  let header = realHosts[target.apiHost] ?? '';
  let source = `来自浏览器对 ${target.apiHost} 的真实请求`;

  // ③ 退而求其次：同一 Cookie 域下其它主机的真实头
  if (!header) {
    for (const [host, value] of Object.entries(realHosts)) {
      if (target.cookieSites.some((site) => cookieAppliesTo(host, site))) {
        header = value;
        source = `来自浏览器对 ${host} 的真实请求`;
        break;
      }
    }
  }

  // ④ 最后兜底：按域从 cookie jar 拼装
  const cookies = collectCookies(target.cookieSites, pool);
  if (!header && cookies.length > 0) {
    header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    source = `由 cookie jar 拼装（${cookies.length} 个）`;
  }

  if (!header && !token) {
    console.log('  Cookie: 未找到（可能还没登录）');
    return {
      target,
      status: 'skipped',
      message: '没有可用 Cookie/token，请确认已在该窗口登录并打开用量页',
      cookieCount: 0,
    };
  }

  let count = 0;
  if (header) {
    count = header.split('; ').length;
    console.log(`  Cookie: ${count} 个，${header.length} 字节 ← ${source}`);
    console.log(`  值：${mask(header)}`);
    if (header.length > 8000) {
      console.log('  \u001b[33m提示：Cookie 较大，可能超过服务端 header 上限\u001b[0m');
    }
  } else {
    console.log('  Cookie: 未找到（仅抓到 token）');
  }

  const extraEnv: Array<{ key: string; value: string }> = [];
  if (token && target.tokenEnvKey) extraEnv.push({ key: target.tokenEnvKey, value: token });
  if (target.identityStorage) {
    const keys = target.identityStorage.envKeys;
    if (identityUserId) extraEnv.push({ key: keys.userId, value: identityUserId });
    if (identityOpTicket) extraEnv.push({ key: keys.opTicket, value: identityOpTicket });
    if (identityParamToken) extraEnv.push({ key: keys.paramToken, value: identityParamToken });
    if (identityUuid) extraEnv.push({ key: keys.uuid, value: identityUuid });
  }

  const message =
    header && token ? '已抓取（Cookie + token）' : header ? '已抓取（Cookie）' : '已抓取（token）';
  const candidates = DISCOVER ? discoverEndpoints(target) : undefined;
  reportCandidates(candidates);

  return {
    target,
    status: 'ok',
    message,
    cookieCount: count,
    value: header || undefined,
    extraEnv,
    candidates,
  };
}

function main(): void {
  try {
    const version = execFileSync('curl', ['-s', '-m', '5', `${CDP_ENDPOINT}/json/version`], {
      encoding: 'utf8',
    });
    const parsed: unknown = JSON.parse(version);
    const browser = isRecord(parsed) ? String(parsed.Browser ?? '') : '';
    console.log(`已连接调试 Chrome：${browser}  (${CDP_ENDPOINT})`);
  } catch {
    console.error(
      `无法连接调试 Chrome（${CDP_ENDPOINT}）。\n请先执行：npm run chrome:debug`,
    );
    process.exit(1);
  }

  pw(['attach', `--cdp=${CDP_ENDPOINT}`], true);

  // 一次性取出全部 Cookie，再按域筛选（比按域名逐个查询更可靠，能覆盖子域）
  const pool = parseCookieList(pw(['--raw', 'cookie-list'], true));
  console.log(`浏览器中现有 Cookie：${pool.length} 个\n`);

  // 位置参数 = 平台 id（`--slot 2` 的 2、`--site global` 的 global 都不是平台 id，要排掉）
  const only = ARGS.filter(
    (arg, index) => !arg.startsWith('--') && index !== SLOT_VALUE_INDEX && index !== SITE_VALUE_INDEX,
  );
  const targets = only.length > 0 ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;
  if (SLOT_SUFFIX) {
    console.log(`多账号槽位：${SLOT}（变量名追加 ${SLOT_SUFFIX}，不会覆盖槽位 1）\n`);
  }
  if (SITE) {
    console.log(`站点选择：${SITE}（仅对声明了该站点变体的平台生效）\n`);
  }

  const results: Result[] = [];
  const envEntries = new Map<string, string>();

  // 先固化浏览器 UA：CodeBuddy 的 WAF 会拒绝缺失或过旧的 UA
  const userAgent = captureUserAgent();
  if (userAgent) {
    envEntries.set('HTTP_USER_AGENT', userAgent);
    console.log(`User-Agent：${userAgent}\n`);
  } else {
    console.log('\u001b[33m未能读取浏览器 User-Agent，将使用内置默认值\u001b[0m\n');
  }

  for (const baseTarget of targets) {
    // `--site` 只对声明了站点变体的平台生效；声明了但不支持该站点 → 跳过并说明可选项
    let target = baseTarget;
    if (SITE && baseTarget.siteVariants) {
      const variant = baseTarget.siteVariants[SITE];
      if (!variant) {
        const available = ['cn', ...Object.keys(baseTarget.siteVariants)].join(' / ');
        console.log(
          `\n\u001b[33m– ${baseTarget.label} 已跳过\u001b[0m：不支持 --site ${SITE}（可用 ${available}）`,
        );
        results.push({
          target: baseTarget,
          status: 'skipped',
          message: `--site ${SITE} 不受支持（可用 ${available}）`,
          cookieCount: 0,
        });
        continue;
      }
      target = { ...baseTarget, ...variant };
    }
    try {
      const result = captureTarget(target, pool);
      results.push(result);
      if (result.status === 'ok') {
        // 槽位后缀只作用于该平台的凭证变量，HTTP_USER_AGENT 这类全局变量不带后缀
        if (result.value) envEntries.set(`${target.envKey}${SLOT_SUFFIX}`, result.value);
        for (const extra of result.extraEnv ?? []) envEntries.set(`${extra.key}${SLOT_SUFFIX}`, extra.value);
      }
    } catch (error) {
      console.log(`  \u001b[31m失败\u001b[0m ${(error as Error).message}`);
      results.push({
        target,
        status: 'failed',
        message: (error as Error).message,
        cookieCount: 0,
      });
    }
  }

  const envInfo =
    envEntries.size > 0
      ? upsertEnvFile(envEntries)
      : { path: resolve(process.cwd(), '.env'), added: [] as string[], updated: [] as string[] };

  const report: string[] = [
    '# 凭证抓取报告',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '> 本文件不含明文凭证（仅记录个数与脱敏后的长度）。',
    '',
    '| 平台 | 状态 | Cookie 数 | 说明 |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (result) =>
        `| ${result.target.label} | ${result.status} | ${result.cookieCount} | ${result.message} |`,
    ),
    '',
  ];
  for (const result of results) {
    if (!result.candidates || result.candidates.length === 0) continue;
    report.push(`## ${result.target.label} 接口候选`, '');
    for (const candidate of result.candidates) {
      report.push(
        `### score=${candidate.score} \`${candidate.method} ${candidate.url}\``,
        '',
        `响应顶层字段：\`${candidate.topKeys.join('`, `')}\``,
        '',
        '推测的 mapping（需人工核对）：',
        '',
        '```jsonc',
        '{',
        ...candidate.mappingDraft.map((line) => `  ${line},`),
        '}',
        '```',
        '',
        '响应片段（前 600 字符）：',
        '',
        '```json',
        candidate.sample,
        '```',
        '',
      );
    }
  }
  if (!DRY_RUN) writeFileSync(REPORT_PATH, report.join('\n'));

  console.log('\n' + '─'.repeat(64));
  for (const result of results) {
    const icon =
      result.status === 'ok'
        ? '\u001b[32m✓\u001b[0m'
        : result.status === 'skipped'
          ? '\u001b[33m–\u001b[0m'
          : '\u001b[31m✗\u001b[0m';
    console.log(`${icon} ${result.target.label.padEnd(18)} ${result.message}`);
  }
  if (envEntries.size > 0) {
    console.log(
      `\n${DRY_RUN ? '[dry-run] 将写入' : '已写入'} ${envInfo.path}\n` +
        `  新增：${envInfo.added.join(', ') || '无'}\n` +
        `  更新：${envInfo.updated.join(', ') || '无'}`,
    );
  } else {
    console.log('\n没有写入任何凭证。');
  }
  if (!DRY_RUN) console.log(`详细报告：${REPORT_PATH}`);

  // 槽位 ≥2 的凭证还没有对应的账号，给出下一步命令（单凭证平台才能一条命令搞定）
  if (SLOT_SUFFIX) {
    const registerable = results.filter(
      (result) => result.status === 'ok' && !result.target.tokenEnvKey && !result.target.identityStorage,
    );
    if (registerable.length > 0) {
      console.log(`\n槽位 ${SLOT} 的凭证还没有对应的账号，注册它（同样会先真实验证）：`);
      for (const result of registerable) {
        const optionFlags = Object.entries(result.target.optionFlags ?? {})
          .map(([key, value]) => ` --${key} ${value}`)
          .join('');
        console.log(
          `  npm run account -- --provider ${result.target.id}` +
            ` --env ${result.target.envKey}${SLOT_SUFFIX}${optionFlags}` +
            ` --name "${result.target.label} · 账号 ${SLOT}"`,
        );
      }
    }
  }
  console.log('\n下一步：npm run probe 验证取数是否正常。');
}

main();
