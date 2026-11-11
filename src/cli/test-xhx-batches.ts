/**
 * 小浣熊「逐批剩余 / 逐批到期」分配的离线回归（`npm run test:xhx-batches`）。
 *
 * 为什么要有它：`allocateXhxBatches()` 是**推理**而不是直接读上游——它按平台公布的
 * 消耗顺序（同类内先到期先消耗）把「账户级桶剩余」分摊到每一笔发放上。
 * 这类算法一旦写反（先消耗最晚到期的、差额被静默吞并），界面上完全看不出异常，
 * 只会让「最快到期」永远偏晚，正是本次要修的那个 bug 的形状。
 *
 * 全部是纯函数与手造流水，**不发任何网络请求、不需要凭证**。
 * 用法：`npm run test:xhx-batches`
 */
import assert from 'node:assert/strict';
import type { AccountConfig } from '../config.js';
import type { ProbeContext } from '../providers/base.js';
import {
  allocateXhxBatches,
  buildXhxLots,
  fetchXhxBills,
  grantsCoverBalances,
  type XhxBalance,
  type XhxBill,
  type XhxEntitlement,
} from '../providers/xiaohuanxiong.js';

/** 参照时刻：2026-11-11 09:14:57（+08:00） */
const NOW = Date.parse('2026-11-11T09:14:57+08:00');
/** 北京时间「今天 24:00」= 2026-11-11T16:00:00.000Z */
const TODAY_END = '2026-11-11T16:00:00.000Z';

function bill(input: {
  id: string;
  points: number;
  at: string;
  expire?: string | null;
  bizType?: string;
  eventName?: string;
}): XhxBill {
  return {
    id: input.id,
    bizType: input.bizType ?? 'daily_grant',
    eventName: input.eventName ?? '每日积分发放',
    points: input.points,
    at: Date.parse(input.at),
    expiresAt: input.expire ? Date.parse(input.expire) : null,
  };
}

function balance(input: Partial<XhxBalance> = {}): XhxBalance {
  return {
    available: 0,
    daily: 0,
    monthly: 0,
    reward: 0,
    topup: 0,
    topupFrozen: false,
    enterpriseTopup: 0,
    ...input,
  };
}

const NO_ENTITLEMENT: XhxEntitlement = { plan: null, subscriptionExpiresAt: null };

/**
 * 用户截图里的那五笔每日发放：11-07 / 11-09 / 11-10 / 11-11 各 300，
 * 到期时间分别延长到 11-13 / 11-15 / 11-16 / 11-17 24:00；
 * 11-08 那笔当天没登录，`expire_at` 就是当日 24:00（已作废）。
 */
function userScreenshotBills(): XhxBill[] {
  return [
    bill({ id: 'd-11-07', points: 300, at: '2026-11-07T00:00:00+08:00', expire: '2026-11-14T00:00:00+08:00' }),
    bill({ id: 'd-11-08', points: 300, at: '2026-11-08T00:00:00+08:00', expire: '2026-11-09T00:00:00+08:00' }),
    bill({ id: 'd-11-09', points: 300, at: '2026-11-09T00:00:00+08:00', expire: '2026-11-16T00:00:00+08:00' }),
    bill({ id: 'd-11-10', points: 300, at: '2026-11-10T00:00:00+08:00', expire: '2026-11-17T00:00:00+08:00' }),
    bill({ id: 'd-11-11', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00' }),
  ];
}

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>): void => {
  cases.push({ name, run });
};

/** ① 无消耗：四笔有效发放各成一条批次，过期那笔不出现 */
test('逐批：无消耗时按发放笔数拆开，过期批次被排除', () => {
  const { batches, gaps } = allocateXhxBatches({
    bills: userScreenshotBills(),
    balances: { daily: 1200, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.equal(batches.length, 4, '11-08 那笔已过期，不应参与');
  assert.deepEqual(
    batches.map((batch) => batch.billId),
    ['d-11-07', 'd-11-09', 'd-11-10', 'd-11-11'],
  );
  assert.deepEqual(
    batches.map((batch) => batch.remaining),
    [300, 300, 300, 300],
  );
  assert.equal(gaps.length, 0);
  // 到期时间必须是各笔自己的 expire_at，而不是「同一笔被复制四份」
  assert.deepEqual(
    batches.map((batch) => new Date(batch.expiresAt).toISOString()),
    [
      '2026-11-13T16:00:00.000Z',
      '2026-11-15T16:00:00.000Z',
      '2026-11-16T16:00:00.000Z',
      '2026-11-17T16:00:00.000Z',
    ],
  );
});

/** ② 先到期先消耗：消耗 600 后只剩最晚到期的两笔 */
test('逐批：按「同类内先到期先消耗」反推剩余', () => {
  const { batches } = allocateXhxBatches({
    bills: userScreenshotBills(),
    balances: { daily: 600, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.deepEqual(
    batches.map((batch) => batch.billId),
    ['d-11-10', 'd-11-11'],
  );
  assert.deepEqual(
    batches.map((batch) => batch.remaining),
    [300, 300],
  );
});

/** ③ 部分消耗落在边界那一笔上：不能把整笔当成剩余 */
test('逐批：消耗到一半时边界批次只保留差额', () => {
  const { batches } = allocateXhxBatches({
    bills: userScreenshotBills(),
    balances: { daily: 1050, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.deepEqual(
    batches.map((batch) => [batch.billId, batch.remaining]),
    [
      ['d-11-07', 150],
      ['d-11-09', 300],
      ['d-11-10', 300],
      ['d-11-11', 300],
    ],
  );
});

/** ④ 发放合计不足：差额进 gaps，绝不被塞进某一笔真实批次 */
test('逐批：明细不足时如实进 gaps，不硬凑', () => {
  const { batches, gaps } = allocateXhxBatches({
    bills: [bill({ id: 'd-11-11', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00' })],
    balances: { daily: 1500, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].remaining, 300);
  assert.deepEqual(gaps, [{ bucket: 'daily', amount: 1200 }]);
});

/** ⑤ 输入顺序无关：翻页顺序 / 上游排序变化不得改变结果 */
test('逐批：流水乱序不影响分配结果', () => {
  const shuffled = [3, 0, 4, 1, 2].map((index) => userScreenshotBills()[index]);
  const forward = allocateXhxBatches({
    bills: userScreenshotBills(),
    balances: { daily: 1050, monthly: 0, reward: 0 },
    now: NOW,
  });
  const backward = allocateXhxBatches({
    bills: shuffled,
    balances: { daily: 1050, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.deepEqual(backward.batches, forward.batches);
});

/** ⑥ 桶之间隔离：加油包 / 过期流水 / 消耗流水都不得混进每日批次 */
test('逐批：加油包与过期流水不参与每日桶分配', () => {
  const { batches } = allocateXhxBatches({
    bills: [
      ...userScreenshotBills(),
      bill({ id: 'topup-1', points: 500, at: '2026-11-05T12:00:00+08:00', expire: null, bizType: 'topup_purchase' }),
      bill({ id: 'expire-1', points: -300, at: '2026-11-09T00:00:00+08:00', expire: null, bizType: 'daily_expire' }),
      bill({ id: 'use-1', points: -4, at: '2026-11-11T09:02:00+08:00', expire: null, bizType: 'desktop_chat' }),
    ],
    balances: { daily: 1200, monthly: 0, reward: 0 },
    now: NOW,
  });
  assert.equal(batches.length, 4);
  assert.ok(batches.every((batch) => batch.bucket === 'daily'));
});

/** ⑦ 三类桶各自独立：每月 / 奖励不会串到每日桶 */
test('逐批：每日 / 每月 / 奖励三类互不串桶', () => {
  const { batches } = allocateXhxBatches({
    bills: [
      bill({ id: 'd', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00' }),
      // 上游 monthly/reward 的 biz_type 未在客户端出现，只有服务端下发的中文 event_name
      bill({ id: 'm', points: 10000, at: '2026-11-01T00:00:00+08:00', expire: '2026-11-30T16:00:00.000Z', bizType: 'points_grant', eventName: '每月会员积分发放' }),
      bill({ id: 'r', points: 2000, at: '2026-10-26T00:00:00+08:00', expire: '2027-10-26T00:00:00+08:00', bizType: 'points_grant', eventName: '新人注册礼包' }),
    ],
    balances: { daily: 300, monthly: 2000, reward: 1000 },
    now: NOW,
  });
  const byBucket = new Map(batches.map((batch) => [batch.bucket, batch.remaining]));
  assert.equal(byBucket.get('daily'), 300);
  assert.equal(byBucket.get('monthly'), 2000);
  assert.equal(byBucket.get('reward'), 1000);
  // 每月桶剩余 2000 < 授予 10000：只呈现剩余，不呈现授予
  assert.equal(batches.find((batch) => batch.bucket === 'monthly')?.granted, 10000);
});

/** ⑧ 组装层：逐批 Lot 的标签 / 金额 / 到期都对得上，且总额仍等于桶剩余 */
test('组装：一条发放一个 CreditLot，金额合计等于账户级剩余', () => {
  const { lots, notes } = buildXhxLots({
    balance: balance({ available: 1200, daily: 1200 }),
    bills: userScreenshotBills(),
    billsAvailable: true,
    entitlement: NO_ENTITLEMENT,
    now: NOW,
  });
  assert.equal(lots.length, 4);
  assert.deepEqual(
    lots.map((lot) => lot.label),
    ['每日赠送积分 · 11-07', '每日赠送积分 · 11-09', '每日赠送积分 · 11-10', '每日赠送积分 · 11-11'],
  );
  assert.equal(
    lots.reduce((sum, lot) => sum + lot.amount, 0),
    1200,
  );
  assert.ok(lots.every((lot) => lot.granted === 300));
  // 最早到期 = 11-07 那一笔 → 「最快到期」不再是「最晚到期」
  assert.equal(lots[0].expiresAt, '2026-11-13T16:00:00.000Z');
  assert.equal(new Set(lots.map((lot) => lot.id)).size, lots.length, '批次 id 必须唯一');
  assert.ok(notes.some((note) => note.includes('反推')), '必须标注逐批剩余是反推口径');
});

/** ⑨ 组装层：明细不足以覆盖时出「未明细部分」调节项并注明，不冒充真实批次 */
test('组装：未覆盖部分单列为调节项并给出说明', () => {
  const { lots, notes } = buildXhxLots({
    balance: balance({ available: 1500, daily: 1500 }),
    bills: userScreenshotBills().slice(-1),
    billsAvailable: true,
    entitlement: NO_ENTITLEMENT,
    now: NOW,
  });
  const gap = lots.find((lot) => lot.id === 'xhx-daily-unitemized');
  assert.ok(gap, '应有未明细部分调节项');
  assert.equal(gap?.amount, 1200);
  assert.ok(gap?.label.includes('未明细部分'));
  assert.equal(gap?.expiresAt, TODAY_END, '差额按保守上界（今天 24:00）估，不谎报 7 天');
  assert.ok(notes.some((note) => note.includes('未取到逐笔明细')));
});

/** ⑩ 明细整体不可用：退回桶级聚合口径，到期靠规则 / 订阅兜底 */
test('组装：明细不可用时退回桶级聚合口径', () => {
  const entitlement: XhxEntitlement = {
    plan: '个人升级版（订阅）',
    subscriptionExpiresAt: '2026-12-01T00:00:00+08:00',
  };
  const { lots, notes } = buildXhxLots({
    balance: balance({ available: 3300, daily: 300, monthly: 2000, reward: 1000, topup: 0 }),
    bills: [],
    billsAvailable: false,
    entitlement,
    now: NOW,
  });
  assert.deepEqual(
    lots.map((lot) => [lot.id, lot.amount, lot.expiresAt]),
    [
      ['xhx-daily', 300, TODAY_END],
      ['xhx-monthly', 2000, '2026-11-30T16:00:00.000Z'],
      ['xhx-reward', 1000, null],
    ],
  );
  assert.ok(notes.some((note) => note.includes('兜底')));
});

/** ⑪ 加油包：永久有效 → 不参与「最快到期」（expiresAt 为 null） */
test('组装：加油包永久有效且单列', () => {
  const { lots } = buildXhxLots({
    balance: balance({ available: 800, topup: 500, enterpriseTopup: 300 }),
    bills: [],
    billsAvailable: false,
    entitlement: NO_ENTITLEMENT,
    now: NOW,
  });
  const topup = lots.find((lot) => lot.id === 'xhx-topup');
  const enterprise = lots.find((lot) => lot.id === 'xhx-enterprise-topup');
  assert.equal(topup?.expiresAt, null);
  assert.equal(topup?.amount, 500);
  assert.equal(enterprise?.expiresAt, null);
  assert.equal(enterprise?.amount, 300);
});

/** ⑫ 奖励差额：到期时间未知时不编日期（拿「已知最早」当日期会让最快到期再次偏晚） */
test('组装：奖励差额批次不给日期，改为「到期未知」并排除在最快到期外', () => {
  const { lots, notes } = buildXhxLots({
    balance: balance({ available: 8000, reward: 5000 }),
    bills: [
      bill({ id: 'r-late', points: 2000, at: '2026-10-01T00:00:00+08:00', expire: '2027-10-01T00:00:00+08:00', bizType: 'points_grant', eventName: '活动奖励' }),
      bill({ id: 'r-later', points: 1000, at: '2026-11-01T00:00:00+08:00', expire: '2027-11-01T00:00:00+08:00', bizType: 'points_grant', eventName: '活动奖励' }),
    ],
    billsAvailable: true,
    entitlement: NO_ENTITLEMENT,
    now: NOW,
  });
  const gap = lots.find((lot) => lot.id === 'xhx-reward-unitemized');
  assert.ok(gap, '应有奖励未明细部分');
  assert.equal(gap?.amount, 2000);
  assert.equal(gap?.expiresAt, null, '缺失的批次比已知的更早到期，已知日期只是上界，不能当真实到期');
  assert.ok(gap?.label.includes('未明细部分'));
  assert.ok(gap?.note.includes('不代表永久有效'));
  assert.ok(notes.some((note) => note.includes('未参与「最快到期」')));
});

/** ⑬ 桶归属：中文「签到奖励」必须归奖励，不能被 daily 关键字先吃掉 */
test('桶归属：biz_type 判不出时按中文 event_name，且签到归奖励', () => {
  const { batches } = allocateXhxBatches({
    bills: [
      bill({ id: 'checkin', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00', bizType: 'points_grant', eventName: '活动签到奖励' }),
      bill({ id: 'daily-chk', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00', bizType: 'points_grant', eventName: '每日签到奖励' }),
      bill({ id: 'daily', points: 300, at: '2026-11-11T00:00:00+08:00', expire: '2026-11-18T00:00:00+08:00', bizType: 'daily_grant', eventName: '每日积分发放' }),
    ],
    balances: { daily: 600, monthly: 0, reward: 300 },
    now: NOW,
  });
  // 顺序由到期时间决定（同到期按发放时间），这里只断言归类
  assert.deepEqual(
    Object.fromEntries(batches.map((batch) => [batch.billId, batch.bucket])),
    { 'daily-chk': 'daily', daily: 'daily', checkin: 'reward' },
    '「每日签到奖励」属于每日额度（7 天），「活动签到奖励」才是奖励积分',
  );
});

/** ⑭ 提前停判据：各桶有效发放合计覆盖剩余即可停（更早的发放已无剩余） */
test('提前停：grantsCoverBalances 只认有效发放，未覆盖时不得停', () => {
  const grants = userScreenshotBills();
  const covered = { daily: 1200, monthly: 0, reward: 0 };
  assert.equal(grantsCoverBalances(grants, covered, NOW), true);
  assert.equal(grantsCoverBalances(grants, { daily: 1500, monthly: 0, reward: 0 }, NOW), false);
  // 余额为 0 的桶不参与判定
  assert.equal(grantsCoverBalances([], { daily: 0, monthly: 0, reward: 0 }, NOW), true);
  // 过期的那笔不能算进覆盖（11-08 那笔已作废）
  assert.equal(
    grantsCoverBalances(grants.filter((b) => b.id === 'd-11-08'), { daily: 300, monthly: 0, reward: 0 }, NOW),
    false,
  );
});

/* ---------------- 取数层：用假 fetch 跑真实实现（纯离线，不联网） ---------------- */

const TEST_ACCOUNT: AccountConfig = {
  provider: 'xiaohuanxiong',
  enabled: true,
  displayName: null,
  credentials: { token: 'offline-test-token' },
  options: {},
};
const TEST_CTX: ProbeContext = { now: NOW, timeoutMs: 1_000, log: () => {} };
const pageBill = (id: string): unknown => ({
  bill_id: id,
  biz_type: 'daily_grant',
  event_name: '每日积分发放',
  points: 300,
  created_at: '2026-11-11T00:00:00+08:00',
  grant_at: '2026-11-11T00:00:00+08:00',
  expire_at: '2026-11-18T00:00:00+08:00',
});

/** 拦截全局 fetch，按页返回假响应；返回调用记录（含 query，便于断言游标） */
async function withStubbedFetch<T>(
  pages: Array<{ items: unknown[]; has_more?: boolean; next_cursor?: string | null }>,
  run: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const page = pages[index] ?? { items: [], has_more: false };
    index += 1;
    return new Response(JSON.stringify({ code: 0, data: page }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

/** ⑮ 游标翻页：has_more → total 翻译，短页末页仍判取全，游标要带到下一页 */
test('取数：游标翻页取全（45 条 / 3 页），且下一页带上 cursor', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => pageBill(`b${i}`));
  const page2 = Array.from({ length: 20 }, (_, i) => pageBill(`b${20 + i}`));
  const page3 = Array.from({ length: 5 }, (_, i) => pageBill(`b${40 + i}`));
  const { result, urls } = await withStubbedFetch(
    [
      { items: page1, has_more: true, next_cursor: 'c1' },
      { items: page2, has_more: true, next_cursor: 'c2' },
      { items: page3, has_more: false },
    ],
    () => fetchXhxBills(TEST_ACCOUNT, TEST_CTX, { type: 'income' }),
  );
  assert.equal(result.items.length, 45);
  assert.equal(result.complete, true);
  assert.equal(result.incompleteNote, null);
  assert.equal(urls.length, 3);
  assert.ok(urls[1].includes('cursor=c1') && urls[2].includes('cursor=c2'), '游标必须带到下一页');
  assert.ok(urls[0].includes('type=income'), '取数类型要透传');
});

/** ⑯ 取全判据：跨页重复 id 不虚增、不误判未取全 */
test('取数：跨页重复的 bill_id 只算一次，仍判取全', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => pageBill(`b${i}`));
  const page2 = [
    ...Array.from({ length: 10 }, (_, i) => pageBill(`b${10 + i}`)),
    ...Array.from({ length: 10 }, (_, i) => pageBill(`b${20 + i}`)),
  ];
  const { result } = await withStubbedFetch(
    [
      { items: page1, has_more: true, next_cursor: 'c1' },
      { items: page2, has_more: false },
    ],
    () => fetchXhxBills(TEST_ACCOUNT, TEST_CTX, { type: 'income' }),
  );
  assert.equal(result.items.length, 30);
  assert.equal(result.complete, true);
});

/** ⑰ 上游说还有却不给游标：必须如实判未取全，不能静默截断 */
test('取数：has_more 但无游标 → 不死循环、判未取全并给出说明', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => pageBill(`b${i}`));
  const { result, urls } = await withStubbedFetch(
    [
      // 上游声称「还有」却不给游标：下一页只会拿回同一批（模拟真实表现）
      { items: page1, has_more: true, next_cursor: null },
      { items: page1, has_more: true, next_cursor: null },
    ],
    () => fetchXhxBills(TEST_ACCOUNT, TEST_CTX, { type: 'income' }),
  );
  assert.equal(result.complete, false);
  assert.ok(result.incompleteNote?.includes('未取全'));
  assert.equal(urls.length, 2, '第 2 页应原样重打（零新增）后停下');
});

/** ⑱ 时间窗覆盖：只认满页跨过边界；短页跨边界不得冒充「已覆盖」 */
test('取数：stopBefore 只在满页跨过边界时判取全', async () => {
  const old = { ...(pageBill('old') as Record<string, unknown>), created_at: '2026-11-08T00:00:00+08:00' };
  const fullPage = [...Array.from({ length: 19 }, (_, i) => pageBill(`b${i}`)), old];
  const windowStart = Date.parse('2026-11-10T00:00:00+08:00');

  const covered = await withStubbedFetch(
    [
      { items: fullPage, has_more: true, next_cursor: 'c1' },
      { items: [], has_more: false },
    ],
    () => fetchXhxBills(TEST_ACCOUNT, TEST_CTX, { type: 'all', stopBefore: windowStart }),
  );
  assert.equal(covered.result.complete, true);
  assert.equal(covered.urls.length, 1, '满页跨过边界就应停，不再多打一页');

  const shortPage = fullPage.slice(0, 5);
  const short = await withStubbedFetch(
    [{ items: shortPage, has_more: true, next_cursor: 'c1' }],
    () => fetchXhxBills(TEST_ACCOUNT, TEST_CTX, { type: 'all', stopBefore: windowStart }),
  );
  assert.equal(short.result.complete, false, '短页跨边界不能宣称窗口已覆盖');
});

/** ⑲ 端到端：假的三个上游接口 → 真实 `probe()`（复刻用户截图：5 笔每日、1 笔已作废） */
test('端到端：probe 产出逐批到期，最快到期 = 11-07 那笔（不是最新的 11-11）', async () => {
  const incomePage: { items: unknown[]; has_more: boolean; next_cursor?: string } = {
    items: [
      ...userScreenshotBills().map((bill) => ({
        bill_id: bill.id,
        biz_type: bill.bizType,
        event_name: bill.eventName,
        points: bill.points,
        created_at: new Date(bill.at).toISOString(),
        grant_at: new Date(bill.at).toISOString(),
        expire_at: bill.expiresAt === null ? null : new Date(bill.expiresAt).toISOString(),
      })),
      {
        bill_id: 'r-1',
        biz_type: 'points_grant',
        event_name: '活动奖励',
        points: 2000,
        created_at: '2026-10-26T00:00:00+08:00',
        grant_at: '2026-10-26T00:00:00+08:00',
        expire_at: '2027-10-26T00:00:00+08:00',
      },
    ],
    has_more: false,
  };

  const olderPage = {
    items: [
      {
        bill_id: 'old-daily',
        biz_type: 'daily_grant',
        event_name: '每日积分发放',
        points: 300,
        created_at: '2026-10-20T00:00:00+08:00',
        grant_at: '2026-10-20T00:00:00+08:00',
        expire_at: '2026-10-27T00:00:00+08:00',
      },
    ],
    has_more: false,
  };
  incomePage.has_more = true;
  incomePage.next_cursor = 'c2';

  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    let body: unknown;
    if (url.includes('/points/v1/balance')) {
      body = {
        code: 0,
        data: {
          available_points: 3200,
          daily_points: 1200,
          monthly_points: 0,
          reward_points: 2000,
          topup_points: 0,
          topup_frozen: false,
          enterprise_topup_points: 0,
        },
      };
    } else if (url.includes('/points/v2/bills')) {
      body = { code: 0, data: url.includes('cursor=c2') ? olderPage : incomePage };
    } else if (url.includes('/auth/v1/entitlement_info')) {
      body = {
        code: 0,
        data: { office: { active_plan: { type: 'subscription', subscription_expired_at: '2026-12-01T00:00:00+08:00' } } },
      };
    } else {
      body = { code: 0, data: {} };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { xiaohuanxiongAdapter } = await import('../providers/xiaohuanxiong.js');
    const snapshot = await xiaohuanxiongAdapter.probe(TEST_ACCOUNT, TEST_CTX);
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.balance?.amount, 3200);
    assert.equal(snapshot.credits.length, 5, '4 笔每日（11-08 已作废）+ 1 笔奖励');
    assert.equal(
      snapshot.nextExpiryAt,
      '2026-11-13T16:00:00.000Z',
      '最快到期必须是 11-07 那笔，而不是最新的 11-11',
    );
    assert.deepEqual(
      snapshot.credits.map((lot) => [lot.label, lot.amount]),
      [
        ['每日赠送积分 · 11-07', 300],
        ['每日赠送积分 · 11-09', 300],
        ['每日赠送积分 · 11-10', 300],
        ['每日赠送积分 · 11-11', 300],
        ['奖励积分 · 10-26', 2000],
      ],
    );
    assert.ok(snapshot.note?.includes('反推'), '卡片 note 必须标注逐批剩余是反推口径');
    assert.ok(urls.some((url) => url.includes('type=income')), '探针应取发放流水');
    // 第 1 页各桶发放合计已覆盖桶剩余 → 必须提前停（证明 probe 真的传了 stopWhen），
    // 否则会去翻只有更早发放的第 2 页
    assert.equal(
      urls.filter((url) => url.includes('/points/v2/bills')).length,
      1,
      '各桶剩余已被覆盖时应停止翻页',
    );
  } finally {
    globalThis.fetch = original;
  }
});

let failed = 0;
for (const item of cases) {
  try {
    await item.run();
    console.log(`  ✓ ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${item.name}\n    ${(error as Error).message}`);
  }
}
console.log(`\n小浣熊逐批分配：${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;