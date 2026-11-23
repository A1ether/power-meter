import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRuntimeDir, type AccountConfig } from './config.js';
import { resolveAdapter } from './providers/index.js';
import type {
  CheckinOutcome,
  CheckinRemoteState,
  CheckinResult,
  ProbeContext,
} from './providers/base.js';

/**
 * 每日签到的编排层。
 *
 * 职责边界：
 *   - 适配器只回答「这个账号能不能签、签一次得到什么」；
 *   - 这里负责账号定位、并发锁、结果落盘、自动定时与重试。
 *
 * 结果文件是**运行态**（`.run/checkin.json`），不写回 accounts.json / .env：
 * 签到不是账号配置，且每天都会被覆盖。
 */

export interface CheckinSettings {
  /** 是否启用自动签到（默认关闭：签到会真实打上游） */
  auto: boolean;
  /** 自动签到时间，北京时间 HH:mm */
  at: string;
}

export interface CheckinRecord {
  /** 北京时间日期 YYYY-MM-DD */
  day: string;
  /** 本次结果时间 ISO */
  at: string;
  outcome: CheckinOutcome;
  credit: number | null;
  streak: number | null;
  message: string;
  /** 当天已尝试次数（自动重试用） */
  tries: number;
}

export interface CheckinAccountState {
  provider: string;
  accountId: string;
  displayName: string;
  enabled: boolean;
  supported: boolean;
  reason: string | null;
  record: CheckinRecord | null;
  /**
   * 上游只读核对结果：本机没有今天的「已签到/已领取」记录时才会查。
   * 用于纠正「在官方客户端签到后，看板仍显示未签到」。
   */
  remote: CheckinRemoteView | null;
  /** 上游核对失败的原因（不含凭证）；仅用于诊断 */
  remoteError: string | null;
}

/** `CheckinRemoteState` 的下发形态：字段归一化 + 查询时间 */
export interface CheckinRemoteView {
  signedToday: boolean;
  credit: number | null;
  streak: number | null;
  inactive: boolean;
  message: string;
  /** 查询时间 ISO */
  at: string;
}

export interface CheckinStatus {
  settings: CheckinSettings;
  accounts: CheckinAccountState[];
  /** 正在签到的账号键（provider|accountId） */
  running: string[];
}

export interface CheckinHost {
  /** 触发热加载（accounts.json / .env 的 mtime 变化时生效） */
  ensureFresh(): void;
  /** 当前配置里的全部账号（含停用） */
  accounts(): AccountConfig[];
  /** 与探测同一套上下文的工厂 */
  context(account: AccountConfig): ProbeContext;
  /** 签到成功后刷新该平台余额（不阻塞签到响应） */
  refreshProvider(provider: string): void | Promise<void>;
}

interface CheckinFile {
  version: number;
  settings: CheckinSettings;
  accounts: Record<string, CheckinRecord>;
}

const STATE_VERSION = 1;
const DEFAULT_SETTINGS: CheckinSettings = { auto: false, at: '09:00' };
const AUTO_RETRY_COOLDOWN_MS = 30 * 60_000;
const AUTO_MAX_TRIES = 3;
const AUTO_CONCURRENCY = 2;
/**
 * 只读远程状态的缓存：签到状态变化不频繁，5 分钟足够；
 * 失败只缓存 1 分钟，避免上游临时抖动让状态长期停在「未知」。
 */
const REMOTE_STATUS_TTL_MS = 5 * 60_000;
const REMOTE_STATUS_ERROR_TTL_MS = 60_000;
const REMOTE_STATUS_CONCURRENCY = 3;
/**
 * 单次远程核对的硬上限。
 *
 * 平台的 ctx.timeoutMs 是给「探测」用的（最长十几秒），签到状态是列表页的
 * 附属信息，不该让弹窗等那么久；超时按「查不到」处理，界面回落到本地口径。
 */
const REMOTE_STATUS_TIMEOUT_MS = 5_000;
/**
 * 当天不再重试的结果。
 *
 * `inactive` 刻意**不**在此列：Qoder 的每日活动 10:00（UTC+8）才开放，
 * 若自动签到设在更早的时间，第一次会得到「当前无活动」；保留重试机会，
 * 最多 3 次 / 30 分钟冷却，避免把「还没开放」误判成「今天没有」。
 */
const SETTLED_OUTCOMES: ReadonlySet<CheckinOutcome> = new Set<CheckinOutcome>([
  'claimed',
  'done',
  'ineligible',
  'unsupported',
]);

export class CheckinError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CheckinError';
  }
}

export function checkinAccountKey(provider: string, accountId: string): string {
  return `${provider}|${accountId}`;
}

/** 北京时间日期（UTC+8），与平台「每日」口径一致 */
export function beijingDayKey(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 北京时间当天已过的分钟数 */
function beijingMinutes(now: number): number {
  const shifted = new Date(now + 8 * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function toRecord(result: CheckinResult, now: number, tries: number): CheckinRecord {
  return {
    day: beijingDayKey(now),
    at: new Date(now).toISOString(),
    outcome: result.outcome,
    credit: typeof result.credit === 'number' && Number.isFinite(result.credit) ? result.credit : null,
    streak: typeof result.streak === 'number' && Number.isFinite(result.streak) ? result.streak : null,
    message: result.message,
    tries,
  };
}

function toRemoteView(state: CheckinRemoteState, now: number): CheckinRemoteView {
  const credit =
    typeof state.credit === 'number' && Number.isFinite(state.credit) ? state.credit : null;
  const streak =
    typeof state.streak === 'number' && Number.isFinite(state.streak) ? state.streak : null;
  return {
    signedToday: state.signedToday === true,
    credit,
    streak,
    inactive: state.inactive === true,
    message: typeof state.message === 'string' ? state.message : '',
    at: new Date(now).toISOString(),
  };
}

/** 给远程核对加硬超时：超时当作「查不到」，不拖住 /api/checkin */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CheckinManager {
  private readonly filePath: string;
  private file: CheckinFile;
  private readonly inflight = new Map<string, Promise<CheckinRecord>>();
  /** 上游只读状态缓存：key 与签到记录一致（provider|accountId） */
  private readonly remoteCache = new Map<
    string,
    { at: number; view: CheckinRemoteView | null; error: string | null }
  >();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly host: CheckinHost) {
    this.filePath = resolve(resolveRuntimeDir(), 'checkin.json');
    this.file = this.load();
  }

  /**
   * 签到状态：本地结果优先；本地今天没有「已签到/已领取」时，
   * 向上游做一次只读核对（`checkin.status()`），结果放在 `remote` 里。
   */
  async status(): Promise<CheckinStatus> {
    this.host.ensureFresh();
    const accounts = this.host.accounts();
    const entries = accounts.map((account) => this.describe(account));
    await this.refreshRemoteStates(accounts, entries);
    return {
      settings: { ...this.file.settings },
      accounts: entries,
      running: [...this.inflight.keys()],
    };
  }

  updateSettings(patch: { auto?: unknown; at?: unknown }): CheckinSettings {
    const next: CheckinSettings = { ...this.file.settings };
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    if (typeof patch.at === 'string') {
      if (parseClock(patch.at) === null) {
        throw new CheckinError('签到时间格式应为 HH:mm（00:00–23:59）', 400);
      }
      next.at = patch.at.trim();
    }
    this.file.settings = next;
    this.save();
    return { ...next };
  }

  /** 手动签到单个账号。账号不存在 / 停用 / 不支持时抛出带状态码的 CheckinError。 */
  async runOne(provider: string, accountId: string): Promise<CheckinRecord> {
    this.host.ensureFresh();
    const { account, adapter } = this.resolveAccount(provider, accountId);
    if (!account.enabled) {
      throw new CheckinError(`账号 ${provider} / ${accountId || '(默认账号)'} 已停用`, 400);
    }
    const checkin = adapter.checkin;
    if (!checkin) {
      throw new CheckinError(`${adapter.displayName} 没有每日签到`, 409);
    }
    const support = this.supportOf(account);
    if (!support.ok) {
      throw new CheckinError(support.reason, 409);
    }
    return this.execute(account, provider);
  }

  /** 手动签到全部支持账号（并发 2，单账号失败不影响其它账号）。 */
  async runAll(): Promise<CheckinRecord[]> {
    this.host.ensureFresh();
    const targets: Array<{ account: AccountConfig; provider: string }> = [];
    for (const account of this.host.accounts()) {
      if (!account.enabled) continue;
      const adapter = resolveAdapter(account.provider);
      if (!adapter?.checkin) continue;
      if (!this.supportOf(account).ok) continue;
      targets.push({ account, provider: adapter.id });
    }
    return this.mapLimit(targets, AUTO_CONCURRENCY, ({ account, provider }) =>
      this.execute(account, provider),
    );
  }

  /** 启动自动签到循环：每分钟检查一次，按北京时间与结果文件决定是否执行。 */
  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.warn(`[checkin] 自动签到检查失败：${(error as Error).message}`);
      });
    }, 60_000);
    // 首次启动稍等片刻，避免与首轮余额探测同时打上游
    setTimeout(() => {
      void this.tick().catch((error: unknown) => {
        console.warn(`[checkin] 自动签到检查失败：${(error as Error).message}`);
      });
    }, 10_000).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.file.settings;
      if (!settings.auto) return;
      this.host.ensureFresh();
      const now = Date.now();
      const gate = parseClock(settings.at);
      if (gate === null || beijingMinutes(now) < gate) return;
      const day = beijingDayKey(now);

      const due: Array<{ account: AccountConfig; provider: string }> = [];
      for (const account of this.host.accounts()) {
        if (!account.enabled) continue;
        const adapter = resolveAdapter(account.provider);
        if (!adapter?.checkin) continue;
        if (!this.supportOf(account).ok) continue;
        const key = checkinAccountKey(adapter.id, account.displayName ?? '');
        const record = this.file.accounts[key];
        if (record?.day === day) {
          if (SETTLED_OUTCOMES.has(record.outcome)) continue;
          if (record.tries >= AUTO_MAX_TRIES) continue;
          if (now - Date.parse(record.at) < AUTO_RETRY_COOLDOWN_MS) continue;
        }
        due.push({ account, provider: adapter.id });
      }
      await this.mapLimit(due, AUTO_CONCURRENCY, ({ account, provider }) =>
        this.execute(account, provider),
      );
    } finally {
      this.ticking = false;
    }
  }

  private execute(account: AccountConfig, provider: string): Promise<CheckinRecord> {
    const accountId = account.displayName ?? '';
    const key = checkinAccountKey(provider, accountId);
    const running = this.inflight.get(key);
    if (running) return running;
    // 本次执行会改变上游与本地状态：旧的上游核对结果立即作废
    this.remoteCache.delete(key);

    const task = (async (): Promise<CheckinRecord> => {
      const adapter = resolveAdapter(account.provider);
      if (!adapter?.checkin) {
        throw new CheckinError(`${account.provider} 没有每日签到`, 409);
      }
      let result: CheckinResult;
      try {
        result = await adapter.checkin.run(account, this.host.context(account));
      } catch (error) {
        result = { outcome: 'failed', message: `签到失败：${(error as Error).message}` };
      }
      const now = Date.now();
      const previous = this.file.accounts[key];
      const tries = (previous?.day === beijingDayKey(now) ? previous.tries : 0) + 1;
      const record = toRecord(result, now, tries);
      this.file.accounts[key] = record;
      this.save();
      console.log(
        `[checkin] ${provider}#${accountId || '(默认账号)'} → ${record.outcome}` +
          (record.credit !== null ? ` +${record.credit}` : '') +
          (record.message ? `（${record.message}）` : ''),
      );

      // 签到成功后余额会变：后台刷新该平台，不阻塞本次响应
      if (record.outcome === 'claimed') {
        void Promise.resolve()
          // 用账号自己的 provider 字符串过滤：accounts.json 可能写的是别名（qoder-cn 等），
          // 而 service 的筛选按账号原始 provider 匹配
          .then(() => this.host.refreshProvider(account.provider))
          .catch((error: unknown) => {
            console.warn(`[checkin] ${provider} 签到后刷新失败：${(error as Error).message}`);
          });
      }
      return record;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, task);
    return task;
  }

  private describe(account: AccountConfig): CheckinAccountState {
    const adapter = resolveAdapter(account.provider);
    const accountId = account.displayName ?? '';
    const provider = adapter?.id ?? account.provider;
    const support = this.supportOf(account);
    return {
      provider,
      accountId,
      displayName: adapter?.displayName ?? account.provider,
      enabled: account.enabled,
      supported: support.ok,
      reason: support.ok ? null : support.reason,
      record: this.file.accounts[checkinAccountKey(provider, accountId)] ?? null,
      remote: null,
      remoteError: null,
    };
  }

  /**
   * 本地今天没有「已签到/已领取」记录时，向上游只读核对一次。
   *
   * - 只对启用且支持、且适配器声明了 `status()` 的账号发起；
   * - 结果按账号缓存（成功 5 分钟 / 失败 1 分钟），避免每次打开弹窗都打上游；
   * - 上游失败只记 `remoteError`，**不**改变本地口径（查不到 ≠ 未签到）。
   */
  private async refreshRemoteStates(
    accounts: AccountConfig[],
    entries: CheckinAccountState[],
  ): Promise<void> {
    const now = Date.now();
    const day = beijingDayKey(now);
    const queue: Array<{
      entry: CheckinAccountState;
      account: AccountConfig;
      key: string;
      status: (account: AccountConfig, ctx: ProbeContext) => Promise<CheckinRemoteState>;
    }> = [];

    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index] as AccountConfig;
      const entry = entries[index] as CheckinAccountState;
      if (!account.enabled || !entry.supported) continue;
      // 本地已经确认今天签过（claimed/done），不再打上游；
      // 其它结果（failed / ineligible / inactive）仍要核对，可能在别处已经签了
      if (
        entry.record?.day === day &&
        (entry.record.outcome === 'claimed' || entry.record.outcome === 'done')
      ) {
        continue;
      }
      const adapter = resolveAdapter(account.provider);
      const status = adapter?.checkin?.status;
      if (!adapter || !status) continue;

      const key = checkinAccountKey(adapter.id, account.displayName ?? '');
      const cached = this.remoteCache.get(key);
      if (cached) {
        const ttl = cached.view ? REMOTE_STATUS_TTL_MS : REMOTE_STATUS_ERROR_TTL_MS;
        if (now - cached.at < ttl) {
          entry.remote = cached.view;
          entry.remoteError = cached.error;
          continue;
        }
      }
      queue.push({ entry, account, key, status });
    }

    if (queue.length === 0) return;
    await this.mapLimit(queue, REMOTE_STATUS_CONCURRENCY, async (item) => {
      try {
        const state = await withTimeout(
          item.status(item.account, this.host.context(item.account)),
          REMOTE_STATUS_TIMEOUT_MS,
          '签到状态查询',
        );
        const view = toRemoteView(state, Date.now());
        this.remoteCache.set(item.key, { at: Date.now(), view, error: null });
        item.entry.remote = view;
        item.entry.remoteError = null;
      } catch (error) {
        const message = (error as Error).message;
        this.remoteCache.set(item.key, { at: Date.now(), view: null, error: message });
        item.entry.remote = null;
        item.entry.remoteError = message;
        console.warn(`[checkin] ${item.entry.displayName} 签到状态核对失败（按本地口径）：${message}`);
      }
    });
  }

  private supportOf(
    account: AccountConfig,
  ): { ok: true } | { ok: false; reason: string } {
    const adapter = resolveAdapter(account.provider);
    if (!adapter?.checkin) {
      return { ok: false, reason: `${adapter?.displayName ?? account.provider} 没有每日签到` };
    }
    try {
      return adapter.checkin.support(account);
    } catch (error) {
      return { ok: false, reason: `无法判断签到能力：${(error as Error).message}` };
    }
  }

  private resolveAccount(
    provider: string,
    accountId: string,
  ): { account: AccountConfig; adapter: NonNullable<ReturnType<typeof resolveAdapter>> } {
    const sameProvider = this.host
      .accounts()
      .filter((account) => resolveAdapter(account.provider)?.id === provider);
    const matches = sameProvider.filter(
      (account) => (account.displayName ?? '') === accountId,
    );
    if (matches.length === 0) {
      // 卡片可能刚拿到上游解析的新昵称，而 accounts.json 尚未热加载；
      // 只有一个账号时退回它，避免「按钮在、点下去 404」。
      if (sameProvider.length === 1) {
        const only = sameProvider[0] as AccountConfig;
        const adapter = resolveAdapter(only.provider);
        if (!adapter) throw new CheckinError(`未知平台 "${only.provider}"`, 404);
        return { account: only, adapter };
      }
      throw new CheckinError(
        `accounts.json 里找不到账号 ${provider}${accountId ? ` / ${accountId}` : ''}`,
        404,
      );
    }
    if (matches.length > 1) {
      throw new CheckinError(
        `平台 ${provider} 下有 ${matches.length} 个账号的 displayName 都是 "${accountId}"，无法定位`,
        409,
      );
    }
    const account = matches[0] as AccountConfig;
    const adapter = resolveAdapter(account.provider);
    if (!adapter) {
      throw new CheckinError(`未知平台 "${account.provider}"`, 404);
    }
    return { account, adapter };
  }

  private async mapLimit<T, R>(
    items: T[],
    limit: number,
    run: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        results.push(await run(item as T));
      }
    });
    await Promise.all(workers);
    return results;
  }

  private load(): CheckinFile {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Partial<CheckinFile>;
        const settings = record.settings ?? DEFAULT_SETTINGS;
        return {
          version: STATE_VERSION,
          settings: {
            auto: settings.auto === true,
            at: typeof settings.at === 'string' && parseClock(settings.at) !== null
              ? settings.at
              : DEFAULT_SETTINGS.at,
          },
          accounts:
            record.accounts && typeof record.accounts === 'object' && !Array.isArray(record.accounts)
              ? record.accounts
              : {},
        };
      }
    } catch {
      // 文件不存在 / 损坏：按空状态继续；签到本身不依赖历史
    }
    return { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS }, accounts: {} };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      console.warn(`[checkin] 结果写入失败（不影响本次签到）：${(error as Error).message}`);
    }
  }
}
