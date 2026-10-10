/**
 * 上游用量明细（usage ledger）：把各平台「使用记录 / 获取记录」的逐笔数据
 * 归一成统一记录，并按**本地时区**的 00:00–24:00 聚合出日级四个数字。
 *
 * 与 usage-history.ts 的分工（见 docs/plans/供应商卡片-用量与增量字段-开发设计方案.md v2）：
 *   - 本模块 = 平台明细接口（精确、不依赖服务是否在观测）；
 *   - usage-history.ts = 本地采样兜底（平台没有对应明细能力时使用）。
 */
import type { UsageSource } from './types.js';

const DAY_MS = 86_400_000;

/** 一笔记录：use = 消耗（使用的量），grant = 获取（增加的量）；amount 非负 */
export interface UsageRecord {
  /** 发生时间（epoch ms） */
  at: number;
  kind: 'use' | 'grant';
  amount: number;
}

/**
 * 适配器明细接口的返回。
 * `covers` 表示该平台**能完整覆盖**的维度：只有覆盖的维度才用上游值
 * （缺记录即 0）；未覆盖的维度回退本地采样，避免「只给了一半、另一半静默为 0」。
 */
export interface UsageLedger {
  records: UsageRecord[];
  covers: { use: boolean; grant: boolean };
}

/** 明细能算出的日级数字（未覆盖的维度保持 undefined，交给兜底） */
export interface LedgerSummary {
  usedToday?: number;
  usedYesterday?: number;
  addedToday?: number;
  addedYesterday?: number;
}

export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 本地时区的当天 00:00（epoch ms） */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 本地日键 YYYY-MM-DD（把「按天返回」的上游数据对齐到本地日） */
export function localDateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 把 YYYY-MM-DD 这样的上游日期标签转成该日的本地时间戳（取中午，避开时区边界） */
export function localNoonOf(dateLabel: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateLabel.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * 按本地日聚合「今日/昨日」四个数字。
 * 只统计落在 [昨日 00:00, 明日 00:00) 的记录；每条记录归属其发生日。
 * 覆盖的维度即使没有记录也会给出 0（有完整记录集，0 是确定值）。
 */
export function summarizeLedger(ledger: UsageLedger, now: number): LedgerSummary {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const tomorrowStart = todayStart + DAY_MS;
  const out: LedgerSummary = {};

  for (const record of ledger.records) {
    if (!Number.isFinite(record.at) || !Number.isFinite(record.amount) || record.amount <= 0) continue;
    if (record.at < yesterdayStart || record.at >= tomorrowStart) continue;
    const isToday = record.at >= todayStart;
    if (record.kind === 'use') {
      if (!ledger.covers.use) continue;
      if (isToday) out.usedToday = roundAmount((out.usedToday ?? 0) + record.amount);
      else out.usedYesterday = roundAmount((out.usedYesterday ?? 0) + record.amount);
    } else {
      if (!ledger.covers.grant) continue;
      if (isToday) out.addedToday = roundAmount((out.addedToday ?? 0) + record.amount);
      else out.addedYesterday = roundAmount((out.addedYesterday ?? 0) + record.amount);
    }
  }

  if (ledger.covers.use) {
    out.usedToday ??= 0;
    out.usedYesterday ??= 0;
  }
  if (ledger.covers.grant) {
    out.addedToday ??= 0;
    out.addedYesterday ??= 0;
  }
  return out;
}

/** 合并卡片里多个账号的来源归并：全 upstream → upstream，全 local → local，其余 mixed */
export function mergeSources(sources: UsageSource[]): UsageSource {
  if (sources.length === 0) return 'local';
  const first = sources[0];
  return sources.every((item) => item === first) ? first : 'mixed';
}