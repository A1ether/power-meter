const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const state = {
  data: null,
  sort: 'expiry',
  query: '',
  autoRefresh: true,
  timer: null,
  loading: false,
};

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
  try {
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

  els.meta.textContent = `共 ${data.providers.length} 个平台 · 服务端缓存 ${data.cacheTtlSeconds}s`;
  els.subtitle.textContent = `多平台余额 / 积分看板 · ${data.totals.ok} 个平台数据正常`;
  els.footerUpdated.textContent = `数据生成于 ${fmtDate(data.generatedAt)}`;
}

function renderSummary(data) {
  const { totals, expiryThresholds, expiryTimeline } = data;
  els.summary.replaceChildren();

  const creditsText =
    Object.entries(totals.creditsByCurrency)
      .filter(([, amount]) => amount > 0)
      .map(([currency, amount]) => `${fmtNumber(amount)} ${currency}`)
      .join(' · ') || '–';
  const balanceText =
    Object.entries(totals.balanceByCurrency)
      .filter(([, amount]) => amount > 0)
      .map(([currency, amount]) => `${fmtNumber(amount)} ${currency}`)
      .join(' · ') || '–';

  const critical = expiryTimeline.filter(
    (hit) => hit.inDays <= expiryThresholds.criticalDays,
  ).length;
  const warning = expiryTimeline.filter(
    (hit) =>
      hit.inDays > expiryThresholds.criticalDays && hit.inDays <= expiryThresholds.warningDays,
  ).length;

  const stats = [
    { label: '平台总数', value: String(totals.providers), hint: `${totals.ok} 正常 / ${totals.failed} 异常` },
    { label: '积分合计', value: creditsText, hint: '按币种汇总所有批次' },
    { label: '金额合计', value: balanceText, hint: '现金 / 代金券余额' },
    {
      label: `≤${expiryThresholds.criticalDays} 天到期`,
      value: String(critical),
      hint: `${expiryThresholds.criticalDays}~${expiryThresholds.warningDays} 天内还有 ${warning} 笔`,
      accent: critical > 0,
    },
  ];

  for (const stat of stats) {
    const card = element('div', `stat${stat.accent ? ' stat--accent' : ''}`);
    card.append(
      element('span', 'stat__label', stat.label),
      element('span', 'stat__value', stat.value),
      element('span', 'stat__hint', stat.hint),
    );
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

function sortedProviders(data) {
  const thresholds = data.expiryThresholds;
  const query = state.query.trim().toLowerCase();
  let providers = data.providers;

  if (query) {
    providers = providers.filter((provider) => {
      const haystack = [
        provider.displayName,
        provider.provider,
        provider.plan ?? '',
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
  els.grid.replaceChildren();

  if (providers.length === 0) {
    els.grid.append(
      element('div', 'empty', state.query ? '没有匹配的平台' : '当前没有启用的平台'),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const provider of providers) fragment.append(buildCard(provider, thresholds));
  els.grid.append(fragment);
}

function buildCard(provider, thresholds) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  const healthy = provider.status === 'ok' || provider.status === 'demo';
  node.dataset.state = healthy ? 'ok' : 'failed';
  node.dataset.urgency = urgencyOf(provider, thresholds);

  node.querySelector('.card__name').textContent = provider.displayName;

  const tags = node.querySelector('.card__tags');
  tags.append(
    element('span', `chip chip--${provider.region}`, provider.region === 'cn' ? '国内' : '国际'),
  );
  if (provider.status === 'demo') tags.append(element('span', 'chip chip--demo', '示例数据'));
  if (provider.stale) tags.append(element('span', 'chip chip--warning', '数据可能过期'));
  if (provider.nextExpiryInDays !== null) {
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
  node.querySelector('.card__plan').textContent = planText;

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

  const list = node.querySelector('.lots__list');
  const credits = [...provider.credits].sort(
    (a, b) => (daysUntil(a.expiresAt) ?? Number.POSITIVE_INFINITY) - (daysUntil(b.expiresAt) ?? Number.POSITIVE_INFINITY),
  );

  if (!healthy) {
    const error = element('p', 'card__error', provider.message || '取数失败');
    node.querySelector('.lots').replaceChildren(error);
  } else if (credits.length === 0) {
    node.querySelector('.lots').replaceChildren(
      element('p', 'card__note muted', '该平台只返回总额度，没有可拆分的积分批次'),
    );
  } else {
    for (const lot of credits) {
      const days = daysUntil(lot.expiresAt);
      const level = levelFor(days, thresholds);
      const item = element('li', 'lot');
      item.dataset.level = level;
      item.append(
        element('span', 'lot__label', lot.label),
        element('span', 'lot__amount', `${fmtNumber(lot.amount)} ${lot.currency}`),
      );
      const expiry = element('div', 'lot__expiry');
      expiry.append(
        element('span', null, lot.expiresAt ? `过期：${fmtDate(lot.expiresAt)}` : '不过期'),
        element('span', 'lot__badge', expiryText(days)),
      );
      item.append(expiry);
      if (lot.note) item.title = lot.note;
      list.append(item);
    }
  }

  const note = node.querySelector('.card__note');
  if (provider.note && healthy) {
    note.hidden = false;
    note.textContent = provider.note;
  } else {
    note.hidden = true;
  }

  node.querySelector('.card__updated').textContent = `更新于 ${fmtDate(provider.updatedAt)}`;
  const link = node.querySelector('.card__link');
  if (provider.dashboardUrl) {
    link.href = provider.dashboardUrl;
  } else {
    link.hidden = true;
  }

  return node;
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

function scheduleAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (!state.autoRefresh) return;
  state.timer = setInterval(() => load(false), REFRESH_INTERVAL_MS);
}

els.refreshBtn.addEventListener('click', () => load(true));
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
  if (document.visibilityState === 'visible') load(false);
});

scheduleAutoRefresh();
load(false);
