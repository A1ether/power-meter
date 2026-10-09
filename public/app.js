const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 每张卡片默认展示的积分数，其余折叠 */
const VISIBLE_LOTS = 3;

const state = {
  data: null,
  sort: 'expiry',
  query: '',
  autoRefresh: true,
  timer: null,
  loading: false,
  /**
   * 已被显式「显示」或「复制」过的托管密钥明文（key = provider#displayName#field）。
   * 只活在内存里，手动刷新时清空——否则凭证轮换后这页还举着旧值。
   */
  revealed: new Map(),
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
  // 手动刷新 = 「重新读一遍配置」，此时把上一轮读出来的明文密钥丢掉
  if (force) state.revealed.clear();
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

  const available =
    Object.entries(totals.availableByCurrency ?? {})
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
    { label: '可用额度合计', value: available, hint: '各平台账户余额汇总，按币种' },
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
  // 有到期概念的走三色分级；明确不过期的（如 D1V 的 quota）直接给绿色标签。
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

  for (const entry of entries) list.append(buildEntry(provider, entry));
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
  if (secrets.length === 0) {
    row.append(element('p', 'entry__note', '未配置可托管的项目密钥'));
  } else {
    for (const secret of secrets) row.append(buildSecretBlock(provider.provider, entry.id, secret));
  }

  if (healthy && entry.note) row.append(element('p', 'entry__note', entry.note));
  return row;
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
  for (const secret of secrets) list.append(buildSecretBlock(provider.provider, provider.accountId, secret));
}

/** state.revealed 的键：平台 + 账号 + 字段，三者才能唯一确定一把密钥 */
function secretIdOf(providerId, accountId, field) {
  return `${providerId}#${accountId ?? ''}#${field}`;
}

function buildSecretBlock(providerId, accountId, secret) {
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
