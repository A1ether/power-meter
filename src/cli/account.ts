/**
 * 一条命令管理「任何平台」的账号（终端版）：增 / 删 / 列。
 *
 *   npm run account -- --list                              # 列出所有可管理平台的账号
 *   npm run account -- --list --provider codebuddy         # 只看某个平台
 *   npm run account -- --provider codebuddy --cookie '<值>' [--name "CodeBuddy · 账号 2"]
 *   npm run account -- --provider codebuddy --env CODEBUDDY_COOKIE_2 [--name "..."]
 *   npm run account -- --provider codebuddy --remove "CodeBuddy · 账号 2"
 *
 * 真正的校验与写盘在 `src/account-store.ts`，与看板上的「＋ 添加账号 / 删除」按钮
 * 共用同一份实现——否则两边迟早会走样（比如一边备份了、一边没备份）。
 * 这里只负责解析参数与把结果打印成人话。
 *
 * 需要哪些凭证 flag：看适配器声明的 `manageFields`（如 codebuddy 是 `--cookie`，
 * a1etheropenai 是 `--apiKey` 与 `--paiApiKey`）；`--list` 会在提示里带出来。
 */
import { addManagedAccount, listManagedAccounts, removeManagedAccount } from '../account-store.js';
import type { ManageFieldDescriptor } from '../providers/base.js';
import { listAdapters, resolveAdapter } from '../providers/index.js';

/** 只带布尔含义的开关；其余 `--xxx` 一律视为「后面跟一个取值」 */
const BOOLEAN_FLAGS = new Set(['list', 'dry-run', 'force']);
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

/** `--env` 可以出现多次，因此单独收集（每次调用 flag() 只会拿到第一个） */
function allFlags(name: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== `--${name}`) return;
    const value = args[index + 1];
    if (value !== undefined && !value.startsWith('--')) out.push(value);
  });
  return out;
}

/** 驼峰字段名 → 连字符写法，两种都能当 flag 用（--paiApiKey / --pai-api-key） */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

const USAGE = `
管理各平台的账号（先真实验证凭证，通过了才写文件）：

  npm run account -- --list                                # 列出所有可管理平台的账号
  npm run account -- --list --provider codebuddy           # 只看某个平台

  # 粘贴明文新增（flag 名 = 适配器 manageFields 里的字段名，如 --cookie）
  npm run account -- --provider codebuddy --cookie '<Cookie 值>' [--name "CodeBuddy · 账号 2"]

  # 引用 .env 里已有的变量（配合 npm run capture -- codebuddy --slot 2 使用）
  npm run account -- --provider codebuddy --env CODEBUDDY_COOKIE_2 [--name "..."]

  # 带站点选择的平台（如 Qoder 的国内站 / 国际站）
  npm run account -- --provider qoder --cookie '<Cookie 值>' --site global

  # 删除（会清掉不再被引用的 .env 变量，写入前自动备份）
  npm run account -- --provider codebuddy --remove "CodeBuddy · 账号 2"

其它可选参数：
  --option k=v   写入账号 options 的非敏感配置（可重复；对 Qoder 而言 --site global 是其快捷写法）
  --force        允许重复添加同一份凭证（默认 409 拒绝）
  --dry-run      只验证不写入

这些操作与看板卡片里的「＋ 添加账号 / 删除」是同一份实现，写完都会自动热加载。
`;

/** 可管理的平台：声明了 manageAccounts + manageFields 的适配器 */
function manageableAdapters(): Array<{ id: string; displayName: string; fields: ManageFieldDescriptor[] }> {
  return listAdapters()
    .filter((adapter) => adapter.manageAccounts === true && (adapter.manageFields ?? []).length > 0)
    .map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      fields: adapter.manageFields ?? [],
    }));
}

function listTargets(provider: string | null): void {
  const targets = manageableAdapters().filter((item) => !provider || item.id === provider);
  if (targets.length === 0) {
    console.log(
      provider
        ? `\n平台「${provider}」没有声明可管理的字段（manageFields），无法在这里增删账号。\n`
        : '\n当前没有可管理账号的平台。\n',
    );
    process.exitCode = provider ? 1 : 0;
    return;
  }

  for (const target of targets) {
    const { accounts, missingEnvVars } = listManagedAccounts(target.id);
    console.log(`\n${target.displayName}（${target.id}）：${accounts.length} 个账号`);
    if (accounts.length === 0) {
      const flags = target.fields
        .map((field) =>
          field.target === 'option'
            ? `[--${field.key} ${(field.choices ?? []).join('|') || '<值>'}]`
            : `--${field.key} '<值>'`,
        )
        .join(' ');
      console.log(`  还没有配置账号。加一个：npm run account -- --provider ${target.id} ${flags}`);
    }
    for (const account of accounts) {
      const previews = Object.entries(account.previews)
        .map(([key, value]) => `${key} ${value || '(未配置)'}`)
        .join(' · ');
      console.log(
        `  ${account.enabled ? '● 已启用' : '○ 已停用'}  ${account.label.padEnd(24)}${previews}` +
          (account.envRefs.length > 0 ? `  [${account.envRefs.join(' / ')}]` : ''),
      );
    }
    if (missingEnvVars.length > 0) {
      console.log(`  注意：以下环境变量为空，相关账号会取数失败 → ${missingEnvVars.join(', ')}`);
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  const provider = flag('provider') ?? '';

  if (has('list') || args.length === 0) {
    listTargets(provider || null);
    return;
  }

  if (!provider) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const adapter = resolveAdapter(provider);
  if (!adapter) {
    console.error(`\n✖ 未知平台「${provider}」。可用平台：${manageableAdapters().map((item) => item.id).join(' / ')}\n`);
    process.exitCode = 1;
    return;
  }

  const removeTarget = flag('remove');
  if (removeTarget !== null) {
    if (!removeTarget) {
      console.error('\n✖ --remove 需要给出账号名，例如 --remove "CodeBuddy · 账号 2"\n');
      process.exitCode = 1;
      return;
    }
    const result = removeManagedAccount(provider, removeTarget);
    if (!result.ok) {
      console.error(`\n✖ ${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n✔ 已删除账号「${result.name}」`);
    console.log(
      result.removedEnvLines.length > 0
        ? `  .env 同时移除了：${result.removedEnvLines.join(', ')}`
        : '  .env 未改动（对应变量仍被其它账号引用，或该账号是明文直填）',
    );
    console.log(`  改动前备份  ${result.backupDir}\n`);
    return;
  }

  // ---- 新增：字段声明决定需要哪些 flag
  const fields = adapter.manageFields ?? [];
  if (adapter.manageAccounts !== true || fields.length === 0) {
    console.error(
      `\n✖ 平台「${adapter.id}」的适配器没有声明 manageAccounts + manageFields，无法用本命令添加账号。\n`,
    );
    process.exitCode = 1;
    return;
  }
  const credentialFields = fields.filter((field) => field.target !== 'option');
  const optionFields = fields.filter((field) => field.target === 'option');

  const credentials: Record<string, string> = {};
  const envRefs: Record<string, string> = {};
  for (const field of credentialFields) {
    const plain = flag(field.key) ?? flag(kebab(field.key));
    if (plain) {
      credentials[field.key] = plain;
      continue;
    }
    // `--env VAR`（单字段平台）或 `--env key=VAR`（多字段平台）
    for (const item of allFlags('env')) {
      const eq = item.indexOf('=');
      const key = eq > 0 ? item.slice(0, eq).trim() : field.key;
      const value = eq > 0 ? item.slice(eq + 1).trim() : item.trim();
      if (key !== field.key || !value) continue;
      envRefs[field.key] = value;
      break;
    }
  }

  // option 字段（如 Qoder 的站点）：`--site global` 或通用 `--option site=global`
  const options: Record<string, string> = {};
  for (const item of allFlags('option')) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    options[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  for (const field of optionFields) {
    const plain = flag(field.key) ?? flag(kebab(field.key));
    if (plain) options[field.key] = plain;
    else if (!options[field.key] && field.defaultValue) options[field.key] = field.defaultValue;
  }

  const missing = credentialFields
    .filter((field) => field.required !== false && !credentials[field.key] && !envRefs[field.key])
    .map((field) => field.label);
  if (missing.length > 0) {
    console.log(USAGE);
    console.error(`✖ 请提供：${missing.join('、')}（明文用 --${fields[0]?.key} '<值>'，或 --env VAR 引用 .env）\n`);
    process.exitCode = 1;
    return;
  }

  const dryRun = has('dry-run');
  console.log(`\n① 验证凭证（真实调用 ${adapter.displayName} 接口）…`);
  const result = await addManagedAccount({
    provider,
    credentials,
    envRefs,
    options,
    name: flag('name') ?? undefined,
    force: has('force'),
    dryRun,
  });

  if (!result.ok) {
    // 重复添加不是错误，只是一次「什么都不做」的提醒
    console.log(`\n${result.stage === 'duplicate' ? '' : '✖ '}${result.error}\n`);
    process.exitCode = result.stage === 'duplicate' ? 0 : 1;
    return;
  }

  const snapshot = result.snapshot;
  console.log(`  状态      ${snapshot.status}`);
  if (snapshot.balance) {
    console.log(
      `  可用额度  ${snapshot.balance.amount.toLocaleString('en-US')} ${snapshot.balance.currency}`,
    );
  }
  if (snapshot.note) console.log(`  说明      ${snapshot.note.split('；')[0]}`);
  const optionText = Object.entries(result.options)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');

  if (result.dryRun) {
    console.log('\n[dry-run] 验证通过，未写入文件。');
    console.log(`  将写入 .env        : ${result.envRefs.join(' / ') || '(引用已有变量，不改 .env)'}`);
    console.log(
      `  将写入 accounts.json: ${result.name}${optionText ? `（options: ${optionText}）` : ''}\n`,
    );
    return;
  }

  console.log(`\n✔ 已添加账号「${result.name}」`);
  console.log(`  .env            ${result.envRefs.join(' / ') || '(引用已有变量，未改动)'}`);
  console.log(
    `  accounts.json   已追加一条账号（凭证以 \${VAR} 引用，不留明文）` +
      (optionText ? `，options: ${optionText}` : ''),
  );
  console.log(`  改动前备份      ${result.backupDir}`);
  console.log('\n服务会监听文件变化自动热加载，刷新 http://127.0.0.1:48213 即可看到。\n');
}

main().catch((error: unknown) => {
  console.error(`\n✖ ${(error as Error).message}\n`);
  process.exitCode = 1;
});
