/**
 * 码道（CodeArts）AK/SK 只读探测。
 *
 * 目的：确认 Huawei Cloud AK/SK 能否直接取到码道订阅/积分信息，
 * 以替代会过期的控制台登录态（见 docs/fixes/CodeArts-华为云登录态频繁失效-修复方案.md）。
 *
 * 用法：
 *   CODEARTS_AK=<ak> CODEARTS_SK=<sk> npm run codearts:aksk-probe
 *   或把它们写进 .env（也兼容 CLI 官方的 CODEARTS_CLI_AK / CODEARTS_CLI_SK 命名）
 *
 * 结论（2026-10-11）：只有「换行式 + 带日期 + 空 body 哈希」组合能通过 APIG 校验，
 * 即 CanonicalRequest 与 StringToSign 都用 \n 分隔；命中后会把完整响应写到
 * `.run/codearts-statistics-plugin.json`（.run/ 已 gitignore），便于核对全部字段。
 *
 * 说明：
 *   - 只发 GET，不做任何写操作；
 *   - 终端输出一律脱敏（长 token 打码，AK/SK 从不打印）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from '../config.js';
import {
  huaweiSignedFetch,
  type HuaweiSignInput,
  type HuaweiSignatureStyle,
} from '../lib/huaweicloud.js';

const SNAP_ACCESS = 'https://snap-access.cn-north-4.myhuaweicloud.com';
const DUMP_PATH = resolve(process.cwd(), '.run/codearts-statistics-plugin.json');

interface ProbeItem {
  label: string;
  url: string;
  note: string;
  dump?: boolean;
}

const PROBES: ProbeItem[] = [
  {
    label: '订阅/套餐信息（CLI 实证，已打通）',
    url: `${SNAP_ACCESS}/snap-manager/v1/statistics/plugin`,
    note: '返回 package / metrics / model_metrics；命中后完整 JSON 落盘到 .run/',
    dump: true,
  },
  {
    label: '当前用户',
    url: `${SNAP_ACCESS}/snap-manager/v1/current/user`,
    note: '验证身份上下文（domain/user）',
  },
  {
    label: '活动逐笔（控制台原路径 + AK/SK 直签，探测免登录态可行性）',
    url: 'https://codearts.huaweicloud.com/portal/promptcenter/v1/ops/credit/overview',
    note: '控制台用 Cookie 调它；若 AK/SK 签名也能过，则逐笔明细可彻底摆脱登录态',
  },
  {
    label: '活动逐笔（CLI 常量反推：`${base}/v1/ops/credit/usage` 同族）',
    url: `${SNAP_ACCESS}/v1/ops/credit/overview`,
    note: 'CLI 二进制里积分接口是 `${snap-access}/v1/ops/credit/usage`（无 snap-manager 前缀），探测同族 overview',
  },
  {
    label: '活动逐笔（snap-access + promptcenter 前缀）',
    url: `${SNAP_ACCESS}/promptcenter/v1/ops/credit/overview`,
    note: '控制台服务名 + 网关根路径的组合，用于排除前缀差异',
  },
  {
    label: '套餐总览（同名假设，已排除）',
    url: `${SNAP_ACCESS}/snap-manager/v1/package/overview`,
    note: '控制台用的是 /portal/snap-manager/v1/package/overview，网关未发布该路由',
  },
  {
    label: '活动/积分总览（假设，已排除）',
    url: `${SNAP_ACCESS}/promptcenter/v1/ops/credit/overview`,
    note: '积分接口不在该网关',
  },
];

/**
 * 华为签名规范的组合矩阵：已实测只有「换行式 + 空 body 哈希」能过 APIG，
 * 因此把它放最前（命中即停），其余组合留作回归与排障。
 */
const VARIANTS: Array<{ label: string; style: HuaweiSignatureStyle; unsignedPayload: boolean }> = [
  { label: '换行式·带日期 + 空body哈希', style: 'newline', unsignedPayload: false },
  { label: '换行式·带日期 + UNSIGNED-PAYLOAD', style: 'newline', unsignedPayload: true },
  { label: '空格式·带日期 + UNSIGNED-PAYLOAD', style: 'legacy', unsignedPayload: true },
  { label: '空格式·带日期 + 空body哈希', style: 'legacy', unsignedPayload: false },
  { label: '空格式·不带日期 + 空body哈希', style: 'legacy-no-date', unsignedPayload: false },
  { label: '空格式·不带日期 + UNSIGNED-PAYLOAD', style: 'legacy-no-date', unsignedPayload: true },
];

const MASK_PATTERN = /[A-Za-z0-9_\-+/=]{40,}/g;

function mask(text: string): string {
  return text.replace(MASK_PATTERN, '[REDACTED]');
}

function preview(json: unknown, fallback: string): string {
  if (json === null) return mask(fallback.replace(/\s+/g, ' ').trim().slice(0, 300)) || '(空响应)';
  return mask(JSON.stringify(json, null, 1)).slice(0, 1500);
}

function topKeys(json: unknown): string {
  if (json === null || typeof json !== 'object') return '(非 JSON 对象)';
  return Object.keys(json as Record<string, unknown>)
    .slice(0, 20)
    .join(', ');
}

function dump(json: unknown): void {
  mkdirSync(resolve(process.cwd(), '.run'), { recursive: true });
  writeFileSync(DUMP_PATH, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  完整响应已写入：${DUMP_PATH}`);
}

/** 针对 statistics/plugin 的简报：把积分相关的 metrics 摘出来，便于人工核对 */
function summarizePackage(json: unknown): void {
  if (json === null || typeof json !== 'object') return;
  const record = json as Record<string, unknown>;
  const metrics = Array.isArray(record.metrics) ? record.metrics : [];
  const creditMetrics = metrics.filter(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === 'object' &&
      String((item as Record<string, unknown>).name ?? '').toLowerCase().includes('credit'),
  );
  if (creditMetrics.length > 0) {
    console.log('  积分指标：');
    for (const metric of creditMetrics) {
      console.log(
        `    - ${String(metric.name)}：总额 ${String(metric.package_credit_amount ?? '-')} / ` +
          `已用 ${String(metric.package_credit_used ?? '-')} / 剩余 ${String(metric.package_credit_remain ?? '-')} / ` +
          `临近过期 ${String(metric.package_credit_expiring_amount ?? '-')}`,
      );
    }
  }
  if (record.package) console.log(`  package：${mask(JSON.stringify(record.package))}`);
  if (record.start_date || record.end_date) {
    console.log(`  计费周期：${String(record.start_date ?? '-')} ~ ${String(record.end_date ?? '-')}`);
  }
}

async function probe(
  base: Omit<HuaweiSignInput, 'unsignedPayload' | 'signatureStyle'>,
  item: ProbeItem,
): Promise<void> {
  for (const variant of VARIANTS) {
    let result;
    try {
      result = await huaweiSignedFetch({
        ...base,
        signatureStyle: variant.style,
        unsignedPayload: variant.unsignedPayload,
        timeoutMs: 12_000,
      });
    } catch (error) {
      console.log(`  [${variant.label}] 请求失败：${(error as Error).message}`);
      return;
    }
    console.log(`  [${variant.label}] HTTP ${result.status}（${result.durationMs}ms）`);
    if (result.ok) {
      console.log(`  顶层字段：${topKeys(result.json)}`);
      summarizePackage(result.json);
      if (item.dump) dump(result.json);
      return;
    }
    if (result.status !== 401 && result.status !== 403) {
      console.log(`  响应体（脱敏）：${preview(result.json, result.text).slice(0, 400)}`);
      return;
    }
  }
  console.log('  六种签名组合均未通过；请把响应体贴回，区分「密钥不匹配」与「规范不匹配」');
}

async function main(): Promise<void> {
  loadDotEnv();
  const ak = process.env.CODEARTS_AK || process.env.CODEARTS_CLI_AK || '';
  const sk = process.env.CODEARTS_SK || process.env.CODEARTS_CLI_SK || '';

  if (!ak || !sk) {
    console.error(
      '缺少 AK/SK。请在终端临时设置后重跑（或写进 .env）：\n' +
        '  export CODEARTS_AK=<你的AK>\n' +
        '  export CODEARTS_SK=<你的SK>\n' +
        '  npm run codearts:aksk-probe\n' +
        '注意：AK/SK 只留在本机，不要贴进任何对话或文档。',
    );
    process.exit(1);
  }

  console.log(`CodeArts AK/SK 探测（AK 前缀 ${ak.slice(0, 4)}…，已脱敏）\n`);

  for (const item of PROBES) {
    console.log(`▶ ${item.label}`);
    console.log(`  ${item.url}`);
    console.log(`  说明：${item.note}`);
    await probe({ accessKey: ak, secretKey: sk, method: 'GET', url: item.url }, item);
    console.log('');
  }

  console.log('探测结束。命中接口的完整响应在 .run/ 下（已 gitignore），可直接交给 AI 读取。');
}

void main();
