import { daysBetween } from './lib/json.js';
import type {
  DashboardPayload,
  DashboardTotals,
  ExpiryHit,
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

export function buildTotals(snapshots: ProviderSnapshot[]): DashboardTotals {
  const creditsByCurrency: Record<string, number> = {};
  const balanceByCurrency: Record<string, number> = {};
  let ok = 0;
  let failed = 0;

  for (const snapshot of snapshots) {
    if (OK_STATUSES.has(snapshot.status)) ok += 1;
    else failed += 1;

    for (const lot of snapshot.credits) {
      if (lot.amount <= 0) continue;
      creditsByCurrency[lot.currency] = round((creditsByCurrency[lot.currency] ?? 0) + lot.amount);
    }
    if (snapshot.balance && snapshot.balance.amount > 0) {
      const key = snapshot.balance.currency;
      balanceByCurrency[key] = round((balanceByCurrency[key] ?? 0) + snapshot.balance.amount);
    }
  }

  return { providers: snapshots.length, ok, failed, creditsByCurrency, balanceByCurrency };
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
  const providers = [...snapshots].sort(
    (a, b) => sortRank(a) - sortRank(b) || a.displayName.localeCompare(b.displayName),
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
