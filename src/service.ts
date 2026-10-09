import { statSync } from 'node:fs';
import { buildPayload, type AggregateSettings } from './aggregate.js';
import {
  loadConfig,
  resolveDotEnvPath,
  type AccountConfig,
  type LoadConfigResult,
} from './config.js';
import { TtlCache } from './lib/cache.js';
import { describeSecrets } from './providers/base.js';
import { resolveAdapter } from './providers/index.js';
import type { ProviderSnapshot } from './types.js';
import { OK_STATUSES } from './types.js';

export interface RefreshOutcome {
  payload: ReturnType<typeof buildPayload>;
  warnings: string[];
  missingEnvVars: string[];
}

const MAX_CONCURRENCY = 6;

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
  private accountsMtimeMs = 0;
  private dotEnvMtimeMs = 0;

  constructor() {
    this.configResult = loadConfig();
    this.cache = new TtlCache<ProviderSnapshot>(
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

    const results: ProviderSnapshot[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, selected.length) },
      async () => {
        while (cursor < selected.length) {
          const index = cursor++;
          const account = selected[index];
          if (!account) continue;
          results.push(await this.probeAccount(account, force));
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async probeAccount(
    account: AccountConfig,
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
        message: `未知平台 "${account.provider}"，请在 src/providers/index.ts 注册适配器，或改用 custom。`,
        note: null,
        secrets: [],
        stale: false,
      };
    }

    const key = `${account.provider}#${account.displayName ?? ''}`;
    const ctx = {
      now,
      timeoutMs: this.configResult.config.settings.requestTimeoutMs,
      log: (message: string, extra?: Record<string, unknown>) => {
        console.log(`[${account.provider}] ${message}`, extra ? JSON.stringify(extra) : '');
      },
    };

    try {
      const snapshot = await this.cache.resolve(key, () => adapter.probe(account, ctx), { force });
      if (OK_STATUSES.has(snapshot.status)) {
        this.lastGood.set(key, snapshot);
        return snapshot;
      }
      const previous = this.lastGood.get(key);
      if (!previous) return snapshot;
      // 保留上次成功数值，但把失败状态透出，让界面能提示「数据可能已过期」
      return {
        ...previous,
        status: snapshot.status,
        message: snapshot.message,
        stale: true,
      };
    } catch (error) {
      const previous = this.lastGood.get(key);
      const message = (error as Error).message;
      if (previous) {
        return { ...previous, status: 'error', message, stale: true };
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
        message,
        note: null,
        // 探测抛异常时仍要能复制密钥：secrets 与取数结果解耦
        secrets: describeSecrets(adapter, account),
        stale: false,
      };
    }
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
    // 配置变了说明用户期待新数据：清掉兜底值，避免用旧数字掩盖新凭证的失败
    this.lastGood.clear();
    console.log(`[config] 检测到 ${changed.join(' / ')} 变更，已重新加载配置与凭证`);
  }
}
