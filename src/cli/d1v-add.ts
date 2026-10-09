/**
 * 一条命令添加 / 查看 D1V 账号。
 *
 *   npm run d1v:add -- <账号密钥> <项目密钥> [--name "显示名"]
 *   npm run d1v:add -- --text "个人apikey：sk-xxx
 *   对应的项目apikey：yyy"
 *   npm run d1v:add -- --list
 *
 * 设计要点：
 *   1. **先验证再写入**。账号密钥拿真额度、项目密钥打 `/v1/models`，
 *      两条链路都通了才动文件。否则会把坏密钥写进 .env，
 *      然后在看板上看到一张红卡片，还得自己回头排查。
 *   2. **复用适配器**做验证而不是另写一套探测逻辑，
 *      这样命令行看到的数字与看板上的完全一致（同一个 probe）。
 *   3. .env 与 accounts.json 都是原地最小改动，注释与其它平台原样保留；
 *      服务监听两个文件的 mtime，保存即热加载，不用重启。
 *   4. 全程只输出掩码，明文只进文件、不进 stdout。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, loadDotEnv } from '../config.js';
import { d1vAdapter, normalizeApiKey } from '../providers/d1v.js';
import type { ProviderSnapshot } from '../types.js';

const ENV_PATH = resolve(process.cwd(), '.env');
const ACCOUNTS_PATH = resolve(process.cwd(), process.env.ACCOUNTS_PATH || 'accounts.json');
const PAI_MODELS_URL = 'https://pai.d1v.ai/v1/models';

const args = process.argv.slice(2);

/** 只带布尔含义的开关；其余 `--xxx` 一律视为「后面跟一个取值」 */
const BOOLEAN_FLAGS = new Set(['list', 'dry-run', 'force']);

function flag(name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

function mask(value: string): string {
  return value.length <= 12 ? '•'.repeat(value.length) : `${value.slice(0, 6)}…${value.slice(-4)}`;
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

const KEY_SHAPE = /[A-Za-z0-9_-]{24,}/g;

/**
 * 解析整段粘贴。按行的关键词判断哪把是项目密钥、哪把是账号密钥，
 * 认不出来的 token 按出现顺序补空位。
 * 关键词里「项目」优先于「个人」：`个人apikey` 与 `项目apikey` 都含 `apikey`。
 */
function parsePastedText(text: string): { apiKey: string; paiKey: string } {
  const tokens: Array<{ value: string; kind: 'pai' | 'api' | 'unknown' }> = [];
  for (const line of text.split(/\r?\n/)) {
    const found = line.match(KEY_SHAPE);
    if (!found) continue;
    const kind = /项目|project|pai/i.test(line)
      ? 'pai'
      : /个人|账号|账户|account|user|api[\s-]*key/i.test(line)
        ? 'api'
        : 'unknown';
    for (const value of found) tokens.push({ value, kind });
  }

  let apiKey = tokens.find((item) => item.kind === 'api')?.value ?? '';
  let paiKey = tokens.find((item) => item.kind === 'pai')?.value ?? '';
  for (const item of tokens) {
    if (item.kind !== 'unknown') continue;
    if (!apiKey) apiKey = item.value;
    else if (!paiKey) paiKey = item.value;
  }
  return { apiKey, paiKey };
}

interface EnvSlot {
  suffix: string;
  apiLine: number;
  paiLine: number;
  apiValue: string;
}

interface EnvFile {
  text: string;
  /** 已存在的 D1V_<X> 槽位，行号从 0 开始 */
  slots: EnvSlot[];
}

function readEnvFile(): EnvFile {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const slots = new Map<string, EnvSlot>();
  lines.forEach((line, index) => {
    const match = /^D1V_([A-Za-z0-9]+)_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!match) return;
    const [, suffix, value] = match;
    slots.set(suffix as string, {
      suffix: suffix as string,
      apiLine: index,
      paiLine: -1,
      apiValue: (value ?? '').trim(),
    });
  });
  lines.forEach((line, index) => {
    const match = /^D1V_([A-Za-z0-9]+)_PAI_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!match) return;
    const slot = slots.get(match[1] as string);
    if (slot) slot.paiLine = index;
  });
  return { text, slots: [...slots.values()] };
}

/**
 * 选一个写入位置：优先复用 .env 里「已存在但为空」的槽位
 * （照着 .env.example 抄下来的人会有 D1V_A_API_KEY= 这样的空行），
 * 没有空槽位再按 A/B/C… 往后排。
 */
function pickSlot(file: EnvFile): { suffix: string; reuse: EnvSlot | null } {
  const empty = file.slots.find((slot) => slot.apiValue === '');
  if (empty) return { suffix: empty.suffix, reuse: empty };

  const used = new Set(file.slots.map((slot) => slot.suffix));
  for (let code = 65; code <= 90; code += 1) {
    const suffix = String.fromCharCode(code);
    if (!used.has(suffix)) return { suffix, reuse: null };
  }
  let index = file.slots.length + 1;
  while (used.has(String(index))) index += 1;
  return { suffix: String(index), reuse: null };
}

/**
 * 写文件前先备份，返回备份目录。
 *
 * 备份放在 `.run/`（已在 .gitignore 里）而不是 `.env.bak` 这种同目录文件——
 * `.env` 被忽略但 `.env.bak` 不会，后者等于把凭证明文摆进 git 的工作区。
 */
function backupBeforeWrite(): string {
  const dir = resolve(process.cwd(), '.run', `d1v-add-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  for (const file of [ENV_PATH, ACCOUNTS_PATH]) {
    if (existsSync(file)) copyFileSync(file, resolve(dir, file.split('/').pop() as string));
  }
  return dir;
}

function writeEnvSlot(suffix: string, apiKey: string, paiKey: string): void {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const lines = raw.split(/\r?\n/);

  const setLine = (prefix: string, value: string): void => {
    const index = lines.findIndex((line) => line.startsWith(`${prefix}=`));
    if (index >= 0) lines[index] = `${prefix}=${value}`;
    else lines.push(`${prefix}=${value}`);
  };

  setLine(`D1V_${suffix}_API_KEY`, apiKey);
  setLine(`D1V_${suffix}_PAI_API_KEY`, paiKey);

  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  writeFileSync(ENV_PATH, text, existsSync(ENV_PATH) ? {} : { mode: 0o600 });
}

interface AccountsFile {
  accounts: Array<Record<string, unknown>>;
  comment?: unknown;
  [key: string]: unknown;
}

function readAccountsFile(): AccountsFile {
  if (!existsSync(ACCOUNTS_PATH)) {
    throw new Error(`找不到 ${ACCOUNTS_PATH}，请先 cp accounts.example.json accounts.json`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`${ACCOUNTS_PATH} 解析失败（未做任何修改）：${(error as Error).message}`);
  }
  if (Array.isArray(parsed)) return { accounts: parsed as Array<Record<string, unknown>> };
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as AccountsFile).accounts)) {
    return parsed as AccountsFile;
  }
  throw new Error(`${ACCOUNTS_PATH} 结构应为数组或 { "accounts": [...] }（未做任何修改）`);
}

/**
 * 列已配置的 D1V 账号。
 * 这里走 loadConfig() 而不是直接读文件：accounts.json 里存的是 `${D1V_A_PAI_API_KEY}`，
 * 只有展开后才能显示密钥掩码——不然列表里每行都是同一串占位符，等于什么都没说。
 */
function listD1vAccounts(): void {
  const { config, missingEnvVars } = loadConfig();
  const rows = config.accounts.filter((account) => account.provider === 'd1v');
  if (rows.length === 0) {
    console.log('\n当前没有 D1V 账号。加一个：\n  npm run d1v:add -- <账号密钥> <项目密钥>\n');
    return;
  }
  console.log(`\n已配置 ${rows.length} 个 D1V 账号（${ACCOUNTS_PATH}）：\n`);
  for (const account of rows) {
    const pai = account.credentials.paiApiKey;
    console.log(
      `  ${account.enabled ? '● 已启用' : '○ 已停用'}  ` +
        `${(account.displayName ?? '(未命名)').padEnd(24)}` +
        `项目密钥 ${pai ? mask(pai) : '(未配置)'}  ` +
        `账号密钥 ${account.credentials.apiKey ? mask(account.credentials.apiKey) : '(未配置)'}`,
    );
  }
  if (missingEnvVars.length > 0) {
    console.log(`\n  注意：以下环境变量为空，相关账号会取数失败 → ${missingEnvVars.join(', ')}`);
  }
  console.log('');
}

async function verifyPaiKey(paiKey: string, timeoutMs: number, modelsUrl: string): Promise<string> {
  const response = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${paiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
  }
  const models = (body as { data?: Array<{ id?: string }> })?.data;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('模型列表为空，密钥可能没有权限');
  }
  return `${models.length} 个可用模型`;
}

function printSnapshot(snapshot: ProviderSnapshot): void {
  const quota = snapshot.balance;
  console.log(`  状态      ${snapshot.status}`);
  console.log(`  账号      ${snapshot.plan ?? '(未取到)'}`);
  console.log(
    `  可用额度  ${quota ? `${quota.amount.toLocaleString('en-US')} ${quota.currency}` : '(无)'}`,
  );
  if (snapshot.nextExpiryAt) {
    console.log(`  最快到期  ${snapshot.nextExpiryAt.slice(0, 10)}（${snapshot.nextExpiryInDays} 天）`);
  }
  for (const lot of snapshot.credits) {
    console.log(
      `  批次      ${lot.label}  ${lot.amount} ${lot.currency}` +
        (lot.expiresAt ? `  过期 ${lot.expiresAt.slice(0, 10)}` : ''),
    );
  }
  if (snapshot.note) console.log(`  说明      ${snapshot.note.split('；')[0]}`);
}

async function main(): Promise<void> {
  if (has('list')) {
    listD1vAccounts();
    return;
  }

  const text = flag('text');
  let apiKey = flag('api') ?? flag('api-key') ?? '';
  let paiKey = flag('pai') ?? flag('pai-key') ?? '';

  if (text === null && !apiKey && !paiKey) {
    const values = positional();
    [apiKey = '', paiKey = ''] = values;
  }
  if (text !== null && text !== '') {
    const parsed = parsePastedText(text);
    apiKey = apiKey || parsed.apiKey;
    paiKey = paiKey || parsed.paiKey;
  }

  apiKey = normalizeApiKey(apiKey);
  paiKey = normalizeApiKey(paiKey);

  if (!apiKey || !paiKey) {
    console.log(`
添加一个 D1V 账号（会先验证两把密钥，通过了才写文件）：

  npm run d1v:add -- <账号密钥> <项目密钥>
  npm run d1v:add -- --text "个人apikey：sk-xxx
  对应的项目apikey：yyy"
  npm run d1v:add -- --list                  # 看已配置的账号
  npm run d1v:add -- --dry-run <账号> <项目>  # 只验证不写入

其它可选参数：
  --name "显示名"      默认用账号邮箱前缀，例如 D1V · sb4hnm
  --pai-base <URL>     项目密钥的校验地址，默认 ${PAI_MODELS_URL}
  --force              允许重复添加账号密钥（默认会拒绝）

用 .env.example 里的空槽位时不影响其它环境变量；写完后看板会自动热加载。
`);
    process.exitCode = 1;
    return;
  }

  const dryRun = has('dry-run');
  const force = has('force');
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS) || 15_000;

  console.log(`\n待添加：账号密钥 ${mask(apiKey)} / 项目密钥 ${mask(paiKey)}\n`);
  console.log('① 验证账号密钥（查额度）…');

  // 复用看板适配器：命令行与页面拿到的是同一份结果
  loadDotEnv();
  const account = {
    provider: 'd1v',
    enabled: true,
    displayName: null,
    credentials: { apiKey, paiApiKey: paiKey },
    options: {},
  };
  const snapshot = await d1vAdapter.probe(account, {
    now: Date.now(),
    timeoutMs,
    log: () => {},
  });
  printSnapshot(snapshot);
  if (snapshot.status !== 'ok') {
    throw new Error(`账号密钥验证失败（${snapshot.status}）：${snapshot.message ?? '未知原因'}`);
  }

  const paiBase = (flag('pai-base') || 'https://pai.d1v.ai/v1').replace(/\/+$/, '');
  const modelsUrl = paiBase === 'https://pai.d1v.ai/v1' ? PAI_MODELS_URL : `${paiBase}/models`;
  console.log(`\n② 验证项目密钥（${modelsUrl}）…`);
  const models = await verifyPaiKey(paiKey, timeoutMs, modelsUrl);
  console.log(`  通过，${models}`);

  // 重复检测：同一把账号密钥已经写进 .env 就不要再加一遍
  const envFile = readEnvFile();
  const duplicate = envFile.slots.find((slot) => slot.apiValue === apiKey);
  if (duplicate && !force) {
    console.log(
      `\n这把账号密钥已在 .env 中（D1V_${duplicate.suffix}_API_KEY），未做修改。\n` +
        '确实要再加一条同名账号，请加 --force。\n',
    );
    return;
  }

  const name = flag('name') || defaultName(snapshot, envFile);
  const { suffix, reuse } = pickSlot(envFile);

  if (dryRun) {
    console.log(`\n[dry-run] 验证全部通过，未写入文件。`);
    console.log(`  将写入 .env            : D1V_${suffix}_API_KEY / D1V_${suffix}_PAI_API_KEY`);
    console.log(`  将写入 ${ACCOUNTS_PATH}: ${name}\n`);
    return;
  }

  // 先读一遍 accounts.json：解析失败要在这里抛，别等 .env 写完才发现
  const accountsFile = readAccountsFile();
  const backupDir = backupBeforeWrite();

  writeEnvSlot(suffix, apiKey, paiKey);
  accountsFile.accounts.push({
    provider: 'd1v',
    displayName: name,
    enabled: true,
    credentials: {
      apiKey: `\${D1V_${suffix}_API_KEY}`,
      paiApiKey: `\${D1V_${suffix}_PAI_API_KEY}`,
    },
    options: {},
  });
  writeFileSync(ACCOUNTS_PATH, `${JSON.stringify(accountsFile, null, 2)}\n`);

  console.log(`\n✔ 已添加账号「${name}」`);
  console.log(`  .env            D1V_${suffix}_API_KEY / D1V_${suffix}_PAI_API_KEY${reuse ? '（复用了原有空槽位）' : ''}`);
  console.log(`  ${ACCOUNTS_PATH}  已追加一条 provider: "d1v"`);
  console.log(`  改动前备份      ${backupDir}`);
  console.log('\n服务会监听文件变化自动热加载，刷新 http://127.0.0.1:8787 即可看到。');
  console.log('想临时停用就把该条目的 enabled 改成 false；想删除就连同 .env 里那两行一起删掉。\n');
}

/** 默认展示名用邮箱前缀，多个账号一眼能分清；取不到就退回序号 */
function defaultName(snapshot: ProviderSnapshot, envFile: EnvFile): string {
  const email = snapshot.plan ?? '';
  const prefix = email.includes('@') ? email.split('@')[0] : email;
  if (prefix) return `D1V · ${prefix}`;
  const used = new Set(envFile.slots.map((slot) => slot.suffix));
  const letter = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].find((item) => !used.has(item)) ?? 'NEW';
  return `D1V · ${letter}`;
}

main().catch((error: unknown) => {
  console.error(`\n✖ ${(error as Error).message}\n`);
  process.exitCode = 1;
});
