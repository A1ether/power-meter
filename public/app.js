// 二维码编码器（MIT 单文件，来源与改造点见 public/vendor/README.md）：执行后挂到 window.QRCode
import './vendor/qrcode.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 每张卡片默认展示的积分数，其余折叠 */
const VISIBLE_LOTS = 3;

/** 合并卡片里默认展示的账号数，其余折叠 */
const VISIBLE_ENTRIES = 2;

/**
 * 来源文案：upstream = 平台明细接口，local = 本地采样兜底，mixed = 合并卡片里两者混合
 * （由后端 dailyUsage.sources 下发，见 src/service.ts 的 withDailyUsage）
 */
const USAGE_SOURCE_LABELS = {
  upstream: '来源：平台明细',
  local: '来源：本地采样兜底（该平台无此明细）',
  mixed: '来源：平台明细 + 本地采样',
};

/**
 * 卡片上的日级用量 / 增量四字段（展示顺序即此顺序）。
 * 口径（2026-10-10 用户确认）：
 *   - 用量 = 该日额度**减少量**之和（使用的量）；
 *   - 增量 = 该日额度**增加量**之和（增加的量，如每日签到、充值）；
 *   两者互不抵消，按本地时间 00:00–24:00 切日。
 * 数据优先来自后端 provider.dailyUsage（平台明细接口，见 src/usage-ledger.ts）。
 * `increase: true` 的字段按正负着色（正=绿、零=灰）并给正数加「+」前缀。
 */
const USAGE_FIELDS = [
  {
    key: 'yesterdayUsed',
    label: '昨日用量',
    increase: false,
    dimension: 'used',
    hint: '昨日（本地时间 00:00–24:00）的消耗合计；增加不计入',
  },
  {
    key: 'yesterdayAdded',
    label: '昨日增量',
    increase: true,
    dimension: 'added',
    hint: '昨日的增加合计（如每日签到、充值）；消耗不计入',
  },
  {
    key: 'todayUsed',
    label: '今日用量',
    increase: false,
    dimension: 'used',
    hint: '今日（本地时间 00:00 起）的消耗合计；增加不计入',
  },
  {
    key: 'todayAdded',
    label: '今日增量',
    increase: true,
    dimension: 'added',
    hint: '今日的增加合计（如每日签到、充值）；消耗不计入',
  },
];

const state = {
  data: null,
  sort: 'expiry',
  query: '',
  autoRefresh: true,
  timer: null,
  loading: false,
  /**
   * 已被显式「显示」或「复制」过的托管密钥明文（key = provider#accountId#field）。
   * 只活在内存里，手动刷新时清空——否则凭证轮换后这页还举着旧值。
   */
  revealed: new Map(),
  /**
   * 增删账号的结果提示（key = 卡片键 `provider#accountId`，见 cardKeyOf）。
   * 存到 state 而不是直接写 DOM：操作完会重新拉一次数据、整张卡片重建，
   * 直接写 DOM 的话提示会跟着一起没掉。
   * 同一平台有多张卡片时（如两个 CodeBuddy 账号），提示只落在操作过的那张卡上。
   */
  manageMessages: new Map(),
  /** GET /api/accounts?provider= 的缓存（含已停用、取数失败的账号），按平台分桶 */
  configuredAccounts: new Map(),
  /** GET /api/providers 的适配器元信息：管理表单的字段声明与文案都来自它（只拉一次） */
  adapterMeta: null,
  /**
   * 当前登录会话：`{ providerId, method, session, timer }`。
   * 全局只保留一个——发起新登录会先取消旧会话，避免两个二维码同时有效。
   * method 是会话的登录方法（`ProviderLogin.id`）：同一平台的扫码与网页端
   * 登录各是一个会话，按钮按 provider+method 匹配自己的状态。
   */
  login: null,
  /**
   * 管理区处于展开状态的卡片（key = cardKeyOf）。
   * 登录轮询会整张重建卡片，展开态必须存在 state 里，否则二维码面板会被收起来。
   */
  manageOpen: new Set(),
  /** 手工凭证 <details> 被用户展开过的卡片（同上，重建卡片时要恢复） */
  manualOpen: new Set(),
  /**
   * 「平台与账号」弹窗的状态：
   *   - providerId = null 时显示平台列表（含一个账号都没有的平台）；
   *   - providerId 非空时显示该平台的登录 / 添加表单（与卡片内管理区同一套逻辑）。
   */
  dialog: { providerId: null },
  /** GET /api/accounts/overview 的缓存；增删 / 登录成功后置空重拉 */
  platformOverview: null,
  /**
   * 左侧导航「按平台」子菜单是否展开。必须存 state：render() / renderGrid() 会
   * 反复重建这个子菜单，展开态写进 DOM 会被下一次渲染重置。
   */
  navPlatformsOpen: false,
  /** 当前 scrollspy 命中的导航目标（data-target 值）；null 表示还没算过 */
  activeTarget: null,
  /** 命令面板当前这一屏的命令（见 buildCommands），index 是选中项 */
  commands: [],
  cmdIndex: -1,
  /**
   * 点击导航项后正在做平滑滚动。滚动过程中 scrollspy 会把途经的区块逐个点亮，
   * 所以这段时间先锁住，等落位（scrollend / 兜底定时器）再交还给 scrollspy。
   */
  navScrollLock: false,
};

/** 登录会话轮询间隔：与后端 intervalMs 无关，后端已经是后台轮询，前端只读状态 */
const LOGIN_POLL_MS = 1_500;

const els = {
  summary: document.getElementById('summary'),
  alert: document.getElementById('alert'),
  grid: document.getElementById('grid'),
  timeline: document.getElementById('timeline'),
  diagnostics: document.getElementById('diagnostics'),
  meta: document.getElementById('meta'),
  subtitle: document.getElementById('subtitle'),
  footerUpdated: document.getElementById('footer-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  autoRefresh: document.getElementById('auto-refresh'),
  sort: document.getElementById('sort'),
  search: document.getElementById('search'),
  cardTemplate: document.getElementById('card-template'),
  manageTemplate: document.getElementById('manage-template'),
  platformsBtn: document.getElementById('platforms-btn'),
  platformsDialog: document.getElementById('platforms-dialog'),
  platformsClose: document.getElementById('platforms-close'),
  platformsTitle: document.getElementById('platforms-title'),
  platformsSubtitle: document.getElementById('platforms-subtitle'),
  platformsBody: document.getElementById('platforms-body'),
  // 新版看板外壳（public/index.html）：导航、徽标、状态条、命令面板、移动端停靠栏
  pageTitle: document.getElementById('page-title'),
  statusChip: document.getElementById('status-chip'),
  statusText: document.getElementById('status-text'),
  nav: document.getElementById('nav'),
  navPill: document.querySelector('#nav .nav__pill'),
  navGroupPlatforms: document.getElementById('nav-group-platforms'),
  navPlatforms: document.getElementById('nav-platforms'),
  navBadgePlatforms: document.getElementById('nav-badge-platforms'),
  navBadgeProviders: document.getElementById('nav-badge-providers'),
  navBadgeTimeline: document.getElementById('nav-badge-timeline'),
  navBadgeDiag: document.getElementById('nav-badge-diag'),
  dock: document.getElementById('dock'),
  dockPill: document.querySelector('#dock .dock__pill'),
  dockCmd: document.getElementById('dock-cmd'),
  cmdOpen: document.getElementById('cmd-open'),
  cmdBtn: document.getElementById('cmd-btn'),
  cmd: document.getElementById('cmd'),
  cmdInput: document.getElementById('cmd-input'),
  cmdList: document.getElementById('cmd-list'),
  cmdEmpty: document.getElementById('cmd-empty'),
  cmdHint: document.getElementById('cmd-hint'),
};

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function fmtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return numberFormat.format(value);
}

function fmtDate(iso) {
  if (!iso) return '未知';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '未知';
  return dateFormat.format(new Date(ts));
}

function pluralize(days) {
  const abs = Math.abs(days);
  if (abs < 1) {
    const hours = Math.max(0, Math.round(abs * 24));
    return `${hours} 小时`;
  }
  return `${Math.round(abs)} 天`;
}

function expiryText(inDays) {
  if (inDays === null || inDays === undefined || Number.isNaN(inDays)) return '无过期时间';
  if (inDays < 0) return `已过期 ${pluralize(inDays)}`;
  if (inDays < 1 / 24) return '不足 1 小时';
  return `${pluralize(inDays)}后到期`;
}

function levelFor(inDays, thresholds) {
  if (inDays === null || inDays === undefined || Number.isNaN(inDays)) return 'none';
  if (inDays < 0) return 'none';
  if (inDays <= thresholds.criticalDays) return 'critical';
  if (inDays <= thresholds.warningDays) return 'warning';
  return 'safe';
}

function urgencyOf(provider, thresholds) {
  const levels = provider.credits
    .filter((lot) => lot.amount > 0)
    .map((lot) => levelFor(daysUntil(lot.expiresAt), thresholds));
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'safe';
}

function daysUntil(iso) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return (ts - Date.now()) / 86_400_000;
}

function balanceFor(provider) {
  if (provider.balance) return provider.balance.amount;
  return provider.credits.reduce((sum, lot) => sum + lot.amount, 0);
}

function currencyFor(provider) {
  return provider.balance?.currency ?? provider.credits[0]?.currency ?? 'CREDITS';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load(force = false) {
  if (state.loading) return;
  state.loading = true;
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = '刷新中…';
  // 手动刷新 = 「重新读一遍配置」，此时把上一轮读出来的明文密钥与配置清单都丢掉
  if (force) {
    state.revealed.clear();
    state.configuredAccounts.clear();
    state.platformOverview = null;
  }
  try {
    // 适配器元信息（「＋ 添加账号」的字段声明）先就位，否则首屏渲染不出表单字段
    await loadAdapterMeta();
    const response = await fetch(`/api/summary${force ? '?force=1' : ''}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    state.data = await response.json();
    render();
  } catch (error) {
    els.diagnostics.replaceChildren(
      element('div', 'diag diag--warn', `加载失败：${error.message}`),
    );
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = '立即刷新';
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  renderSummary(data);
  renderAlert(data);
  renderSortOptions(data);
  renderGrid(data);
  renderTimeline(data);
  renderDiagnostics(data);
  // 外壳（导航徽标 / 平台子菜单 / 状态条）跟着同一份数据走，放在业务渲染之后
  renderShell(data);

  els.meta.textContent = `共 ${data.providers.length} 个平台 · 服务端缓存 ${data.cacheTtlSeconds}s`;
  els.subtitle.textContent = `多平台余额 / 积分看板 · ${data.totals.ok} 个平台数据正常`;
  els.footerUpdated.textContent = `数据生成于 ${fmtDate(data.generatedAt)}`;
}

function renderSummary(data) {
  const { totals, expiryThresholds, expiryTimeline } = data;
  els.summary.replaceChildren();

  const availableRows = Object.entries(totals.availableByCurrency ?? {})
    .filter(([, amount]) => amount > 0)
    .map(([currency, amount]) => ({ unit: currency, amount: fmtNumber(amount) }));

  const critical = expiryTimeline.filter(
    (hit) => hit.inDays <= expiryThresholds.criticalDays,
  ).length;
  const warning = expiryTimeline.filter(
    (hit) =>
      hit.inDays > expiryThresholds.criticalDays && hit.inDays <= expiryThresholds.warningDays,
  ).length;

  const stats = [
    { label: '平台总数', value: String(totals.providers), hint: `${totals.ok} 正常 / ${totals.failed} 异常` },
    {
      label: '可用额度合计',
      rows: availableRows.length > 0 ? availableRows : [{ unit: '', amount: '–' }],
      hint: '各币种余额独立汇总，数值之间互不换算',
    },
    {
      label: `≤${expiryThresholds.criticalDays} 天到期`,
      value: String(critical),
      hint: `${expiryThresholds.criticalDays}~${expiryThresholds.warningDays} 天内还有 ${warning} 笔`,
      accent: critical > 0,
    },
    {
      label: '到期批次总数',
      value: String(expiryTimeline.length),
      hint: '只统计仍可用的积分批次',
    },
  ];

  for (const stat of stats) {
    const card = element('div', `stat${stat.accent ? ' stat--accent' : ''}`);
    card.append(element('span', 'stat__label', stat.label));
    if (stat.rows) {
      const rows = element('div', 'stat__rows');
      for (const row of stat.rows) {
        const rowEl = element('div', 'stat__row');
        rowEl.append(
          row.unit ? element('span', 'stat__row-unit', row.unit) : element('span'),
          element('span', 'stat__row-amount', row.amount),
        );
        rows.append(rowEl);
      }
      card.append(rows);
    } else {
      card.append(element('span', 'stat__value', stat.value));
    }
    card.append(element('span', 'stat__hint', stat.hint));
    els.summary.append(card);
  }
}

function renderAlert(data) {
  const next = data.nextExpiry;
  if (!next) {
    els.alert.hidden = true;
    return;
  }
  const level = levelFor(next.inDays, data.expiryThresholds);
  els.alert.hidden = false;
  els.alert.className = `alert${level === 'critical' ? ' alert--danger' : level === 'warning' ? ' alert--warning' : ''}`;
  els.alert.replaceChildren();

  const body = element('div', 'alert__body');
  body.append(
    element('strong', null, `最快到期：${next.displayName} · ${next.lotLabel}`),
    element(
      'p',
      null,
      `${fmtNumber(next.amount)} ${next.currency} 将于 ${fmtDate(next.expiresAt)} 到期（${expiryText(next.inDays)}），建议优先使用。`,
    ),
  );
  els.alert.append(element('span', 'alert__icon', level === 'critical' ? '🔥' : '⏳'), body);
}

function renderSortOptions(data) {
  const thresholds = data.expiryThresholds;
  const risky = data.providers.filter(
    (provider) => urgencyOf(provider, thresholds) !== 'safe',
  ).length;
  const option = els.sort.querySelector('option[value="risk"]');
  if (option) option.textContent = `仅看有到期风险的（${risky}）`;
  els.sort.value = state.sort;
}

/**
 * 站点 → 前端文案。Qoder 的国内站 / 国际站是同一个 provider 下的两个账号，
 * 「按平台」子菜单、「平台与账号」弹窗与卡片 region 徽标都按这张表说人话。
 * 出现未登记的站点值时回退大写标识，不抛错——分组与筛选仍然可用。
 */
const SITE_LABELS = { cn: '国内版', global: '国际版' };

/**
 * 站点筛选词：`<平台名> <站点标签>`。
 *
 * 子菜单行的标签、命令面板的「查看 X」、卡片搜索 haystack 三处**必须**走同一个函数，
 * 否则「点菜单能筛到、手输同样的词却筛空」这种口径分裂就会出现。
 */
function siteFilterTerm(baseName, region) {
  const site = SITE_LABELS[region] ?? String(region ?? '').toUpperCase();
  return `${baseName} ${site}`.trim();
}

/** 平台显示名：优先用 /api/providers 的适配器名（干净、稳定，不含账号后缀） */
function baseNameOf(providerId, members) {
  const meta = metaFor({ provider: providerId });
  if (meta?.displayName) return meta.displayName;
  // 回退：快照标题去掉「 · 账号名」后缀，避免把某一账号的身份当成平台名
  const first = members[0]?.displayName ?? providerId;
  return first.split(' · ')[0].trim() || providerId;
}

/**
 * 哪些平台需要按站点拆行：同一 provider 的快照里出现了多于一种 region。
 *
 * 只有这类平台才需要「Qoder CN / Qoder 国际版」两行；CodeBuddy 两个账号都是 cn，
 * 语义上就是一个平台，合并成一行才是对的。
 */
function crossRegionProviders(providers) {
  const seen = new Map();
  for (const provider of providers) {
    if (!seen.has(provider.provider)) seen.set(provider.provider, new Set());
    seen.get(provider.provider).add(provider.region);
  }
  const cross = new Set();
  for (const [id, regions] of seen) {
    if (regions.size > 1) cross.add(id);
  }
  return cross;
}

/**
 * 「按平台」子菜单与命令面板的行模型：一个平台一行；跨站点平台按站点拆行。
 *
 * 返回 `[{ key, provider, region, label, members }]`，其中 region 为 null 表示
 * 未拆站点的整平台行。行数口径 = 平台数（跨站点平台按站点计），与「按平台」一致。
 */
function platformGroups(data) {
  const providers = data?.providers ?? [];
  if (providers.length === 0) return [];

  const cross = crossRegionProviders(providers);
  const buckets = new Map();

  for (const provider of providers) {
    const split = cross.has(provider.provider);
    const key = split ? `${provider.provider}#${provider.region}` : provider.provider;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.members.push(provider);
    } else {
      buckets.set(key, {
        key,
        provider: provider.provider,
        region: split ? provider.region : null,
        members: [provider],
      });
    }
  }

  return [...buckets.values()].map((group) => {
    const baseName = baseNameOf(group.provider, group.members);
    return {
      ...group,
      label: group.region ? siteFilterTerm(baseName, group.region) : baseName,
    };
  });
}

/**
 * 组金额：组内可用快照、**同币种**才求和。
 * 混币种返回 null（界面显示 —），与 src/aggregate.ts 的取向一致——
 * 不同单位硬加会给出一个假数字。
 */
function groupBalance(members) {
  const healthy = members.filter((item) => item.status === 'ok' || item.status === 'demo');
  if (healthy.length === 0) return null;
  const currencies = new Set(healthy.map((item) => currencyFor(item)));
  if (currencies.size > 1) return null;
  return healthy.reduce((sum, item) => sum + balanceFor(item), 0);
}

/** 组状态点：组内最紧急的那一条（critical > warning > safe） */
function groupUrgency(members, thresholds) {
  const levels = members.map((item) => urgencyOf(item, thresholds));
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'safe';
}

function sortedProviders(data) {
  const thresholds = data.expiryThresholds;
  const query = state.query.trim().toLowerCase();
  let providers = data.providers;
  // 跨站点平台（如 Qoder）的卡片要能被「Qoder CN / Qoder 国际版」精确命中：
  // 卡片标题里没有站点字样，所以在这里补上站点筛选词（与子菜单同源）
  const crossRegion = crossRegionProviders(providers);

  if (query) {
    providers = providers.filter((provider) => {
      const siteText = crossRegion.has(provider.provider)
        ? siteFilterTerm(baseNameOf(provider.provider, [provider]), provider.region)
        : '';
      const haystack = [
        provider.displayName,
        provider.provider,
        provider.plan ?? '',
        siteText,
        currencyFor(provider),
        ...provider.credits.map((lot) => lot.label),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  if (state.sort === 'risk') {
    providers = providers.filter((provider) => urgencyOf(provider, thresholds) !== 'safe');
  }

  const rank = { critical: 0, warning: 1, safe: 2 };
  const sorted = [...providers];
  sorted.sort((a, b) => {
    switch (state.sort) {
      case 'amount-asc':
        return balanceFor(a) - balanceFor(b);
      case 'amount-desc':
        return balanceFor(b) - balanceFor(a);
      case 'name':
        return a.displayName.localeCompare(b.displayName, 'zh-CN');
      case 'status':
        return Number(a.status === 'ok' || a.status === 'demo') - Number(b.status === 'ok' || b.status === 'demo');
      case 'risk':
      case 'expiry':
      default: {
        const levelDiff = rank[urgencyOf(a, thresholds)] - rank[urgencyOf(b, thresholds)];
        if (levelDiff !== 0) return levelDiff;
        const aDays = a.nextExpiryInDays ?? Number.POSITIVE_INFINITY;
        const bDays = b.nextExpiryInDays ?? Number.POSITIVE_INFINITY;
        if (aDays !== bDays) return aDays - bDays;
        return a.displayName.localeCompare(b.displayName, 'zh-CN');
      }
    }
  });
  return sorted;
}

function renderGrid(data) {
  const thresholds = data.expiryThresholds;
  const providers = sortedProviders(data);
  // 「额度卡片」徽标就是排序 / 筛选后的张数：所有分支（含空结果提前 return）都要同步，
  // 所以放在算完 providers 的位置，而不是函数末尾
  refreshProviderBadge(providers.length);
  els.grid.replaceChildren();

  if (providers.length === 0) {
    if (state.query) {
      els.grid.append(element('div', 'empty', '没有匹配的平台'));
      return;
    }
    // 空看板是「第一次使用」的常态：给出直达添加入口，而不是让用户去翻文档
    const empty = element('div', 'empty');
    empty.append(
      element('p', 'empty__title', '还没有启用的平台'),
      element('p', 'empty__hint', '点下面的按钮登录或填写凭证，完成后这里会自动出现卡片。'),
    );
    const addBtn = element('button', 'btn btn--primary empty__action', '＋ 添加平台账号');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => openPlatformsDialog());
    empty.append(addBtn);
    els.grid.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  // 跨站点平台（如 Qoder）的卡片徽标要显示站点标签，与「按平台」子菜单的行文案对齐
  const crossRegion = crossRegionProviders(providers);
  for (const provider of providers) {
    fragment.append(buildCard(provider, thresholds, crossRegion));
  }
  els.grid.append(fragment);
}

function buildCard(provider, thresholds, crossRegion = new Set()) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  const healthy = provider.status === 'ok' || provider.status === 'demo';
  node.dataset.state = healthy ? 'ok' : 'failed';
  node.dataset.urgency = urgencyOf(provider, thresholds);

  node.querySelector('.card__name').textContent = provider.displayName;

  const tags = node.querySelector('.card__tags');
  // 同平台跨站点时（Qoder 国内 / 国际），徽标说「CN / 国际版」才和左侧子菜单对得上；
  // 只有一个站点的平台保持原「国内 / 国际」，不为没有歧义的地方造新词
  const regionText = crossRegion.has(provider.provider)
    ? (SITE_LABELS[provider.region] ?? String(provider.region ?? '').toUpperCase())
    : provider.region === 'cn'
      ? '国内'
      : '国际';
  tags.append(element('span', `chip chip--${provider.region}`, regionText));
  if (provider.status === 'demo') tags.append(element('span', 'chip chip--demo', '示例数据'));
  if (provider.stale) tags.append(element('span', 'chip chip--warning', '数据可能过期'));
  // 有到期概念的走三色分级；明确不过期的（如 A1etherOpenAi 的 quota）直接给绿色标签。
  // 两者互斥：一旦声明了永不过期，就不该再出现任何到期倒计时
  if (provider.neverExpires) {
    tags.append(element('span', 'chip chip--ok', '永不过期'));
  } else if (provider.nextExpiryInDays !== null) {
    const level = levelFor(provider.nextExpiryInDays, thresholds);
    const label = `${expiryText(provider.nextExpiryInDays)}`;
    tags.append(
      element(
        'span',
        `chip chip--${level === 'critical' ? 'danger' : level === 'warning' ? 'warning' : 'ok'}`,
        label,
      ),
    );
  }
  if (!healthy) tags.append(element('span', 'chip chip--danger', provider.status));

  node.querySelector('.card__amount').textContent = healthy ? fmtNumber(balanceFor(provider)) : '—';
  node.querySelector('.card__currency').textContent = healthy ? currencyFor(provider) : '';

  const planText = [provider.plan, provider.source === 'local' ? '本地示例' : null]
    .filter(Boolean)
    .join(' · ');
  const planNode = node.querySelector('.card__plan');
  planNode.textContent = planText;
  // 没有套餐名时整行隐藏，避免空 <p> 带着负 margin 参与排版，让各卡片高度不一致
  planNode.hidden = planText === '';

  renderUsage(node, provider, healthy);

  const meter = node.querySelector('.meter');
  const primaryWindow = provider.windows.find((window) => window.showMeter);
  if (healthy && primaryWindow) {
    meter.hidden = false;
    node.querySelector('.meter__fill').style.width = `${Math.max(2, 100 - primaryWindow.usedPercent)}%`;
    node.querySelector('.meter__left').textContent = primaryWindow.label;
    node.querySelector('.meter__right').textContent =
      `剩余 ${fmtNumber(primaryWindow.remaining)} / ${fmtNumber(primaryWindow.limit)}` +
      (primaryWindow.resetsAt ? ` · ${fmtDate(primaryWindow.resetsAt)} 重置` : '');
  } else {
    meter.hidden = true;
  }

  const lotsContainer = node.querySelector('.lots');
  const list = node.querySelector('.lots__list');
  const credits = [...provider.credits].sort(
    (a, b) => (daysUntil(a.expiresAt) ?? Number.POSITIVE_INFINITY) - (daysUntil(b.expiresAt) ?? Number.POSITIVE_INFINITY),
  );

  if (!healthy) {
    lotsContainer.replaceChildren(element('p', 'card__error', provider.message || '取数失败'));
  } else if (credits.length === 0) {
    lotsContainer.replaceChildren(
      element('p', 'card__note muted', '该平台目前没有可用的积分批次'),
    );
  } else {
    credits.forEach((lot, index) => {
      const days = daysUntil(lot.expiresAt);
      const level = levelFor(days, thresholds);
      const item = element('li', `lot${index >= VISIBLE_LOTS ? ' lot--collapsed' : ''}`);
      item.dataset.level = level;
      const amount = element('span', 'lot__amount', `${fmtNumber(lot.amount)} ${lot.currency}`);
      if (lot.basis === 'granted') {
        // 平台只给账户级剩余时，批次金额是「该周期授予量」，避免被误当成剩余
        amount.append(element('span', 'lot__basis', ' 授予量'));
      }
      item.append(element('span', 'lot__label', lot.label), amount);
      const expiry = element('div', 'lot__expiry');
      expiry.append(
        element('span', null, lot.expiresAt ? `过期：${fmtDate(lot.expiresAt)}` : '不过期'),
        element('span', 'lot__badge', expiryText(days)),
      );
      item.append(expiry);
      if (lot.note) item.title = lot.note;
      list.append(item);
    });

    // 超出 VISIBLE_LOTS 的折叠起来，避免单个平台把整屏占满
    const hiddenCount = credits.length - VISIBLE_LOTS;
    if (hiddenCount > 0) {
      const toggle = element('button', 'lots__toggle', `展开其余 ${hiddenCount} 个 ⌄`);
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const expanded = list.classList.toggle('lots__list--expanded');
        toggle.textContent = expanded ? '收起 ⌃' : `展开其余 ${hiddenCount} 个 ⌄`;
        toggle.setAttribute('aria-expanded', String(expanded));
      });
      lotsContainer.append(toggle);
    }
  }

  const note = node.querySelector('.card__note');
  if (provider.note && healthy) {
    note.hidden = false;
    note.textContent = provider.note;
  } else {
    note.hidden = true;
  }

  renderEntries(node, provider);
  renderSecrets(node, provider);

  // 管理区来自 #manage-template：卡片与「平台与账号」弹窗共用同一套渲染逻辑。
  // 每次重建都克隆一份，避免把上一次的输入值 / 结果提示带进来。
  const slot = node.querySelector('.manage-slot');
  slot.replaceChildren();
  const manageRoot = els.manageTemplate.content.firstElementChild.cloneNode(true);
  slot.append(manageRoot);
  renderManage(manageRoot, cardTarget(provider), {
    toggle: node.querySelector('.manage__toggle'),
  });

  node.querySelector('.card__updated').textContent = `更新于 ${fmtDate(provider.updatedAt)}`;
  const link = node.querySelector('.card__link');
  if (provider.dashboardUrl) {
    link.href = provider.dashboardUrl;
  } else {
    link.hidden = true;
  }

  return node;
}

/**
 * 日级用量 / 增量区块（四字段，2×2 网格）。
 *
 * 平台声明了 usageUrl 时，整块是跳转到平台用量页的外链（新窗口打开）；
 * 没有用量页的平台保持纯展示（见 src/types.ts 的 usageUrl）。
 *
 * 取值严格对应后端 provider.dailyUsage 的同名键；字段整体缺失（旧后端）
 * 或该日为 null 时显示「–」——新装首日看不到「昨日」属正常，不当作错误。
 * 增量按正负着色（正=绿、零=灰；现口径为「增加量之和」，负值分支防御性保留）；
 * 用量为消耗口径（非负）不着色。
 */
function renderUsage(node, provider, healthy) {
  const box = node.querySelector('.usage');
  if (!healthy) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  // 用量区整块可点：透明地复用平台声明的用量页，前端不硬编码任何平台地址
  if (provider.usageUrl) {
    box.href = provider.usageUrl;
    box.classList.add('usage--link');
    box.setAttribute('aria-label', `打开 ${provider.displayName} 用量页（新窗口）`);
  }

  const usage = provider.dailyUsage ?? {};
  const currency = usage.currency ?? currencyFor(provider);
  const grid = node.querySelector('.usage__grid');
  grid.replaceChildren();

  for (const field of USAGE_FIELDS) {
    const value = usage[field.key];
    const item = element('div', 'usage__item');
    const label = element('span', 'usage__label', field.label);
    const valueNode = element('span', 'usage__value');
    const source = USAGE_SOURCE_LABELS[usage.sources?.[field.dimension]] ?? USAGE_SOURCE_LABELS.local;

    if (value === null || value === undefined || Number.isNaN(value)) {
      valueNode.textContent = '–';
      valueNode.classList.add('usage__value--none');
      item.title = `${field.label}：暂无数据（${source}；看板被打开并采样后自动出现）`;
    } else {
      // 增加量显式带「+」，与「用量」在视觉上区分开
      valueNode.textContent = `${field.increase && value > 0 ? '+' : ''}${fmtNumber(value)} ${currency}`;
      if (field.increase) {
        valueNode.classList.add(
          value > 0 ? 'usage__value--up' : value < 0 ? 'usage__value--down' : 'usage__value--zero',
        );
      }
      // 数值过长被省略号截断时，悬停仍能看到完整值、口径与来源
      item.title = `${field.label}：${valueNode.textContent}（${field.hint}；${source}）`;
    }
    item.append(label, valueNode);
    grid.append(item);
  }
}

/**
 * 多账号合并的平台（provider.entries 非空）：一条账号一行，
 * 「掩码密钥 + 该账号的可用额度」放在一起，方便横向对比谁快用完了。
 */
function renderEntries(node, provider) {
  const box = node.querySelector('.entries');
  const list = node.querySelector('.entries__list');
  const entries = Array.isArray(provider.entries) ? provider.entries : [];
  list.replaceChildren();
  box.hidden = entries.length === 0;
  if (entries.length === 0) return;

  // 合并卡片里额度由条目表达，卡片顶部保留合计；
  // 而「进度条 / 积分批次（过期·剩余）」是给有到期概念的平台用的，
  // 对「不过期的 quota」没有意义，整块隐掉
  node.querySelector('.meter').hidden = true;
  node.querySelector('.lots').hidden = true;

  entries.forEach((entry, index) => {
    const row = buildEntry(provider, entry);
    if (index >= VISIBLE_ENTRIES) row.classList.add('entry--collapsed');
    list.append(row);
  });

  // 超出 VISIBLE_ENTRIES 的折叠起来，避免账号一多就把卡片撑爆
  // （与「可用积分批次」是同一套交互，连按钮样式都一样）
  const hiddenCount = entries.length - VISIBLE_ENTRIES;
  if (hiddenCount > 0) {
    const toggle = element('button', 'entries__toggle', `展开其余 ${hiddenCount} 个 ⌄`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const expanded = list.classList.toggle('entries__list--expanded');
      toggle.textContent = expanded ? '收起 ⌃' : `展开其余 ${hiddenCount} 个 ⌄`;
      toggle.setAttribute('aria-expanded', String(expanded));
    });
    box.append(toggle);
  }
}

function buildEntry(provider, entry) {
  const healthy = entry.status === 'ok' || entry.status === 'demo';
  // 额度归零是事实判断，不需要阈值：0 就是调不动了
  const empty = healthy && entry.amount <= 0;
  const row = element(
    'div',
    `entry${healthy ? '' : ' entry--failed'}${empty ? ' entry--empty' : ''}`,
  );

  const head = element('div', 'entry__head');
  head.append(element('span', 'entry__name', entry.label || '(未命名账号)'));
  head.append(
    element(
      'span',
      `entry__amount${healthy && !empty ? '' : ' entry__amount--failed'}`,
      healthy ? `${fmtNumber(entry.amount)} ${entry.currency}` : entry.status,
    ),
  );
  row.append(head);

  if (empty) row.append(element('p', 'entry__error', 'quota 已用尽，该账号调不动'));

  if (!healthy && entry.message) row.append(element('p', 'entry__error', entry.message));

  const secrets = Array.isArray(entry.secrets) ? entry.secrets : [];
  const removeButton = provider.manageAccounts ? buildRemoveButton(provider, entry) : null;

  if (secrets.length === 0) {
    row.append(element('p', 'entry__note', '未配置可托管的项目密钥'));
    // 没有密钥块可以挂靠时，「删除」得自己占一行，否则这个账号在界面上就删不掉了
    if (removeButton) {
      const actions = element('div', 'entry__actions');
      actions.append(removeButton);
      row.append(actions);
    }
  } else {
    secrets.forEach((secret, index) => {
      // 「删除」跟「显示 / 复制」排在同一行的动作容器里（挂到第一个密钥块上）
      row.append(
        buildSecretBlock(provider.provider, entry.id, secret, index === 0 ? removeButton : null),
      );
    });
  }

  if (healthy && entry.note) row.append(element('p', 'entry__note', entry.note));
  return row;
}

/* ---------------------------- 增删账号 ---------------------------- */

/**
 * 「删除」按钮。`target` 是管理区的渲染目标（卡片或弹窗里的同一份视图），
 * 它决定删除后的重绘范围：卡片只重绘网格，弹窗只重绘平台列表 / 管理视图。
 */
function buildRemoveButton(provider, entry, target) {
  // 复用「显示 / 复制」那套按钮样式，只换配色，保证形式一致
  const button = element('button', 'secret__btn secret__btn--danger', '删除');
  button.type = 'button';
  button.title = `删除账号「${entry.label || entry.id || '未命名'}」`;
  button.setAttribute('aria-label', `删除账号 ${entry.label || entry.id || '未命名'}`);
  button.addEventListener('click', () => removeAccount(provider, entry, target));
  return button;
}

/** 所有增删操作都带自定义头：跨域请求会因此必须先过 CORS 预检，而后端从不放行预检 */
async function manageRequest(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Power-Meter-Intent': 'write' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `接口返回 ${response.status}`);
  return payload ?? {};
}

/**
 * 增删提示的键：合并卡片是 `provider#`，单账号卡片是 `provider#accountId`。
 * 同一平台有多张卡片（如两个 CodeBuddy 账号）时，提示只落在被操作的那张卡上。
 */
function cardKeyOf(provider) {
  return `${provider.provider}#${provider.accountId ?? ''}`;
}

function setManageMessage(key, kind, text) {
  state.manageMessages.set(key, { kind, text });
}

/**
 * 管理区的渲染目标统一描述：卡片与「平台与账号」弹窗各传一份。
 *
 *   - `provider`：表单/登录请求要的 provider id 与标题（弹窗里由平台元信息拼出
 *     `{ provider, displayName }`，卡片直接用快照）；
 *   - `refresh()`：增删 / 登录成功后该刷新哪里——卡片刷新看板，弹窗刷新平台总览；
 *   - `key`：结果提示与展开态的存放键。
 */
function cardTarget(provider) {
  return {
    provider,
    key: cardKeyOf(provider),
    currentAccountId: provider.accountId ?? '',
    alwaysOpen: false,
    async refresh() {
      await load(true);
    },
  };
}

function dialogTarget(platform) {
  return {
    provider: {
      provider: platform.id,
      displayName: platform.displayName,
      manageAccounts: platform.manageAccounts,
    },
    key: `platform#${platform.id}`,
    currentAccountId: null,
    alwaysOpen: true,
    async refresh() {
      state.platformOverview = null;
      // 看板卡片也要跟着变（删除 / 新增账号后卡片增减），弹窗本身保持打开
      if (state.data) await load(true);
      await renderPlatformDialog();
    },
  };
}

/**
 * 适配器元信息（`/api/providers`）：管理表单的字段声明（manageFields）与提示文案都来自它。
 * 它是静态声明、不随刷新变化，所以只拉一次；拉取失败则留空并允许下次重试。
 */
async function loadAdapterMeta() {
  if (state.adapterMeta) return state.adapterMeta;
  try {
    const response = await fetch('/api/providers', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    const providers = (await response.json()).providers ?? [];
    state.adapterMeta = new Map(providers.map((item) => [item.id, item]));
  } catch (error) {
    state.adapterMeta = null;
    void error;
  }
  return state.adapterMeta ?? new Map();
}

function metaFor(provider) {
  return (state.adapterMeta ?? new Map()).get(provider.provider) ?? null;
}

async function removeAccount(provider, entry, target = cardTarget(provider)) {
  const label = entry.label || entry.id || '未命名';
  const platform = target.provider.displayName ?? provider.displayName;
  const confirmed = window.confirm(
    `删除 ${platform} 账号「${label}」？\n\n` +
      '会同时清掉 .env 里不再被其它账号引用的凭证变量，改动前自动备份到 .run/。',
  );
  if (!confirmed) return;
  try {
    const result = await manageRequest('/api/accounts/remove', {
      provider: target.provider.provider,
      accountId: entry.id,
    });
    const cleaned = result.removedEnvLines?.length
      ? `，并移除了 ${result.removedEnvLines.join(' / ')}`
      : '';
    setManageMessage(target.key, 'ok', `已删除「${label}」${cleaned}`);
    state.configuredAccounts.delete(target.provider.provider);
    state.platformOverview = null;
    // 卡片的 refresh() 会 load(true)，弹窗的 refresh() 会重拉总览，各自都能看到结果
    await target.refresh();
  } catch (error) {
    setManageMessage(target.key, 'err', `删除「${label}」失败：${error.message}`);
    await target.refresh();
  }
}

/**
 * 某平台的配置清单（含已停用 / 取数失败、因而不在卡片条目里的账号）。
 * 懒加载 + 按平台缓存；增删之后由调用方清掉对应桶。
 */
async function loadConfiguredAccounts(providerId, force = false) {
  if (!force && state.configuredAccounts.has(providerId)) {
    return state.configuredAccounts.get(providerId);
  }
  let accounts = [];
  try {
    const response = await fetch(`/api/accounts?provider=${encodeURIComponent(providerId)}`, {
      headers: { Accept: 'application/json', 'X-Power-Meter-Intent': 'read' },
    });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    accounts = (await response.json()).accounts ?? [];
  } catch (error) {
    els.diagnostics.prepend(
      element('div', 'diag diag--warn', `读取 ${providerId} 账号清单失败：${error.message}`),
    );
  }
  state.configuredAccounts.set(providerId, accounts);
  return accounts;
}

/* ------------------------- 扫码 / 打开链接登录 ------------------------- */

/** 登录相关请求统一走自定义头（与增删账号同一条 CSRF 防线） */
async function loginRequest(path, { method = 'POST', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Power-Meter-Intent': 'login',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `接口返回 ${response.status}`);
  return payload ?? {};
}

/** 弹窗里可读的状态文案；与后端 LoginSessionStatus 一一对应 */
const LOGIN_STATUS_TEXT = {
  waiting: '等待扫码 / 授权…',
  landing: '登录成功，正在验证取数并写入本机配置…',
  ready: '已完成',
  expired: '登录已超时，请重新获取二维码或链接。',
  failed: '登录失败',
  cancelled: '已取消',
  invalid: '登录会话不存在或已清理，请重新发起。',
};

const LOGIN_TERMINAL = new Set(['ready', 'expired', 'failed', 'cancelled', 'invalid']);

/** 登录站点下拉的展示文案（值仍用适配器声明的 cn / global） */
const LOGIN_SITE_LABELS = {
  cn: '国内站 qoder.com.cn',
  global: '国际站 qoder.com',
};

/**
 * 一个平台的登录块：按钮组（按 loginMethods 声明渲染）→ 申请会话 →
 * 画二维码 / 给链接 / 等网页抓取 → 轮询 → 刷新看板。
 *
 * 约定：
 *   - 二维码只在会话 `qr === true` 时展示（Trae 的回调固定落 127.0.0.1，扫码无意义；
 *     Qoder 的「网页端登录」由服务端驱动本机 Chrome，也不产生二维码）；
 *   - 面板状态存 `state.login`，按「providerId + method」记——同一平台的
 *     扫码与网页端登录是两个会话，互不挤占；卡片与弹窗共享同一会话；
 *   - 同一方法只保留一个会话：再点同方法按钮会先取消旧会话。
 */
function renderLogin(box, target, loginMeta, siteField = null) {
  const panel = box.querySelector('.login__panel');
  const canvas = box.querySelector('.login__canvas');
  const qrFallback = box.querySelector('.login__qr-fallback');
  const statusLine = box.querySelector('.login__status');
  const link = box.querySelector('.login__link');
  const copyBtn = box.querySelector('.login__copy');
  const cancelBtn = box.querySelector('.login__cancel');
  const note = box.querySelector('.login__note');

  const providerId = target.provider.provider;
  // 同一平台在卡片与弹窗里共享会话状态：用 providerId 识别，而不是卡片键。
  // buttonsBox 里每个按钮带 data-method，指向自己发起的会话方法。
  const buttonsBox = box.querySelector('.login__buttons');
  const methodButtons = [];

  // 会话查找：state.login 只有一个全局槽位，但匹配按 provider+method——
  // 其他方法（或其他平台）的会话不能污染本方法的按钮状态
  const sessionOf = (methodId) =>
    state.login?.providerId === providerId && state.login.method === methodId
      ? state.login.session
      : null;

  // 站点选择：只有「声明了站点 option 的平台」（Qoder）才渲染，选项直接取
  // manageFields 的 choices，与手工表单同源。
  const siteBox = box.querySelector('.login__site');
  const siteSelect = box.querySelector('.login__site-select');
  siteBox.hidden = !siteField;

  // 按钮组：方法清单来自 /api/providers 的 loginMethods（前端不认平台名）。
  // loginMeta 兼容旧字段：声明了 loginMethods 的平台以它为准。
  const methods =
    Array.isArray(loginMeta.methods) && loginMeta.methods.length
      ? loginMeta.methods
      : [
          {
            id: 'default',
            label: loginMeta.label,
            hint: loginMeta.hint,
            qr: loginMeta.qr,
            kind: loginMeta.qr ? 'scan' : 'link',
          },
        ];
  for (const method of methods) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = method.kind === 'web' ? 'login__start login__start--secondary' : 'login__start';
    btn.dataset.method = method.id;
    btn.textContent = method.label;
    btn.title = method.hint || method.label;
    buttonsBox.append(btn);
    methodButtons.push({ ...method, btn });
  }

  const paint = (view, methodId) => {
    // 没有会话：所有按钮恢复文案可用；有活跃会话：发起它的按钮显示「登录中」，
    // 其余按钮保持可用（点了会先取消旧会话再发起新的）
    for (const { id, label, btn } of methodButtons) {
      const active = view && id === methodId;
      if (!view) {
        btn.disabled = false;
        btn.textContent = label;
      } else if (active) {
        btn.disabled = !LOGIN_TERMINAL.has(view.status);
        btn.textContent = LOGIN_TERMINAL.has(view.status) ? '重新获取' : '登录中…';
      } else {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
    if (!view) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    const text = view.message || LOGIN_STATUS_TEXT[view.status] || view.status;
    statusLine.textContent = text;
    statusLine.dataset.state = view.status;

    // authUrl 只在等待阶段下发；终态后后端会清空。
    // 「网页端登录」（kind=web）的 authUrl 是本机 Chrome 已打开的页面，
    // 不重复给链接与复制按钮。
    const authUrl = view.authUrl || '';
    const isWebKind = (methodButtons.find((m) => m.id === methodId)?.kind ?? '') === 'web';
    link.hidden = !authUrl || isWebKind;
    if (authUrl && !isWebKind) link.href = authUrl;
    copyBtn.hidden = !authUrl || isWebKind;

    const showQr = Boolean(authUrl) && view.qr === true && Boolean(window.QRCode);
    canvas.hidden = !showQr;
    qrFallback.hidden = !authUrl || showQr || isWebKind;
    if (showQr) {
      const drawn = window.QRCode.toCanvas(canvas, authUrl, { size: 220, margin: 4 });
      canvas.hidden = !drawn;
      qrFallback.hidden = drawn;
      if (!drawn) qrFallback.textContent = '链接过长，二维码生成失败；请点下方按钮在新窗口打开。';
    } else if (authUrl && !isWebKind) {
      qrFallback.textContent =
        view.qr === true
          ? '二维码组件未加载，请直接打开链接。'
          : '该平台只能在本机浏览器完成登录，请点下方按钮打开。';
    }

    cancelBtn.hidden = LOGIN_TERMINAL.has(view.status);
    note.hidden = view.status !== 'ready';
    if (view.status === 'ready' && view.account) {
      note.textContent = view.account.updated
        ? `已更新「${view.account.name}」的登录凭证`
        : `已添加「${view.account.name}」`;
    }
  };

  // 初绘：把当前会话（如有）画到它自己的方法按钮上；站点下拉只认当前会话
  const currentSession = methodButtons.map((m) => sessionOf(m.id)).find(Boolean) ?? null;
  if (currentSession) {
    paint(currentSession, currentSession.method);
  } else {
    paint(null, null);
  }
  if (siteField) {
    if (siteSelect.options.length === 0) {
      // 登录只支持「具体站点」：auto 是探测策略，不是登录目标，过滤掉
      for (const choice of siteField.choices ?? []) {
        if (choice === 'auto') continue;
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = LOGIN_SITE_LABELS[choice] ?? choice;
        if (choice === (siteField.defaultValue ?? 'cn')) option.selected = true;
        siteSelect.append(option);
      }
    }
    siteSelect.disabled = Boolean(currentSession && !LOGIN_TERMINAL.has(currentSession.status));
    // 回显会话实际申请的站点（卡片重建 / 弹窗切换后仍对得上）
    if (currentSession?.site) siteSelect.value = currentSession.site;
  }

  for (const method of methodButtons) {
    method.btn.onclick = async () => {
      const methodId = method.id;
      method.btn.disabled = true;
      method.btn.textContent = '申请中…';
      try {
        // 先取消本平台其它方法的会话：面板只有一个，同时挂两个会状态混乱。
        // （后端按 provider+method 隔离会话，这里取消是纯前端选择。）
        if (state.login && state.login.session) {
          await loginRequest('/api/login/cancel', { body: { id: state.login.session.id } }).catch(
            () => {},
          );
          if (state.login.timer) clearTimeout(state.login.timer);
          state.login = null;
        }
        // 站点随会话一起提交：登录结果落库时带同一站点，之后 probe 走对应 origin
        const options = {};
        if (siteField) options[siteField.key] = siteSelect.value;
        const payload = await loginRequest('/api/login/start', {
          body: {
            provider: providerId,
            ...(methodId === 'default' ? {} : { method: methodId }),
            ...(siteField ? { options } : {}),
          },
        });
        const view = payload.session;
        state.login = { providerId, method: view.method || methodId, session: view, timer: null };
        paint(view, view.method || methodId);
        // 面板里已经是发起结果；其余卡片 / 弹窗在下次重绘时按 providerId 隐藏旧面板
        scheduleLoginPoll(providerId);
      } catch (error) {
        paint(null, methodId);
        statusLine.textContent = `发起登录失败：${error.message}`;
        statusLine.dataset.state = 'failed';
        panel.hidden = false;
      }
    };
  }

  copyBtn.onclick = async () => {
    const authUrl = state.login?.session?.authUrl;
    if (!authUrl) return;
    if (!(await copyText(authUrl))) {
      els.diagnostics.prepend(
        element('div', 'diag diag--warn', '浏览器拒绝写入剪贴板，请点「在新窗口打开登录页」后手动复制地址。'),
      );
      return;
    }
    copyBtn.textContent = '已复制';
    setTimeout(() => {
      copyBtn.textContent = '复制链接';
    }, 1600);
  };

  cancelBtn.onclick = async () => {
    const id = state.login?.session?.id;
    if (!id) return;
    cancelBtn.disabled = true;
    try {
      const payload = await loginRequest('/api/login/cancel', { body: { id } });
      if (state.login) {
        if (state.login.timer) clearTimeout(state.login.timer);
        state.login.timer = null;
        state.login.session = payload.session;
      }
      paint(payload.session);
    } catch (error) {
      statusLine.textContent = `取消失败：${error.message}`;
    } finally {
      cancelBtn.disabled = false;
    }
  };
}

/**
 * 全局单定时器轮询当前会话。
 *
 * 服务端在 `start` 后已经自己轮询上游，这里只是读本地状态；
 * 页面切到后台被节流也没关系——回来时 `visibilitychange` 会补一次。
 */
function scheduleLoginPoll(providerId) {
  // 已经排了下一轮就不要再排：renderGrid 每 1.5s 会重建卡片，这里也会被重复调用
  if (state.login?.timer) return;
  if (!state.login || state.login.providerId !== providerId) return;
  state.login.timer = setTimeout(async () => {
    const current = state.login;
    if (!current || current.providerId !== providerId) return;
    const id = current.session?.id;
    if (!id) return;
    // 先清掉句柄，再决定要不要续排；否则下面的 scheduleLoginPoll 会被自己的「已排」判断挡掉
    current.timer = null;
    try {
      const payload = await loginRequest(`/api/login/poll?id=${encodeURIComponent(id)}`, {
        method: 'GET',
      });
      current.session = payload.session;
    } catch (error) {
      // 会话被清理（服务重启 / TTL 结束）：停轮询，把状态写进面板
      current.session = {
        ...(current.session ?? {}),
        status: 'invalid',
        authUrl: null,
        message: `登录会话已失效：${error.message}`,
      };
    }

    const view = current.session;
    repaintManageTargets(providerId);
    if (LOGIN_TERMINAL.has(view.status)) {
      if (view.status === 'ready') {
        state.configuredAccounts.delete(providerId);
        state.platformOverview = null;
        // 卡片与弹窗都刷新：登录成功后看板要出现新卡片，弹窗要更新账号列表。
        // 会话本身留给下次重绘消费（renderManage 会把表单收起来，并把 state.login 置空）。
        if (state.data) await load(true);
        if (els.platformsDialog.open) await renderPlatformDialog();
      } else {
        // 失败 / 过期 / 取消：收起管理区，避免二维码面板一直占着卡片
        for (const key of [...state.manageOpen]) {
          if (key.startsWith(`${providerId}#`) || key === `platform#${providerId}`) {
            state.manageOpen.delete(key);
          }
        }
        state.login = null;
        repaintManageTargets(providerId);
      }
      return;
    }
    scheduleLoginPoll(providerId);
  }, LOGIN_POLL_MS);
}

/** 登录状态变化后重绘所有挂着该平台的视图：看板卡片 + 已打开的弹窗 */
function repaintManageTargets(providerId) {
  if (state.data) renderGrid(state.data);
  // 弹窗可能停在平台列表（providerId 为空）：也重绘，账号数才算得准
  if (els.platformsDialog.open) void renderPlatformDialog();
}

/**
 * 管理区：凭证字段由适配器声明（`manageFields`）动态渲染，前端不认平台名——
 * 任何平台只要声明了 manageAccounts + manageFields 就自动获得这套增删界面。
 *
 * 同一份逻辑服务两个宿主（由 `target` 描述，见 cardTarget / dialogTarget）：
 *   - 看板卡片：展开后才显示，`target.currentAccountId` 是这张卡代表的账号；
 *   - 「平台与账号」弹窗：始终展开（`target.alwaysOpen`），代表整个平台，
 *     因此没有账号的平台也能从这里第一次添加账号。
 *
 * 账号清单用配置兜底：卡片上只出现「启用的、能取数的」账号，
 * 而停用或缺凭证的账号也得能删。
 *
 * 登录入口同样由声明驱动：`/api/providers` 的 `login` 非空才渲染「扫码 / 打开链接登录」，
 * 手工 Cookie 表单收进 <details> 兜底（见 public/index.html 的 #manage-template）。
 */
function renderManage(root, target, options = {}) {
  const box = root.classList?.contains('manage') ? root : root.querySelector('.manage');
  const provider = target.provider;
  const meta = metaFor(provider);
  const toggle = options.toggle ?? null;

  if (toggle) toggle.hidden = !provider.manageAccounts;
  if (!provider.manageAccounts) {
    box.hidden = true;
    return;
  }

  const form = box.querySelector('.manage__form');
  const status = box.querySelector('.manage__result');
  const listBox = box.querySelector('.manage__hidden');
  const fieldsBox = box.querySelector('.manage__fields');
  const hint = box.querySelector('.manage__hint');
  const manual = box.querySelector('.manage__manual');
  const loginBox = box.querySelector('.login');
  const loginHint = loginBox.querySelector('.login__hint');
  const listTitle = listBox.querySelector('.manage__hidden-title');
  const listNode = listBox.querySelector('.manage__hidden-list');
  const cancel = box.querySelector('.manage__cancel');

  // 手工区展开态也要跨重建保留：登录轮询会重建卡片 / 弹窗
  manual.open = state.manualOpen.has(target.key);
  manual.addEventListener('toggle', () => {
    if (manual.open) state.manualOpen.add(target.key);
    else state.manualOpen.delete(target.key);
  });

  // 登录块：适配器声明了登录能力才出现；没有登录能力的平台保持手工表单。
  // loginMeta.methods 来自 /api/providers 的 loginMethods（后端对未声明多方法的
  // 平台自动回退为单方法清单），renderLogin 据此渲染按钮组。
  const loginMeta = meta?.login ? { ...meta.login, methods: meta.loginMethods ?? [] } : null;
  // 多站点平台的登录站点选择：取 manageFields 里「有 choices 的第一个 option 字段」，
  // 前端不认平台名——Qoder 的 site（cn / global / auto）之外，
  // 未来别的平台声明站点字段也能直接复用这块 UI。
  const siteField =
    (meta?.manageFields ?? []).find(
      (field) => field.target === 'option' && Array.isArray(field.choices) && field.choices.length > 0,
    ) ?? null;
  loginBox.hidden = !loginMeta;
  if (loginMeta) {
    loginHint.textContent = loginMeta.hint;
    loginHint.hidden = !loginMeta.hint;
    manual.querySelector('summary').textContent = '手工填写凭证（兜底）';
    renderLogin(loginBox, target, loginMeta, siteField);
  } else {
    // 没有登录能力：表单就是唯一入口，不再叫「兜底」
    manual.querySelector('summary').textContent = '填写凭证';
  }

  const message = state.manageMessages.get(target.key);
  status.hidden = !message;
  if (message) {
    status.className = `manage__result manage__result--${message.kind}`;
    status.textContent = message.text;
  }

  const showResult = (kind, text) => {
    setManageMessage(target.key, kind, text);
    status.hidden = false;
    status.className = `manage__result manage__result--${kind}`;
    status.textContent = text;
  };

  // 字段声明：有 choices 的渲染成下拉框（如 Qoder 的站点 cn / global / auto），
  // 长文本（Cookie 可达数 KB）用 textarea，其余用密码框
  const fields = meta?.manageFields ?? [];
  fieldsBox.replaceChildren();
  for (const field of fields) {
    const label = element('label', 'manage__field');
    label.append(element('span', null, field.label));
    let input;
    if (Array.isArray(field.choices) && field.choices.length > 0) {
      input = document.createElement('select');
      for (const choice of field.choices) {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = choice;
        if (field.defaultValue === choice) option.selected = true;
        input.append(option);
      }
    } else if (field.multiline) {
      input = document.createElement('textarea');
      input.rows = 3;
      input.spellcheck = false;
    } else {
      input = document.createElement('input');
      input.type = field.secret === false ? 'text' : 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
    }
    input.name = field.key;
    if (field.placeholder) input.placeholder = field.placeholder;
    label.append(input);
    if (field.hint) label.append(element('span', 'manage__field-hint', field.hint));
    fieldsBox.append(label);
  }

  // 能取到适配器声明时，表单才是可用的；声明拉取失败只提示、不隐藏已有账号列表
  if (!meta) {
    // 适配器已声明可管理、但元信息没拉到：只读展示，绝不渲染可提交的表单
    hint.textContent = `读取平台能力清单失败，暂时无法在这里添加${provider.displayName}账号；请刷新页面后重试。`;
    hint.hidden = false;
    fieldsBox.replaceChildren();
    manual.hidden = true;
    listTitle.textContent = '尚未加载账号清单';
    listNode.replaceChildren();
    if (toggle) toggle.hidden = true;
    box.hidden = false;
    return;
  }
  if (fields.length === 0 && !loginMeta) {
    hint.textContent = '该平台暂未声明可添加的字段或登录方式。';
  } else {
    hint.textContent = meta.manageHint ?? '凭证会先验证，通过了才写入本机配置；写入前会自动备份。';
  }
  hint.hidden = false;
  manual.hidden = fields.length === 0;
  form.querySelector('.manage__submit').disabled = fields.length === 0;

  /** 账号清单：卡片与弹窗都从同一个接口取（含停用 / 缺凭证账号） */
  const paintAccounts = async (force = false) => {
    const accounts = await loadConfiguredAccounts(provider.provider, force);
    renderConfiguredAccounts(listBox, target, accounts);
  };

  // 登录会话还挂在同一个平台上时，卡片的管理区必须保持展开——二维码 / 状态就住在里面
  if (state.login?.providerId === provider.provider) state.manageOpen.add(target.key);

  const toggleLabel = loginMeta ? '＋ 登录 / 添加账号' : '＋ 添加账号';
  const collapse = () => {
    state.manageOpen.delete(target.key);
    form.hidden = true;
    if (toggle) {
      toggle.textContent = toggleLabel;
      toggle.setAttribute('aria-expanded', 'false');
    }
  };
  const expand = () => {
    state.manageOpen.add(target.key);
    form.hidden = false;
    if (toggle) {
      toggle.textContent = '收起';
      toggle.setAttribute('aria-expanded', 'true');
    }
  };

  if (target.alwaysOpen || state.manageOpen.has(target.key)) {
    box.hidden = false;
    expand();
    void paintAccounts();
  } else {
    collapse();
  }

  if (toggle) {
    toggle.onclick = async () => {
      if (state.manageOpen.has(target.key)) {
        collapse();
        return;
      }
      box.hidden = false;
      expand();
      await paintAccounts();
    };
  }

  cancel.onclick = () => {
    form.reset();
    if (target.alwaysOpen) return;
    box.hidden = true;
    collapse();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (fields.length === 0) {
      showResult('err', '该平台没有声明可添加的字段，请检查 /api/providers 的 manageFields。');
      return;
    }

    // 字段按声明的 target 分流：credential → 凭证（落 .env），option → 非敏感配置（落 options）
    const credentials = {};
    const options = {};
    const missing = [];
    for (const field of fields) {
      const value = (form.elements[field.key]?.value ?? '').trim();
      const bucket = field.target === 'option' ? options : credentials;
      if (value) bucket[field.key] = value;
      else if (field.required !== false) missing.push(field.label);
    }
    if (missing.length > 0) {
      showResult('err', `请填写：${missing.join('、')}。`);
      return;
    }

    const submit = box.querySelector('.manage__submit');
    submit.disabled = true;
    submit.textContent = '验证中…';
    try {
      const result = await manageRequest('/api/accounts/add', {
        provider: provider.provider,
        credentials,
        options,
        name: form.elements.accountName.value.trim() || undefined,
      });
      const added = result.account ?? {};
      const details = (result.details ?? []).join(' · ');
      const optionText = Object.entries(result.options ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(' · ');
      // 变量名跟着站点走（国际站写 QODER_GLOBAL_*），回显出来让人知道凭证落在哪
      const envText = (result.envRefs ?? []).join(' / ');
      setManageMessage(
        target.key,
        'ok',
        `已添加「${added.label || result.name}」：${fmtNumber(added.amount ?? 0)} ${added.currency ?? ''}` +
          (details ? ` · ${details}` : '') +
          (optionText ? ` · ${optionText}` : '') +
          (envText ? ` · 凭证变量 ${envText}` : ''),
      );
      form.reset();
      state.configuredAccounts.delete(provider.provider);
      state.platformOverview = null;
      // 卡片刷新看板、弹窗刷新平台总览；两边都会把成功提示重绘出来
      await target.refresh();
      if (state.data) renderGrid(state.data);
    } catch (error) {
      setManageMessage(target.key, 'err', `添加失败：${error.message}`);
      await target.refresh();
      if (state.data) renderGrid(state.data);
    } finally {
      submit.disabled = false;
      submit.textContent = '验证并添加';
    }
  };

  // 登录成功：收起兜底表单与手工区，但保留管理区展开，让「已添加」结果可见。
  // 先取消上一轮遗留的会话，否则每次重绘都会把用户刚展开的手工表单再收起来。
  if (state.login?.providerId === provider.provider && state.login.session?.status === 'ready') {
    form.reset();
    state.manualOpen.delete(target.key);
    manual.open = false;
    form.hidden = true;
    state.login = null;
  }
}

/**
 * 本平台已配置的账号清单。
 *
 * 两种卡片的取舍不一样：
 *   - 合并卡片（entries 非空）：条目行上自带删除按钮，这里只补「没进条目」的那些
 *     （已停用 / 缺凭证）；
 *   - 单账号卡片（entries 为空，如 CodeBuddy 的两个账号各一张卡）：卡片正文没有
 *     可挂靠的密钥行，必须在这里列出全部账号并标出当前卡片，否则这个账号
 *     在界面上就删不掉了。
 */
function renderConfiguredAccounts(box, target, accounts) {
  // 弹窗里服务的是整个平台（没有「当前卡片」），卡片里则要标出自己
  const currentAccountId = target.currentAccountId;
  const shown = new Set(
    currentAccountId === null ? [] : ((currentAccountId && target.provider.entries) || []).map((entry) => entry.id),
  );
  const single = currentAccountId !== null && shown.size === 0;
  const list = single ? accounts : accounts.filter((account) => !shown.has(account.id));

  box.hidden = list.length === 0;
  box.querySelector('.manage__hidden-title').textContent =
    currentAccountId === null
      ? '本平台已配置的账号：'
      : single
        ? '本平台已配置的账号（当前卡片已标出）：'
        : '以下账号已配置但未显示在卡片上（已停用或缺凭证）：';

  const listNode = box.querySelector('.manage__hidden-list');
  listNode.replaceChildren();

  for (const account of list) {
    const row = element('div', 'hidden-account');
    row.append(element('span', 'hidden-account__name', account.label));
    const flags = [];
    if (single && account.id === currentAccountId) flags.push('当前卡片');
    if (!account.enabled) flags.push('已停用');
    if (!account.complete) flags.push('缺凭证');
    if (flags.length > 0) row.append(element('span', 'hidden-account__flag', flags.join(' · ')));
    row.append(buildRemoveButton(target.provider, { id: account.id, label: account.label }, target));
    listNode.append(row);
  }
}

/* ------------------- 「平台与账号」弹窗（全局入口） ------------------- */

/**
 * 弹窗解决的是「没有账号的平台在页面上完全没有入口」：
 * 卡片只来自已启用的账号，而这里按适配器注册表列出**全部平台**，
 * 一个账号都没有的平台也能从这里第一次登录 / 填写凭证。
 *
 * 平台能力（能不能网页添加、有没有登录）全部来自后端声明，前端不认平台名。
 */
async function loadPlatformOverview(force = false) {
  if (!force && state.platformOverview) return state.platformOverview;
  const response = await fetch('/api/accounts/overview', {
    headers: { Accept: 'application/json', 'X-Power-Meter-Intent': 'read' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `接口返回 ${response.status}`);
  state.platformOverview = payload;
  return payload;
}

function openPlatformsDialog(providerId = null) {
  state.dialog.providerId = providerId;
  if (!els.platformsDialog.open) els.platformsDialog.showModal();
  void renderPlatformDialog();
}

async function renderPlatformDialog() {
  if (!els.platformsDialog.open) return;
  const providerId = state.dialog.providerId;
  els.platformsBody.replaceChildren();

  let overview;
  try {
    overview = await loadPlatformOverview();
  } catch (error) {
    els.platformsTitle.textContent = '平台与账号';
    els.platformsSubtitle.textContent = '读取平台清单失败';
    els.platformsBody.append(
      element('p', 'dialog__error', `读取平台与账号失败：${error.message}`),
    );
    return;
  }

  // 管理视图的表单字段来自 /api/providers（与卡片同一份 metaFor）：先确保它已就位，
  // 否则冷启动后直接点弹窗会误报「能力清单加载失败」。
  if (providerId && !state.adapterMeta) await loadAdapterMeta();

  const platforms = overview.providers ?? [];
  if (providerId) {
    const platform = platforms.find((item) => item.id === providerId);
    if (!platform) {
      state.dialog.providerId = null;
      return renderPlatformDialog();
    }
    renderPlatformManage(platform);
    return;
  }

  els.platformsTitle.textContent = '平台与账号';
  const totalAccounts = platforms.reduce((sum, item) => sum + (item.accounts?.length ?? 0), 0);
  els.platformsSubtitle.textContent =
    `${platforms.length} 个平台 · 已配置 ${totalAccounts} 个账号 · 所有操作都在本机完成`;

  const list = element('div', 'platforms');
  for (const platform of platforms) list.append(buildPlatformRow(platform));
  els.platformsBody.append(list);

  // 配置文件 / 环境变量层面的问题一并透出，省得再去看服务日志
  const issues = [
    ...(overview.warnings ?? []),
    ...(overview.missingEnvVars ?? []).map(
      (name) => `环境变量 ${name} 为空，引用它的账号会解析成空凭证。`,
    ),
    ...platforms.flatMap((item) =>
      (item.warnings ?? []).map((text) => `【${item.displayName}】${text}`),
    ),
  ];
  if (issues.length > 0) {
    const box = element('div', 'dialog__issues');
    box.append(element('p', 'dialog__issues-title', '配置提示'));
    for (const text of issues) box.append(element('p', 'dialog__issue', text));
    els.platformsBody.append(box);
  } else {
    els.platformsBody.append(
      element('p', 'dialog__path', `账号文件：${overview.accountsFilePath}`),
    );
  }
}

/** 平台列表里的一行：身份 + 账号清单 + 操作入口 */
function buildPlatformRow(platform) {
  const accounts = platform.accounts ?? [];
  const row = element('div', 'platform');
  const head = element('div', 'platform__head');

  const title = element('div', 'platform__title');
  title.append(element('span', 'platform__name', platform.displayName));
  title.append(
    element('span', `chip chip--${platform.region}`, platform.region === 'cn' ? '国内' : '国际'),
  );
  title.append(
    element(
      'span',
      `platform__count${accounts.length > 0 ? '' : ' platform__count--empty'}`,
      accounts.length > 0 ? `${accounts.length} 个账号` : '还没有配置账号',
    ),
  );
  head.append(title);

  // 与后端 addManagedAccount 的放行条件一致：没有 manageFields 的平台即便声明了
  // manageAccounts 也无法通过通用接口落库，所以这里不假装可以网页添加
  const supported = platform.manageAccounts && (platform.manageFields ?? []).length > 0;
  if (supported) {
    const open = element('button', 'secret__btn secret__btn--primary', '登录 / 添加账号');
    open.type = 'button';
    open.addEventListener('click', () => {
      state.dialog.providerId = platform.id;
      void renderPlatformDialog();
    });
    head.append(open);
  } else {
    head.append(element('span', 'platform__unsupported', '暂不支持网页添加'));
  }
  row.append(head);

  if (accounts.length > 0) {
    const target = dialogTarget(platform);
    const listNode = element('div', 'platform__accounts');
    for (const account of accounts) {
      const accountRow = element('div', 'hidden-account');
      accountRow.append(element('span', 'hidden-account__name', account.label));
      const flags = [];
      if (!account.enabled) flags.push('已停用');
      if (!account.complete) flags.push('缺凭证');
      const preview = Object.values(account.previews ?? {}).filter(Boolean)[0];
      if (preview) flags.push(preview);
      if (flags.length > 0) {
        accountRow.append(element('span', 'hidden-account__flag', flags.join(' · ')));
      }
      accountRow.append(buildRemoveButton(target.provider, account, target));
      listNode.append(accountRow);
    }
    row.append(listNode);
  } else {
    // 没有网页入口的平台（CodeArts / MiniMax / custom）：把「怎么做」直接摆在页面上
    // （只引用变量名与抓取命令，不含任何明文凭证）
    row.append(element('p', 'platform__hint', platform.credentialHint));
  }
  return row;
}

/** 平台的管理视图：复用卡片里的同一套登录 / 表单 / 账号列表 */
function renderPlatformManage(platform) {
  els.platformsTitle.textContent = platform.displayName;
  els.platformsSubtitle.textContent =
    platform.manageHint || '登录或填写凭证，验证通过后写入本机配置';

  const back = element('button', 'secret__btn dialog__back', '← 返回平台列表');
  back.type = 'button';
  back.addEventListener('click', () => {
    state.dialog.providerId = null;
    void renderPlatformDialog();
  });
  els.platformsBody.append(back);

  const root = els.manageTemplate.content.firstElementChild.cloneNode(true);
  els.platformsBody.append(root);
  renderManage(root, dialogTarget(platform));
}

/**
 * 单账号平台的「托管密钥」区块：只展示掩码，明文按需向后端要。
 * 与卡片健康状态无关——额度查询失败时，密钥通常仍然要能用。
 */
function renderSecrets(node, provider) {
  const box = node.querySelector('.secrets');
  const list = node.querySelector('.secrets__list');
  const secrets = Array.isArray(provider.secrets) ? provider.secrets : [];
  list.replaceChildren();

  // 合并卡片把密钥挪进条目里了，卡片级区块没有内容可放
  if (secrets.length === 0 || (provider.entries ?? []).length > 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const secret of secrets) {
    list.append(buildSecretBlock(provider.provider, provider.accountId, secret));
  }
}

/** state.revealed 的键：平台 + 账号 + 字段，三者才能唯一确定一把密钥 */
function secretIdOf(providerId, accountId, field) {
  return `${providerId}#${accountId ?? ''}#${field}`;
}

/**
 * 一个「托管密钥」块：标签 + 显示/复制 + 掩码值。
 * `trailingAction` 用于把外部的按钮（如账号的「删除」）并进同一行动作里，
 * 让三个按钮落在同一条水平线上。
 */
function buildSecretBlock(providerId, accountId, secret, trailingAction = null) {
  const id = secretIdOf(providerId, accountId, secret.key);
  const revealed = state.revealed.get(id);

  const row = element('div', 'secret');
  const head = element('div', 'secret__head');
  head.append(element('span', 'secret__label', secret.label));

  const actions = element('div', 'secret__actions');
  const toggle = element('button', 'secret__btn', revealed ? '隐藏' : '显示');
  toggle.type = 'button';
  toggle.title = secret.hint || '查看完整密钥';
  toggle.addEventListener('click', async () => {
    if (state.revealed.has(id)) {
      state.revealed.delete(id);
      renderGrid(state.data);
      return;
    }
    const value = await requestSecret(providerId, accountId, secret.key, toggle, '读取中…');
    if (!value) return;
    state.revealed.set(id, value);
    renderGrid(state.data);
  });

  const copy = element('button', 'secret__btn secret__btn--primary', '复制');
  copy.type = 'button';
  copy.title = secret.hint || '复制到剪贴板';
  copy.addEventListener('click', async () => {
    const value =
      state.revealed.get(id) ||
      (await requestSecret(providerId, accountId, secret.key, copy, '读取中…'));
    if (!value) return;
    if (!(await copyText(value))) {
      els.diagnostics.prepend(
        element('div', 'diag diag--warn', `浏览器拒绝写入剪贴板，请用「显示」后手动复制 ${secret.label}`),
      );
      return;
    }
    state.revealed.set(id, value);
    copy.textContent = '已复制';
    copy.classList.add('secret__btn--done');
    setTimeout(() => {
      copy.textContent = '复制';
      copy.classList.remove('secret__btn--done');
    }, 1600);
  });

  actions.append(toggle, copy);
  if (trailingAction) actions.append(trailingAction);
  head.append(actions);

  row.append(head);
  const value = element('code', 'secret__value', revealed || secret.preview);
  if (secret.hint) value.title = secret.hint;
  row.append(value);
  return row;
}

/** 向本机后端要一次明文；失败时把原因写进「诊断」区，不弹窗打断 */
async function requestSecret(providerId, accountId, field, button, busyText) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    const response = await fetch('/api/reveal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 自定义头：跨域请求会因此必须先过 CORS 预检，而后端从不放行预检
        'X-Power-Meter-Intent': 'reveal',
      },
      body: JSON.stringify({ provider: providerId, accountId: accountId ?? '', key: field }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `接口返回 ${response.status}`);
    return payload?.value ?? '';
  } catch (error) {
    els.diagnostics.prepend(
      element('div', 'diag diag--warn', `读取密钥 ${field} 失败：${error.message}`),
    );
    return '';
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/**
 * 写剪贴板。非安全上下文（例如用局域网 IP 打开页面）下
 * `navigator.clipboard` 不存在，退回 textarea + execCommand。
 */
async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 落到下面的兜底方案
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-1000px';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch {
    return false;
  }
}

function renderTimeline(data) {
  const hits = data.expiryTimeline;
  els.timeline.replaceChildren();
  if (hits.length === 0) {
    els.timeline.append(element('li', 'muted', '暂无可用的到期信息'));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const hit of hits) {
    const level = levelFor(hit.inDays, data.expiryThresholds);
    const item = element('li');
    item.dataset.level = level;
    item.append(
      element('span', 'timeline__when', fmtDate(hit.expiresAt)),
      element('span', 'timeline__name', `${hit.displayName} · ${hit.lotLabel}`),
      element('span', 'timeline__amount', `${fmtNumber(hit.amount)} ${hit.currency}`),
      element('span', 'timeline__badge', expiryText(hit.inDays)),
    );
    fragment.append(item);
  }
  els.timeline.append(fragment);
}

function renderDiagnostics(data) {
  els.diagnostics.replaceChildren();
  const items = [];

  for (const variable of data.missingEnvVars ?? []) {
    items.push({
      warn: true,
      text: `环境变量 ${variable} 为空，相关平台的凭证引用会解析成空值。请在 .env 中补齐后重新刷新。`,
    });
  }
  for (const warning of data.warnings ?? []) {
    items.push({ warn: true, text: warning });
  }
  for (const provider of data.providers) {
    if (provider.status === 'ok' || provider.status === 'demo') continue;
    items.push({
      warn: provider.status !== 'notConfigured',
      text: `【${provider.displayName}】${provider.status}：${provider.message ?? '未提供原因'}`,
    });
  }

  if (items.length === 0) {
    els.diagnostics.append(element('div', 'diag', '一切正常，没有需要处理的配置问题。'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.append(element('div', `diag${item.warn ? ' diag--warn' : ''}`, item.text));
  }
  els.diagnostics.append(fragment);
}

// ===========================================================================
// 看板外壳：导航徽标 / 按平台子菜单 / 滑动高亮块（scrollspy）/ 命令面板 / 停靠栏
//
// 这些只负责「外壳」的交互，不参与取数，也不重写任何业务渲染。数字口径一律复用
// 业务侧已有的函数（sortedProviders / urgencyOf / balanceFor / fmtNumber），
// 避免外壳和区块各算一套、对不上。
// ===========================================================================

/** 导航目标 → 顶栏标题。alert / toolbar 故意不在表里：它们没有导航项，向上沿用 */
const NAV_SECTION_TITLES = {
  summary: '总览',
  providers: '额度卡片',
  'timeline-panel': '到期时间线',
  'diagnostics-panel': '诊断',
};

/** 「有导航项」的 data-section 值（与左侧导航的 data-target 一一对应） */
const NAV_TARGETS = new Set(Object.keys(NAV_SECTION_TITLES));

/** scrollspy 探针落在视口高度的这个比例处，用来判断「正在看哪个区块」 */
const NAV_PROBE_RATIO = 0.28;

/**
 * 点击导航后滚动停止多久才把控制权交还 scrollspy。
 * 用「最后一次滚动后静默 240ms」而不是固定时长：平滑滚动可能比任何固定值都长。
 */
const NAV_SCROLL_SETTLE_MS = 240;

let navPillFrame = 0;
let scrollSpyFrame = 0;
let navScrollLockTimer = 0;

/**
 * 外壳刷新入口，由 render() 在业务区块渲染完之后调用。
 * 只写徽标 / 状态条 / 平台子菜单；这些都必须跟着同一份 /api/summary 数据走。
 */
function renderShell(data) {
  if (!data) return;
  const totals = data.totals ?? {};
  const providers = data.providers ?? [];
  const timeline = data.expiryTimeline ?? [];
  const thresholds = data.expiryThresholds ?? { criticalDays: 3, warningDays: 7 };

  setBadge(els.navBadgePlatforms, totals.providers ?? providers.length);
  setBadge(els.navBadgeTimeline, timeline.length);

  // 到期时间线：有 critical 批次就把徽标点热（CSS 的 .nav__badge--hot）
  if (els.navBadgeTimeline) {
    els.navBadgeTimeline.classList.toggle(
      'nav__badge--hot',
      timeline.some((hit) => hit.inDays <= thresholds.criticalDays),
    );
  }

  // 诊断徽标口径：与 renderDiagnostics 同源，但排除 notConfigured——
  // 「还没配账号」是常态，不该天天飘一个待处理角标
  const diagCount = countDiagnostics(data);
  setBadge(els.navBadgeDiag, diagCount);
  if (els.navBadgeDiag) {
    els.navBadgeDiag.classList.toggle('is-zero', diagCount === 0);
    els.navBadgeDiag.classList.toggle('nav__badge--hot', diagCount > 0);
  }

  // 状态条：N 正常 / M 异常；有异常时整条转 warning 色
  if (els.statusText) {
    els.statusText.textContent = `${totals.ok ?? 0} 正常 / ${totals.failed ?? 0} 异常`;
  }
  if (els.statusChip) {
    els.statusChip.classList.toggle('status--warn', (totals.failed ?? 0) > 0);
  }

  renderNavPlatforms(data);
  // 徽标文案变了导航项宽度就变了，高亮块得重新量一次
  scheduleNavPill();
}

/** 写一个徽标数字；元素缺失（旧版 HTML）时静默跳过 */
function setBadge(node, value) {
  if (!node) return;
  node.textContent = String(value ?? 0);
}

/** 「额度卡片」徽标 = 当前排序 / 筛选后的卡片张数，renderGrid 每次都会调用 */
function refreshProviderBadge(count) {
  setBadge(els.navBadgeProviders, count);
}

/** 需要处理的诊断条数：缺环境变量 + 聚合警告 + 状态既不是 ok/demo/notConfigured 的平台 */
function countDiagnostics(data) {
  const missing = (data.missingEnvVars ?? []).length;
  const warnings = (data.warnings ?? []).length;
  const unhealthy = (data.providers ?? []).filter(
    (provider) =>
      provider.status !== 'ok' &&
      provider.status !== 'demo' &&
      provider.status !== 'notConfigured',
  ).length;
  return missing + warnings + unhealthy;
}

/**
 * 「按平台」子菜单：一行一个平台（同一平台的多个账号合成一行），
 * 跨站点的平台（Qoder 国内 / 国际）按站点拆行，标签为 `Qoder CN` / `Qoder 国际版`。
 * 右侧是该组金额合计与组内最紧急的到期状态点。
 * data 为 null（首屏接口还没回来）时保持空清单，不写占位行。
 */
function renderNavPlatforms(data) {
  if (!els.navPlatforms) return;
  els.navPlatforms.replaceChildren();

  const groups = platformGroups(data);
  if (groups.length > 0) {
    // 阈值缺省时给个兜底，避免 urgencyOf 读 undefined.criticalDays 直接抛错
    const thresholds = data.expiryThresholds ?? { criticalDays: 3, warningDays: 7 };
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      const amount = groupBalance(group.members);
      const row = element('button', 'nav__sub-item');
      row.type = 'button';
      // 点行 = 把组标签写进筛选框（跨站点行即「Qoder CN」这类站点筛选词）
      row.dataset.provider = group.provider;
      if (group.region) row.dataset.region = group.region;
      row.dataset.filter = group.label;

      const dot = element('span', 'nav__sub-dot');
      dot.dataset.level = groupUrgency(group.members, thresholds);
      row.append(
        dot,
        element('span', 'nav__sub-label', group.label),
        // 取数失败 / 混币种时金额没有意义：显示占位符并弱化，别让人以为它是 0
        element(
          'span',
          `nav__sub-amount${amount === null ? ' nav__sub-amount--muted' : ''}`,
          amount === null ? '—' : fmtNumber(amount),
        ),
      );
      row.addEventListener('click', () => filterByProvider(group.label));
      fragment.append(row);
    }
    els.navPlatforms.append(fragment);
  }

  // 展开态存在 state 里：子菜单每次重建后按它恢复，刷新数据时不会被收起
  syncNavGroupState();
}

/** 把 state.navPlatformsOpen 落到 DOM（hidden / aria-expanded / is-open 三处） */
function syncNavGroupState() {
  if (!els.navPlatforms || !els.navGroupPlatforms) return;
  els.navPlatforms.hidden = !state.navPlatformsOpen;
  els.navGroupPlatforms.setAttribute('aria-expanded', String(state.navPlatformsOpen));
  els.navGroupPlatforms.classList.toggle('is-open', state.navPlatformsOpen);
}

function toggleNavPlatforms() {
  state.navPlatformsOpen = !state.navPlatformsOpen;
  syncNavGroupState();
  scheduleNavPill();
}

/**
 * 子菜单行 / 命令面板「查看 X」共用：等价于在筛选框里输入平台名。
 * 复用现有 state.query + renderGrid，不另开一套筛选逻辑。
 */
function filterByProvider(name) {
  state.query = name;
  if (els.search && els.search.value !== name) els.search.value = name;
  if (state.data) renderGrid(state.data);
  const grid = document.querySelector('#grid');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // 高亮块与顶栏标题立刻跟到「额度卡片」，不等滚动结束
  applyActiveTarget('providers');
  lockNavScroll();
}

/** 平滑滚到某个导航目标（data-section 值） */
function scrollToSection(target) {
  const section = document.querySelector(`[data-section="${target}"]`);
  if (!section) return;
  applyActiveTarget(target);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  lockNavScroll();
}

/** 点亮某个导航目标：左侧导航、移动端停靠栏、顶栏标题一起更新 */
function applyActiveTarget(target) {
  if (!target) return;
  state.activeTarget = target;

  for (const item of document.querySelectorAll('#nav .nav__item[data-target]')) {
    item.classList.toggle('is-active', item.dataset.target === target);
  }
  // 停靠栏只有 4 个固定项（没有「诊断」），匹配不到就一个都不点亮
  for (const item of document.querySelectorAll('#dock .dock__item[data-target]')) {
    item.classList.toggle('is-active', item.dataset.target === target);
  }

  const title = NAV_SECTION_TITLES[target];
  if (title && els.pageTitle && els.pageTitle.textContent !== title) {
    els.pageTitle.textContent = title;
  }
  scheduleNavPill();
}

/**
 * scrollspy 的核心判断：取所有 [data-section]，选「顶部已越过探针、且离探针最近」的那个；
 * alert / toolbar 没有导航项，向前沿用最近一个有导航项的区块。
 */
function currentSectionTarget() {
  const sections = [...document.querySelectorAll('[data-section]')];
  if (sections.length === 0) return null;

  // 页面还在顶部（或整页没有滚动余地）：总览就是激活项
  if (window.scrollY <= 2) return 'summary';

  // 隐藏区块（#alert 有内容才显示）没有盒子，rect 恒为 0，会把探针判断带偏；
  // getClientRects() 为空正是「当前没有渲染」的可靠信号
  const rendered = sections.filter((section) => section.getClientRects().length > 0);
  if (rendered.length === 0) return 'summary';

  const probe = window.innerHeight * NAV_PROBE_RATIO;
  let passed = null;
  for (const section of rendered) {
    if (section.getBoundingClientRect().top <= probe) passed = section;
  }

  // 滚到页面底部时，最后一个区块往往还没到探针位置（它太矮，页脚先到头了）。
  // 但「刚点过导航」不能直接认最后一个：点「到期时间线」后页面会顶到底，
  // 此时用户要的是时间线，不该被紧随其后的「诊断」抢走。
  // 所以兜底只在「没有任何区块越过探针」时生效。
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight > window.innerHeight + 4;
  const atBottom = scrollable && window.scrollY + window.innerHeight >= doc.scrollHeight - 2;
  const hit = passed ?? (atBottom ? rendered[rendered.length - 1] : rendered[0]);
  if (!hit) return null;

  // 从命中点向前找第一个有导航项的区块，把 alert / toolbar 这类「无导航项」的沿用掉。
  // 这里用全量 sections 的顺序定位，保证 alert 消失与否都不影响沿用结果
  const index = sections.indexOf(hit);
  for (let i = index; i >= 0; i -= 1) {
    const target = sections[i].dataset.section;
    if (NAV_TARGETS.has(target)) return target;
  }
  return 'summary';
}

/** 滚动位置变化后重算激活项；rAF 节流，绝不用 setInterval */
function updateScrollSpy() {
  if (state.navScrollLock) return;
  // 命令面板是模态的：它内部滚动（列表 scrollIntoView）会带出 window scroll，
  // 此时背后区块的激活项与标题不该跳
  if (els.cmd?.open) return;
  const target = currentSectionTarget();
  if (!target || target === state.activeTarget) return;
  applyActiveTarget(target);
}

function scheduleScrollSpy() {
  if (scrollSpyFrame) return;
  scrollSpyFrame = requestAnimationFrame(() => {
    scrollSpyFrame = 0;
    updateScrollSpy();
  });
}

/** scroll 事件的唯一入口：锁定期间只续期，不重算激活项 */
function onWindowScroll() {
  if (state.navScrollLock) {
    extendNavScrollLock();
    return;
  }
  scheduleScrollSpy();
}

/**
 * 点击导航后先锁住 scrollspy，否则平滑滚动的中途会把途经区块逐个点亮。
 * 每次收到滚动事件就续期，停稳 NAV_SCROLL_SETTLE_MS 后自动交还（scrollend 支持时提前）。
 */
function lockNavScroll() {
  state.navScrollLock = true;
  extendNavScrollLock();
}

function extendNavScrollLock() {
  if (!state.navScrollLock) return;
  if (navScrollLockTimer) clearTimeout(navScrollLockTimer);
  navScrollLockTimer = setTimeout(releaseNavScrollLock, NAV_SCROLL_SETTLE_MS);
}

function releaseNavScrollLock() {
  if (navScrollLockTimer) clearTimeout(navScrollLockTimer);
  navScrollLockTimer = 0;
  if (!state.navScrollLock) return;
  state.navScrollLock = false;
  scheduleScrollSpy();
}

/** 重新量高亮块：尺寸/位置一律走行内 style，配合 CSS transition 实现滑动 */
function positionNavPill() {
  // 左侧导航是竖排：高亮块贴左边、宽度跟着文字伸缩（left 固定 0）
  positionPill(els.nav, els.navPill, '.nav__item', { left: 0 });
  // 移动端停靠栏是横排：高亮块跟着项横向滑动（断点由 CSS 决定，JS 不判断视口宽度）
  positionPill(els.dock, els.dockPill, '.dock__item', {});
}

/**
 * 把高亮块量到激活项的位置。
 * 四个尺寸全部写成行内 style：CSS 无论按 top/height 还是 left/width 做过渡都能对上。
 * `options.left` 用于竖排导航——宽度跟着文字伸缩，左边距恒定，不需要每帧量。
 */
function positionPill(container, pill, selector, options = {}) {
  if (!container || !pill) return;
  const active = container.querySelector(`${selector}.is-active`);
  if (!active) {
    pill.classList.add('is-hidden');
    // 尺寸也清掉，下次显示时不会从上一个位置「跳」过来
    pill.style.top = '';
    pill.style.height = '';
    pill.style.left = '';
    pill.style.width = '';
    return;
  }

  // offsetTop / offsetLeft 只有在 offsetParent 就是容器时才表示「相对容器」；
  // CSS 若换了定位方式 offsetParent 会变，这里用 rect 差值兜底，避免高亮块整体跑偏
  const relative = (edge) => {
    const offset = edge === 'top' ? active.offsetTop : active.offsetLeft;
    if (!active.offsetParent || active.offsetParent === container) return offset;
    return active.getBoundingClientRect()[edge] - container.getBoundingClientRect()[edge];
  };
  const left = typeof options.left === 'number' ? options.left : relative('left');

  pill.classList.remove('is-hidden');
  pill.style.top = `${relative('top')}px`;
  pill.style.height = `${active.offsetHeight}px`;
  pill.style.left = `${left}px`;
  pill.style.width = `${active.offsetWidth}px`;
}

function scheduleNavPill() {
  if (navPillFrame) return;
  navPillFrame = requestAnimationFrame(() => {
    navPillFrame = 0;
    positionNavPill();
  });
}

// ---------------------------------------------------------------------------
// 命令面板
// ---------------------------------------------------------------------------

/** 命令一律现算：数据变了（平台增减、刷新后状态变化），命令清单跟着变 */
function buildCommands() {
  const items = [
    { label: '跳转到总览', hint: '跳转', run: () => scrollToSection('summary') },
    { label: '跳转到额度卡片', hint: '跳转', run: () => scrollToSection('providers') },
    { label: '跳转到到期时间线', hint: '跳转', run: () => scrollToSection('timeline-panel') },
    { label: '跳转到诊断', hint: '跳转', run: () => scrollToSection('diagnostics-panel') },
    { label: '立即刷新数据', hint: '操作', run: () => void load(true) },
    { label: '打开平台与账号', hint: '操作', run: () => openPlatformsDialog() },
    { label: '切换自动刷新', hint: '操作', run: () => toggleAutoRefresh() },
  ];
  // 平台命令与「按平台」子菜单同源（platformGroups）：跨站点平台出两条
  // 「查看 Qoder CN / 查看 Qoder 国际版」，不拆站点的平台仍是一条
  for (const group of platformGroups(state.data)) {
    items.push({
      label: `查看 ${group.label}`,
      hint: '平台',
      run: () => filterByProvider(group.label),
    });
  }
  return items;
}

/** 命令面板里的「切换自动刷新」：必须与勾选框共用同一份状态，不能各存各的 */
function toggleAutoRefresh() {
  const next = !state.autoRefresh;
  state.autoRefresh = next;
  if (els.autoRefresh) els.autoRefresh.checked = next;
  scheduleAutoRefresh();
}

/** 按输入框关键词重建列表（label + hint 小写 includes；中文直接 includes） */
function rebuildCommandList() {
  if (!els.cmdList) return;
  const keyword = (els.cmdInput?.value ?? '').trim().toLowerCase();
  const all = buildCommands();
  const matched = keyword
    ? all.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(keyword))
    : all;

  state.commands = matched;
  state.cmdIndex = matched.length > 0 ? 0 : -1;

  els.cmdList.replaceChildren();
  matched.forEach((item, index) => {
    const li = element('li', 'cmd__item');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.id = `cmd-item-${index}`;
    li.append(
      element('span', 'cmd__item-label', item.label),
      element('span', 'cmd__item-hint', item.hint),
    );
    // 鼠标滑过与键盘共用同一个 state.cmdIndex，选中态永远只有一处
    li.addEventListener('mouseenter', () => setCommandIndex(index));
    li.addEventListener('click', () => {
      setCommandIndex(index);
      runCommand();
    });
    els.cmdList.append(li);
  });

  if (els.cmdEmpty) els.cmdEmpty.hidden = matched.length > 0;
  if (els.cmdHint) els.cmdHint.textContent = `共 ${matched.length} 条命令`;
  syncCommandSelection();
}

/** 选中态同步：is-active 与 aria-selected 必须一起改（可访问性） */
function syncCommandSelection() {
  if (!els.cmdList) return;
  const items = [...els.cmdList.querySelectorAll('.cmd__item')];
  items.forEach((node, index) => {
    const active = index === state.cmdIndex;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', String(active));
  });
  const activeNode = items[state.cmdIndex];
  if (els.cmdInput) {
    if (activeNode?.id) els.cmdInput.setAttribute('aria-activedescendant', activeNode.id);
    else els.cmdInput.removeAttribute('aria-activedescendant');
  }
  if (activeNode) activeNode.scrollIntoView({ block: 'nearest' });
}

/** 设置选中项（越界时循环）；没有结果时置 -1 */
function setCommandIndex(index) {
  if (state.commands.length === 0) {
    state.cmdIndex = -1;
    syncCommandSelection();
    return;
  }
  const total = state.commands.length;
  state.cmdIndex = ((index % total) + total) % total;
  syncCommandSelection();
}

function moveCommand(delta) {
  // cmdIndex 为 -1 只出现在「没有匹配结果」时（重建列表会选中第一项）；
  // 此时按方向键不改选中态，交给 setCommandIndex 处理空列表
  if (state.cmdIndex < 0) {
    setCommandIndex(0);
    return;
  }
  setCommandIndex(state.cmdIndex + delta);
}

/** 执行当前选中项：一律先关面板再执行（命令可能要开另一个 dialog） */
function runCommand() {
  const item = state.commands[state.cmdIndex];
  if (!item) return;
  closeCommandPalette();
  item.run();
}

function openCommandPalette() {
  if (!els.cmd) return;
  if (!els.cmd.open) els.cmd.showModal();
  if (els.cmdInput) {
    els.cmdInput.value = '';
    els.cmdInput.focus();
  }
  rebuildCommandList();
}

function closeCommandPalette() {
  if (els.cmd?.open) els.cmd.close();
}

/** ⌘K / Ctrl+K 是全局唤起键：在 #search、凭证输入框里也要生效（这里只认修饰键组合） */
function isCommandHotkey(event) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    typeof event.key === 'string' &&
    event.key.toLowerCase() === 'k'
  );
}

function toggleCommandPalette() {
  if (els.cmd?.open) closeCommandPalette();
  else openCommandPalette();
}

// ---------------------------------------------------------------------------
// 外壳事件绑定（一次性）
// ---------------------------------------------------------------------------

/**
 * 把导航、子菜单、命令面板、停靠栏、scrollspy 一次绑好。
 * 所有元素都按「可能不存在」处理：旧版 HTML 缺某个 id 时只丢对应交互，不拖垮整页脚本。
 */
function bindShell() {
  // 导航项 / 停靠栏项：平滑滚动 + 立即点亮
  for (const item of document.querySelectorAll('#nav .nav__item[data-target]')) {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      scrollToSection(item.dataset.target);
    });
  }
  for (const item of document.querySelectorAll('#dock .dock__item[data-target]')) {
    item.addEventListener('click', () => scrollToSection(item.dataset.target));
  }

  els.navGroupPlatforms?.addEventListener('click', toggleNavPlatforms);
  els.dockCmd?.addEventListener('click', openCommandPalette);
  els.cmdOpen?.addEventListener('click', openCommandPalette);
  els.cmdBtn?.addEventListener('click', openCommandPalette);

  // 命令面板
  els.cmdInput?.addEventListener('input', rebuildCommandList);
  // 点背景关闭：dialog 内部点击不会命中 dialog 自身
  els.cmd?.addEventListener('click', (event) => {
    if (event.target === els.cmd) closeCommandPalette();
  });
  // Esc 走原生 cancel → close；这里只清选中态，不拦默认关闭行为
  els.cmd?.addEventListener('cancel', () => {
    state.cmdIndex = -1;
  });
  els.cmd?.addEventListener('close', () => {
    state.cmdIndex = -1;
    els.cmdInput?.removeAttribute('aria-activedescendant');
    // 面板里可能滚过页面，关掉后把激活项按真实滚动位置重新对齐
    scheduleScrollSpy();
  });

  document.addEventListener('keydown', (event) => {
    // ⌘K / Ctrl+K 优先：即便焦点在 #search、凭证输入框或 #cmd-input 里也要能唤起
    if (isCommandHotkey(event)) {
      // 只拦这一组组合键，普通输入照常落到输入框
      event.preventDefault();
      toggleCommandPalette();
      return;
    }
    if (!els.cmd?.open) return;
    // 输入法组合期间不抢键：中文候选词的回车 / 方向键要留给输入法
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCommand(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveCommand(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runCommand();
    }
  });

  // scrollspy：scroll 用 rAF 节流；resize 时区块位置全变了，重算激活项并重量高亮块
  window.addEventListener('scroll', onWindowScroll, { passive: true });
  window.addEventListener('resize', () => {
    scheduleScrollSpy();
    scheduleNavPill();
  });
  // 平滑滚动结束（支持的浏览器）提前解锁；不支持时靠 lockNavScroll 的静默计时兜底
  window.addEventListener('scrollend', releaseNavScrollLock);
  // 用户中途自己滚（滚轮 / 触摸 / 键盘）就立刻交还控制权，别让高亮卡在点击的目标上
  window.addEventListener('wheel', releaseNavScrollLock, { passive: true });
  window.addEventListener('touchstart', releaseNavScrollLock, { passive: true });
  // 字体/图片加载完布局会变，再量一次高亮块
  window.addEventListener('load', () => {
    scheduleScrollSpy();
    scheduleNavPill();
  });

  // 首屏先按当前滚动位置点亮一次（不是等第一次滚动才亮）
  updateScrollSpy();
  scheduleNavPill();

  // 子菜单若用 CSS 过渡展开，期间量到的是动画中间态：展开结束后再校一次
  els.navPlatforms?.addEventListener('transitionend', scheduleNavPill);
}

function scheduleAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (!state.autoRefresh) return;
  state.timer = setInterval(() => load(false), REFRESH_INTERVAL_MS);
}

els.refreshBtn.addEventListener('click', () => load(true));
els.platformsBtn.addEventListener('click', () => openPlatformsDialog());
els.platformsClose.addEventListener('click', () => els.platformsDialog.close());
// 点遮罩关闭（dialog 内部点击不冒泡到 dialog 本身时才算遮罩）
els.platformsDialog.addEventListener('click', (event) => {
  if (event.target === els.platformsDialog) els.platformsDialog.close();
});
els.platformsDialog.addEventListener('close', () => {
  state.dialog.providerId = null;
});
els.autoRefresh.addEventListener('change', (event) => {
  state.autoRefresh = event.target.checked;
  scheduleAutoRefresh();
});
els.sort.addEventListener('change', (event) => {
  state.sort = event.target.value;
  if (state.data) renderGrid(state.data);
});
els.search.addEventListener('input', (event) => {
  state.query = event.target.value;
  if (state.data) renderGrid(state.data);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  load(false);
  // 后台标签页的定时器会被节流：回到前台立刻补一次登录状态，并继续轮询
  if (state.login?.session && !LOGIN_TERMINAL.has(state.login.session.status)) {
    scheduleLoginPoll(state.login.providerId);
  }
});

// 外壳交互先就位：即使 /api/summary 还没回来，导航、命令面板、停靠栏也能用
bindShell();

scheduleAutoRefresh();
load(false);
