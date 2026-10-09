import { daysBetween } from './lib/json.js';
import type {
  Currency,
  DashboardPayload,
  DashboardTotals,
  ExpiryHit,
  ProviderEntry,
  ProviderSnapshot,
} from './types.js';
import { OK_STATUSES } from './types.js';

export interface AggregateSettings {
  cacheTtlSeconds: number;
  expiryCriticalDays: number;
  expiryWarningDays: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 把声明了 `groupAccounts` 的平台的多条账号快照合并成一张卡片。
 *
 * 动机：D1V 的一个账号 = 一把项目密钥 + 一份 quota，是多份「同一种东西」。
 * 摆成一屏的独立卡片后，真正要看的「谁快用完了」被冲散在滚动里。
 *
 * 合并后：
 *   - 每个账号成为一条 `entries[]`，身份（accountId / 展示名）下移到条目里；
 *   - 卡片余额是各条目同币种之和，`plan` 变成「N 个账号」；
 *   - 条目按**额度升序**排列——最少的排最前，也就是最该关注的排最前，
 *     与看板「最快到期优先」是同一个取向。
 */
export function groupSnapshots(snapshots: ProviderSnapshot[]): ProviderSnapshot[] {
  const out: ProviderSnapshot[] = [];
  const grouped = new Map<string, { card: ProviderSnapshot; entries: ProviderEntry[] }>();

  for (const snapshot of snapshots) {
    if (!snapshot.groupAccounts) {
      out.push(snapshot);
      continue;
    }
    const bucket = grouped.get(snapshot.provider);
    if (bucket) bucket.entries.push(toEntry(snapshot));
    else grouped.set(snapshot.provider, { card: snapshot, entries: [toEntry(snapshot)] });
  }

  for (const { card, entries } of grouped.values()) out.push(finalizeCard(card, entries));
  return out;
}

/** 把一个账号快照压成卡片里的一条 */
function toEntry(snapshot: ProviderSnapshot): ProviderEntry {
  return {
    id: snapshot.accountId,
    label: snapshot.plan || snapshot.accountId || snapshot.provider,
    amount: snapshot.balance?.amount ?? 0,
    currency: snapshot.balance?.currency ?? 'CREDITS',
    status: snapshot.status,
    message: snapshot.message,
    note: snapshot.note,
    secrets: snapshot.secrets,
  };
}

function finalizeCard(card: ProviderSnapshot, input: ProviderEntry[]): ProviderSnapshot {
  // 额度升序：最少的排最前，也就是最该关注的排最前
  const entries = [...input].sort((a, b) => a.amount - b.amount);
  const healthy = entries.filter((entry) => OK_STATUSES.has(entry.status));
  const failed = entries.filter((entry) => !OK_STATUSES.has(entry.status));

  // 同一平台的条目理论上同币种；真有混币种就只汇总额度最大的那一种，
  // 避免把不同单位硬加在一起给出一个假数字
  const totals = new Map<string, number>();
  for (const entry of healthy) {
    totals.set(entry.currency, round((totals.get(entry.currency) ?? 0) + entry.amount));
  }
  const dominant = [...totals.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  return {
    ...card,
    entries,
    // 账号身份已经下移到 entries[].id，卡片本身不再代表某一个账号
    accountId: '',
    // 只要有一个账号可用，这张卡片就不算坏——失败的账号在它自己那条上显示原因
    status: healthy.length > 0 ? 'ok' : (failed[0]?.status ?? card.status),
    balance: dominant ? { amount: dominant[1], currency: dominant[0] as Currency } : null,
    plan: `${entries.length} 个账号${failed.length > 0 ? `（${failed.length} 个异常）` : ''}`,
    // 不过期的额度：不参与「最快到期」，也不该被合成事件补一条
    credits: [],
    windows: [],
    nextExpiryAt: null,
    nextExpiryInDays: null,
    secrets: [],
    message:
      failed.length > 0
        ? failed.map((entry) => `${entry.label}：${entry.message ?? '取数失败'}`).join('；')
        : null,
    note: totals.size > 1 ? '各账号额度单位不一致，卡片总额只取了其中一种' : null,
  };
}

export function buildTotals(snapshots: ProviderSnapshot[]): DashboardTotals {
  const creditsByCurrency: Record<string, number> = {};
  const balanceByCurrency: Record<string, number> = {};
  const availableByCurrency: Record<string, number> = {};
  let ok = 0;
  let failed = 0;

  const add = (bucket: Record<string, number>, currency: string, amount: number): number => {
    const next = round((bucket[currency] ?? 0) + amount);
    bucket[currency] = next;
    return next;
  };

  for (const snapshot of snapshots) {
    if (OK_STATUSES.has(snapshot.status)) ok += 1;
    else failed += 1;

    // basis='granted' 的批次只表达「何时到期」，不参与累加
    let lotsRemaining = 0;
    for (const lot of snapshot.credits) {
      if (lot.amount <= 0 || lot.basis === 'granted') continue;
      lotsRemaining += lot.amount;
      add(creditsByCurrency, lot.currency, lot.amount);
    }

    if (snapshot.balance && snapshot.balance.amount > 0) {
      add(balanceByCurrency, snapshot.balance.currency, snapshot.balance.amount);
      add(availableByCurrency, snapshot.balance.currency, snapshot.balance.amount);
    } else if (lotsRemaining > 0) {
      add(availableByCurrency, snapshot.credits[0]?.currency ?? 'CREDITS', lotsRemaining);
    }
  }

  return {
    providers: snapshots.length,
    ok,
    failed,
    availableByCurrency,
    creditsByCurrency,
    balanceByCurrency,
  };
}

/**
 * 生成「最快到期」事件流。
 *
 * 首选带过期时间的积分批次；若某平台只有窗口重置时间（如 Qoder 的 nextResetAt），
 * 则补一条合成事件，避免这类平台在排序里被边缘化。
 */
export function buildExpiryTimeline(snapshots: ProviderSnapshot[], now: number): ExpiryHit[] {
  const hits: ExpiryHit[] = [];

  for (const snapshot of snapshots) {
    const futureLots = snapshot.credits
      .filter((lot) => lot.expiresAt !== null && lot.amount > 0)
      .map((lot) => ({ lot, ts: Date.parse(lot.expiresAt as string) }))
      .filter((entry) => Number.isFinite(entry.ts) && entry.ts >= now)
      .sort((a, b) => a.ts - b.ts);

    for (const { lot, ts } of futureLots) {
      hits.push({
        provider: snapshot.provider,
        displayName: snapshot.displayName,
        lotId: lot.id,
        lotLabel: lot.label,
        amount: lot.amount,
        currency: lot.currency,
        expiresAt: lot.expiresAt as string,
        inDays: daysBetween(now, lot.expiresAt as string),
      });
      // ts 已参与排序，这里显式引用避免未使用变量
      void ts;
    }

    const earliestLotExpiry = futureLots[0]?.lot.expiresAt ?? null;
    const coveredByLot = earliestLotExpiry !== null && snapshot.nextExpiryAt === earliestLotExpiry;
    if (!coveredByLot && snapshot.nextExpiryAt) {
      const ts = Date.parse(snapshot.nextExpiryAt);
      if (Number.isFinite(ts) && ts >= now) {
        const totalAmount = snapshot.credits.reduce((sum, lot) => sum + lot.amount, 0);
        hits.push({
          provider: snapshot.provider,
          displayName: snapshot.displayName,
          lotId: 'window-boundary',
          lotLabel: '本期额度重置（未用完即作废）',
          amount: round(totalAmount || snapshot.balance?.amount || 0),
          currency: snapshot.credits[0]?.currency ?? snapshot.balance?.currency ?? 'CREDITS',
          expiresAt: snapshot.nextExpiryAt,
          inDays: daysBetween(now, snapshot.nextExpiryAt),
        });
      }
    }
  }

  return hits.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

export function buildPayload(
  snapshots: ProviderSnapshot[],
  settings: AggregateSettings,
  now = Date.now(),
): DashboardPayload {
  // 先合并「一个平台一张卡片」的那种（多个账号 -> 一张卡片多条 entry），再排序
  const providers = groupSnapshots(snapshots).sort(
    (a, b) => sortRank(a) - sortRank(b) || a.displayName.localeCompare(b.displayName, 'zh-CN'),
  );
  const expiryTimeline = buildExpiryTimeline(providers, now);

  return {
    generatedAt: new Date(now).toISOString(),
    cacheTtlSeconds: settings.cacheTtlSeconds,
    expiryThresholds: {
      criticalDays: settings.expiryCriticalDays,
      warningDays: settings.expiryWarningDays,
    },
    totals: buildTotals(providers),
    nextExpiry: expiryTimeline[0] ?? null,
    expiryTimeline,
    providers,
  };
}

/**
 * 服务端默认排序权重：
 *   0 = 可正常读取的，按最快到期（由前端做精细排序）
 *   1 = 无过期信息的
 *   2 = 取数失败的（排最后，避免干扰注意力）
 */
function sortRank(snapshot: ProviderSnapshot): number {
  if (!OK_STATUSES.has(snapshot.status)) return 2;
  return snapshot.nextExpiryAt ? 0 : 1;
}
