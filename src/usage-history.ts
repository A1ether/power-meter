/**
 * 按天用量历史：把「每次刷新看到的额度」记成本地样本，推算卡片的
 * 「昨日/今日用量」与「昨日/今日增量」四个日级指标。
 *
 * 为什么不直接取上游：各平台适配器只返回「当前」快照——`windows[].used` 是
 * 周期累计、`credits[]` 是当前剩余，没有统一的「昨天消耗了多少」这种时间切片。
 * 本模块用本地采样补齐这一维度（见 docs/plans/供应商卡片-用量与增量字段-开发设计方案.md）。
 *
 * 口径（2026-10-10 由用户确认）：
 * - 用量 = 该日**观测到的额度减少量之和**（使用的量，非负；增加不抵消）；
 * - 增量 = 该日**观测到的额度增加量之和**（增加的量，如每日签到、充值，非负；减少不抵消）；
 * - 两者互不抵消、各自独立累计；按**服务器本地时区**的 00:00–24:00 切日；
 *   该日无样本时指标为 null。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRuntimeDir } from './config.js';
import { asNumber, isRecord } from './lib/json.js';
import { startOfDay } from './usage-ledger.js';

const DAY_MS = 86_400_000;
/** 样本保留窗口（14 天）：够算昨日/今日，也为后续趋势图留余量 */
const KEEP_DAYS = 14;
/** 每 key 样本上限，防御异常写入导致文件膨胀 */
const MAX_SAMPLES_PER_KEY = 4000;
/** 心跳间隔：数值没变化也最多隔这么久记一条，保证「零用量/零增量」可被表达 */
const HEARTBEAT_MS = 15 * 60 * 1000;

export interface UsageSample {
  /** 观测时间（epoch ms） */
  t: number;
  /** 当时卡片展示的额度数值 */
  a: number;
}

export interface DailyMetrics {
  todayUsed: number | null;
  yesterdayUsed: number | null;
  todayAdded: number | null;
  yesterdayAdded: number | null;
}

interface StoreFile {
  version: 1;
  samples: Record<string, UsageSample[]>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 采样文件路径：锚定到配置目录（与 .env / accounts.json 同源），不依赖进程 cwd */
export function resolveUsageHistoryPath(): string {
  return resolve(resolveRuntimeDir(), 'usage-history.json');
}

export class UsageHistory {
  private readonly samples = new Map<string, UsageSample[]>();
  private dirty = false;

  constructor(private readonly path: string = resolveUsageHistoryPath()) {
    this.load();
  }

  /**
   * 记录一次观测（key 与缓存键一致：`provider#accountId`）。
   * 数值变化即记；数值不变时按 HEARTBEAT_MS 补心跳，避免空转样本。
   */
  observe(key: string, amount: number, now: number): void {
    if (!Number.isFinite(amount)) return;
    const list = this.samples.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && (now <= last.t || (last.a === round(amount) && now - last.t < HEARTBEAT_MS))) return;
    list.push({ t: now, a: round(amount) });
    this.samples.set(key, list);
    this.dirty = true;
  }

  /** 今日/昨日四个指标；该日没有任何样本时对应值为 null */
  metricsFor(key: string, now: number): DailyMetrics {
    const list = this.samples.get(key) ?? [];
    const todayStart = startOfDay(now);
    const tomorrowStart = todayStart + DAY_MS;
    return {
      todayUsed: sumOnDay(list, todayStart, tomorrowStart, 'down'),
      yesterdayUsed: sumOnDay(list, todayStart - DAY_MS, todayStart, 'down'),
      todayAdded: sumOnDay(list, todayStart, tomorrowStart, 'up'),
      yesterdayAdded: sumOnDay(list, todayStart - DAY_MS, todayStart, 'up'),
    };
  }

  /** 落盘（有变化才写）。原子写：先写临时文件再 rename，避免半截文件 */
  flush(now = Date.now()): void {
    if (!this.dirty) return;
    if (this.prune(now)) this.dirty = true;
    const payload: StoreFile = { version: 1, samples: Object.fromEntries(this.samples) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (error) {
      // 历史只是增强信息，写盘失败不影响取数主链路
      console.warn(`[usage] 用量历史写入失败：${(error as Error).message}`);
    }
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      // 首次运行（文件不存在）或文件损坏：从空历史开始，不影响服务
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.samples)) return;
    for (const [key, raw] of Object.entries(parsed.samples)) {
      if (!Array.isArray(raw)) continue;
      const list: UsageSample[] = [];
      for (const item of raw) {
        if (!isRecord(item)) continue;
        const t = asNumber(item.t);
        const a = asNumber(item.a);
        if (t === null || a === null) continue;
        list.push({ t, a });
      }
      list.sort((x, y) => x.t - y.t);
      if (list.length > 0) this.samples.set(key, list);
    }
    if (this.prune(Date.now())) this.dirty = true;
  }

  /** 裁剪过期与超量样本；返回是否发生变化（变化则需落盘） */
  private prune(now: number): boolean {
    const floor = startOfDay(now) - KEEP_DAYS * DAY_MS;
    let changed = false;
    for (const [key, list] of this.samples) {
      let kept = list.filter((sample) => sample.t >= floor);
      if (kept.length > MAX_SAMPLES_PER_KEY) kept = kept.slice(kept.length - MAX_SAMPLES_PER_KEY);
      if (kept.length === 0) {
        this.samples.delete(key);
        changed = true;
      } else if (kept.length !== list.length) {
        this.samples.set(key, kept);
        changed = true;
      }
    }
    return changed;
  }
}

/**
 * 单日累计：相邻样本区间中「结束样本」落在 [start, end) 的减少量（用量）
 * 或增加量（增量）之和；两者互不抵消、各自独立统计。
 *
 * 使用/增加发生在两个样本之间时，整段记给结束样本所在的那天——
 * 因此服务离线空窗期内的变化会整体计入恢复后的那一天（观测口径）。
 */
function sumOnDay(
  list: UsageSample[],
  start: number,
  end: number,
  direction: 'up' | 'down',
): number | null {
  let inDay = 0;
  let total = 0;
  for (let i = 1; i < list.length; i += 1) {
    const current = list[i];
    if (current.t < start || current.t >= end) continue;
    inDay += 1;
    const previous = list[i - 1];
    if (direction === 'down' && previous.a > current.a) total += previous.a - current.a;
    if (direction === 'up' && current.a > previous.a) total += current.a - previous.a;
  }
  return inDay > 0 ? round(total) : null;
}