/**
 * CodeArts 控制台接口诊断（只读）。
 *
 * 用途：看板出现「活动列表为空 / 活动福利逐笔缺失 / 增量被压成 0」时，
 * 用 .env 里的登录态 Cookie 直接看控制台接口的**原始返回**，判断到底是：
 *   ① 活动确实没有记录（当前没有进行中的活动）；
 *   ② 登录态已失效（但接口仍返回 200 空数据）；
 *   ③ 接口/参数变了（返回结构对不上）。
 *
 * 用法：
 *   npm run codearts:console-probe        # 读取 .env 的 CODEARTS_COOKIE
 *
 * 说明：只发 GET，不做任何写操作；输出一律脱敏。
 */
import { loadDotEnv } from '../config.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { consoleHeaders } from '../providers/codearts.js';
import type { AccountConfig } from '../config.js';

const CA_BASE = 'https://codearts.huaweicloud.com';
const MASK_PATTERN = /[A-Za-z0-9_\-+/=]{40,}/g;

/** 是否出现「200 + 空响应」（登录态失效的判定依据，同时决定退出码） */
let sawEmpty = false;

/** consoleHeaders 只用到 options.cftk，这里给一个最小账号壳即可 */
const SHELL_ACCOUNT: AccountConfig = {
  provider: 'codearts',
  enabled: true,
  displayName: null,
  credentials: {},
  options: {},
};

function mask(text: string): string {
  return text.replace(MASK_PATTERN, '[REDACTED]');
}

function stamp(path: string): string {
  return `${CA_BASE}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;
}

function snippet(text: string, length = 900): string {
  return mask(text.replace(/\s+/g, ' ').trim()).slice(0, length);
}

function describe(body: unknown): string {
  if (body === null || typeof body !== 'object') return '(非对象响应)';
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 12).join(', ');
  const data = record.data;
  let extra = '';
  if (data !== null && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    const items = dataRecord.items;
    if (Array.isArray(items)) extra = `；data.items 长度 = ${items.length}`;
    const benefits = dataRecord.benefits;
    if (Array.isArray(benefits)) extra = `；data.benefits 长度 = ${benefits.length}`;
  }
  return `顶层字段：${keys}${extra}`;
}

async function call(
  headers: Record<string, string>,
  path: string,
  timeoutMs = 12_000,
): Promise<unknown | null> {
  const url = stamp(path);
  console.log(`\n▶ GET ${path}`);
  try {
    const result = await fetchJson(url, { headers, timeoutMs: Math.min(timeoutMs, 8_000) });
    console.log(`  HTTP ${result.status}  ${describe(result.body)}  响应长度 ${result.text.length}`);
    if (result.text.length === 0) {
      sawEmpty = true;
      console.log('  ⚠️ 空响应：这是登录态失效的典型表现（控制台对失效会话返回 200 + 空 body，不返回 401）');
      console.log('     处理：npm run codearts:refresh（一键拉起调试 Chrome + 重抓 + 校验）');
      return null;
    }
    console.log(`  原始响应（前 900 字，已脱敏）：\n  ${snippet(result.text)}`);
    return result.body;
  } catch (error) {
    const kind = error instanceof HttpError ? `HTTP ${error.status}` : '异常';
    console.log(`  ${kind}：${snippet((error as Error).message, 300)}`);
    return null;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const cookie = (process.env.CODEARTS_COOKIE || '').trim();
  if (!cookie) {
    console.error('缺少 CODEARTS_COOKIE（请写在 .env 里，不要贴进对话）。');
    process.exit(1);
  }
  const headers = consoleHeaders(SHELL_ACCOUNT, cookie);
  console.log(`CodeArts 控制台接口诊断（Cookie 长度 ${cookie.length}，已脱敏）`);

  // ① 余额对照（AK/SK 也看得到，用于确认登录态是否真的有效）
  await call(headers, '/portal/snap-manager/v1/package/overview');

  // ② 活动列表：为空就说明「逐笔没有来源」，非空则继续看每个活动的逐笔
  const overview = await call(headers, '/portal/promptcenter/v1/ops/credit/overview');
  const data =
    overview !== null && typeof overview === 'object'
      ? (overview as Record<string, unknown>).data
      : null;
  const items =
    data !== null && typeof data === 'object'
      ? ((data as Record<string, unknown>).items as unknown[] | undefined)
      : undefined;

  if (Array.isArray(items) && items.length > 0) {
    for (const item of items.slice(0, 3)) {
      if (item === null || typeof item !== 'object') continue;
      const id = (item as Record<string, unknown>).campaignId ?? (item as Record<string, unknown>).campaign_id;
      if (id === undefined || id === null) continue;
      await call(headers, `/portal/promptcenter/v1/ops/credit/campaign/${String(id)}`, 8_000);
    }
  } else {
    console.log('\n活动列表为空：逐笔明细没有来源（既可能是真的没有进行中的活动，也可能是接口口径变化）');
  }

  console.log('\n诊断结束（输出已脱敏，不含凭证）。');
  if (sawEmpty) {
    console.log(
      '结论：登录态已失效（退出码 3）——请在调试 Chrome 窗口里登录 codearts.huaweicloud.com，' +
        '然后重跑 npm run codearts:refresh。',
    );
    process.exitCode = 3;
  } else {
    console.log('结论：登录态有效（退出码 0）。');
  }
}

void main();
