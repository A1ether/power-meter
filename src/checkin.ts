import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRuntimeDir, type AccountConfig } from './config.js';
import { resolveAdapter } from './providers/index.js';
import type { CheckinOutcome, CheckinResult, ProbeContext } from './providers/base.js';

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

export class CheckinManager {
  private readonly filePath: string;
  private file: CheckinFile;
  private readonly inflight = new Map<string, Promise<CheckinRecord>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly host: CheckinHost) {
    this.filePath = resolve(resolveRuntimeDir(), 'checkin.json');
    this.file = this.load();
  }

  status(): CheckinStatus {
    this.host.ensureFresh();
    const accounts = this.host.accounts().map((account) => this.describe(account));
    return {
      settings: { ...this.file.settings },
      accounts,
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
    };
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
