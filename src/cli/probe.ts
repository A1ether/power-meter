/**
 * 命令行探测器：不开浏览器就能验证凭证是否可用。
 *
 *   npm run probe                    # 探测 accounts.json 里所有启用的平台
 *   npm run probe -- qoder trae      # 只探测指定平台
 *   npm run probe -- --json          # 输出原始 JSON
 */
import { adoptResolvedAccountName } from '../account-store.js';
import { loadConfig } from '../config.js';
import { resolveAdapter } from '../providers/index.js';
import type { ProviderSnapshot } from '../types.js';
import { OK_STATUSES } from '../types.js';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const filters = args.filter((arg) => !arg.startsWith('--'));

function pad(value: string, width: number): string {
  const cells = [...value].length;
  return value + ' '.repeat(Math.max(0, width - cells));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function color(snapshot: ProviderSnapshot): string {
  if (snapshot.status === 'ok') return '\u001b[32m';
  if (snapshot.status === 'demo') return '\u001b[36m';
  if (snapshot.status === 'notConfigured') return '\u001b[33m';
  return '\u001b[31m';
}

async function main(): Promise<void> {
  const { config, warnings, missingEnvVars } = loadConfig();
  const accounts = config.accounts.filter(
    (account) =>
      account.enabled &&
      (filters.length === 0 ||
        filters.some(
          (filter) =>
            filter === account.provider ||
            filter === account.displayName ||
            filter === account.provider.split(':').pop(),
        )),
  );

  if (missingEnvVars.length > 0) {
    console.log(`\u001b[33m环境变量缺失：${missingEnvVars.join(', ')}\u001b[0m`);
  }
  for (const warning of warnings) console.log(`\u001b[33m${warning}\u001b[0m`);

  if (accounts.length === 0) {
    console.log('没有匹配的已启用平台。');
    return;
  }

  const snapshots: ProviderSnapshot[] = [];
  for (const account of accounts) {
    const adapter = resolveAdapter(account.provider);
    if (!adapter) {
      console.log(`\u001b[31m未知平台 ${account.provider}\u001b[0m`);
      continue;
    }
    const started = Date.now();
    const snapshot = await adapter.probe(account, {
      now: Date.now(),
      timeoutMs: config.settings.requestTimeoutMs,
      log: () => {},
      // 探针同样把解析出的平台昵称落库（只替换「登录账号」占位名），
      // 这样 CLI 验证一次就能看到卡片标题变成「平台 · 昵称」，与看板口径一致
      persistAccountName: async (resolvedName) =>
        adoptResolvedAccountName(account.provider, account.displayName ?? '', resolvedName),
    });
    snapshots.push(snapshot);
    const elapsed = Date.now() - started;
    // 探针是「逐账号」的诊断工具，不走聚合层的合并，
    // 所以标题要用账号自己的名字——否则合并类平台（如 A1etherOpenAi）几行全长一样
    console.log(
      `${color(snapshot)}\u25cf\u001b[0m ${pad(account.displayName || snapshot.displayName, 26)} ` +
        `${pad(snapshot.status, 14)} ${String(elapsed).padStart(5)}ms  ${snapshot.message ?? ''}`,
    );
    if (snapshot.balance) {
      console.log(
        `  ${pad('', 24)}余额 ${snapshot.balance.amount} ${snapshot.balance.currency}` +
          (snapshot.nextExpiryAt ? `  最快到期 ${snapshot.nextExpiryAt.slice(0, 10)}` : ''),
      );
    }
    // 说明的第一段通常是最关键的口径信息（如 Qoder 的「站点：国际站（…）」、
    // 回退说明），整段可能很长（含隐藏批次等），只打第一段
    if (snapshot.note) {
      console.log(`  ${pad('', 24)}说明 ${snapshot.note.split('；')[0]}`);
    }
    for (const window of snapshot.windows) {
      console.log(
        `  ${pad('', 24)}${window.label}: ${window.remaining}/${window.limit}` +
          (window.resetsAt ? `  重置 ${window.resetsAt.slice(0, 10)}` : ''),
      );
    }
    for (const lot of snapshot.credits) {
      console.log(
        `  ${pad('', 24)}  · ${pad(lot.label, 24)} ${pad(String(lot.amount), 10)} ` +
          `过期 ${lot.expiresAt ? lot.expiresAt.slice(0, 10) : '—'}`,
      );
    }
    // 可托管密钥：这里只回显掩码，明文只在看板上按需读取
    for (const secret of snapshot.secrets) {
      console.log(`  ${pad('', 24)}密钥 ${pad(secret.label, 20)} ${secret.preview}`);
    }
  }

  const ok = snapshots.filter((snapshot) => OK_STATUSES.has(snapshot.status)).length;
  console.log(
    `\n合计 ${snapshots.length} 个平台，正常 ${ok} 个，异常 ${snapshots.length - ok} 个。`,
  );

  if (jsonMode) {
    // 既打印可读结果，也支持机器读取
    const plain = snapshots.map((snapshot) => ({
      ...snapshot,
      displayWidth: stripAnsi(snapshot.displayName).length,
    }));
    console.log(JSON.stringify(plain, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error('探测失败：', error);
  process.exit(1);
});
