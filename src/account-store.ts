/**
 * 平台无关的账号存储层：增 / 删 / 列。
 *
 * 谁用它：任何声明了 `manageAccounts: true` + `manageFields` 的适配器
 * （当前是 CodeBuddy；前端「＋ 添加账号」、HTTP `/api/accounts*`、`npm run account` 共用这一份实现）。
 *
 * 与 `src/a1etheropenai-store.ts` 的分工：
 *   - 通用逻辑（验证 → 去重 → 命名 → 分配 .env 槽位 → 备份 → 落盘）在本文件；
 *   - A1etherOpenAi 有专用语义（两把密钥分别验证、`A1etherOpenAi_<字母>_API_KEY` 槽位、
 *     项目密钥要打只读模型列表），所以它的增删仍走原实现，本文件只做**分派**。
 *
 * 三条贯穿始终的规则（与专用存储层一致）：
 *   1. **先验证再写入**：`adapter.probe()` 通过才动文件，失败原样退出、不留半截配置。
 *   2. **写入前备份**到 `.run/`（已 gitignore）。不能写 `.env.bak` 这类同目录文件
 *      ——`.env` 被忽略而 `.env.bak` 不会，那等于把凭证明文摆进 git 工作区。
 *   3. **只回显掩码**：明文只进 `.env`（权限 0600），`accounts.json` 里只写 `${VAR}` 引用，
 *      响应与日志都不出现明文。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addA1etherOpenAiAccount,
  backupBeforeWrite,
  listA1etherOpenAiAccounts,
  readAccountsFile,
  removeA1etherOpenAiAccount,
  writeAccountsFile,
} from './a1etheropenai-store.js';
import { loadConfig, loadDotEnv, resolveDotEnvPath } from './config.js';
import type { AccountConfig } from './config.js';
import { isPlaceholderAccountName, maskSecret } from './providers/base.js';
import type { ManageFieldDescriptor, ProviderAdapter } from './providers/base.js';
import { resolveAdapter } from './providers/index.js';
import type { ProviderSnapshot } from './types.js';

/** A1etherOpenAi 走专用存储层（见文件头说明），其余平台走本文件的通用实现 */
const DEDICATED_PROVIDER = 'a1etheropenai';

function envPath(): string {
  // 读路径由 loadDotEnv()/resolveDotEnvPath() 决定（会尊重 --config-dir），
  // 写路径必须与之一致：桌面版 cwd 与配置目录虽相同，但命令行 `--config-dir` 时
  // 只有统一到 resolveDotEnvPath() 才不会把新凭证写到 cwd 的另一个 .env。
  return resolveDotEnvPath();
}

/* ------------------------------------------------------------------ *
 * .env 读写
 * ------------------------------------------------------------------ */

interface EnvFile {
  lines: string[];
  /** 变量名 → 当前值（同名多行取最后一条） */
  values: Map<string, string>;
}

function readEnvFile(): EnvFile {
  const path = envPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const values = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return { lines, values };
}

/** 就地覆盖或追加若干变量行；文件不存在时以 0600 权限新建 */
function upsertEnvValues(entries: Map<string, string>): string[] {
  const path = envPath();
  const existing = existsSync(path);
  const lines = (existing ? readFileSync(path, 'utf8') : '').split(/\r?\n/);
  const written: string[] = [];

  for (const [key, value] of entries) {
    const index = lines.findIndex((line) => {
      const eq = line.indexOf('=');
      return eq > 0 && line.slice(0, eq).trim() === key;
    });
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    written.push(key);
  }

  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`, existing ? {} : { mode: 0o600 });
  return written;
}

/** 删掉若干变量行（只是「不再被引用」的那些），返回真正删掉的名字 */
function removeEnvValues(names: Set<string>): string[] {
  const path = envPath();
  if (!existsSync(path) || names.size === 0) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const removed: string[] = [];
  const kept = lines.filter((line) => {
    const eq = line.indexOf('=');
    const name = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!names.has(name)) return true;
    removed.push(name);
    return false;
  });
  if (removed.length > 0) writeFileSync(path, kept.join('\n'));
  return removed;
}

/* ------------------------------------------------------------------ *
 * 命名与槽位
 * ------------------------------------------------------------------ */

/** `provider id` → .env 变量名的默认前缀：codebuddy → CODEBUDDY */
function providerEnvPrefix(providerId: string): string {
  return providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * credentials 的键 → .env 变量名前缀（适配器可用 envNames 覆盖）。
 *
 * `options` 是该账号即将写入的 options：适配器的 `envNames` 可以是函数，
 * 按账号配置给出不同的变量名（Qoder 拆站后改用**静态对象**——站点由 provider 决定，
 * `qoder` → `QODER_COOKIE`，`qoder-intl` → `QODER_GLOBAL_COOKIE`，见 qoder.ts）。
 * 旧账号（已在 `credentials` 里写死 `${出变量}`）不经过这里，变量名不会被改动。
 */
export function envNameFor(
  adapter: ProviderAdapter,
  credentialKey: string,
  options: Record<string, string> = {},
): string {
  const names =
    typeof adapter.envNames === 'function' ? adapter.envNames(options) : adapter.envNames;
  return names?.[credentialKey] ?? `${providerEnvPrefix(adapter.id)}_${credentialKey.toUpperCase()}`;
}

/** 槽位名：1 号用无后缀名（沿用历史约定），N≥2 用 `<前缀>_N` */
function slotEnvName(base: string, slot: number): string {
  return slot <= 1 ? base : `${base}_${slot}`;
}

/** 批量槽位名：同一个账号的所有字段共用同一个槽位号 */
function slotEnvNames(bases: string[], slot: number): string[] {
  return bases.map((base) => slotEnvName(base, slot));
}

/**
 * 挑一个可用槽位：优先复用「`.env` 里存在但值为空」或「根本不存在」的变量名
 * （照着 accounts.example.json 抄下来的人会留下 `CODEBUDDY_COOKIE=` 这类空行），
 * 已存在且有值的名字跳过——它属于现有账号。
 */
function allocateSlot(bases: string[], file: EnvFile, referenced: Set<string>): number {
  const occupied = (names: string[]): boolean =>
    names.some((name) => referenced.has(name) || (file.values.get(name) ?? '') !== '');
  for (let slot = 1; slot <= 99; slot += 1) {
    if (!occupied(slotEnvNames(bases, slot))) return slot;
  }
  return 100;
}

/** 从一条 accounts.json 条目里解析出它引用的 .env 变量名（`${VAR}` 形式） */
function referencedEnvNames(item: Record<string, unknown>): string[] {
  const credentials = (item.credentials ?? {}) as Record<string, unknown>;
  const names: string[] = [];
  for (const value of Object.values(credentials)) {
    if (typeof value !== 'string') continue;
    const match = /^\$\{([A-Za-z0-9_]+)\}$/.exec(value.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** 默认展示名：`CodeBuddy · 账号 2`，撞名往后顺延 */
function defaultName(adapter: ProviderAdapter, existing: Set<string>): string {
  const base = `${adapter.displayName} · 账号`;
  for (let index = existing.size + 1; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function sameProvider(item: Record<string, unknown>, adapter: ProviderAdapter): boolean {
  return String(item.provider ?? '').trim().toLowerCase() === adapter.id;
}

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

/** 卡片管理面板里的一个账号（字段与 A1etherOpenAi 的列表视图对齐） */
export interface ManagedAccountView {
  /** 稳定标识 = accounts.json 里的 displayName（可能是空串） */
  id: string;
  label: string;
  enabled: boolean;
  /** 必需凭证是否齐全（缺了就没法取数，卡片上也不会出现） */
  complete: boolean;
  /** credentials 键 → 掩码预览 */
  previews: Record<string, string>;
  /** 引用到的 .env 变量名（明文直填的条目为空数组） */
  envRefs: string[];
  /**
   * 账号的非敏感选项，**只含适配器在 `manageFields` 里声明为 `target: 'option'` 的键**
   * （如 MiniMax 的 `site`；Qoder 拆分站点后已无此类字段）。
   *
   * 用途：前端按这些选项做展示或分组。之所以要白名单而不是整份
   * `options` 透出去：`options` 里可能有用户自定义域名之类的配置，而 `option` 字段
   * 的契约本身就是「非敏感、可展示」（见 base.ts 的 ManageFieldDescriptor）。
   */
  options: Record<string, string>;
}

export interface ListManagedResult {
  accounts: ManagedAccountView[];
  warnings: string[];
  missingEnvVars: string[];
}

/**
 * 列某平台已配置的账号。
 * 走 loadConfig() 而不是直接读文件：accounts.json 里存的是 `${VAR}`，
 * 只有展开后才能显示掩码——否则每行都是同一串占位符，等于什么都没说。
 */
export function listManagedAccounts(provider: string): ListManagedResult {
  const adapter = resolveAdapter(provider);
  if (!adapter) {
    return { accounts: [], warnings: [`未知平台「${provider}」，无法列出账号。`], missingEnvVars: [] };
  }

  if (adapter.id === DEDICATED_PROVIDER) {
    const listed = listA1etherOpenAiAccounts();
    return {
      accounts: listed.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        enabled: account.enabled,
        complete: account.complete,
        previews: { apiKey: account.apiPreview, paiApiKey: account.paiPreview },
        envRefs: account.envSuffix
          ? [`A1etherOpenAi_${account.envSuffix}_API_KEY`, `A1etherOpenAi_${account.envSuffix}_PAI_API_KEY`]
          : [],
        // 该平台没有站点之类的 option 字段，恒为空（见 declaredOptionsOf）
        options: {},
      })),
      warnings: listed.warnings,
      missingEnvVars: listed.missingEnvVars,
    };
  }

  loadDotEnv();
  const { config, warnings, missingEnvVars } = loadConfig();
  const rawRefs = new Map<string, string[]>();
  try {
    for (const item of readAccountsFile().accounts) {
      if (!sameProvider(item, adapter)) continue;
      rawRefs.set(String(item.displayName ?? ''), referencedEnvNames(item));
    }
  } catch {
    // 清单读不出来不影响掩码预览，只是少了 env 变量提示
  }

  const accounts = config.accounts
    .filter((account) => account.provider === adapter.id)
    .map((account) => ({
      id: account.displayName ?? '',
      label: account.displayName || '(未命名)',
      enabled: account.enabled,
      // 凭证齐全才算「完整」：缺一个就没法取数，卡片上也看不到它。
      // 支持多凭证形态的平台（Cookie / 登录令牌）由 isConfigured 自己判断。
      complete: adapter.isConfigured
        ? adapter.isConfigured(account)
        : adapter.requiredCredentialKeys.every((key) => Boolean(account.credentials[key])),
      previews: Object.fromEntries(
        Object.entries(account.credentials).map(([key, value]) => [key, maskSecret(value)]),
      ),
      envRefs: rawRefs.get(account.displayName ?? '') ?? [],
      // 只透出声明为 option 的键（非敏感）；前端据此把账号归到对应站点行
      options: declaredOptionsOf(adapter, account),
    }));

  return { accounts, warnings, missingEnvVars };
}

/**
 * 账号的非敏感选项白名单：`manageFields` 里 `target === 'option'` 的键。
 *
 * 看板要展示账号的非敏感选项，但整份 `options` 还可能装着用户自定义域名之类的配置，
 * 不该全下发。声明为 option 的字段本身就是「非敏感、可展示」的契约
 *（见 base.ts 的 ManageFieldDescriptor）。拆分后的 Qoder 两个平台没有 option 字段，
 * 因此返回空对象——前端不再有机会按选项值分桶。
 */
function declaredOptionsOf(
  adapter: ProviderAdapter,
  account: AccountConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of adapter.manageFields ?? []) {
    if (field.target !== 'option') continue;
    const value = account.options[field.key];
    if (typeof value === 'string' && value.trim()) out[field.key] = value.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 新增
 * ------------------------------------------------------------------ */

export interface AddManagedInput {
  provider: string;
  /** 明文凭证（看板表单 / CLI 直接粘贴）；与 envRefs 二选一 */
  credentials?: Record<string, string>;
  /** 引用 .env 里已有的变量名，如 `{ cookie: "CODEBUDDY_COOKIE_2" }`（capture --slot 之后用） */
  envRefs?: Record<string, string>;
  /**
   * 非敏感配置：适配器 manageFields 里 `target: 'option'` 的字段取值（如 Qoder 的站点 site）。
   * 直接写进 accounts.json 的 options，不落 .env、不进掩码预览。
   */
  options?: Record<string, string>;
  /** 不传则按 `平台名 · 账号 N` 自动命名 */
  name?: string;
  /** 允许「同一份凭证」重复添加（默认拒绝） */
  force?: boolean;
  /** 只验证不写入 */
  dryRun?: boolean;
  timeoutMs?: number;
}

export type AddStage = 'input' | 'verify' | 'duplicate' | 'name' | 'write';

export interface AddManagedSuccess {
  ok: true;
  provider: string;
  name: string;
  /** 写进 accounts.json 的凭证引用，如 `{ cookie: "${CODEBUDDY_COOKIE_2}" }` */
  credentials: Record<string, string>;
  /** 写进 accounts.json 的 options（option 字段的取值，如 `{ site: "global" }`） */
  options: Record<string, string>;
  envRefs: string[];
  backupDir: string | null;
  snapshot: ProviderSnapshot;
  /** 给界面/终端补一句人话（如「项目密钥可用（12 个模型）」） */
  details: string[];
  dryRun: boolean;
}

export interface AddManagedFailure {
  ok: false;
  status: number;
  stage: AddStage;
  error: string;
}

export type AddManagedResult = AddManagedSuccess | AddManagedFailure;

function fail(status: number, stage: AddStage, error: string): AddManagedFailure {
  return { ok: false, status, stage, error };
}

/**
 * 账号某个 option 字段的「有效值」：未配置时按字段默认值算，
 * 这样「同一份凭证 + 显式写了默认值」与「没写该选项」会被正确判为重复添加，
 * 而不是各建一个账号。（当前没有平台声明 `target: 'option'` 字段——Qoder 的
 * `site` 已随站点拆分移除——机制保留给日后需要的平台。）
 */
function effectiveOption(account: AccountConfig, field: ManageFieldDescriptor): string {
  const raw = account.options[field.key];
  if (raw === undefined || raw === null || raw === '') return field.defaultValue ?? '';
  return String(raw);
}

/**
 * 重复添加检查的比较口径：
 *   - 折叠空白（`.env` 读回、手工粘贴的首尾 / 换行差异不算新凭证）；
 *   - Cookie 类字段按 `;` 拆分后排序再比较——同一份 Cookie 只换个参数顺序，
 *     语义完全相同，不该被当成新账号。
 * 只用于比较，写入 `.env` 的仍是原值。
 */
function comparableCredential(key: string, value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!/cookie/i.test(key)) return normalized;
  const parts = normalized
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || !parts.every((part) => part.includes('='))) return normalized;
  return parts.sort().join('; ');
}

/**
 * 凭证字段在当前输入下是否必填。
 *
 * 默认逐字段必填（旧语义）。声明了 `pairedWith` / `flagGroup` 的字段按组判断：
 * 组内全空 → 只有锚点必填；组内有值 → 组内所有非 `required: false` 的字段都必填。
 *
 * 锚点 = 组内第一个未声明 `pairedWith` 的字段（CodeArts 的 AccessKey）。
 * 配对的 SecretKey 不是锚点，所以填了 SecretKey 不填 AccessKey 时，
 * AccessKey 仍然必填，SecretKey 则只在 AccessKey 有值时才必填。
 */
export function isFieldRequired(
  field: ManageFieldDescriptor,
  filledKeys: Set<string>,
  fields: ManageFieldDescriptor[],
): boolean {
  if (field.target === 'option') return field.required !== false;
  if (!field.flagGroup && !field.pairedWith) return field.required !== false;

  const group = field.flagGroup
    ? fields.filter((item) => item.flagGroup === field.flagGroup)
    : [field, ...fields.filter((item) => item.key === field.pairedWith)];
  const anchor = group[0].pairedWith ? undefined : group[0];
  if (anchor === field) return true;
  return group.some((item) => filledKeys.has(item.key));
}

/** 从 `credentials` / `envRefs` 里取一个字段的值（envRefs 引用 .env，需先 loadDotEnv） */
function inputValue(input: AddManagedInput, key: string): string {
  const direct = input.credentials?.[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const ref = input.envRefs?.[key];
  if (typeof ref === 'string' && ref.trim()) {
    const name = ref.trim().replace(/^\$\{|\}$/g, '');
    return (process.env[name] ?? '').trim();
  }
  return '';
}

/**
 * 新增一个账号。
 *
 * 顺序固定：解析输入 → 真实验证（probe）→ 去重 → 命名 → 分配 .env 槽位 → 备份 → 落盘。
 * 任何一步失败都在**动文件之前**返回，不留下半截配置。
 */
export async function addManagedAccount(input: AddManagedInput): Promise<AddManagedResult> {
  const adapter = resolveAdapter((input.provider ?? '').trim());
  if (!adapter) {
    return fail(404, 'input', `未知平台「${input.provider}」，请先在 src/providers/index.ts 注册适配器。`);
  }
  if (adapter.manageAccounts !== true) {
    return fail(403, 'input', `平台「${adapter.id}」未开放看板增删账号（适配器没有声明 manageAccounts）。`);
  }

  loadDotEnv();
  const timeoutMs = input.timeoutMs ?? (Number(process.env.REQUEST_TIMEOUT_MS) || 15_000);

  // ---- A1etherOpenAi：专用实现（两把密钥分别验证 + 字母槽位 + 项目密钥托管）
  if (adapter.id === DEDICATED_PROVIDER) {
    const apiKey = inputValue(input, 'apiKey');
    const paiApiKey = inputValue(input, 'paiApiKey');
    if (!apiKey || !paiApiKey) {
      return fail(400, 'input', '个人 apikey 与项目 apikey 均为必填。');
    }
    const outcome = await addA1etherOpenAiAccount({
      apiKey,
      paiKey: paiApiKey,
      name: input.name,
      force: input.force,
      dryRun: input.dryRun,
      timeoutMs,
    });
    if (!outcome.ok) {
      const stage: AddStage =
        outcome.stage === 'apiKey' || outcome.stage === 'paiKey' ? 'verify' : outcome.stage;
      return fail(outcome.status, stage, outcome.error);
    }
    return {
      ok: true,
      provider: adapter.id,
      name: outcome.name,
      credentials: {
        apiKey: `\${A1etherOpenAi_${outcome.suffix}_API_KEY}`,
        paiApiKey: `\${A1etherOpenAi_${outcome.suffix}_PAI_API_KEY}`,
      },
      options: {},
      envRefs: [
        `A1etherOpenAi_${outcome.suffix}_API_KEY`,
        `A1etherOpenAi_${outcome.suffix}_PAI_API_KEY`,
      ],
      backupDir: outcome.backupDir,
      snapshot: outcome.snapshot,
      details: [`项目密钥可用（${outcome.modelCount} 个模型）`],
      dryRun: outcome.dryRun,
    };
  }

  // ---- 通用实现：字段声明驱动
  // credential 字段 → .env + credentials；option 字段 → accounts.json 的 options（不落 .env）
  const fields: ManageFieldDescriptor[] = adapter.manageFields ?? [];
  if (fields.length === 0) {
    return fail(
      403,
      'input',
      `平台「${adapter.id}」的适配器没有声明 manageFields，无法用通用表单添加账号。`,
    );
  }
  const credentialFields = fields.filter((field) => field.target !== 'option');
  const optionFields = fields.filter((field) => field.target === 'option');
  if (credentialFields.length === 0) {
    return fail(
      403,
      'input',
      `平台「${adapter.id}」的 manageFields 里没有可写入的凭证字段（只有 option 字段）。`,
    );
  }

  const values: Record<string, string> = {};
  const refs: Record<string, string> = {};
  const optionValues: Record<string, string> = {};
  const missingFields: string[] = [];
  const missingVars: string[] = [];
  for (const field of credentialFields) {
    const direct = input.credentials?.[field.key];
    if (typeof direct === 'string' && direct.trim()) {
      values[field.key] = direct.trim();
      continue;
    }
    const ref = input.envRefs?.[field.key];
    if (typeof ref === 'string' && ref.trim()) {
      const name = ref.trim().replace(/^\$\{|\}$/g, '');
      const resolved = (process.env[name] ?? '').trim();
      if (resolved) {
        values[field.key] = resolved;
        refs[field.key] = name;
      } else {
        missingVars.push(name);
      }
      continue;
    }
    // 成组字段（CodeArts 的 AK/SK）按组判断，其余保留逐字段必填
    if (isFieldRequired(field, new Set(Object.keys(values)), credentialFields)) {
      missingFields.push(field.label);
    }
  }
  for (const field of optionFields) {
    const direct = input.options?.[field.key];
    if (typeof direct === 'string' && direct.trim()) {
      const value = direct.trim();
      if (field.choices && field.choices.length > 0 && !field.choices.includes(value)) {
        return fail(
          400,
          'input',
          `「${field.label}」取值「${value}」无效，可选：${field.choices.join(' / ')}。`,
        );
      }
      optionValues[field.key] = value;
      continue;
    }
    if (field.defaultValue) optionValues[field.key] = field.defaultValue;
    else if (field.required !== false) missingFields.push(field.label);
  }
  if (missingVars.length > 0) {
    return fail(
      400,
      'input',
      `引用的 .env 变量不存在或为空：${missingVars.join('、')}（请先写入该变量，或直接粘贴明文）。`,
    );
  }
  if (missingFields.length > 0) {
    return fail(400, 'input', `请填写：${missingFields.join('、')}。`);
  }
  // 所有凭证字段都声明为可选时（如商汤小浣熊的「Cookie 或 令牌」二选一），
  // 空表单也能通过上面的逐字段校验——这里兜一层，给出比「验证失败」更明确的提示
  if (Object.keys(values).length === 0) {
    return fail(400, 'input', `请至少填写一个凭证字段：${credentialFields.map((f) => f.label).join(' / ')}。`);
  }

  // ① 真实验证：用适配器自己的 probe（连同 option 取值，如站点），
  //    命令行 / 页面 / 接口拿到的是同一份结果
  const snapshot = await adapter.probe(
    {
      provider: adapter.id,
      enabled: true,
      displayName: null,
      credentials: values,
      options: { ...optionValues },
    },
    { now: Date.now(), timeoutMs, log: () => {} },
  );
  if (snapshot.status !== 'ok') {
    return fail(400, 'verify', `凭证验证失败（${snapshot.status}）：${snapshot.message ?? '未知原因'}`);
  }

  // ② 读清单 + 去重 + 命名
  let accountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch (error) {
    return fail(500, 'write', (error as Error).message);
  }
  const members = accountsFile.accounts.filter((item) => sameProvider(item, adapter));
  const existingNames = new Set(members.map((item) => String(item.displayName ?? '')));

  const { config } = loadConfig();
  const duplicate = config.accounts.find(
    (account: AccountConfig) =>
      account.provider === adapter.id &&
      Object.entries(values).every(
        ([key, value]) =>
          comparableCredential(key, account.credentials[key] ?? '') === comparableCredential(key, value),
      ) &&
      // option 也纳入比对：同一份 Cookie 加 cn 与 global 是两个账号，加两次 cn 才是重复
      optionFields.every(
        (field) =>
          effectiveOption(account, field) === (optionValues[field.key] ?? field.defaultValue ?? ''),
      ),
  );
  if (duplicate && !input.force) {
    return fail(
      409,
      'duplicate',
      `这份凭证已经配置过了（账号「${duplicate.displayName ?? '未命名'}」）。确实要再加一条请显式允许重复。`,
    );
  }

  const requested = (input.name ?? '').trim();
  if (requested && existingNames.has(requested)) {
    return fail(409, 'name', `已存在名为「${requested}」的账号，请换一个名字。`);
  }
  const name = requested || defaultName(adapter, existingNames);

  // ③ 槽位：明文输入的 credential 字段各自需要一个新的 .env 变量；
  //    引用已有变量的字段直接用那个变量（option 字段不占槽位）
  const plainFields = credentialFields.filter((field) => !refs[field.key]);
  // 变量前缀跟着适配器的 envNames 与本次写入的 options 走
  // （Qoder 国际站：provider = qoder-intl → QODER_GLOBAL_COOKIE）
  const bases = plainFields.map((field) => envNameFor(adapter, field.key, optionValues));
  const occupied = new Set<string>(members.flatMap((item) => referencedEnvNames(item)));
  const envFile = readEnvFile();
  const slot = bases.length > 0 ? allocateSlot(bases, envFile, occupied) : null;

  const credentialRefs: Record<string, string> = {};
  for (const field of credentialFields) {
    const ref =
      refs[field.key] ??
      (slot !== null ? slotEnvName(envNameFor(adapter, field.key, optionValues), slot) : undefined);
    // 可选字段留空时不写进 credentials，避免留下一个指向空变量的引用
    if (!ref || !values[field.key]) continue;
    credentialRefs[field.key] = `\${${ref}}`;
  }

  if (input.dryRun) {
    return {
      ok: true,
      provider: adapter.id,
      name,
      credentials: credentialRefs,
      options: optionValues,
      envRefs: Object.values(credentialRefs).map((ref) => ref.replace(/^\$\{|\}$/g, '')),
      backupDir: null,
      snapshot,
      details: [],
      dryRun: true,
    };
  }

  // ④ 落盘
  let backupDir: string;
  try {
    backupDir = backupBeforeWrite('add', adapter.id);
    if (slot !== null) {
      const entries = new Map<string, string>();
      for (const field of plainFields) {
        const value = values[field.key];
        if (!value) continue;
        entries.set(slotEnvName(envNameFor(adapter, field.key, optionValues), slot), value);
      }
      if (entries.size > 0) upsertEnvValues(entries);
    }
    accountsFile.accounts.push({
      provider: adapter.id,
      displayName: name,
      enabled: true,
      credentials: credentialRefs,
      options: optionValues,
    });
    writeAccountsFile(accountsFile);
  } catch (error) {
    return fail(500, 'write', `写入失败：${(error as Error).message}`);
  }

  return {
    ok: true,
    provider: adapter.id,
    name,
    credentials: credentialRefs,
    options: optionValues,
    envRefs: Object.values(credentialRefs).map((ref) => ref.replace(/^\$\{|\}$/g, '')),
    backupDir,
    snapshot,
    details: [],
    dryRun: false,
  };
}

/* ------------------------------------------------------------------ *
 * 登录落库（扫码 / 打开链接登录成功后调用）
 * ------------------------------------------------------------------ */

export interface LandLoginInput {
  provider: string;
  /** 平台账号身份（CodeBuddy uid / Qoder user_id / Trae UserID），用于去重 */
  accountId: string;
  /**
   * 卡片级「重新登录」指定的原账号（`accounts.json` 的 displayName）。
   * 命中即原地更新——重新登录绝不能新增卡片（原卡片可能是取数失败的失效卡）。
   */
  targetAccountId?: string;
  /** 平台昵称，用于生成默认卡片名 */
  accountName?: string;
  /** 登录产物（明文），由会话层在内存中直接传入，不经过 HTTP */
  credentials: Record<string, string>;
  /** 非敏感配置（uid / enterpriseId / domain / site / loginAccountId 等） */
  options?: Record<string, string>;
  timeoutMs?: number;
}

export interface LandLoginSuccess {
  ok: true;
  provider: string;
  /** 最终写入 accounts.json 的 displayName */
  name: string;
  /** true = 同一平台账号已存在，本次是更新；false = 新建 */
  updated: boolean;
  envRefs: string[];
  backupDir: string | null;
  snapshot: ProviderSnapshot;
}

export interface LandLoginFailure {
  ok: false;
  status: number;
  stage: 'input' | 'verify' | 'write';
  error: string;
}

export type LandLoginResult = LandLoginSuccess | LandLoginFailure;

/** 从原始 accounts.json 条目里取登录身份（非敏感，存在 options 里） */
function loginIdentityOf(item: Record<string, unknown>): string {
  const options = (item.options ?? {}) as Record<string, unknown>;
  const value = options.loginAccountId;
  return typeof value === 'string' ? value.trim() : '';
}

/** 从原始 accounts.json 条目里取登录昵称（非敏感，登录时写入 options.loginName） */
function loginNameOf(item: Record<string, unknown>): string {
  const options = (item.options ?? {}) as Record<string, unknown>;
  const value = options.loginName;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 登录落库时定位「这次登录属于哪一条已有账号」。
 *
 * 顺序：
 *   1. `targetAccountId`（卡片级「重新登录」显式指定）——最高优先级，
 *      保证原卡片原地更新，不会因为凭证指纹变化而新建；
 *   2. 平台账号身份 `loginAccountId`——弹窗里重复登录同一账号的常规路径；
 *   3. 登录昵称 `loginName`——兼容历史条目（它们的 loginAccountId 是 Cookie 指纹，
 *      每次登录都会变）。只在**唯一命中**时认，避免把两个同名账号误合并。
 *
 * 返回 undefined = 新账号。
 */
function findLoginTarget(
  members: Array<Record<string, unknown>>,
  identity: string,
  accountName: string,
  targetAccountId: string,
): Record<string, unknown> | undefined {
  if (targetAccountId) {
    const byTarget = members.filter(
      (item) => String(item.displayName ?? '') === targetAccountId,
    );
    if (byTarget.length === 1) return byTarget[0];
    // 目标已被改名 / 删除：退回下面按身份匹配，至少不会把新凭证挂到别的账号上
  }
  const byIdentity = identity
    ? members.find((item) => loginIdentityOf(item) === identity)
    : undefined;
  if (byIdentity) return byIdentity;
  if (accountName) {
    const byName = members.filter((item) => loginNameOf(item) === accountName);
    if (byName.length === 1) return byName[0];
  }
  return undefined;
}

/**
 * 是否是「登录账号」占位名（判定在 `base.ts`，探测与落库共用）。
 *
 * 平台改名后（如 Qoder 拆成「国内版 / 国际版」），旧条目的占位名仍带老前缀，
 * 因此适配器声明的 `legacyDisplayNames` 也要认，否则这些账号永远等不到自动补昵称。
 */
function isPlaceholderLoginName(adapter: ProviderAdapter, name: string): boolean {
  return [adapter.displayName, ...(adapter.legacyDisplayNames ?? [])].some((displayName) =>
    isPlaceholderAccountName(displayName, name),
  );
}

/** 在「同平台已有名字」集合里挑一个不撞名的 `平台 · 昵称`（撞名追加序号） */
function uniqueAccountName(
  adapter: ProviderAdapter,
  accountName: string,
  taken: Set<string>,
): string {
  const base = accountName
    ? `${adapter.displayName} · ${accountName}`
    : `${adapter.displayName} · 登录账号`;
  let name = base;
  for (let index = 2; taken.has(name) && index < 1000; index += 1) {
    name = `${base} ${index}`;
  }
  return name;
}

/**
 * 探测阶段解析到昵称后，把通用占位名改成「平台 · 昵称」并写回 accounts.json。
 *
 * 由编排层通过 `ProbeContext.persistAccountName` 注入：
 *   - 只处理当前仍是占位名的条目（见 `isPlaceholderLoginName`），自定义名不动；
 *   - 返回最终展示名供本轮快照使用；不需要改或写盘失败时返回 null；
 *   - 写入前备份到 `.run/`，只改 `displayName` 与 `options.loginName` 两个字段。
 */
export function adoptResolvedAccountName(
  provider: string,
  currentName: string,
  resolvedName: string,
): string | null {
  const adapter = resolveAdapter(provider);
  const next = resolvedName.trim();
  if (!adapter || !next) return null;
  if (!isPlaceholderLoginName(adapter, currentName)) return null;

  let accountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch {
    return null;
  }
  const members = accountsFile.accounts.filter((item) => sameProvider(item, adapter));
  const target = members.find((item) => String(item.displayName ?? '') === currentName);
  if (!target) return null;

  const taken = new Set(members.map((item) => String(item.displayName ?? '')));
  taken.delete(currentName);
  const name = uniqueAccountName(adapter, next, taken);

  try {
    backupBeforeWrite('login-name', adapter.id);
    target.displayName = name;
    target.options = { ...((target.options ?? {}) as Record<string, unknown>), loginName: next };
    writeAccountsFile(accountsFile);
  } catch {
    return null;
  }
  return name;
}

/**
 * 登录成功后落库：**同一平台账号更新原条目，否则新建**。
 *
 * 与 `addManagedAccount` 的差别只有两点：
 *   1. 凭证不是用户填的，而是登录协议产出的（可能是多把令牌）；
 *   2. 按「目标账号 → `options.loginAccountId` → 唯一登录昵称」定位原条目：
 *      同一账号重新登录只刷新令牌，不新增卡片（displayName 是卡片身份，不能变）。
 *
 * 其余规则完全一致：先 probe 验证 → 备份 → 写 `.env`（0600）→ 写 accounts.json。
 */
export async function landLoginAccount(input: LandLoginInput): Promise<LandLoginResult> {
  const adapter = resolveAdapter((input.provider ?? '').trim());
  if (!adapter) {
    return { ok: false, status: 404, stage: 'input', error: `未知平台「${input.provider}」。` };
  }
  if (!adapter.login) {
    return { ok: false, status: 403, stage: 'input', error: `平台「${adapter.id}」未声明登录能力。` };
  }
  const accountId = (input.accountId ?? '').trim();
  const targetAccountId = (input.targetAccountId ?? '').trim();
  // 卡片级重新登录可能拿不到上游账号 ID（个别平台只在页面侧有身份），
  // 只要有明确目标账号就仍可原地更新，不能因此拒绝落库。
  if (!accountId && !targetAccountId) {
    return { ok: false, status: 400, stage: 'input', error: '登录结果缺少平台账号 ID，无法落库。' };
  }

  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.credentials ?? {})) {
    if (typeof value === 'string' && value.trim()) credentials[key] = value.trim();
  }
  if (Object.keys(credentials).length === 0) {
    return { ok: false, status: 400, stage: 'input', error: '登录结果没有可用凭证。' };
  }

  loadDotEnv();
  const timeoutMs = input.timeoutMs ?? (Number(process.env.REQUEST_TIMEOUT_MS) || 15_000);
  const optionValues: Record<string, string> = { ...(input.options ?? {}) };
  // 身份为空时不要覆盖旧值：原地更新应保留原 loginAccountId
  if (accountId) optionValues.loginAccountId = accountId;
  const accountName = (input.accountName ?? '').trim();
  if (accountName) optionValues.loginName = accountName;

  // ① 真实验证：登录拿到的令牌必须先能取到数，才允许写进本机配置
  const snapshot = await adapter.probe(
    {
      provider: adapter.id,
      enabled: true,
      displayName: null,
      credentials,
      options: { ...optionValues },
    },
    { now: Date.now(), timeoutMs, log: () => {} },
  );
  if (snapshot.status !== 'ok') {
    return {
      ok: false,
      status: 400,
      stage: 'verify',
      error: `登录已成功，但凭证取数验证失败（${snapshot.status}）：${snapshot.message ?? '未知原因'}`,
    };
  }

  // ② 读清单：找同一平台账号
  let accountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch (error) {
    return { ok: false, status: 500, stage: 'write', error: (error as Error).message };
  }
  const members = accountsFile.accounts.filter((item) => sameProvider(item, adapter));
  const existing = findLoginTarget(members, accountId, accountName, targetAccountId);
  // 既没有上游身份、也没命中目标账号：这条记录以后无法去重，宁可拒绝也不写
  if (!existing && !accountId) {
    return {
      ok: false,
      status: 400,
      stage: 'input',
      error: '登录结果缺少平台账号 ID，且要更新的账号已不存在，无法落库。',
    };
  }
  const existingNames = new Set(members.map((item) => String(item.displayName ?? '')));

  const envFile = readEnvFile();
  const occupied = new Set<string>(members.flatMap((item) => referencedEnvNames(item)));
  const credentialRefs: Record<string, string> = {};
  const envWrites = new Map<string, string>();
  /** 更新后不再被任何账号引用的旧变量（登录产物替换了旧凭证形态，如 Cookie） */
  const staleEnvNames = new Set<string>();
  let slot: number | null = null;

  if (existing) {
    // 更新：优先复用该条目已经引用的变量名；新增的凭证 key 再分配槽位
    const existingRefs = referencedEnvNames(existing);
    const missingKeys: string[] = [];
    for (const [key, value] of Object.entries(credentials)) {
      const raw = ((existing.credentials ?? {}) as Record<string, unknown>)[key];
      const match = typeof raw === 'string' ? /^\$\{([A-Za-z0-9_]+)\}$/.exec(raw.trim()) : null;
      if (match?.[1]) {
        credentialRefs[key] = `\${${match[1]}}`;
        envWrites.set(match[1], value);
      } else {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      const bases = missingKeys.map((key) => envNameFor(adapter, key, optionValues));
      slot = allocateSlot(bases, envFile, new Set([...occupied, ...existingRefs]));
      for (const key of missingKeys) {
        const name = slotEnvName(envNameFor(adapter, key, optionValues), slot);
        credentialRefs[key] = `\${${name}}`;
        envWrites.set(name, credentials[key] as string);
      }
    }
    // 登录账号只保留登录产物：旧 Cookie 等引用不再写回，变量若无人再引用就清理
    const keptRefs = new Set(Object.values(credentialRefs).map((ref) => ref.replace(/^\$\{|\}$/g, '')));
    const stillReferenced = new Set(
      members
        .filter((item) => item !== existing)
        .flatMap((item) => referencedEnvNames(item)),
    );
    for (const name of existingRefs) {
      if (!keptRefs.has(name) && !stillReferenced.has(name)) staleEnvNames.add(name);
    }
  } else {
    // 新建：所有凭证共用一个槽位号；前缀跟着登录结果里的 options（如国际站 site）
    const bases = Object.keys(credentials).map((key) => envNameFor(adapter, key, optionValues));
    slot = allocateSlot(bases, envFile, occupied);
    for (const [key, value] of Object.entries(credentials)) {
      const name = slotEnvName(envNameFor(adapter, key, optionValues), slot);
      credentialRefs[key] = `\${${name}}`;
      envWrites.set(name, value);
    }
  }

  // ③ 命名：更新默认保持原名（displayName 是卡片/缓存/删除的稳定标识），
  //    例外：原名仍是「登录账号」占位名、而本次登录拿到了昵称 → 改成「平台 · 昵称」。
  //    新建按昵称生成。
  let name = existing ? String(existing.displayName ?? '') : '';
  if (!existing) {
    name = uniqueAccountName(adapter, accountName, existingNames);
  } else if (accountName && isPlaceholderLoginName(adapter, name)) {
    const taken = new Set(existingNames);
    taken.delete(name);
    name = uniqueAccountName(adapter, accountName, taken);
  }

  // ④ 落盘
  let backupDir: string;
  try {
    backupDir = backupBeforeWrite('login', adapter.id);
    if (envWrites.size > 0) upsertEnvValues(envWrites);
    if (staleEnvNames.size > 0) removeEnvValues(staleEnvNames);
    if (existing) {
      const currentOptions = (existing.options ?? {}) as Record<string, unknown>;
      // 登录产物替换整份凭证：同一账号不再混用旧 Cookie，避免探测走错分支
      existing.credentials = credentialRefs;
      existing.options = { ...currentOptions, ...optionValues };
      // 占位名被昵称取代时同步落盘（此时 name 与原名不同，见 ③）
      existing.displayName = name;
    } else {
      accountsFile.accounts.push({
        provider: adapter.id,
        displayName: name,
        enabled: true,
        credentials: credentialRefs,
        options: optionValues,
      });
    }
    writeAccountsFile(accountsFile);
  } catch (error) {
    return { ok: false, status: 500, stage: 'write', error: `写入失败：${(error as Error).message}` };
  }

  return {
    ok: true,
    provider: adapter.id,
    name,
    updated: Boolean(existing),
    envRefs: Object.values(credentialRefs).map((ref) => ref.replace(/^\$\{|\}$/g, '')),
    backupDir,
    snapshot,
  };
}

/* ------------------------------------------------------------------ *
 * 删除
 * ------------------------------------------------------------------ */

export interface RemoveManagedSuccess {
  ok: true;
  name: string;
  removedEnvLines: string[];
  backupDir: string;
}

export interface RemoveManagedFailure {
  ok: false;
  status: number;
  error: string;
}

export type RemoveManagedResult = RemoveManagedSuccess | RemoveManagedFailure;

/**
 * 删掉一个账号：移除 accounts.json 条目，并清掉不再被引用的 .env 变量。
 *
 * 「不再被引用」这个判断很关键：槽位是复用的（比如把 A1etherOpenAi 的账号
 * 全删掉后字母槽位会被后来者占用），按名字直接删变量有可能把别的账号
 * 还在用的那份凭证一起删掉。
 */
export function removeManagedAccount(provider: string, accountId: string): RemoveManagedResult {
  const adapter = resolveAdapter((provider ?? '').trim());
  if (!adapter) return { ok: false, status: 404, error: `未知平台「${provider}」，无法删除账号。` };
  if (adapter.manageAccounts !== true) {
    return { ok: false, status: 403, error: `平台「${adapter.id}」未开放看板增删账号。` };
  }

  if (adapter.id === DEDICATED_PROVIDER) {
    const outcome = removeA1etherOpenAiAccount(accountId);
    if (!outcome.ok) return { ok: false, status: outcome.status, error: outcome.error ?? '删除失败。' };
    return {
      ok: true,
      name: outcome.name ?? '',
      removedEnvLines: outcome.removedEnvLines ?? [],
      backupDir: outcome.backupDir ?? '',
    };
  }

  let accountsFile;
  try {
    accountsFile = readAccountsFile();
  } catch (error) {
    return { ok: false, status: 500, error: (error as Error).message };
  }

  const matches = accountsFile.accounts.filter(
    (item) => sameProvider(item, adapter) && String(item.displayName ?? '') === accountId,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      status: 404,
      error: `找不到 ${adapter.displayName} 账号 ${accountId ? `「${accountId}」` : '(未命名)'}。`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `有 ${matches.length} 个 ${adapter.displayName} 账号的 displayName 都是「${accountId}」，无法定位。请先把它们改成不同的名字。`,
    };
  }

  const target = matches[0] as Record<string, unknown>;
  const remaining = accountsFile.accounts.filter((item) => item !== target);
  const stillReferenced = new Set(
    remaining.filter((item) => sameProvider(item, adapter)).flatMap((item) => referencedEnvNames(item)),
  );
  const removable = new Set(
    referencedEnvNames(target).filter((name) => !stillReferenced.has(name)),
  );

  let backupDir: string;
  let removedEnvLines: string[] = [];
  try {
    backupDir = backupBeforeWrite('remove', adapter.id);
    removedEnvLines = removeEnvValues(removable);
    writeAccountsFile({ ...accountsFile, accounts: remaining });
  } catch (error) {
    return { ok: false, status: 500, error: `写入失败：${(error as Error).message}` };
  }

  return { ok: true, name: String(target.displayName ?? ''), removedEnvLines, backupDir };
}
