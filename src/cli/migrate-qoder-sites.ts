/**
 * 一次性迁移：把 `accounts.json` 里 Qoder 的**旧站点配置**迁到新平台身份。
 *
 * 背景：Qoder 的国内站与国际站以前是「一个平台 + `options.site`」，现已拆成
 * 两个平台（`qoder` 国内版 / `qoder-intl` 国际版，见
 * `docs/plans/平台适配器-Qoder国内站与国际站彻底分离-开发设计方案.md` §3.4）。
 * 拆分后 `options.site` 不再参与站点解析，但**带 `site: "global"` 的旧账号
 * 会继续挂在国内版平台下**——用国际站 Cookie 打 qoder.com.cn 必然 401。
 * 这个脚本负责把这类账号挪到 `qoder-intl`。
 *
 * 规则（与方案 §3.4 一致）：
 *   - `provider: "qoder"` + `site: "global"` → `provider: "qoder-intl"`，删 `site` / `fallbackSite`；
 *   - `provider: "qoder"` + `site: "cn"` 或无 → 只删 `site` / `fallbackSite`，provider 不变；
 *   - `site: "auto"` / 其它取值 → **不改**（无法判断这份凭证属于哪个站点），只提示需人工确认；
 *   - 只改 `provider` 与 `options` 两个字段：凭证内容、`${VAR}` 引用、displayName 一律不动。
 *
 * 用法：
 *   npm run migrate:qoder-sites -- --dry-run   # 只打印将要做的改动
 *   npm run migrate:qoder-sites                # 备份后写入（`.run/qoder-sites-<时间戳>/`）
 *
 * 本脚本**不会**向上游平台发任何请求，也不会输出凭证明文。
 */
import { resolveAdapter } from '../providers/index.js';
import {
  backupBeforeWrite,
  readAccountsFile,
  writeAccountsFile,
} from '../a1etheropenai-store.js';

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

/** 旧配置里需要清理的站点选项 */
const LEGACY_OPTION_KEYS = ['site', 'fallbackSite'] as const;

interface Planned {
  /** accounts.json 里的下标（原文件顺序） */
  index: number;
  displayName: string;
  /** 迁移前的 provider → 迁移后 */
  from: string;
  to: string;
  /** 本次要改的说明（空 = 无需改动） */
  notes: string[];
  /** 需要人工确认：脚本不动它 */
  manual: boolean;
}

function optionString(record: Record<string, unknown>, key: string): string {
  const raw = record[key];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function main(): void {
  const file = readAccountsFile();
  const planned: Planned[] = [];

  for (const [index, entry] of file.accounts.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const adapter = resolveAdapter(typeof entry.provider === 'string' ? entry.provider : '');
    // 只处理「拆出站点前就存在」的 Qoder 账号：provider 解析到国内版
    // （国际版 provider 已是 qoder-intl，无需处理；别家平台一律不碰）
    if (!adapter || adapter.id !== 'qoder') continue;

    const options =
      entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options)
        ? (entry.options as Record<string, unknown>)
        : {};
    const site = optionString(options, 'site');
    const hasFallback = Object.prototype.hasOwnProperty.call(options, 'fallbackSite');

    const item: Planned = {
      index,
      displayName: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : '(未命名)',
      from: typeof entry.provider === 'string' ? entry.provider : '',
      to: typeof entry.provider === 'string' ? entry.provider : '',
      notes: [],
      manual: false,
    };

    if (site === 'auto') {
      // `auto` 没有指定站点：这份凭证可能是国际站的，脚本无法代判
      item.manual = true;
      item.notes.push('options.site 为 "auto"，无法判断凭证属于哪个站点 → 需人工确认');
      planned.push(item);
      continue;
    }

    if (site === 'global') {
      item.to = 'qoder-intl';
      item.notes.push('provider 改为 qoder-intl（平台已拆分为独立国际版）');
    } else if (site === 'cn') {
      item.notes.push('站点已是国内版，仅清理选项');
    }
    for (const key of LEGACY_OPTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        item.notes.push(`删除 options.${key}`);
      }
    }
    if (hasFallback) item.notes.push('options.fallbackSite 已废弃（不再跨站点回退）');

    if (item.notes.length === 0) continue;
    planned.push(item);
  }

  if (planned.length === 0) {
    console.log('没有需要迁移的 Qoder 账号（accounts.json 里已无旧站点配置）。');
    return;
  }

  console.log(`\n发现 ${planned.length} 条需要处理的 Qoder 账号：\n`);
  for (const item of planned) {
    const head = item.manual ? '\u001b[33m需人工确认\u001b[0m' : '\u001b[36m将迁移\u001b[0m';
    console.log(`  [${item.index}] ${head} ${item.displayName}`);
    if (item.from !== item.to) console.log(`      provider：${item.from} → ${item.to}`);
    for (const note of item.notes) console.log(`      · ${note}`);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] 未写入任何文件。去掉 --dry-run 执行迁移。\n');
    return;
  }

  const backup = backupBeforeWrite('sites', 'qoder');
  let changed = 0;
  for (const item of planned) {
    if (item.manual) continue;
    const entry = file.accounts[item.index];
    if (item.from !== item.to) entry.provider = item.to;
    const options =
      entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options)
        ? (entry.options as Record<string, unknown>)
        : {};
    for (const key of LEGACY_OPTION_KEYS) delete options[key];
    entry.options = options;
    changed += 1;
  }
  writeAccountsFile(file);

  console.log(`\n已更新 ${changed} 条账号，备份目录：${backup}`);
  if (planned.some((item) => item.manual)) {
    console.log(
      '\n\u001b[33m仍有账号需人工处理\u001b[0m：`options.site: "auto"` 的账号无法自动判定站点，' +
        '请在看板上确认它实际属于国内版还是国际版，再改为对应的平台（qoder / qoder-intl）。\n',
    );
  }
  console.log(
    '下一步：\n' +
      '  1. 看板上刷新页面，确认两条 Qoder 卡片分别显示国内版 / 国际版的账号；\n' +
      '  2. 用 npm run probe -- qoder 与 npm run probe -- qoder-intl 核对取数（会真实请求上游）。\n',
  );
}

main();