/**
 * 一条命令添加 / 查看 D1V 账号（终端版）。
 *
 *   npm run d1v:add -- <账号密钥> <项目密钥> [--name "显示名"]
 *   npm run d1v:add -- --text "个人apikey：sk-xxx
 *   对应的项目apikey：yyy"
 *   npm run d1v:add -- --list
 *
 * 真正的校验与写盘在 `src/d1v-store.ts`，与看板上的「添加 / 删除账号」按钮
 * 共用同一份实现——否则两边迟早会走样（比如一边备份了、一边没备份）。
 * 这里只负责解析参数与把结果打印成人话。
 */
import {
  addD1vAccount,
  listD1vAccounts,
  parseKeyPairText,
  removeD1vAccount,
} from '../d1v-store.js';
import { normalizeApiKey } from '../providers/d1v.js';
import type { ProviderSnapshot } from '../types.js';

/** 只带布尔含义的开关；其余 `--xxx` 一律视为「后面跟一个取值」 */
const BOOLEAN_FLAGS = new Set(['list', 'dry-run', 'force', 'remove-all-confirm']);
const args = process.argv.slice(2);

function flag(name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

/** 位置参数：既不是开关，也不是某个开关的取值 */
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      out.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    // 只有「带值」的开关才吃掉下一个参数；
    // 否则 `--dry-run sk-xxx yyy` 会把密钥当成 dry-run 的取值丢掉
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) i += 1;
  }
  return out;
}

const USAGE = `
添加 / 查看 D1V 账号（会先验证两把密钥，通过了才写文件）：

  npm run d1v:add -- <账号密钥> <项目密钥>
  npm run d1v:add -- --text "个人apikey：sk-xxx
  对应的项目apikey：yyy"
  npm run d1v:add -- --list                    # 看已配置的账号
  npm run d1v:add -- --dry-run <账号> <项目>    # 只验证不写入
  npm run d1v:add -- --remove "<账号名>"        # 删除（同样先备份）

其它可选参数：
  --name "显示名"      默认用账号邮箱前缀，例如 D1V · sb4hnm
  --pai-base <URL>     项目密钥的校验地址，默认 https://pai.d1v.ai/v1
  --force              允许重复添加账号密钥（默认会拒绝）

这些操作与看板上 D1V 卡片里的「添加 / 删除」是同一份实现，写完都会自动热加载。
`;

function printSnapshot(snapshot: ProviderSnapshot): void {
  console.log(`  状态      ${snapshot.status}`);
  console.log(`  账号      ${snapshot.plan ?? '(未取到)'}`);
  if (snapshot.balance) {
    console.log(
      `  可用额度  ${snapshot.balance.amount.toLocaleString('en-US')} ${snapshot.balance.currency}`,
    );
  }
  if (snapshot.note) console.log(`  说明      ${snapshot.note.split('；')[0]}`);
}

function listAccounts(): void {
  const { accounts, missingEnvVars } = listD1vAccounts();
  if (accounts.length === 0) {
    console.log('\n当前没有 D1V 账号。加一个：\n  npm run d1v:add -- <账号密钥> <项目密钥>\n');
    return;
  }
  console.log(`\n已配置 ${accounts.length} 个 D1V 账号：\n`);
  for (const account of accounts) {
    console.log(
      `  ${account.enabled ? '● 已启用' : '○ 已停用'}  ${account.label.padEnd(26)}` +
        `账号密钥 ${(account.apiPreview || '(未配置)').padEnd(16)}` +
        `项目密钥 ${account.paiPreview || '(未配置)'}` +
        (account.envSuffix ? `  [D1V_${account.envSuffix}_*]` : ''),
    );
  }
  if (missingEnvVars.length > 0) {
    console.log(`\n  注意：以下环境变量为空，相关账号会取数失败 → ${missingEnvVars.join(', ')}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  if (has('list')) {
    listAccounts();
    return;
  }

  const removeTarget = flag('remove');
  if (removeTarget !== null) {
    if (!removeTarget) {
      console.error('\n✖ --remove 需要给出账号名，例如 --remove "D1V · sb4hnm"\n');
      process.exitCode = 1;
      return;
    }
    const result = removeD1vAccount(removeTarget);
    if (!result.ok) {
      console.error(`\n✖ ${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n✔ 已删除账号「${result.name}」`);
    if (result.removedEnvLines?.length) {
      console.log(`  .env 同时移除了：${result.removedEnvLines.join(', ')}`);
    } else {
      console.log('  .env 未改动（对应变量仍被其它账号引用，或该账号是明文直填）');
    }
    console.log(`  改动前备份  ${result.backupDir}\n`);
    return;
  }

  let apiKey = flag('api') ?? flag('api-key') ?? '';
  let paiKey = flag('pai') ?? flag('pai-key') ?? '';

  const text = flag('text');
  if (text === null && !apiKey && !paiKey) {
    [apiKey = '', paiKey = ''] = positional();
  }
  if (text) {
    const parsed = parseKeyPairText(text);
    apiKey = apiKey || parsed.apiKey;
    paiKey = paiKey || parsed.paiKey;
  }

  if (!normalizeApiKey(apiKey) || !normalizeApiKey(paiKey)) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const dryRun = has('dry-run');
  const result = await addD1vAccount({
    apiKey,
    paiKey,
    name: flag('name') ?? undefined,
    paiBase: flag('pai-base') ?? undefined,
    force: has('force'),
    dryRun,
    onStage: (stage) => {
      console.log(stage === 'apiKey' ? '\n① 验证账号密钥（查额度）…' : '\n② 验证项目密钥…');
    },
  });

  if (!result.ok) {
    // 重复添加不是错误，只是一次「什么都不做」的提醒
    console.log(`\n${result.stage === 'duplicate' ? '' : '✖ '}${result.error}\n`);
    process.exitCode = result.stage === 'duplicate' ? 0 : 1;
    return;
  }

  // onStage 已经在各步开始时打过标题，这里补上结果
  printSnapshot(result.snapshot);
  console.log(`  通过，${result.modelCount} 个可用模型`);

  if (result.dryRun) {
    console.log('\n[dry-run] 验证全部通过，未写入文件。');
    console.log(`  将写入 .env        : D1V_${result.suffix}_API_KEY / D1V_${result.suffix}_PAI_API_KEY`);
    console.log(`  将写入 accounts.json: ${result.name}\n`);
    return;
  }

  console.log(`\n✔ 已添加账号「${result.name}」`);
  console.log(
    `  .env            D1V_${result.suffix}_API_KEY / D1V_${result.suffix}_PAI_API_KEY` +
      (result.reused ? '（复用了原有空槽位）' : ''),
  );
  console.log('  accounts.json   已追加一条 provider: "d1v"');
  console.log(`  改动前备份      ${result.backupDir}`);
  console.log('\n服务会监听文件变化自动热加载，刷新 http://127.0.0.1:8787 即可看到。\n');
}

main().catch((error: unknown) => {
  console.error(`\n✖ ${(error as Error).message}\n`);
  process.exitCode = 1;
});
