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

// ---------------------------------------------------------------- playwright-cli 封装

function pw(args: string[], allowFailure = false): string {
  try {
    return execFileSync('playwright-cli', ['-s=' + SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (error) {
    if (allowFailure) return '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`playwright-cli ${args.join(' ')} 失败：${stderr || (error as Error).message}`);
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
}

const TARGETS: Target[] = [
  {
    id: 'qoder',
    label: 'Qoder',
    envKey: 'QODER_COOKIE',
    cookieSites: ['qoder.com.cn', 'qoder.cn', 'qoder.com'],
    usageUrl: 'https://qoder.com.cn/account/usage',
    apiHost: 'qoder.com.cn',
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

  // ① 首选：浏览器对该 API 主机真实发送的 Cookie 头
  const realHosts = captureRealCookieHeaders();
  let header = realHosts[target.apiHost] ?? '';
  let source = `来自浏览器对 ${target.apiHost} 的真实请求`;

  // ② 退而求其次：同一 Cookie 域下其它主机的真实头
  if (!header) {
    for (const [host, value] of Object.entries(realHosts)) {
      if (target.cookieSites.some((site) => cookieAppliesTo(host, site))) {
        header = value;
        source = `来自浏览器对 ${host} 的真实请求`;
        break;
      }
    }
  }

  // ③ 最后兜底：按域从 cookie jar 拼装
  const cookies = collectCookies(target.cookieSites, pool);
  if (!header && cookies.length > 0) {
    header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    source = `由 cookie jar 拼装（${cookies.length} 个）`;
  }

  if (!header) {
    console.log('  Cookie: 未找到（可能还没登录）');
    return {
      target,
      status: 'skipped',
      message: '没有可用 Cookie，请确认已在该窗口登录并打开用量页',
      cookieCount: 0,
    };
  }

  const count = header.split('; ').length;
  console.log(`  Cookie: ${count} 个，${header.length} 字节 ← ${source}`);
  console.log(`  值：${mask(header)}`);
  if (header.length > 8000) {
    console.log('  \u001b[33m提示：Cookie 较大，可能超过服务端 header 上限\u001b[0m');
  }

  const candidates = DISCOVER ? discoverEndpoints(target) : undefined;
  if (candidates) {
    for (const candidate of candidates) {
      console.log(`  \u001b[36m候选\u001b[0m score=${candidate.score} ${candidate.method} ${candidate.url}`);
    }
    if (candidates.length === 0) console.log('  没有找到像余额接口的响应');
  }

  return { target, status: 'ok', message: '已抓取', cookieCount: count, value: header, candidates };
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

  const only = ARGS.filter((arg) => !arg.startsWith('--'));
  const targets = only.length > 0 ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;

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

  for (const target of targets) {
    try {
      const result = captureTarget(target, pool);
      results.push(result);
      if (result.status === 'ok' && result.value) envEntries.set(target.envKey, result.value);
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
  console.log('\n下一步：npm run probe 验证取数是否正常。');
}

main();
