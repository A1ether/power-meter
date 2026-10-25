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

/**
 * 额度单位。各平台口径不同，不做换算，在界面与汇总里按单位分开计。
 * `QUOTA` 是 A1etherOpenAi 的模型调用计量单位（1 USD = 500,000 quota，实测恒定），
 * 它与同平台的 USD 钱包余额是同一笔钱的两套计量，因此不能相加。
 */
export type Currency = 'CREDITS' | 'POINTS' | 'QUOTA' | 'USD' | 'CNY';

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

/** 日级指标的来源：平台明细接口 / 本地采样兜底 / 合并卡片里两者混合 */
export type UsageSource = 'upstream' | 'local' | 'mixed';

/**
 * 卡片的日级用量 / 增量。
 *
 * 数据来源（v2，见 docs/plans/供应商卡片-用量与增量字段-开发设计方案.md）：
 *   - 优先取各平台用量页背后的明细接口（`ProviderAdapter.fetchUsageLedger`），
 *     按本地时区 00:00–24:00 归集，精确到笔；
 *   - 平台没有对应明细能力的维度，退回本地采样（src/usage-history.ts）兜底，
 *     并在 `sources` 里如实标注，界面 tooltip 可见。
 *
 * 口径（2026-10-10 由用户确认）：
 * - 「用量」= 该日**减少量之和**（使用的量，非负；增加不抵消）；
 * - 「增量」= 该日**增加量之和**（增加的量，如每日签到、充值，非负；减少不抵消）；
 * - 明细来源下「该日无记录 = 0」（有完整记录集）；本地采样下「该日无样本 = null」。
 */
export interface DailyUsage {
  todayUsed: number | null;
  yesterdayUsed: number | null;
  todayAdded: number | null;
  yesterdayAdded: number | null;
  currency: Currency;
  /**
   * 每个字段各自的数据来源，用于界面**逐字段**标注（upstream / local / mixed）。
   *
   * 逐字段而非「按维度」：同一次取数里「今日」与「昨日」可能分别来自两种来源
   * ——上限是「平台明细」，而「今日」是尚在进行中的一天，上游按天聚合当天可能
   * 还没出数，此时退回本地实时观测（见 src/service.ts 的 reconcileToday）。
   */
  sources: {
    todayUsed: UsageSource;
    yesterdayUsed: UsageSource;
    todayAdded: UsageSource;
    yesterdayAdded: UsageSource;
  };
}

/**
 * 「托管密钥」引用：值本身**不进快照**，只下发展示用的掩码预览。
 * 前端按 key 调 `/api/reveal` 按需取明文（见 server.ts 的 reveal 路由）。
 */
export interface SecretRef {
  /** 凭证 key，作为 /api/reveal 的入参 */
  key: string;
  /** 展示名，如 `A1etherOpenAi_PAI_API_KEY` */
  label: string;
  /** 掩码预览，如 `sk-abc…9f2c` */
  preview: string;
  /** 说明这句话在界面上给谁看（如「用于模型调用」） */
  hint: string;
}

/**
 * 卡片里的一个账号条目。
 *
 * 有些平台的账号是「同一个东西的多份」（A1etherOpenAi 就是：每个账号一把项目密钥 +
 * 一份 quota），摆成一屏卡片会把真正要看的对比信息冲散。
 * 这类平台的适配器声明 `groupAccounts`，聚合层把它的多个账号快照合并成
 * 一张卡片，每个账号变成这里的一条 entry。
 */
export interface ProviderEntry {
  /**
   * 稳定标识：账号在 accounts.json 里的 displayName（没写就是空串）。
   * 前端把它回传给 `/api/reveal`，服务端据此定位到唯一账号。
   */
  id: string;
  /** 展示用名称，优先取账号邮箱之类的身份信息 */
  label: string;
  /** 这条账号的可用额度 */
  amount: number;
  currency: Currency;
  status: ProviderStatus;
  message: string | null;
  /** 补充说明，如「已用 17,888 quota · 4 次请求」 */
  note: string | null;
  secrets: SecretRef[];
}

export interface ProviderSnapshot {
  provider: string;
  displayName: string;
  /**
   * 账号在 accounts.json 里的 displayName（没写就是空串）。
   * 一个账号一张卡片时它就是这张卡的身份；合并成一张卡片后，
   * 身份下移到 entries[].id，这里置空。
   */
  accountId: string;
  /** 该适配器是否要求把所有账号并进一张卡片（见 ProviderEntry） */
  groupAccounts: boolean;
  /** 额度永不过期（由适配器显式声明，见 ProviderAdapter.neverExpires） */
  neverExpires: boolean;
  /** 是否允许在看板上增删该平台的账号（见 ProviderAdapter.manageAccounts） */
  manageAccounts: boolean;
  /** 合并后的账号条目；非合并平台为空数组 */
  entries: ProviderEntry[];
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
  /**
   * 平台「用量页」地址：卡片「每日用量」区整块作为外链跳转的目标（新窗口打开）。
   * 与 dashboardUrl 分开：dashboardUrl 是「面板入口」（A1etherOpenAi 指向 api-key 设置页），
   * 不一定是用量页；空串表示没有可跳转的用量页（用量区保持纯展示）。
   */
  usageUrl: string;
  message: string | null;
  note: string | null;
  /**
   * 可托管的密钥（目前只有 A1etherOpenAi 用）。与探测结果解耦：
   * 即使余额查询失败，只要凭证在，仍能复制密钥。
   */
  secrets: SecretRef[];
  /** true 表示本次刷新失败，展示的是上一次成功的数据 */
  stale: boolean;
  /**
   * 日级用量 / 增量（本地采样历史推算）。由编排层在取数成功后填充；
   * 适配器不感知此字段，构建快照时统一置 null（见 base.ts 的 buildSnapshot）。
   */
  dailyUsage: DailyUsage | null;
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
  /**
   * 该笔额度的人民币估值（元）——各平台官方「积分包 / 增购积分」单价折算，
   * 见 `src/credit-value.ts`。`null` = 不折算（非 CREDITS 单位，或该平台没有官方单价）。
   */
  cny: number | null;
  /** 上面这个数字的换算口径明细（多行文本，前端直接用作悬停说明）；不折算时为 null */
  cnyNote: string | null;
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
