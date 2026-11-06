import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from './lib/json.js';

export interface AccountConfig {
  provider: string;
  enabled: boolean;
  displayName: string | null;
  /** 敏感凭证：文件里建议写 ${ENV_VAR} 形式，由 expandEnv 展开 */
  credentials: Record<string, string>;
  /** 非敏感配置，如站点、接口地址、字段映射 */
  options: Record<string, unknown>;
}

export interface AppConfig {
  server: { port: number; host: string };
  settings: {
    cacheTtlSeconds: number;
    requestTimeoutMs: number;
    expiryCriticalDays: number;
    expiryWarningDays: number;
  };
  accountsFilePath: string;
  accounts: AccountConfig[];
}

/**
 * sidecar 模式的运行选项：power-meter 作为 magpie 的伴随进程（而非独立看板站）时的开关。
 * 全部由 CLI 参数或环境变量驱动，独立看板用法（不带任何参数）行为完全不变。
 */
export interface SidecarOptions {
  /**
   * 不 serve public/ 看板静态资源（`--no-static` / `POWER_METER_NO_STATIC=1`）。
   * sidecar 下看板 UI 由 magpie GUI 渲染，这里只暴露 /api/*；`/` 返回 JSON 指引而非 404 的 HTML。
   */
  noStatic: boolean;
  /**
   * 看板静态资源根目录（`--static-dir <d>` / `POWER_METER_STATIC_DIR`）。
   *
   * 桌面版把 `public/` 打进 App 资源目录，bun 编译后的 `import.meta.url` 指向虚拟文件系统
   * 读不到真实目录，因此必须显式指定。缺省 null = 沿用 `<dist>/../public/`，浏览器/CLI 用法不变。
   */
  staticDir: string | null;
  /**
   * 访问令牌（`--token <t>` / `POWER_METER_TOKEN`）。非空时，除 /api/health 与静态资源外的
   * /api/* 请求必须带 `X-Power-Meter-Token` 头（或 `?token=` 查询）匹配，否则 401。
   * 配合既有的回环 + privilegedGuard，给跨进程调用再加一层；缺省为空 = 不启用（保持兼容）。
   */
  token: string;
  /** 解析命中的 .env 文件路径（--config-dir 重定位后的绝对路径），供启动日志展示 */
  dotEnvPath: string;
}

const DEFAULTS = {
  port: 48213,
  host: '127.0.0.1',
  cacheTtlSeconds: 300,
  requestTimeoutMs: 12_000,
  expiryCriticalDays: 5,
  expiryWarningDays: 14,
};

/** .env 的绝对路径（服务用它监听 mtime 做热加载）；--config-dir 会把基准目录从 cwd 换掉 */
let dotEnvDir = process.cwd();
export function resolveDotEnvPath(file = '.env'): string {
  return resolve(dotEnvDir, file);
}

/**
 * 解析 sidecar 相关 CLI 参数与环境变量，并就地生效配置目录重定位。
 * 必须在 loadConfig() 之前调用（loadConfig 会先跑 loadDotEnv，依赖重定位后的目录）。
 *
 * 支持：
 *   --port <n>        覆盖 PORT（0 = 让内核分配随机空闲端口，server 从 address() 回读真实端口）
 *   --host <h>        覆盖 HOST
 *   --no-static       不 serve 看板静态资源
 *   --static-dir <d>  覆盖看板静态资源根目录（桌面版把 public/ 放进 App Resources）
 *   --token <t>       启用 /api/* 访问令牌
 *   --config-dir <d>  把 .env 与 accounts.json 的默认基准目录从 cwd 换成 <d>
 *                     （显式的 ACCOUNTS_PATH 环境变量仍优先于它）
 */
export function parseSidecarOptions(argv: string[] = process.argv.slice(2)): SidecarOptions {
  const takeValue = (index: number, flag: string): string => {
    const inline = argv[index].slice(flag.length);
    if (inline) return inline;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} 需要一个值，如 ${flag} <value>`);
    }
    return next;
  };

  let noStatic = process.env.POWER_METER_NO_STATIC === '1';
  let token = process.env.POWER_METER_TOKEN ?? '';
  let staticDir: string | null = process.env.POWER_METER_STATIC_DIR
    ? resolve(process.env.POWER_METER_STATIC_DIR)
    : null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-static') {
      noStatic = true;
    } else if (arg === '--static-dir' || arg.startsWith('--static-dir=')) {
      staticDir = resolve(takeValue(i, '--static-dir='));
      if (arg === '--static-dir') i += 1;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      process.env.PORT = takeValue(i, '--port=');
      if (arg === '--port') i += 1;
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      process.env.HOST = takeValue(i, '--host=');
      if (arg === '--host') i += 1;
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      token = takeValue(i, '--token=');
      if (arg === '--token') i += 1;
    } else if (arg === '--config-dir' || arg.startsWith('--config-dir=')) {
      const dir = resolve(takeValue(i, '--config-dir='));
      if (arg === '--config-dir') i += 1;
      dotEnvDir = dir;
      // 仅当用户没有显式指定 ACCOUNTS_PATH 时，才把账号文件锚定到 config-dir；
      // 显式的 ACCOUNTS_PATH 永远优先（无论是相对还是绝对，保持原有 cwd 语义）。
      if (!process.env.ACCOUNTS_PATH) {
        process.env.ACCOUNTS_PATH = resolve(dir, 'accounts.json');
      }
    }
  }

  return { noStatic, staticDir, token, dotEnvPath: resolveDotEnvPath() };
}

/**
 * 上一次由 .env 注入进 process.env 的键值。
 *
 * 存在两个原因：
 *   1. 允许反复调用时用新值覆盖「上一次由 .env 写入的旧值」——
 *      `npm run capture` 刷新 Cookie 后，长驻服务才能拿到新凭证；
 *   2. 绝不覆盖由 shell / launchd 真正设置的进程环境变量（它们优先级更高）。
 */
const dotEnvOwned = new Map<string, string>();

/**
 * 是否已完成「首轮所有权登记」。
 *
 * Bun 会在进程启动时自动把 cwd 的 `.env` 注入 process.env（源码运行与编译后二进制均如此）。
 * 这些键此刻看起来和 shell 变量一模一样，`dotEnvOwned` 里却没有记录，于是后续重载会命中
 * `process.env[key] !== dotEnvOwned.get(key)` 而拒绝覆盖——桌面版登录刷新凭证后服务拿不到新值。
 * 首轮把「当前值与文件值一致」的键登记为 .env 所有，就把这条链路接回来了。
 * Node 下首轮这些键通常是 undefined（不会被登记），行为与修复前完全一致。
 */
let dotEnvPrimed = false;

/** 极简 .env 解析（避免引入 dotenv 依赖）；可重复调用，后一次覆盖前一次 */
export function loadDotEnv(file = '.env'): void {
  const path = resolveDotEnvPath(file);
  const next = new Map<string, string>();
  if (existsSync(path)) {
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      next.set(key, value);
    }
  }

  // ⓪ 首轮登记：Bun 预加载的 .env 值先认领，否则下面的 ② 永远判定「不是我们写的」
  if (!dotEnvPrimed) {
    dotEnvPrimed = true;
    if ((process.versions as Record<string, string | undefined>).bun) {
      for (const [key, value] of next) {
        if (process.env[key] === value) dotEnvOwned.set(key, value);
      }
    }
  }

  // ① 本次 .env 里已删除的键：如果是我们当初写进去的，就还原（避免旧凭证残留）
  for (const [key, value] of dotEnvOwned) {
    if (next.has(key)) continue;
    dotEnvOwned.delete(key);
    if (process.env[key] === value) delete process.env[key];
  }

  // ② 写入本次的值：仅当该键尚无值，或当前值正是上一次由 .env 写入的那个
  for (const [key, value] of next) {
    if (process.env[key] === undefined || process.env[key] === dotEnvOwned.get(key)) {
      process.env[key] = value;
      dotEnvOwned.set(key, value);
    }
  }
}

function envInt(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 把 ${VAR} 占位符展开为环境变量；缺失时返回空串并记录变量名 */
export function expandEnv(value: string, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved === '') {
      missing.add(name);
      return '';
    }
    return resolved;
  });
}

function expandDeep(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') return expandEnv(value, missing);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, missing));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item, missing);
    return out;
  }
  return value;
}

function toStringRecord(value: unknown, missing: Set<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    const raw = typeof item === 'string' ? item : String(item);
    const expanded = expandEnv(raw, missing).trim();
    if (expanded) out[key] = expanded;
  }
  return out;
}

export interface LoadConfigResult {
  config: AppConfig;
  /** accounts.json 里引用但环境变量缺失的变量名，用于给出可操作提示 */
  missingEnvVars: string[];
  warnings: string[];
}

export function loadConfig(): LoadConfigResult {
  loadDotEnv();
  const warnings: string[] = [];
  const missing = new Set<string>();
  const accountsFilePath = resolve(
    process.cwd(),
    process.env.ACCOUNTS_PATH || 'accounts.json',
  );

  let rawAccounts: unknown[] = [];
  if (existsSync(accountsFilePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(accountsFilePath, 'utf8'));
      const list = isRecord(parsed) ? parsed.accounts : parsed;
      if (Array.isArray(list)) rawAccounts = list;
      else warnings.push('accounts.json 结构应为数组，或 { "accounts": [...] }');
    } catch (error) {
      warnings.push(`accounts.json 解析失败：${(error as Error).message}`);
    }
  } else {
    warnings.push(
      `未找到 ${accountsFilePath}：看板里添加第一个账号时会自动创建；` +
        '想一次性带入示例配置可复制 accounts.example.json。',
    );
  }

  const accounts: AccountConfig[] = [];
  for (const raw of rawAccounts) {
    if (!isRecord(raw)) continue;
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    if (!provider) {
      warnings.push('跳过一条缺少 provider 字段的账号');
      continue;
    }
    const enabled = raw.enabled !== false;
    // 只为「已启用」的账号收集缺失变量，否则禁用掉的示例配置也会一直报缺
    const accountMissing = new Set<string>();
    const account: AccountConfig = {
      provider,
      enabled,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
      credentials: toStringRecord(raw.credentials, accountMissing),
      options: (expandDeep(raw.options, accountMissing) as Record<string, unknown>) ?? {},
    };
    if (enabled) for (const name of accountMissing) missing.add(name);
    accounts.push(account);
  }

  // 同一平台下 displayName 必须唯一：它是账号的稳定标识——缓存键、本地用量采样键、
  // /api/reveal 与删除操作的定位都靠它。重名（含都未写）会让两个账号共享同一份结果，
  // 界面上表现为「两个账号额度一模一样」，属于静默错误，所以在这里显式告警。
  const nameCounts = new Map<string, { provider: string; displayName: string; count: number }>();
  for (const account of accounts) {
    const displayName = account.displayName ?? '';
    const key = `${account.provider}\u0000${displayName}`;
    const found = nameCounts.get(key);
    if (found) found.count += 1;
    else nameCounts.set(key, { provider: account.provider, displayName, count: 1 });
  }
  for (const item of nameCounts.values()) {
    if (item.count < 2) continue;
    warnings.push(
      item.displayName
        ? `平台 ${item.provider} 下有 ${item.count} 个账号的 displayName 都是「${item.displayName}」：` +
            '它们的取数结果会互相覆盖，请分别改成不同的名字。'
        : `平台 ${item.provider} 下有 ${item.count} 个账号都没有写 displayName：` +
            '它们的取数结果会互相覆盖，请分别补上不同的 displayName。',
    );
  }

  return {
    config: {
      server: {
        port: envInt('PORT', DEFAULTS.port),
        host: process.env.HOST || DEFAULTS.host,
      },
      settings: {
        cacheTtlSeconds: envInt('CACHE_TTL_SECONDS', DEFAULTS.cacheTtlSeconds),
        requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs),
        expiryCriticalDays: envInt('EXPIRY_CRITICAL_DAYS', DEFAULTS.expiryCriticalDays),
        expiryWarningDays: envInt('EXPIRY_WARNING_DAYS', DEFAULTS.expiryWarningDays),
      },
      accountsFilePath,
      accounts,
    },
    missingEnvVars: [...missing].sort(),
    warnings,
  };
}
