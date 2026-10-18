import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { buildPayload, type AggregateSettings } from './aggregate.js';
import {
  loadConfig,
  loadDotEnv,
  resolveDotEnvPath,
  type AccountConfig,
  type LoadConfigResult,
} from './config.js';
import { TtlCache } from './lib/cache.js';
import { describeSecrets, type ProbeContext, type ProviderAdapter } from './providers/base.js';
import { resolveAdapter } from './providers/index.js';
import type { ProviderSnapshot } from './types.js';
import { OK_STATUSES } from './types.js';
import { UsageHistory } from './usage-history.js';
import { summarizeLedger, type UsageLedger } from './usage-ledger.js';

export interface RefreshOutcome {
  payload: ReturnType<typeof buildPayload>;
  warnings: string[];
  missingEnvVars: string[];
}

const MAX_CONCURRENCY = 6;

/** `.env` 写入串行队列：令牌刷新可能并发发生，避免两次读改写互相覆盖 */
let envWriteChain: Promise<void> = Promise.resolve();

function enqueueEnvWrite(task: () => void): Promise<void> {
  const next = envWriteChain.then(task, task);
  // 链上保留一个已 settle 的 Promise，失败不让后续写入被跳过
  envWriteChain = next.catch(() => {});
  return next;
}

/** 就地覆盖 `.env` 里的若干变量（不新增文件头，只改/追加行） */
function writeEnvValues(entries: Map<string, string>): void {
  const path = resolveDotEnvPath();
  const existed = existsSync(path);
  const lines = (existed ? readFileSync(path, 'utf8') : '').split(/\r?\n/);
  for (const [key, value] of entries) {
    const index = lines.findIndex((line) => {
      const eq = line.indexOf('=');
      return eq > 0 && line.slice(0, eq).trim() === key;
    });
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`, existed ? {} : { mode: 0o600 });
}

/**
 * 把令牌刷新结果写回 `.env` 并让进程立刻用上新值。
 *
 * 只写「该账号当前凭证确实引用着的变量」：`accounts.json` 里存的是 `${VAR}`，
 * 若账号是明文直填（没有引用），刷新结果无处可写，直接跳过——
 * 这比悄悄改 `accounts.json` 更安全（后者会动到用户手写的配置）。
 *
 * 注意：适配器的 `patch` 用的是**凭证键**（`accessToken` / `refreshToken`），
 * 而条目里的引用可能是历史槽位名（如 `CODEBUDDY_ACCESS_TOKEN_2`），
 * 所以必须按 key 反查引用，不能直接用 `envNameFor()` 拼名字。
 */
async function persistRefreshedCredentials(
  account: AccountConfig,
  patch: Record<string, string>,
): Promise<void> {
  const names = new Map<string, string>();
  let entryCredentials: Record<string, unknown> = {};
  try {
    const filePath = loadConfig().config.accountsFilePath;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const list = Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? ((parsed as { accounts: unknown[] }).accounts as unknown[])
      : [];
    const entry = list.find((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return (
        String(record.provider ?? '').trim() === account.provider &&
        String(record.displayName ?? '') === (account.displayName ?? '')
      );
    }) as Record<string, unknown> | undefined;
    entryCredentials = (entry?.credentials ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      const raw = entryCredentials[key];
      const match = typeof raw === 'string' ? /^\$\{([A-Za-z0-9_]+)\}$/.exec(raw.trim()) : null;
      if (match?.[1]) names.set(key, match[1]);
    }
  } catch {
    return;
  }

  const entries = new Map<string, string>();
  for (const [key, name] of names) {
    const value = patch[key];
    if (typeof value === 'string' && value.trim()) entries.set(name, value.trim());
  }
  // 明文直填的账号没有 `${VAR}` 可写：跳过（不改用户手写的 accounts.json）
  if (entries.size === 0) return;

  await enqueueEnvWrite(() => {
    writeEnvValues(entries);
    // 让当前进程立即拿到新值；下一次 ensureConfigFresh 会因 mtime 变化重载配置
    loadDotEnv();
  });
}

/** 卡片上展示的额度：优先账户余额，无余额时退回剩余批次之和（与前端 balanceFor() 同口径） */
function displayedAmount(snapshot: ProviderSnapshot): number {
  if (snapshot.balance) return snapshot.balance.amount;
  return snapshot.credits.reduce((sum, lot) => sum + lot.amount, 0);
}

/**
 * 账号的取数键：`provider#displayName`（缓存、上一次成功值、本地用量采样共用它）。
 *
 * 同一平台下 displayName 是账号的稳定标识，正常情况下唯一。真出现重名
 * （含都未写 displayName）时追加出现序号——loadConfig 已经会针对重名告警，
 * 但配置错误不该表现为「两个账号显示同一份额度」这种静默串号。
 */
function accountKeys(accounts: AccountConfig[]): string[] {
  const bases = accounts.map((account) => `${account.provider}#${account.displayName ?? ''}`);
  const totals = new Map<string, number>();
  for (const base of bases) totals.set(base, (totals.get(base) ?? 0) + 1);

  const seen = new Map<string, number>();
  return bases.map((base) => {
    if ((totals.get(base) ?? 1) < 2) return base;
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    return `${base}#${index}`;
  });
}

/**
 * 看板编排层：
 *   - 按 accounts.json 逐平台并发探测，单平台超时不拖累整体
 *   - 结果进 TTL 缓存，前端 5 分钟轮询不会把上游打爆
 *   - 上游失败时回退到上一次成功值，并打上 stale 标记
 *   - 监听 accounts.json mtime，改完配置无需重启
 */
export class DashboardService {
  private configResult: LoadConfigResult;
  private cache: TtlCache<ProviderSnapshot>;
  private readonly lastGood = new Map<string, ProviderSnapshot>();
  /** 本地用量采样历史（.run/usage-history.json），用于日级用量/增量的兜底 */
  private readonly usage = new UsageHistory();
  /** 平台明细接口的缓存（v2）：与探测同样走 TTL，避免每次刷新都多打上游 */
  private ledgerCache: TtlCache<UsageLedger | null>;
  private accountsMtimeMs = 0;
  private dotEnvMtimeMs = 0;

  constructor() {
    this.configResult = loadConfig();
    this.cache = new TtlCache<ProviderSnapshot>(
      this.configResult.config.settings.cacheTtlSeconds * 1_000,
    );
    this.ledgerCache = new TtlCache<UsageLedger | null>(
      this.configResult.config.settings.cacheTtlSeconds * 1_000,
    );
    this.accountsMtimeMs = this.readMtime();
    this.dotEnvMtimeMs = this.readDotEnvMtime();
  }

  get settings(): AggregateSettings {
    const { cacheTtlSeconds, expiryCriticalDays, expiryWarningDays } = this.configResult.config.settings;
    return { cacheTtlSeconds, expiryCriticalDays, expiryWarningDays };
  }

  get accounts(): AccountConfig[] {
    return this.configResult.config.accounts;
  }

  get warnings(): string[] {
    return this.configResult.warnings;
  }

  get missingEnvVars(): string[] {
    return this.configResult.missingEnvVars;
  }

  /** 手动刷新：清空缓存后重新取数 */
  async refresh(providerFilter?: string[]): Promise<RefreshOutcome> {
    this.ensureConfigFresh();
    const snapshots = await this.collect(true, providerFilter);
    return {
      payload: buildPayload(snapshots, this.settings),
      warnings: this.warnings,
      missingEnvVars: this.missingEnvVars,
    };
  }

  async getPayload(): Promise<RefreshOutcome> {
    this.ensureConfigFresh();
    const snapshots = await this.collect(false);
    return {
      payload: buildPayload(snapshots, this.settings),
      warnings: this.warnings,
      missingEnvVars: this.missingEnvVars,
    };
  }

  private async collect(
    force: boolean,
    providerFilter?: string[],
  ): Promise<ProviderSnapshot[]> {
    const enabled = this.configResult.config.accounts.filter((account) => account.enabled);
    const selected =
      providerFilter && providerFilter.length > 0
        ? enabled.filter((account) =>
            providerFilter.some(
              (name) =>
                name === account.provider ||
                name === account.displayName ||
                name.toLowerCase() === account.provider.toLowerCase(),
            ),
          )
        : enabled;

    if (selected.length === 0) return [];

    const keys = accountKeys(selected);
    const results: ProviderSnapshot[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, selected.length) },
      async () => {
        while (cursor < selected.length) {
          const index = cursor++;
          const account = selected[index];
          if (!account) continue;
          results.push(await this.probeAccount(account, keys[index] ?? '', force));
        }
      },
    );
    await Promise.all(workers);
    // 一批采样结束统一落盘一次，避免每个平台各写一遍
    this.usage.flush();
    return results;
  }

  private async probeAccount(
    account: AccountConfig,
    key: string,
    force: boolean,
  ): Promise<ProviderSnapshot> {
    const adapter = resolveAdapter(account.provider);
    const now = Date.now();
    if (!adapter) {
      return {
        provider: account.provider,
        displayName: account.displayName || account.provider,
        accountId: account.displayName ?? '',
        groupAccounts: false,
        neverExpires: false,
        manageAccounts: false,
        entries: [],
        region: 'global',
        status: 'notConfigured',
        source: 'api',
        updatedAt: new Date(now).toISOString(),
        plan: null,
        balance: null,
        credits: [],
        windows: [],
        nextExpiryAt: null,
        nextExpiryInDays: null,
        dashboardUrl: '',
        usageUrl: '',
        message: `未知平台 "${account.provider}"，请在 src/providers/index.ts 注册适配器，或改用 custom。`,
        note: null,
        secrets: [],
        stale: false,
        dailyUsage: null,
      };
    }

    const ctx: ProbeContext = {
      now,
      timeoutMs: this.configResult.config.settings.requestTimeoutMs,
      log: (message: string, extra?: Record<string, unknown>) => {
        console.log(`[${account.provider}] ${message}`, extra ? JSON.stringify(extra) : '');
      },
      // 令牌刷新后写回 .env；失败只记日志，不阻断本次取数
      persistCredentials: (patch) => persistRefreshedCredentials(account, patch),
    };

    try {
      const snapshot = await this.cache.resolve(key, () => adapter.probe(account, ctx), { force });
      if (OK_STATUSES.has(snapshot.status)) {
        this.lastGood.set(key, snapshot);
        // 本地采样兜底：采样的就是「页面即将展示的数值」，保证时间序列与卡片口径一致
        this.usage.observe(key, displayedAmount(snapshot), now);
        const ledger = await this.fetchLedger(adapter, account, key, ctx, force);
        return this.withDailyUsage(snapshot, key, now, ledger);
      }
      const previous = this.lastGood.get(key);
      if (!previous) return { ...snapshot, dailyUsage: null };
      // 保留上次成功数值，但把失败状态透出，让界面能提示「数据可能已过期」
      return {
        ...previous,
        status: snapshot.status,
        message: snapshot.message,
        stale: true,
        // 失败卡片不展示日级用量（与界面「失败卡片只显示原因」的现状一致）
        dailyUsage: null,
      };
    } catch (error) {
      const previous = this.lastGood.get(key);
      const message = (error as Error).message;
      if (previous) {
        return { ...previous, status: 'error', message, stale: true, dailyUsage: null };
      }
      return {
        provider: account.provider,
        displayName: adapter.groupAccounts
          ? adapter.displayName
          : account.displayName || adapter.displayName,
        accountId: account.displayName ?? '',
        groupAccounts: adapter.groupAccounts === true,
        neverExpires: adapter.neverExpires === true,
        manageAccounts: adapter.manageAccounts === true,
        entries: [],
        region: adapter.region,
        status: 'error',
        source: 'api',
        updatedAt: new Date(now).toISOString(),
        plan: null,
        balance: null,
        credits: [],
        windows: [],
        nextExpiryAt: null,
        nextExpiryInDays: null,
        dashboardUrl: adapter.dashboardUrl,
        usageUrl: adapter.usageUrl,
        message,
        note: null,
        // 探测抛异常时仍要能复制密钥：secrets 与取数结果解耦
        secrets: describeSecrets(adapter, account),
        stale: false,
        dailyUsage: null,
      };
    }
  }

  /**
   * 拉取平台明细（v2）：走与探测同 TTL 的缓存，避免每次刷新都多打上游。
   * 未实现 / 失败一律返回 null，由 withDailyUsage 逐维度回退本地采样，不阻塞卡片。
   */
  private async fetchLedger(
    adapter: ProviderAdapter,
    account: AccountConfig,
    key: string,
    ctx: ProbeContext,
    force: boolean,
  ): Promise<UsageLedger | null> {
    const fetch = adapter.fetchUsageLedger;
    if (!fetch) return null;
    try {
      return await this.ledgerCache.resolve(
        key,
        async () => {
          try {
            return await fetch(account, ctx);
          } catch (error) {
            ctx.log(`用量明细获取失败，已回退本地采样：${(error as Error).message}`);
            return null;
          }
        },
        { force },
      );
    } catch {
      return null;
    }
  }

  /**
   * 组装日级四字段（v2）：明细接口覆盖的维度用上游值（该日缺记录 = 0），
   * 未覆盖 / 明细失败的维度回退本地采样，并在 sources 里如实标注来源。
   */
  private withDailyUsage(
    snapshot: ProviderSnapshot,
    key: string,
    now: number,
    ledger: UsageLedger | null,
  ): ProviderSnapshot {
    const local = this.usage.metricsFor(key, now);
    const summary = ledger ? summarizeLedger(ledger, now) : {};
    const usedUpstream = ledger?.covers.use === true;
    const addedUpstream = ledger?.covers.grant === true;
    return {
      ...snapshot,
      dailyUsage: {
        todayUsed: usedUpstream ? summary.usedToday ?? 0 : local.todayUsed,
        yesterdayUsed: usedUpstream ? summary.usedYesterday ?? 0 : local.yesterdayUsed,
        todayAdded: addedUpstream ? summary.addedToday ?? 0 : local.todayAdded,
        yesterdayAdded: addedUpstream ? summary.addedYesterday ?? 0 : local.yesterdayAdded,
        currency: snapshot.balance?.currency ?? snapshot.credits[0]?.currency ?? 'CREDITS',
        sources: {
          used: usedUpstream ? 'upstream' : 'local',
          added: addedUpstream ? 'upstream' : 'local',
        },
      },
    };
  }

  private static mtimeOf(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  private readMtime(): number {
    return DashboardService.mtimeOf(this.configResult.config.accountsFilePath);
  }

  private readDotEnvMtime(): number {
    return DashboardService.mtimeOf(resolveDotEnvPath());
  }

  /**
   * accounts.json 或 .env 被改动后自动热加载，免去重启。
   *
   * 必须同时监听 .env：`npm run capture` 刷新 Cookie 时只重写 .env，
   * 若只盯 accounts.json，长驻服务会一直拿着过期凭证，表现为
   * 「npm run probe 正常，但页面刷新无效」。
   */
  private ensureConfigFresh(): void {
    const accountsMtime = this.readMtime();
    const dotEnvMtime = this.readDotEnvMtime();
    if (accountsMtime === this.accountsMtimeMs && dotEnvMtime === this.dotEnvMtimeMs) return;

    const changed: string[] = [];
    if (accountsMtime !== this.accountsMtimeMs) changed.push('accounts.json');
    if (dotEnvMtime !== this.dotEnvMtimeMs) changed.push('.env');
    this.accountsMtimeMs = accountsMtime;
    this.dotEnvMtimeMs = dotEnvMtime;

    this.configResult = loadConfig();
    this.cache = new TtlCache<ProviderSnapshot>(
      this.configResult.config.settings.cacheTtlSeconds * 1_000,
    );
    this.ledgerCache = new TtlCache<UsageLedger | null>(
      this.configResult.config.settings.cacheTtlSeconds * 1_000,
    );
    // 配置变了说明用户期待新数据：清掉兜底值，避免用旧数字掩盖新凭证的失败
    this.lastGood.clear();
    console.log(`[config] 检测到 ${changed.join(' / ')} 变更，已重新加载配置与凭证`);
  }
}
