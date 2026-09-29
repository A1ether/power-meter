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

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  cacheTtlSeconds: 300,
  requestTimeoutMs: 12_000,
  expiryCriticalDays: 7,
  expiryWarningDays: 30,
};

/** 极简 .env 解析（避免引入 dotenv 依赖） */
export function loadDotEnv(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
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
    if (process.env[key] === undefined) process.env[key] = value;
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
    warnings.push(`未找到 ${accountsFilePath}，请先复制 accounts.example.json`);
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
