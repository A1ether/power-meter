import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { adoptResolvedAccountName } from './account-store.js';
import { buildPayload, type AggregateSettings } from './aggregate.js';
import {
  loadConfig,
  loadDotEnv,
  resolveDotEnvPath,
  resolveRuntimeDir,
  type AccountConfig,
  type LoadConfigResult,
} from './config.js';
import { TtlCache } from './lib/cache.js';
import { describeSecrets, type ProbeContext, type ProviderAdapter } from './providers/base.js';
import { resolveAdapter } from './providers/index.js';
import type { ProviderSnapshot, UsageSource } from './types.js';
import { OK_STATUSES } from './types.js';
import { UsageHistory } from './usage-history.js';
import { summarizeLedger, type UsageLedger } from './usage-ledger.js';

export interface RefreshOutcome {
  payload: ReturnType<typeof buildPayload>;
  warnings: string[];
  missingEnvVars: string[];
}

const MAX_CONCURRENCY = 6;

/**
 * 后台刷新任务的进度句柄。
 *
 * 非阻塞模式（`/api/summary?wait=0`）在任务进行期间反复读这里：`done/total`
 * 让界面能显示「刷新中 3/11」，`queuedForce` 保证刷新途中点「立即刷新」不会丢。
 */
interface RefreshJob {
  force: boolean;
  startedAt: number;
  total: number;
  done: number;
  queuedForce: boolean;
  promise: Promise<void>;
}

interface PersistedSnapshot {
  key: string;
  snapshot: ProviderSnapshot;
}

interface PersistedSnapshotsFile {
  version: 1;
  savedAt: number;
  snapshots: PersistedSnapshot[];
}

/** 磁盘快照路径：与 usage-history 同源锚定到运行时目录（`.run/`，已 gitignore） */
function snapshotStorePath(): string {
  return resolve(resolveRuntimeDir(), 'summary-cache.json');
}

/** 当前这批快照里最近一次成功取数的时间（占位快照不参与） */
function latestUpdatedAt(snapshots: ProviderSnapshot[]): string | null {
  let latest = 0;
  for (const snapshot of snapshots) {
    if (snapshot.pending) continue;
    const ts = Date.parse(snapshot.updatedAt);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

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

/**
 * 把探测时解析出的平台昵称写回 accounts.json（仅「登录账号」占位名会被替换）。
 *
 * 与 `persistRefreshedCredentials` 的区别：这里改的是展示名而不是凭证，
 * 因此走 `account-store` 的落库函数（自带备份），避免两处各写一套 JSON 逻辑。
 * 写盘失败不阻断取数：返回 null，调用方沿用原名。
 */
async function persistResolvedName(
  account: AccountConfig,
  resolvedName: string,
): Promise<string | null> {
  try {
    const name = adoptResolvedAccountName(
      account.provider,
      account.displayName ?? '',
      resolvedName,
    );
    if (name) {
      // 留痕：改的是卡片身份，排查「卡片怎么突然改名了」时要能对上时间点与旧名字
      console.log(
        `[account] ${account.provider} 展示名自动更新：「${account.displayName ?? ''}」→「${name}」` +
          '（来源：平台 userinfo 昵称，已备份到 .run/）',
      );
    }
    return name;
  } catch (error) {
    console.log(`[account] ${account.provider} 展示名更新失败：${(error as Error).message}`);
    return null;
  }
}

/** 卡片上展示的额度：优先账户余额，无余额时退回剩余批次之和（与前端 balanceFor() 同口径） */
function displayedAmount(snapshot: ProviderSnapshot): number {
  if (snapshot.balance) return snapshot.balance.amount;
  return snapshot.credits.reduce((sum, lot) => sum + lot.amount, 0);
}

/**
 * 「今日」字段的择优：上游按天聚合 vs 本地实时观测 —— 两者是**同一个量**的独立观测。
 *
 * 为什么不能「上游优先」：CodeArts 控制台的按天用量是**统计模型给出的总量**（不是可逐笔的
 * 扣减记录，用户 2026-10-25 指出），当天这一格明显滞后。实测（2026-10-25 01:31，本机服务）：
 * 上游「今天」= 0.01 积分，而同一时刻余额自当天首个样本起已下降 135.68 —— 于是卡片显示 ≈ 0。
 *
 * 为什么也不是「一律本地优先」：本地观测也会漏（服务没开、采样间隔里的先消耗后发放），
 * 而上游对**已结束的日子**是完整记录集。
 *
 * 取较大值：两个观测都不可能在同一个量上「多记」（不是相加，不会双计），取大既避免了
 * 把「今天还没出数」当成确定的 0，也不会低估。已结束的昨日仍以上游为准（缺记录 = 0）。
 */
function reconcileToday(
  upstream: number | undefined,
  local: number | null,
  covered: boolean,
): { value: number | null; source: UsageSource } {
  if (!covered) return { value: local, source: 'local' };
  const value = upstream ?? 0;
  if (local === null || local <= value) return { value, source: 'upstream' };
  return { value: local, source: 'mixed' };
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
  /**
   * 本轮 / 最近一次已知的账号快照（key 与缓存键一致）。
   *
   * 与 TtlCache 的区别：`live` 在**每个账号 probe 返回时立即更新**，
   * 供非阻塞接口在整批取数结束前就能把已完成的部分画出来；缓存则要等
   * `resolve()` 成功后才写入。
   */
  private readonly live = new Map<string, ProviderSnapshot>();
  /** 正在进行的后台刷新；同一时刻只允许一个，避免重复打上游 */
  private job: RefreshJob | null = null;
  /** 上一轮后台刷新结束时间：失败账号 15s 后过期，冷却 10s 防止轮询把上游打爆 */
  private refreshEndedAt = 0;
  private readonly snapshotStorePath = snapshotStorePath();

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
    // 进程重启后先用磁盘快照出画面（统一标 stale），再由后台刷新覆盖
    this.restoreSnapshots();
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

  /**
   * 后台强制刷新（签到成功后调用）。
   *
   * 走与 `/api/summary?wait=0&force=1` 同一个单任务通道：前端紧接着的强制刷新
   * 不会另起一轮上游请求，而是并入当前任务 / 排队一轮。
   */
  refreshInBackground(providerFilter?: string[]): void {
    this.ensureConfigFresh();
    this.startBackgroundRefresh(true, providerFilter);
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

  /**
   * 非阻塞取数（`/api/summary?wait=0`）：立即返回「当前已知」的聚合结果，
   * 需要刷新时把取数放到后台，由前端轮询逐平台补齐。
   *
   * 这是首屏 / 浏览器刷新 / 「立即刷新」不再长时间空白的核心：
   * HTTP 响应不再依赖上游探测完成，画面先出来，数据边取边更新。
   */
  getImmediateOutcome(options: { force?: boolean } = {}): RefreshOutcome {
    this.ensureConfigFresh();
    const selected = this.selectedAccounts();
    this.startBackgroundRefresh(options.force === true);

    const snapshots = this.immediateSnapshots(selected);
    const payload = buildPayload(snapshots, this.settings);
    const job = this.job;
    return {
      payload: {
        ...payload,
        refreshing: job !== null,
        progress: job
          ? { done: Math.min(job.done, job.total), total: job.total }
          : { done: selected.length, total: selected.length },
        dataUpdatedAt: latestUpdatedAt(snapshots),
      },
      warnings: this.warnings,
      missingEnvVars: this.missingEnvVars,
    };
  }

  private selectedAccounts(providerFilter?: string[]): AccountConfig[] {
    const enabled = this.configResult.config.accounts.filter((account) => account.enabled);
    if (!providerFilter || providerFilter.length === 0) return enabled;
    return enabled.filter((account) =>
      providerFilter.some(
        (name) =>
          name === account.provider ||
          name === account.displayName ||
          name.toLowerCase() === account.provider.toLowerCase(),
      ),
    );
  }

  private async collect(
    force: boolean,
    providerFilter?: string[],
    job: RefreshJob | null = null,
  ): Promise<ProviderSnapshot[]> {
    const selected = this.selectedAccounts(providerFilter);
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
          const result = await this.probeAccount(
            account,
            keys[index] ?? '',
            force,
            // 进度按「probe 已返回」计：用量明细稍后才会补齐，不该拖住进度条
            job ? () => { job.done += 1; } : undefined,
          );
          results.push(result);
        }
      },
    );
    await Promise.all(workers);
    // 一批采样结束统一落盘一次，避免每个平台各写一遍
    this.usage.flush();
    // 成功快照落盘：进程重启后仍能立即出画面（数据标 stale，后台会刷新）
    this.persistSnapshots();
    return results;
  }

  /**
   * 构造一次探测 / 签到用的上下文。
   *
   * 签到复用同一套凭证写回与日志口径：令牌续期仍然写回 `.env`，
   * 平台昵称仍只替换占位名。`now` 可注入，便于纯函数测试与结果落盘。
   */
  createProbeContext(account: AccountConfig, now = Date.now()): ProbeContext {
    return {
      now,
      timeoutMs: this.configResult.config.settings.requestTimeoutMs,
      log: (message: string, extra?: Record<string, unknown>) => {
        console.log(`[${account.provider}] ${message}`, extra ? JSON.stringify(extra) : '');
      },
      // 令牌刷新后写回 .env；失败只记日志，不阻断本次取数
      persistCredentials: (patch) => persistRefreshedCredentials(account, patch),
      // 平台昵称 → 展示名（只替换「登录账号」占位名）
      persistAccountName: (resolvedName) => persistResolvedName(account, resolvedName),
    };
  }

  private async probeAccount(
    account: AccountConfig,
    key: string,
    force: boolean,
    onProbed?: () => void,
  ): Promise<ProviderSnapshot> {
    const adapter = resolveAdapter(account.provider);
    const now = Date.now();
    if (!adapter) {
      const unknown: ProviderSnapshot = {
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
      this.live.set(key, unknown);
      onProbed?.();
      return unknown;
    }

    const ctx = this.createProbeContext(account, now);

    try {
      const snapshot = await this.cache.resolve(key, () => adapter.probe(account, ctx), { force });
      if (OK_STATUSES.has(snapshot.status)) {
        this.lastGood.set(key, snapshot);
        // 本地采样兜底：采样的就是「页面即将展示的数值」，保证时间序列与卡片口径一致
        this.usage.observe(key, displayedAmount(snapshot), now);
        /*
         * 先发布「余额已就绪」的中间态，再去取用量明细：
         * 明细接口是另一条上游请求（同样受 timeout 约束），不该挡住卡片余额首屏。
         * 中间态优先复用上一轮明细缓存，没有就退回本地采样。
         */
        const quick = this.withDailyUsage(
          snapshot,
          key,
          now,
          this.ledgerCache.peek(key)?.value ?? null,
        );
        this.live.set(key, quick);
        onProbed?.();

        const ledger = await this.fetchLedger(adapter, account, key, ctx, force);
        const complete = this.withDailyUsage(snapshot, key, now, ledger);
        this.live.set(key, complete);
        return complete;
      }
      const previous = this.lastGood.get(key);
      if (!previous) {
        const failed = { ...snapshot, dailyUsage: null };
        this.live.set(key, failed);
        onProbed?.();
        return failed;
      }
      // 保留上次成功数值，但把失败状态透出，让界面能提示「数据可能已过期」
      const stale = {
        ...previous,
        status: snapshot.status,
        message: snapshot.message,
        stale: true,
        // 失败卡片不展示日级用量（与界面「失败卡片只显示原因」的现状一致）
        dailyUsage: null,
      };
      this.live.set(key, stale);
      onProbed?.();
      return stale;
    } catch (error) {
      const previous = this.lastGood.get(key);
      const message = (error as Error).message;
      if (previous) {
        const stale = { ...previous, status: 'error' as const, message, stale: true, dailyUsage: null };
        this.live.set(key, stale);
        onProbed?.();
        return stale;
      }
      const failed: ProviderSnapshot = {
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
      this.live.set(key, failed);
      onProbed?.();
      return failed;
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
   * 组装日级四字段（v3）：证据与口径见 docs/fixes/用量明细-CodeArts今日用量恒为0-修复方案.md
   *   - 已结束的日子（昨日）：明细覆盖的维度用上游值（该日缺记录 = 0，是确定值）；
   *   - 进行中的当天（今日）：上游与本地观测**取较大值**（见 reconcileToday）——
   *     上游按天统计当天明显滞后（实测 0.01），本地观测（余额下降）会漏（服务没开）；
   *   - 未覆盖 / 明细失败的维度回退本地采样；
   *   - sources 逐字段标注来源，界面 tooltip 可见。
   */
  private withDailyUsage(
    snapshot: ProviderSnapshot,
    key: string,
    now: number,
    ledger: UsageLedger | null,
  ): ProviderSnapshot {
    const local = this.usage.metricsFor(key, now);
    const summary = ledger ? summarizeLedger(ledger, now) : {};
    const coversUse = ledger?.covers.use === true;
    const coversGrant = ledger?.covers.grant === true;
    const todayUsed = reconcileToday(summary.usedToday, local.todayUsed, coversUse);
    const todayAdded = reconcileToday(summary.addedToday, local.todayAdded, coversGrant);
    return {
      ...snapshot,
      dailyUsage: {
        todayUsed: todayUsed.value,
        yesterdayUsed: coversUse ? summary.usedYesterday ?? 0 : local.yesterdayUsed,
        todayAdded: todayAdded.value,
        yesterdayAdded: coversGrant ? summary.addedYesterday ?? 0 : local.yesterdayAdded,
        currency: snapshot.balance?.currency ?? snapshot.credits[0]?.currency ?? 'CREDITS',
        sources: {
          todayUsed: todayUsed.source,
          yesterdayUsed: coversUse ? 'upstream' : 'local',
          todayAdded: todayAdded.source,
          yesterdayAdded: coversGrant ? 'upstream' : 'local',
        },
      },
    };
  }

  /**
   * 启动后台刷新（同一时刻只允许一个）。
   *
   * - `force=true`：手动刷新，跳过 TTL 重新探测；
   * - 任务进行中再次请求 force：只置 `queuedForce`，当前这轮结束后再补一轮，
   *   避免两个 collect 同时打上游；
   * - 非 force：缓存全新鲜就什么都不做；刚结束的一轮有失败账号时冷却 10s
   *   （失败缓存 TTL 是 15s，冷却后才会重试），防止前端 1s 轮询把上游打爆。
   */
  private startBackgroundRefresh(force: boolean, providerFilter?: string[]): void {
    if (this.job) {
      if (force && !this.job.force) this.job.queuedForce = true;
      return;
    }
    const selected = this.selectedAccounts(providerFilter);
    if (selected.length === 0) return;
    if (!force) {
      if (this.allFresh(selected)) return;
      if (Date.now() - this.refreshEndedAt < 10_000) return;
    }

    const job: RefreshJob = {
      force,
      startedAt: Date.now(),
      total: selected.length,
      done: 0,
      queuedForce: false,
      promise: Promise.resolve(),
    };
    this.job = job;
    job.promise = this.collect(force, providerFilter, job)
      .then(() => undefined)
      .catch((error) => {
        console.log(`[refresh] 后台取数失败：${(error as Error).message}`);
      })
      .finally(() => {
        this.refreshEndedAt = Date.now();
        if (this.job === job) this.job = null;
        if (job.queuedForce) {
          job.queuedForce = false;
          // 同步接上排队中的强制刷新：中间不留「refreshing=false」的窗口，
          // 否则前端刚好在那个 tick 轮询会误以为刷新结束而停掉轮询
          this.startBackgroundRefresh(true);
        }
      });
  }

  /** 所有启用账号的缓存都在 TTL 内且拿到了值（失败缓存的 value 为 null，视为不新鲜） */
  private allFresh(selected: AccountConfig[]): boolean {
    const keys = accountKeys(selected);
    return keys.every((key) => {
      const entry = this.cache.peek(key);
      return entry !== null && !entry.expired && entry.value !== null;
    });
  }

  /**
   * 立即组装快照：已完成的进度 > TTL 缓存（含过期值的 stale 兜底）> 上次成功值。
   * 完全没有数据的账号给出 pending 占位，界面据此画「取数中」而不是空白或 0 余额。
   */
  private immediateSnapshots(selected: AccountConfig[]): ProviderSnapshot[] {
    const keys = accountKeys(selected);
    const out: ProviderSnapshot[] = [];
    const missing: number[] = [];

    selected.forEach((_account, index) => {
      const key = keys[index] ?? '';
      const cached = this.cache.peek(key);
      const known =
        this.live.get(key) ?? cached?.value ?? cached?.stale ?? this.lastGood.get(key) ?? null;
      if (known) out.push(known);
      else missing.push(index);
    });

    /*
     * 没取到的账号一律补占位快照：
     *   - 单账号平台 = 一张「取数中」卡片；
     *   - 合并平台（groupAccounts）会被聚合层并进同一张卡片，成为一行「取数中」，
     *     卡片结构与账号数保持不变，逐行补齐时不跳变。
     */
    const now = Date.now();
    for (const index of missing) {
      const account = selected[index];
      if (!account) continue;
      out.push(this.pendingSnapshot(account, now));
    }
    return out;
  }

  private pendingSnapshot(account: AccountConfig, now: number): ProviderSnapshot {
    const adapter = resolveAdapter(account.provider);
    return {
      provider: account.provider,
      displayName: adapter?.groupAccounts
        ? adapter.displayName
        : account.displayName || adapter?.displayName || account.provider,
      accountId: account.displayName ?? '',
      groupAccounts: adapter?.groupAccounts === true,
      neverExpires: adapter?.neverExpires === true,
      manageAccounts: adapter?.manageAccounts === true,
      entries: [],
      region: adapter?.region ?? 'global',
      status: 'unavailable',
      source: 'api',
      updatedAt: new Date(now).toISOString(),
      plan: null,
      balance: null,
      credits: [],
      windows: [],
      nextExpiryAt: null,
      nextExpiryInDays: null,
      dashboardUrl: adapter?.dashboardUrl ?? '',
      usageUrl: adapter?.usageUrl ?? '',
      message: '正在取数…',
      note: null,
      // 取数未完成也能复制托管密钥：secrets 与余额解耦（与 probe 异常分支同口径）
      secrets: adapter ? describeSecrets(adapter, account) : [],
      stale: false,
      pending: true,
      dailyUsage: null,
    };
  }

  /**
   * 成功快照落盘（`.run/summary-cache.json`，原子写）。
   *
   * 只存 `OK_STATUSES`：失败 / 占位快照没有复用价值，还会让下次首屏误报。
   * 文件内容只有掩码预览与额度，不含凭证明文。
   */
  private persistSnapshots(): void {
    const selected = this.selectedAccounts();
    if (selected.length === 0) return;
    const keys = accountKeys(selected);
    const snapshots: PersistedSnapshot[] = [];
    for (const key of keys) {
      const snapshot = this.live.get(key);
      if (!snapshot || snapshot.pending || !OK_STATUSES.has(snapshot.status)) continue;
      snapshots.push({ key, snapshot });
    }
    if (snapshots.length === 0) return;

    const payload: PersistedSnapshotsFile = { version: 1, savedAt: Date.now(), snapshots };
    try {
      mkdirSync(dirname(this.snapshotStorePath), { recursive: true });
      const tmp = `${this.snapshotStorePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.snapshotStorePath);
    } catch (error) {
      // 快照只是首屏加速，写盘失败不影响取数主链路
      console.log(`[cache] 快照写入失败：${(error as Error).message}`);
    }
  }

  /** 服务启动时恢复磁盘快照：只认当前配置里仍启用的账号，并统一标 stale */
  private restoreSnapshots(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.snapshotStorePath, 'utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const file = parsed as Partial<PersistedSnapshotsFile>;
    if (file.version !== 1 || !Array.isArray(file.snapshots)) return;

    const enabled = new Set(accountKeys(this.selectedAccounts()));
    for (const item of file.snapshots) {
      if (typeof item !== 'object' || item === null) continue;
      const { key, snapshot } = item as Partial<PersistedSnapshot>;
      if (typeof key !== 'string' || !enabled.has(key)) continue;
      if (!snapshot || typeof snapshot !== 'object') continue;
      if (key !== `${snapshot.provider}#${snapshot.accountId ?? ''}`) continue;
      const restored: ProviderSnapshot = { ...snapshot, pending: false, stale: true };
      this.live.set(key, restored);
      // 也当作上次成功值：这一轮失败时可以继续展示，而不是整张卡片变白
      this.lastGood.set(key, restored);
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
  /** 配置热加载：accounts.json / .env 的 mtime 变化时重建内存配置（签到状态接口也复用它） */
  ensureConfigFresh(): void {
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
    // 配置变了说明用户期待新数据：缓存必须重建，但**已知快照要留下**——
    // 否则正在进行的刷新会被中途清空，界面退回一片「取数中」。
    // 只保留新配置里仍启用的账号，并标 stale：新凭证的结果回来前，旧数值如实标「可能过期」。
    const keep = new Set(accountKeys(this.selectedAccounts()));
    for (const key of [...this.lastGood.keys()]) {
      if (!keep.has(key)) this.lastGood.delete(key);
    }
    for (const [key, snapshot] of [...this.live]) {
      if (!keep.has(key)) {
        this.live.delete(key);
        continue;
      }
      this.live.set(key, { ...snapshot, stale: true });
    }
    // 允许下一轮立即重试（否则会被 10s 冷却挡住，用户刚改完凭证却看不到刷新）
    this.refreshEndedAt = 0;
    console.log(`[config] 检测到 ${changed.join(' / ')} 变更，已重新加载配置与凭证`);
  }
}
