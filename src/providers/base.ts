import type { AccountConfig } from '../config.js';
import { clamp, daysBetween, firstString, toIso } from '../lib/json.js';
import type { UsageLedger } from '../usage-ledger.js';
import type {
  BoundaryKind,
  CreditLot,
  Currency,
  MoneyBalance,
  ProviderSnapshot,
  ProviderStatus,
  QuotaWindow,
  SecretRef,
  WindowKind,
} from '../types.js';

export interface ProbeContext {
  now: number;
  timeoutMs: number;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /**
   * 令牌刷新后写回 `.env`（由编排层注入；账号添加/登录验证时不注入）。
   *
   * 只有「账号已经在 accounts.json 里、且凭证是 `${VAR}` 引用」时才会真正落盘；
   * 写回失败不阻断本次探测，只是下次刷新会再试一遍。
   */
  persistCredentials?: (patch: Record<string, string>) => Promise<void>;
  /**
   * 探测时解析出的平台昵称 → 写回 accounts.json 的展示名（由编排层注入）。
   *
   * 只在账号当前仍是通用占位名（`<适配器> · 登录账号`）时才会真正改名，
   * 用户自定义过的名字一律不动；返回最终展示名（未改动时即原值），
   * 适配器用它组装本轮快照，避免等下一轮配置热加载。
   */
  persistAccountName?: (resolvedName: string) => Promise<string | null>;
}

/**
 * 看板 / CLI「添加账号」表单里的一个输入项。
 *
 * `key` 必须是该平台 credentials 里的键（如 codebuddy 的 `cookie`、
 * a1etheropenai 的 `apiKey`），这样表单收集到的值可以直接当凭证用。
 */
export interface ManageFieldDescriptor {
  key: string;
  label: string;
  placeholder?: string;
  /** 输入框下方的补充说明（可选） */
  hint?: string;
  /** 是否必填，默认 true */
  required?: boolean;
  /** 长文本（Cookie 可达数 KB）→ 渲染成 textarea */
  multiline?: boolean;
  /** 默认 true：输入框用 password 类型，避免明文贴在屏幕上 */
  secret?: boolean;
  /**
   * 写入目标，默认 `credential`：
   *   - `credential`：写进 accounts.json 的 `credentials`，占 `.env` 槽位、参与掩码预览；
   *   - `option`：写进 `options`（如将来某个平台的站点选择），属非敏感配置，
   *     不占 `.env` 槽位、不进掩码预览；表单里的取值会被校验必须在 `choices` 内。
   */
  target?: 'credential' | 'option';
  /** 候选项：非空时前端渲染成下拉框（目前只对 target: 'option' 有意义） */
  choices?: string[];
  /** 下拉框的默认选中项，同时也是「未提供该选项时」写入 options 的值 */
  defaultValue?: string;
  /**
   * 成组字段（目前只用于 CodeArts 的 AccessKey / SecretKey）：
   * `pairedWith` 指向组内另一个字段的 key，两者要么都填、要么都不填；
   * 组内任一字段有值时，本字段即变为必填（除非本字段 `required: false`）。
   * 未声明时沿用「逐字段必填」的旧语义。
   */
  pairedWith?: string;
  /** 可选字段组：`required: false` + `flagGroup` 的字段彼此同进同退——全空不报错 */
  flagGroup?: string;
}

/* ------------------------------------------------------------------ *
 * 「扫码 / 打开链接登录」契约
 * ------------------------------------------------------------------ */

export interface LoginStartInput {
  now: number;
  timeoutMs: number;
  /** 登录会话 id：Trae 用它拼回调地址（`/authorize?lt=<sessionId>`） */
  sessionId: string;
  /** 服务自身的回环基址，如 `http://127.0.0.1:48213` */
  callbackBase: string;
  /** 非敏感选项（目前只用于站点选择，登录固定 cn） */
  options: Record<string, string>;
  /**
   * 用哪个登录方法（`ProviderLogin.id`）。缺省 = 平台的默认方法（`login`）。
   * 只有声明了 `loginMethods` 的平台才有多个可选值。
   */
  method?: string;
  log: (message: string) => void;
}

export interface LoginStartResult {
  /** 用户在浏览器 / 手机上打开的授权页 */
  authUrl: string;
  /** 该链接能否跨设备扫码（Trae 的本地回调不能） */
  qr: boolean;
  ttlMs: number;
  hint?: string;
  /** 协议私有状态（state / PKCE verifier / 设备私钥），只留在服务端内存 */
  secret: unknown;
}

export type LoginPollResult =
  | { status: 'waiting'; message?: string }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      /** 平台账号身份：id 用于去重（同一账号重复登录 → 更新原条目） */
      account: { id: string; name: string };
      /** 明文凭证，由登录会话层写入 `.env`（0600） */
      credentials: Record<string, string>;
      /** 非敏感配置，写入 accounts.json 的 options */
      options: Record<string, string>;
      message?: string;
    };

/**
 * 平台登录能力。声明了它，看板卡片上就会出现「扫码 / 打开链接登录」入口；
 * 未声明的平台行为完全不变（继续用手工 Cookie 表单）。
 */
export interface ProviderLogin {
  /**
   * 方法标识（如 Qoder 的 `'web'`）。同一平台声明多个方法时用它区分会话；
   * 只有一个方法的平台可省略，此时 `login` 即默认方法。
   */
  id?: string;
  /** 按钮文案，如「扫码登录」 */
  label: string;
  hint: string;
  /** 该链接是否支持手机扫码（Trae 为 false） */
  qr: boolean;
  /**
   * 方法形态，仅用于前端文案/图标。缺省按 `qr` 推导（true → scan，false → link）。
   * `web` = 由服务端驱动本机浏览器抓取登录态（无二维码、无跨设备链接）。
   */
  kind?: 'scan' | 'link' | 'web';
  /** 服务端轮询上游的间隔，默认 2000ms */
  intervalMs?: number;
  start(input: LoginStartInput): Promise<LoginStartResult>;
  poll(secret: unknown, ctx: ProbeContext): Promise<LoginPollResult>;
  /**
   * 接收浏览器回调（Trae 的 `/authorize`）。返回 true 表示已接收；
   * 收到的内容由适配器自己存进 `secret`，供后续 `poll()` 消费。
   */
  handleCallback?(secret: unknown, query: URLSearchParams): boolean | Promise<boolean>;
  /**
   * 会话终结（ready / failed / expired / cancelled）后释放登录期占用的资源。
   *
   * 「网页端登录」的 CDP 标签页与 WebSocket 连接挂在 secret 里，
   * 不释放会一直占用调试 Chrome；没有这类资源的平台不必声明。
   * 由登录会话层在 settle() 里调用；释放失败静默，不影响状态上报。
   */
  cleanup?(secret: unknown): void | Promise<void>;
}

/**
 * 取某个平台可用的登录方法。
 *
 * 规则（保持向后兼容）：
 *   - 声明了 `loginMethods` 时，按 `method` 在其中按 `id` 查；`method` 缺省 → 取第一个；
 *   - 未声明 `loginMethods` 时，`login` 就是唯一的默认方法，`method` 一律忽略。
 *
 * 放在适配器层：会话层与路由都要用同一份判定，避免各写一套。
 */
export function resolveLoginMethod(
  adapter: ProviderAdapter,
  method?: string | null,
): ProviderLogin | null {
  const methods = adapter.loginMethods?.length ? adapter.loginMethods : null;
  if (methods) {
    const wanted = (method ?? '').trim();
    if (!wanted) return methods[0] ?? null;
    return methods.find((item) => (item.id ?? '') === wanted) ?? null;
  }
  return adapter.login ?? null;
}

/**
 * 平台适配器契约。新增平台只需实现 probe() 并注册到 registry。
 * 与 token-monitor 的 per-provider `limits.js` 一一对应。
 */
export interface ProviderAdapter {
  id: string;
  displayName: string;
  /**
   * 该平台改名前的 displayName（占位名兼容）。
   *
   * 占位名 `<displayName> · 登录账号` 是登录时没拿到昵称留下的，
   * 平台改名（如 Qoder 拆成「Qoder 国内版 / Qoder 国际版」）后，
   * 旧条目仍是老前缀——这些名字也要认，否则它们永远等不到自动补昵称
   * （见 `isPlaceholderAccountName` 与 `src/account-store.ts` 的 adoptResolvedAccountName）。
   */
  legacyDisplayNames?: string[];
  region: 'cn' | 'global';
  dashboardUrl: string;
  /** 平台用量页地址：卡片「每日用量」区点击跳转目标（见 src/types.ts 的 usageUrl），没有写空串 */
  usageUrl: string;
  /** 需要哪些凭证 key，缺失即 notConfigured（未声明 isConfigured 时生效） */
  requiredCredentialKeys: string[];
  /**
   * 凭证完整度判断。同一平台可能支持多种凭证形态（Cookie / 登录令牌），
   * `requiredCredentialKeys` 表达不了「A 或 B」，由适配器自己判断。
   * 未声明时回退 `requiredCredentialKeys`（见 src/account-store.ts）。
   */
  isConfigured?: (account: AccountConfig) => boolean;
  credentialHint: string;
  /**
   * 把这个平台的所有账号并进**一张卡片**（每个账号成为卡片里的一条 entry）。
   *
   * 适用于「同一个东西的多份」：A1etherOpenAi 的每个账号都是一把项目密钥 + 一份 quota，
   * 拆成多张卡片会让额度对比被冲散。默认 false = 一个账号一张卡片。
   */
  groupAccounts?: boolean;
  /**
   * 该平台的额度**永不过期**。
   *
   * 必须由适配器显式声明，不能靠「没有批次/没有到期时间」推断——
   * 「确认不会过期」和「上游没给过期信息」是两件事，
   * 后者在界面上应该什么标签都不给，而不是标一个「永不过期」骗人。
   */
  neverExpires?: boolean;
  /**
   * 允许在看板上直接增删该平台的账号（A1etherOpenAi 的「添加 / 删除」按钮）。
   *
   * 前端只认这个开关，不认平台名——以后别的平台想接同样的管理界面，
   * 声明开关 + 提供对应接口即可。
   */
  manageAccounts?: boolean;
  /**
   * 「添加账号」表单的字段声明（配合 manageAccounts 使用）。
   *
   * 只声明 manageAccounts 而不声明字段 = 仍走该平台自己的专用实现
   * （A1etherOpenAi 就是这样：它有两把密钥与项目密钥验证等额外语义）；
   * 两者都声明 = 接入平台无关的通用增删实现（见 src/account-store.ts）。
   */
  manageFields?: ManageFieldDescriptor[];
  /** 表单底部的提示文案（如「Cookie 会先验证，通过了才写入本机配置」） */
  manageHint?: string;
  /**
   * 「扫码 / 打开链接登录」能力。声明后前端在管理区顶部展示登录入口，
   * 手工凭证表单折叠为兜底；未声明则只显示原表单。
   */
  login?: ProviderLogin;
  /**
   * 多个登录方法的完整清单。声明后卡片登录区会出现多个按钮（如 Qoder 的
   * 「扫码登录」+「网页端登录」），每个按钮对应一个方法。
   *
   * 与 `login` 的关系：`login` 仍是默认方法（不传 `method` 时用它），
   * `loginMethods` 只是把可选方法列全；只声明 `login` 的平台行为完全不变。
   * 用 `resolveLoginMethod(adapter, method)` 取方法，不要各处自己判断。
   */
  loginMethods?: ProviderLogin[];
  /**
   * credentials 的键 → .env 变量名前缀。
   * 默认推导为 `${PROVIDER_ID}_${KEY}`（如 codebuddy 的 cookie → CODEBUDDY_COOKIE），
   * 与历史约定不符的平台（如 codearts 的 accessKey → CODEARTS_AK）在这里显式声明。
   * 第 N 个账号的槽位写成 `<前缀>_N`（N≥2）。
   *
   * 也可以传函数：同一平台的凭证变量名要跟着某个**非敏感选项**走时用它
   * （参数是该账号**即将写入**的 options——添加时来自表单，登录时来自登录结果）。
   * 典型场景是「一个实现承载多个平台身份」：如 `qoder.ts` 用工厂产出国内版 / 国际版，
   * 各绑定一张静态表（`QODER_*` / `QODER_GLOBAL_*`），不再靠站点选项推算前缀。
   */
  envNames?: Record<string, string> | ((options: Record<string, string>) => Record<string, string>);
  /**
   * 声明哪些凭证允许在看板上「显示 / 复制」。不声明即整条链路关闭：
   * 快照不带 secrets，`/api/reveal` 也会拒绝该 key。
   *
   * 之所以做成函数而不是静态对象：是否暴露要看账号的具体配置
   * （例如 A1etherOpenAi 默认只暴露项目密钥，账号密钥要显式开启 options.revealApiKey）。
   */
  revealableSecrets?: (account: AccountConfig) => SecretDescriptor[];
  /**
   * 拉取「逐笔用量 / 获取明细」（可选）。返回值里的 `covers` 声明该平台能完整覆盖
   * 的维度：覆盖的维度用上游值（缺记录 = 0），未覆盖的维度回退本地采样兜底
   * （见 src/usage-ledger.ts 与 docs/plans/供应商卡片-用量与增量字段-开发设计方案.md v2）。
   *
   * 未实现此方法 = 该平台四个字段全部走本地采样，行为与 v1 一致。
   */
  fetchUsageLedger?: (account: AccountConfig, ctx: ProbeContext) => Promise<UsageLedger | null>;
  probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot>;
}

export interface SecretDescriptor {
  key: string;
  label: string;
  hint?: string;
}

export interface WindowInput {
  kind?: WindowKind;
  label: string;
  used: number;
  limit: number;
  remaining?: number;
  boundary?: BoundaryKind;
  resetsAt?: string | null;
  expiresAt?: string | null;
  currency?: Currency;
}

/** 归一化额度窗口，百分比与 remaining 由 used/limit 推导，避免上游字段不一致 */
export function makeWindow(input: WindowInput): QuotaWindow {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const used = round(Math.max(0, input.used));
  const limit = round(Math.max(0, input.limit));
  const remaining = round(Math.max(0, input.remaining ?? limit - used));
  const usedPercent = limit > 0 ? clamp((used / limit) * 100, 0, 100) : 0;
  return {
    kind: input.kind ?? 'billing',
    label: input.label,
    used,
    limit,
    remaining,
    usedPercent,
    remainingPercent: clamp(100 - usedPercent, 0, 100),
    boundary: input.boundary ?? 'mixed',
    resetsAt: input.resetsAt ? toIso(input.resetsAt) : null,
    expiresAt: input.expiresAt ? toIso(input.expiresAt) : null,
    showMeter: limit > 0,
  };
}

/**
 * 是否是「登录时没拿到昵称」留下的通用占位名：
 * `<适配器> · 登录账号`，撞名时是 `... 登录账号 2`。
 *
 * 只有这种名字允许在后续拿到昵称时自动改名——用户手动改过的名字一律不动。
 * 放在适配器层：探测（provider）与落库（account-store）要用同一份判定。
 */
export function isPlaceholderAccountName(adapterDisplayName: string, name: string): boolean {
  const pattern = new RegExp(
    `^${adapterDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · 登录账号(?: \\d+)?$`,
  );
  return pattern.test(name.trim());
}

export function makeLot(input: {
  id: string;
  label: string;
  amount: number;
  currency: Currency;
  expiresAt?: string | null;
  note?: string;
  basis?: 'remaining' | 'granted';
}): CreditLot {
  return {
    id: input.id,
    label: input.label,
    amount: Math.max(0, Math.round(input.amount * 100) / 100),
    currency: input.currency,
    expiresAt: input.expiresAt ? toIso(input.expiresAt) : null,
    note: input.note ?? '',
    basis: input.basis ?? 'remaining',
  };
}

/** 分成「仍可用」与「已过期」两组：过期的批次不再逐条展示，只汇总成一句提示 */
export function splitByExpiry(
  lots: CreditLot[],
  now: number,
): { active: CreditLot[]; expired: CreditLot[] } {
  const active: CreditLot[] = [];
  const expired: CreditLot[] = [];
  for (const lot of lots) {
    if (lot.expiresAt && Date.parse(lot.expiresAt) < now) expired.push(lot);
    else active.push(lot);
  }
  return { active, expired };
}

export function sumAmount(lots: CreditLot[]): number {
  return Math.round(lots.reduce((sum, lot) => sum + lot.amount, 0) * 100) / 100;
}

/**
 * 生成「被隐藏批次」的说明。
 * 看板只展示还能用的批次，但不能让人以为数据丢了，所以把过滤掉的数量说清楚。
 */
export function hiddenLotsNote(expired: CreditLot[], usedUpCount = 0): string | null {
  const parts: string[] = [];
  if (usedUpCount > 0) parts.push(`已隐藏 ${usedUpCount} 个已用尽的积分包`);
  if (expired.length > 0) {
    parts.push(
      `另有 ${expired.length} 个批次已过期（共 ${sumAmount(expired)} 积分作废），未在列表中展示`,
    );
  }
  return parts.length > 0 ? parts.join('；') : null;
}

export function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const kept = notes.filter((note): note is string => typeof note === 'string' && note !== '');
  return kept.length > 0 ? kept.join('；') : null;
}

export interface SnapshotInput {
  adapter: ProviderAdapter;
  account: AccountConfig;
  status: ProviderStatus;
  now: number;
  source?: 'api' | 'web' | 'local';
  plan?: string | null;
  balance?: MoneyBalance | null;
  credits?: CreditLot[];
  windows?: QuotaWindow[];
  message?: string | null;
  note?: string | null;
  /** 无批次过期时间时，用窗口的重置时间兜底 */
  fallbackExpiryFromWindow?: boolean;
  /**
   * 本轮刚解析出的展示名（如平台昵称写回后的最终名字）。
   * 缺省时沿用 `account.displayName`；仅用于标题，不改变缓存键。
   */
  displayName?: string | null;
  /**
   * 与 `displayName` 配套的账号标识（前端管理/删除/读取密钥靠它定位）。
   * 改名当轮必须一起给，否则卡片标题已变、操作仍指向旧名字。
   */
  accountId?: string | null;
}

/**
 * 组装快照并计算「最快到期」。
 *
 * 过期时间优先级：
 *   1. credits[].expiresAt 中最早的未来时间（真正意义上的积分过期）
 *   2. 窗口 expir/sreset 时间兜底（周期重置等同于作废）
 */
export function buildSnapshot(input: SnapshotInput): ProviderSnapshot {
  const credits = input.credits ?? [];
  const windows = input.windows ?? [];
  let nextExpiryAt: string | null = null;

  const datedLots = credits
    .filter((lot) => lot.expiresAt !== null && lot.amount > 0)
    .sort((a, b) => Date.parse(a.expiresAt as string) - Date.parse(b.expiresAt as string));
  const futureLot = datedLots.find((lot) => Date.parse(lot.expiresAt as string) >= input.now);
  if (futureLot) nextExpiryAt = futureLot.expiresAt;

  if (!nextExpiryAt && input.fallbackExpiryFromWindow !== false) {
    const boundaryTimes = windows
      .map((window) => window.expiresAt ?? (window.boundary === 'reset' ? window.resetsAt : null))
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const future = boundaryTimes.find((value) => Date.parse(value) >= input.now);
    if (future) nextExpiryAt = future;
  }

  // 合并成一张卡片的平台，标题用适配器名（账号身份下移到 entries[].id），
  // 否则多张卡片会顶着各自的账号名、看起来像不同平台
  const displayName = input.adapter.groupAccounts
    ? input.adapter.displayName
    : input.displayName || input.account.displayName || input.adapter.displayName;

  return {
    provider: input.adapter.id,
    displayName,
    accountId: input.accountId ?? input.account.displayName ?? '',
    groupAccounts: input.adapter.groupAccounts === true,
    neverExpires: input.adapter.neverExpires === true,
    manageAccounts: input.adapter.manageAccounts === true,
    entries: [],
    region: input.adapter.region,
    status: input.status,
    source: input.source ?? 'api',
    updatedAt: new Date(input.now).toISOString(),
    plan: input.plan ?? null,
    balance: input.balance ?? null,
    credits,
    windows,
    nextExpiryAt,
    nextExpiryInDays: nextExpiryAt ? daysBetween(input.now, nextExpiryAt) : null,
    dashboardUrl: input.adapter.dashboardUrl,
    usageUrl: input.adapter.usageUrl,
    message: input.message ?? null,
    note: input.note ?? null,
    secrets: describeSecrets(input.adapter, input.account),
    stale: false,
    // 日级用量由编排层用本地采样历史填充，适配器不感知
    dailyUsage: null,
  };
}

/**
 * 密钥掩码。保留前后缀是为了让「多个账号」场景下能一眼分辨是哪把钥匙，
 * 这与各家控制台存 `key_prefix` 的做法一致；短到没法安全截断时整体打码。
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * 把适配器声明的可托管凭证转成快照里的 secrets。
 * 只输出**是否存在 + 掩码预览**，明文永远不进快照、不进 API 响应。
 */
export function describeSecrets(
  adapter: ProviderAdapter,
  account: AccountConfig,
): SecretRef[] {
  const declared = adapter.revealableSecrets?.(account) ?? [];
  const out: SecretRef[] = [];
  for (const item of declared) {
    const value = account.credentials[item.key];
    if (!value) continue;
    out.push({
      key: item.key,
      label: item.label,
      preview: maskSecret(value),
      hint: item.hint ?? '',
    });
  }
  return out;
}

export function notConfigured(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  missingKeys: string[],
): ProviderSnapshot {
  return buildSnapshot({
    adapter,
    account,
    status: 'notConfigured',
    now: ctx.now,
    source: 'api',
    message: `缺少凭证：${missingKeys.join(', ')}。${adapter.credentialHint}`,
  });
}

export function failure(
  adapter: ProviderAdapter,
  account: AccountConfig,
  ctx: ProbeContext,
  status: ProviderStatus,
  message: string,
): ProviderSnapshot {
  return buildSnapshot({ adapter, account, status, now: ctx.now, source: 'api', message });
}

/** 从凭证/选项中取第一个非空值，凭证优先 */
export function cred(
  account: AccountConfig,
  ctx: ProbeContext,
  keys: string[],
  optionKeys: string[] = [],
): string {
  for (const key of keys) {
    const value = account.credentials[key];
    if (value) return value;
  }
  for (const key of optionKeys) {
    const value = account.options[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function optString(account: AccountConfig, key: string): string {
  const value = account.options[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function optNumber(account: AccountConfig, key: string): number | null {
  const value = account.options[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** options 里的布尔开关，兼容 true / "true" / 1 / "1" */
export function optBool(account: AccountConfig, key: string, fallback = false): boolean {
  const value = account.options[key];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * 从任意粘贴形式里抽出指定请求头的值。兼容以下三种常见做法：
 *   1. DevTools 右键请求 → Copy as cURL：
 *      curl 'https://x' -H 'cookie: a=1; b=2' -H "authorization: Bearer x"
 *   2. 从 Request Headers 直接复制一整行：Cookie: a=1; b=2
 *   3. 只复制值本身：a=1; b=2
 */
export function extractHeaderValue(raw: string, headerName: string): string {
  const value = raw.trim();
  if (!value) return '';
  const name = headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const curl = new RegExp(
    `(?:-H|--header)\\s+(['"])\\s*${name}\\s*:\\s*([\\s\\S]*?)\\1`,
    'i',
  ).exec(value);
  if (curl?.[2]) return curl[2].trim();
  const line = new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*([^\\n]+)`, 'i').exec(value);
  if (line?.[1]) return line[1].trim();
  return value;
}

/**
 * 把裸 Cookie 值 / `Cookie:` 头 / cURL 抓包统一成可直接发送的 Cookie 头。
 * 另外兼容 Cookie 被换行折行的情况：只把后续仍然长得像 `k=v` 的行拼回来，
 * 这样多行 cURL 命令行不会被误吞。
 */
export function normalizeCookieHeader(raw: string): string {
  const first = extractHeaderValue(raw, 'cookie').replace(/\s+/g, ' ').trim();
  if (!first) return '';
  const continuations = raw
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[^\s:=]+=[^\s;]*;?$/.test(line));
  if (continuations.length === 0) return first;
  return `${first} ${continuations.join(' ')}`.replace(/\s+/g, ' ').trim();
}

/** 从多个候选字段里抽取过期时间，兼容各家命名 */
export function extractExpiry(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const record = source as Record<string, unknown>;
  const nested = [
    record,
    (record.entitlement_base_info ?? record.entitlementBaseInfo) as
      | Record<string, unknown>
      | undefined,
    (record.quota ?? {}) as Record<string, unknown>,
    (record.pack ?? {}) as Record<string, unknown>,
  ].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);

  for (const candidate of nested) {
    const raw = firstString(
      candidate.expiresAt,
      candidate.expires_at,
      candidate.expireAt,
      candidate.expire_at,
      candidate.expireTime,
      candidate.expire_time,
      candidate.expiryDate,
      candidate.expiry_date,
      candidate.validUntil,
      candidate.valid_until,
      candidate.validEndTime,
      candidate.valid_end_time,
      candidate.endTime,
      candidate.end_time,
      candidate.deadline,
    );
    if (raw) {
      const iso = toIso(raw);
      if (iso) return iso;
    }
    const numeric = candidate.expiredAt ?? candidate.expired_at;
    if (numeric !== undefined) {
      const iso = toIso(numeric);
      if (iso) return iso;
    }
  }
  return null;
}
