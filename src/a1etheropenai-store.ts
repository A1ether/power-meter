/**
 * A1etherOpenAi 账号的本地存储层：增 / 删 / 列。
 *
 * 命令行（`src/cli/a1etheropenai-add.ts`）和 HTTP 接口（`/api/a1etheropenai/accounts`）共用这一份实现，
 * 因为这些操作是「改 .env + 改 accounts.json」两个文件的原子写，
 * 分散成两份迟早会走样（比如一边备份了、一边没备份）。
 *
 * 三条贯穿始终的规则：
 *   1. **先验证再写入**。两把密钥都通了才动文件，失败原样退出、不留半截配置。
 *   2. **写入前备份**到 `.run/`（已 gitignore）。备份不能放 `.env.bak` 这类同目录文件——
 *      `.env` 被忽略而 `.env.bak` 不会，那等于把凭证明文摆进 git 工作区。
 *   3. **只回显掩码**。明文只进文件，绝不进 API 响应、日志与终端输出。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, loadDotEnv, resolveDotEnvPath } from './config.js';
import { maskSecret } from './providers/base.js';
import { a1etheropenaiAdapter, normalizeApiKey } from './providers/a1etheropenai.js';
import type { ProviderSnapshot } from './types.js';

const PAI_DEFAULT_BASE = 'https://pai.d1v.ai/v1';
const KEY_SHAPE = /[A-Za-z0-9_-]{24,}/g;

function envPath(): string {
  // 读路径走 resolveDotEnvPath()（会尊重 --config-dir），写路径必须跟读路径一致，
  // 否则桌面版会把凭证写到 cwd 而不是配置目录。缺省仍是 cwd/.env，CLI 行为不变。
  return resolveDotEnvPath();
}

/** 账号清单路径以 loadConfig() 为准，这样 `.env` 里的 ACCOUNTS_PATH 生效 */
function accountsPath(): string {
  return loadConfig().config.accountsFilePath;
}

/* ------------------------------------------------------------------ *
 * .env 读写
 * ------------------------------------------------------------------ */

interface EnvFile {
  text: string;
  /** 已存在的 A1etherOpenAi_<X>_API_KEY 槽位，行号从 0 开始 */
  slots: Array<{ suffix: string; apiLine: number; paiLine: number; apiValue: string }>;
}

function readEnvFile(): EnvFile {
  const path = envPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const slots = new Map<string, { suffix: string; apiLine: number; paiLine: number; apiValue: string }>();

  lines.forEach((line, index) => {
    const match = /^A1etherOpenAi_([A-Za-z0-9]+)_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!match) return;
    slots.set(match[1] as string, {
      suffix: match[1] as string,
      apiLine: index,
      paiLine: -1,
      apiValue: (match[2] ?? '').trim(),
    });
  });
  lines.forEach((line, index) => {
    const match = /^A1etherOpenAi_([A-Za-z0-9]+)_PAI_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!match) return;
    const slot = slots.get(match[1] as string);
    if (slot) slot.paiLine = index;
  });

  return { text, slots: [...slots.values()] };
}

/**
 * 选一个写入位置：优先复用 `.env` 里「已存在但为空」的槽位
 * （照着 .env.example 抄下来的人会有 `A1etherOpenAi_A_API_KEY=` 这样的空行），
 * 没有空槽位再按 A/B/C… 往后排。
 */
export function pickEnvSlot(): { suffix: string; reused: boolean } {
  const file = readEnvFile();
  const empty = file.slots.find((slot) => slot.apiValue === '');
  if (empty) return { suffix: empty.suffix, reused: true };

  const used = new Set(file.slots.map((slot) => slot.suffix));
  for (let code = 65; code <= 90; code += 1) {
    const suffix = String.fromCharCode(code);
    if (!used.has(suffix)) return { suffix, reused: false };
  }
  let index = file.slots.length + 1;
  while (used.has(String(index))) index += 1;
  return { suffix: String(index), reused: false };
}

function writeEnvSlot(suffix: string, apiKey: string, paiKey: string): void {
  const path = envPath();
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = raw.split(/\r?\n/);

  const setLine = (prefix: string, value: string): void => {
    const index = lines.findIndex((line) => line.startsWith(`${prefix}=`));
    if (index >= 0) lines[index] = `${prefix}=${value}`;
    else lines.push(`${prefix}=${value}`);
  };

  setLine(`A1etherOpenAi_${suffix}_API_KEY`, apiKey);
  setLine(`A1etherOpenAi_${suffix}_PAI_API_KEY`, paiKey);

  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  writeFileSync(path, text, existsSync(path) ? {} : { mode: 0o600 });
}

/* ------------------------------------------------------------------ *
 * accounts.json 读写
 * ------------------------------------------------------------------ */

/** accounts.json 的统一读写类型：通用存储层（src/account-store.ts）也复用它 */
export interface AccountsFile {
  accounts: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function readAccountsFile(): AccountsFile {
  const path = accountsPath();
  // 首次使用没有账号文件是正常状态（看板里可以第一次添加账号就把它建出来），
  // 所以按空清单返回；写入方（writeAccountsFile）会在落盘时自动创建。
  if (!existsSync(path)) return { accounts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} 解析失败（未做任何修改）：${(error as Error).message}`);
  }
  if (Array.isArray(parsed)) return { accounts: parsed as Array<Record<string, unknown>> };
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as AccountsFile).accounts)) {
    return parsed as AccountsFile;
  }
  throw new Error(`${path} 结构应为数组或 { "accounts": [...] }（未做任何修改）`);
}

export function writeAccountsFile(file: AccountsFile): void {
  writeFileSync(accountsPath(), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * 写入前备份两个文件，返回备份目录。
 * `label` 用于区分是哪个平台的操作（通用存储层传入适配器 id）。
 */
export function backupBeforeWrite(op: string, label = 'a1etheropenai'): string {
  const dir = resolve(
    process.cwd(),
    '.run',
    `${label}-${op}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const file of [envPath(), accountsPath()]) {
    if (existsSync(file)) copyFileSync(file, resolve(dir, file.split('/').pop() as string));
  }
  return dir;
}

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

export interface A1etherOpenAiAccountView {
  /** 稳定标识 = accounts.json 里的 displayName（可能就是空串） */
  id: string;
  /** 展示名：邮箱优先，退回 displayName */
  label: string;
  enabled: boolean;
  apiPreview: string;
  paiPreview: string;
  /** 两把密钥是否都配齐了（只有 apiKey 时没法展示额度、也没法复制） */
  complete: boolean;
  /** credentials 里引用的环境变量前缀，如 `A1etherOpenAi_A`；写死明文时为 null */
  envSuffix: string | null;
}

/**
 * 列已配置的 A1etherOpenAi 账号。
 * 走 loadConfig() 而不是直接读文件：accounts.json 里存的是 `${A1etherOpenAi_A_API_KEY}`，
 * 只有展开后才能显示掩码——否则每行都是同一串占位符，等于什么都没说。
 */
export function listA1etherOpenAiAccounts(): {
  accounts: A1etherOpenAiAccountView[];
  warnings: string[];
  missingEnvVars: string[];
} {
  loadDotEnv();
  const { config, warnings, missingEnvVars } = loadConfig();

  // 环境变量前缀只能从**原始** accounts.json 里读：
  // loadConfig() 已经把 `${A1etherOpenAi_A_API_KEY}` 展开成明文了，那时正则什么都匹配不到
  const rawSuffix = new Map<string, string>();
  try {
    for (const item of readAccountsFile().accounts) {
      if (item.provider !== 'a1etheropenai') continue;
      const suffix = envSuffixOfAccount((item.credentials ?? {}) as Record<string, string>);
      if (suffix) rawSuffix.set(String(item.displayName ?? ''), suffix);
    }
  } catch {
    // 清单读不出来不影响预览，只是少了 env 前缀提示
  }

  const accounts = config.accounts
    .filter((account) => account.provider === 'a1etheropenai')
    .map((account) => {
      const api = account.credentials.apiKey ?? '';
      const pai = account.credentials.paiApiKey ?? '';
      const id = account.displayName ?? '';
      return {
        id,
        label: account.displayName || '(未命名)',
        enabled: account.enabled,
        apiPreview: api ? maskSecret(api) : '',
        paiPreview: pai ? maskSecret(pai) : '',
        complete: Boolean(api && pai),
        envSuffix: rawSuffix.get(id) ?? null,
      };
    });
  return { accounts, warnings, missingEnvVars };
}

/** 从 `{ apiKey: "${A1etherOpenAi_A_API_KEY}" }` 里解析出 `A1etherOpenAi_A`；不是占位符就返回 null */
function envSuffixOfAccount(credentials: Record<string, string>): string | null {
  const raw = credentials.apiKey ?? '';
  const match = /^\$\{A1etherOpenAi_([A-Za-z0-9]+)_API_KEY\}$/.exec(raw.trim());
  return match?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * 新增
 * ------------------------------------------------------------------ */

export interface AddInput {
  apiKey: string;
  paiKey: string;
  /** 不传则按邮箱自动命名 */
  name?: string;
  paiBase?: string;
  timeoutMs?: number;
  /** 允许「同一把账号密钥」重复添加（默认拒绝） */
  force?: boolean;
  /** 只验证不写入 */
  dryRun?: boolean;
  /** 每进入一步前回调一次，让终端 / 界面能实时反馈进度 */
  onStage?: (stage: 'apiKey' | 'paiKey') => void;
}

export interface AddSuccess {
  ok: true;
  name: string;
  suffix: string;
  reused: boolean;
  backupDir: string | null;
  snapshot: ProviderSnapshot;
  modelCount: number;
  dryRun: boolean;
}

export interface AddFailure {
  ok: false;
  /** 建议的 HTTP 状态码 */
  status: number;
  error: string;
  /** 已经完成的步骤，便于界面提示「密钥是对的，只是没写入」 */
  stage: 'apiKey' | 'paiKey' | 'duplicate' | 'write';
}

export async function addA1etherOpenAiAccount(input: AddInput): Promise<AddSuccess | AddFailure> {
  const apiKey = normalizeApiKey(input.apiKey);
  const paiKey = normalizeApiKey(input.paiKey);
  if (!apiKey || !paiKey) {
    return { ok: false, status: 400, stage: 'apiKey', error: '个人 apikey 与项目 apikey 均为必填。' };
  }

  const timeoutMs = input.timeoutMs ?? (Number(process.env.REQUEST_TIMEOUT_MS) || 15_000);
  loadDotEnv();

  // ① 账号密钥：复用看板适配器，命令行 / 页面 / 接口拿到的是同一份结果
  input.onStage?.('apiKey');
  const snapshot = await a1etheropenaiAdapter.probe(
    {
      provider: 'a1etheropenai',
      enabled: true,
      displayName: null,
      credentials: { apiKey, paiApiKey: paiKey },
      options: {},
    },
    { now: Date.now(), timeoutMs, log: () => {} },
  );
  if (snapshot.status !== 'ok') {
    // 密钥不对属于「请求里给的参数有问题」，不是服务端故障，所以统一 400；
    // 具体原因（unauthorized / 网络 / 上游 5xx）在 error 文案里带上
    return {
      ok: false,
      status: 400,
      stage: 'apiKey',
      error: `账号密钥验证失败（${snapshot.status}）：${snapshot.message ?? '未知原因'}`,
    };
  }

  // ② 项目密钥：打只读的模型列表，返回模型才算通过（不产生费用）
  input.onStage?.('paiKey');
  let modelCount = 0;
  try {
    modelCount = await verifyPaiKey(paiKey, timeoutMs, input.paiBase);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      stage: 'paiKey',
      error: `项目密钥验证失败：${(error as Error).message}`,
    };
  }

  // ③ 重复检测 & 命名。都要先读一遍现有清单
  let accountsFile: AccountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch (error) {
    return { ok: false, status: 500, stage: 'write', error: (error as Error).message };
  }
  const existingNames = new Set(
    accountsFile.accounts
      .filter((item) => item.provider === 'a1etheropenai')
      .map((item) => String(item.displayName ?? '')),
  );

  const envFile = readEnvFile();
  const duplicate = envFile.slots.find((slot) => slot.apiValue === apiKey);
  if (duplicate && !input.force) {
    return {
      ok: false,
      status: 409,
      stage: 'duplicate',
      error: `这把账号密钥已经配置过了（A1etherOpenAi_${duplicate.suffix}_API_KEY）。确实要再加一条请勾选「允许重复」。`,
    };
  }

  const requested = (input.name ?? '').trim();
  if (requested && existingNames.has(requested)) {
    return { ok: false, status: 409, stage: 'write', error: `已存在名为「${requested}」的账号，请换一个名字。` };
  }
  const name = requested || defaultName(snapshot.plan, existingNames);

  const { suffix, reused } = pickEnvSlot();

  if (input.dryRun) {
    return { ok: true, name, suffix, reused, backupDir: null, snapshot, modelCount, dryRun: true };
  }

  // ④ 落盘
  let backupDir: string;
  try {
    backupDir = backupBeforeWrite('add');
    writeEnvSlot(suffix, apiKey, paiKey);
    accountsFile.accounts.push({
      provider: 'a1etheropenai',
      displayName: name,
      enabled: true,
      credentials: {
        apiKey: `\${A1etherOpenAi_${suffix}_API_KEY}`,
        paiApiKey: `\${A1etherOpenAi_${suffix}_PAI_API_KEY}`,
      },
      options: {},
    });
    writeAccountsFile(accountsFile);
  } catch (error) {
    return { ok: false, status: 500, stage: 'write', error: `写入失败：${(error as Error).message}` };
  }

  return { ok: true, name, suffix, reused, backupDir, snapshot, modelCount, dryRun: false };
}

/**
 * 默认展示名：邮箱前缀最好认人。
 * 撞名时补 `-2`、`-3`——displayName 是账号的稳定标识（读取密钥、删除都靠它），
 * 同名会让这两个操作无法定位到唯一账号。
 */
function defaultName(email: string | null, existing: Set<string>): string {
  const prefix = email ? (email.includes('@') ? email.split('@')[0] : email) : '';
  const base = `A1etherOpenAi · ${prefix || '新账号'}`;
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function verifyPaiKey(
  paiKey: string,
  timeoutMs: number,
  paiBase?: string,
): Promise<number> {
  const base = (paiBase || PAI_DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/models`;
  const response = await fetch(url, {
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
  const models = (body as { data?: unknown })?.data;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('模型列表为空，密钥可能没有权限');
  }
  return models.length;
}

/* ------------------------------------------------------------------ *
 * 删除
 * ------------------------------------------------------------------ */

export interface RemoveResult {
  ok: boolean;
  status: number;
  name?: string;
  removedEnvLines?: string[];
  backupDir?: string;
  error?: string;
}

/**
 * 删掉一个 A1etherOpenAi 账号：移除 accounts.json 条目，并清掉不再被引用的 .env 变量。
 *
 * 「不再被引用」这个判断很关键：槽位是按字母复用的，
 * 直接按名字删变量有可能把别的账号还在用的那把钥匙一起删掉。
 */
export function removeA1etherOpenAiAccount(accountId: string): RemoveResult {
  let accountsFile: AccountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch (error) {
    return { ok: false, status: 500, error: (error as Error).message };
  }

  const matches = accountsFile.accounts.filter(
    (item) => item.provider === 'a1etheropenai' && String(item.displayName ?? '') === accountId,
  );
  if (matches.length === 0) {
    return { ok: false, status: 404, error: `找不到 A1etherOpenAi 账号 ${accountId ? `「${accountId}」` : '(未命名)'}。` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `有 ${matches.length} 个 A1etherOpenAi 账号的 displayName 都是「${accountId}」，无法定位。请先把它们改成不同的名字。`,
    };
  }

  const target = matches[0] as Record<string, unknown>;
  const credentials = (target.credentials ?? {}) as Record<string, string>;
  const suffix = envSuffixOfAccount(credentials);

  const remaining = accountsFile.accounts.filter((item) => item !== target);
  const stillReferenced = new Set(
    remaining
      .filter((item) => item.provider === 'a1etheropenai')
      .map((item) => envSuffixOfAccount((item.credentials ?? {}) as Record<string, string>))
      .filter((value): value is string => value !== null),
  );

  let backupDir: string | undefined;
  const removedEnvLines: string[] = [];
  try {
    backupDir = backupBeforeWrite('remove');
    // 槽位不再被任何账号引用时才删变量行；明文直填的条目没有槽位，自然跳过
    if (suffix && !stillReferenced.has(suffix)) {
      const path = envPath();
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      const targets = new Set([`A1etherOpenAi_${suffix}_API_KEY`, `A1etherOpenAi_${suffix}_PAI_API_KEY`]);
      const kept = lines.filter((line) => {
        const name = line.split('=')[0]?.trim() ?? '';
        if (targets.has(name)) {
          removedEnvLines.push(name);
          return false;
        }
        return true;
      });
      writeFileSync(path, kept.join('\n'));
    }
    writeAccountsFile({ ...accountsFile, accounts: remaining });
  } catch (error) {
    return { ok: false, status: 500, error: `写入失败：${(error as Error).message}` };
  }

  return {
    ok: true,
    status: 200,
    name: String(target.displayName ?? ''),
    removedEnvLines,
    backupDir,
  };
}

/** 供接口把「逗号分隔的 key 形状」解析回一组密钥；同时兼容整段粘贴 */
export function parseKeyPairText(text: string): { apiKey: string; paiKey: string } {
  const tokens: Array<{ value: string; kind: 'pai' | 'api' | 'unknown' }> = [];
  for (const line of text.split(/\r?\n/)) {
    const found = line.match(KEY_SHAPE);
    if (!found) continue;
    // 「项目」优先于「个人」：`个人apikey` 与 `项目apikey` 都含 `apikey`
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
