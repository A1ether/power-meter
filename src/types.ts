/**
 * 统一数据契约。
 *
 * 设计直接沿用了开源项目 Javis603/token-monitor 的 normalizeLimitProvider 契约
 * （provider/source/status/windows/balance + window kind: session|daily|weekly|billing），
 * 并针对本项目目标补充了「带过期时间的积分批次」credits: CreditLot[]。
 * 见 docs/开源项目调研与复用评估.md。
 */

export type ProviderStatus =
  | 'ok'
  | 'demo'
  | 'notConfigured'
  | 'unauthorized'
  | 'forbidden'
  | 'rateLimited'
  | 'notFound'
  | 'unavailable'
  | 'error';

export const OK_STATUSES: ReadonlySet<ProviderStatus> = new Set<ProviderStatus>(['ok', 'demo']);

/** 额度窗口类型，与 token-monitor 的 window.kind 对齐 */
export type WindowKind = 'session' | 'daily' | 'weekly' | 'billing';

/**
 * 该窗口的归零原因：
 * - reset : 周期重置（未用完会被回收）
 * - expiry: 明确过期时间
 * - mixed : 两者兼有/不明确
 */
export type BoundaryKind = 'reset' | 'expiry' | 'mixed';

export type Currency = 'CREDITS' | 'POINTS' | 'USD' | 'CNY';

export interface QuotaWindow {
  kind: WindowKind;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  usedPercent: number;
  remainingPercent: number;
  boundary: BoundaryKind;
  /** 周期重置时间（ISO） */
  resetsAt: string | null;
  /** 明确过期时间（ISO） */
  expiresAt: string | null;
  showMeter: boolean;
}

/** 一笔带（或不带）过期时间的积分/额度批次，是「最快到期」排序的最小单位 */
export interface CreditLot {
  id: string;
  label: string;
  amount: number;
  currency: Currency;
  expiresAt: string | null;
  note: string;
  /**
   * amount 的口径：
   * - `remaining`（默认）：该批次**当前剩余**，可直接累加进总额
   * - `granted`：该批次**授予总量**（平台只给账户级剩余、不提供批次级剩余时使用），
   *   此时仅用于展示「什么时候到期」，不参与汇总，避免与 balance 重复计算
   */
  basis: 'remaining' | 'granted';
}

export interface MoneyBalance {
  amount: number;
  currency: Currency;
}

export interface ProviderSnapshot {
  provider: string;
  displayName: string;
  region: 'cn' | 'global';
  status: ProviderStatus;
  source: 'api' | 'web' | 'local';
  updatedAt: string;
  plan: string | null;
  balance: MoneyBalance | null;
  credits: CreditLot[];
  windows: QuotaWindow[];
  /** 所有批次中最早的过期时间 */
  nextExpiryAt: string | null;
  /** 距离过期还有多少天（含小数，负数表示已过期） */
  nextExpiryInDays: number | null;
  dashboardUrl: string;
  message: string | null;
  note: string | null;
  /** true 表示本次刷新失败，展示的是上一次成功的数据 */
  stale: boolean;
}

export interface ExpiryHit {
  provider: string;
  displayName: string;
  lotId: string;
  lotLabel: string;
  amount: number;
  currency: Currency;
  expiresAt: string;
  inDays: number;
}

export interface DashboardTotals {
  providers: number;
  ok: number;
  failed: number;
  /**
   * 可用额度合计：每个平台取「账户余额」，没有余额字段时退回「剩余批次之和」。
   * 批次是余额的拆分，两者相加会重复计算，所以汇总只保留这一个口径。
   */
  availableByCurrency: Record<string, number>;
  /** 仅供排查用的分项：剩余批次之和 */
  creditsByCurrency: Record<string, number>;
  /** 仅供排查用的分项：账户余额之和 */
  balanceByCurrency: Record<string, number>;
}

export interface DashboardPayload {
  generatedAt: string;
  cacheTtlSeconds: number;
  expiryThresholds: { criticalDays: number; warningDays: number };
  totals: DashboardTotals;
  /** 全局最快到期的一条，用于顶部告警 */
  nextExpiry: ExpiryHit | null;
  /** 按最快到期升序排列的到期事件流 */
  expiryTimeline: ExpiryHit[];
  providers: ProviderSnapshot[];
}
