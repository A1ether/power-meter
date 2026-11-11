/**
 * 分页不变式的离线回归（`npm run test:pagination`）。
 *
 * 为什么要有它：CodeArts 的 29 笔签到被截断成 20 笔，缺额被对账差额静默吸收，
 * 界面上看起来完全正常。这类 bug **不会报错、不会掉字段**，只会在某个平台
 * 某天数据变多时悄悄少算。因此把「取全判据」钉成可执行断言，改 `pagination.ts`
 * 或调用方时跑一次即可确认没有回退。
 *
 * 全部是纯函数 / 注入桩，**不发任何网络请求**，不需要凭证。
 * 用法：`npm run test:pagination`
 */
import assert from 'node:assert/strict';
import { fetchAllPages, incompleteNote } from '../lib/pagination.js';

type Item = { id: string };

/** 造一个「分页服务端」：按页返回切片，可指定是否忽略分页参数 */
function makeServer(
  all: Item[],
  options: { pageSize?: number; total?: number | null; ignorePaging?: boolean } = {},
) {
  const pageSize = options.pageSize ?? 100;
  const calls: number[] = [];
  return {
    calls,
    fetchPage: async (page: number) => {
      calls.push(page);
      if (options.ignorePaging) {
        // 模拟「参数名猜错」：每页都返回同一批
        return { items: all.slice(0, pageSize), total: options.total ?? null };
      }
      const start = (page - 1) * pageSize;
      return {
        items: all.slice(start, start + pageSize),
        total: options.total === undefined ? all.length : options.total,
      };
    },
  };
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>): void => {
  cases.push({ name, run });
};

/** ① 本次事故的原始形状：29 条、默认页 20 条 */
test('取全：29 条 / 每页 20，complete 且条数齐全', async () => {
  const all = Array.from({ length: 29 }, (_, i) => ({ id: `b${i}` }));
  const server = makeServer(all, { pageSize: 20 });
  const result = await fetchAllPages<Item>({
    fetchPage: server.fetchPage,
    pageSize: 20,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 29);
  assert.equal(result.complete, true);
  assert.equal(result.expected, 29);
  assert.equal(result.pages, 2);
});

/** ② 回归护栏：只要有一条被漏掉，complete 必须为 false */
test('不变量：少取一条 → complete=false（不允许静默截断）', async () => {
  const all = Array.from({ length: 29 }, (_, i) => ({ id: `b${i}` }));
  // 模拟上游只允许一页（maxPages=1）：截断必须被识别
  const server = makeServer(all, { pageSize: 20 });
  const result = await fetchAllPages<Item>({
    fetchPage: server.fetchPage,
    pageSize: 20,
    maxPages: 1,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 20);
  assert.equal(result.complete, false);
  assert.equal(result.expected, 29);
  assert.ok(incompleteNote(result)?.includes('20'));
});

/** ③ 分页参数不被识别：每页同一批 → 靠「零新增」停下并判未取全 */
test('参数未识别：每页返回同一批 → 不死循环，complete=false', async () => {
  const all = Array.from({ length: 29 }, (_, i) => ({ id: `b${i}` }));
  const server = makeServer(all, { pageSize: 20, ignorePaging: true });
  const result = await fetchAllPages<Item>({
    fetchPage: server.fetchPage,
    pageSize: 20,
    maxPages: 10,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 20);
  assert.equal(result.complete, false);
  assert.equal(result.stoppedBy, 'no-progress');
  assert.equal(server.calls.length, 2, '第 2 页零新增后应立即停止，不应打满 10 页');
});

/** ④ 上游不给 total：短页即末页，正常情况判取全 */
test('无 total：短页判据可判取全', async () => {
  const all = Array.from({ length: 15 }, (_, i) => ({ id: `b${i}` }));
  const server = makeServer(all, { pageSize: 20, total: null });
  const result = await fetchAllPages<Item>({
    fetchPage: server.fetchPage,
    pageSize: 20,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 15);
  assert.equal(result.complete, true);
  assert.equal(result.expected, null);
});

/** ⑤ 短页与 total 矛盾（上游按 status 过滤）→ 不判取全 */
test('短页但 total 更大：判未取全（防止「被过滤」伪装成「取全」）', async () => {
  const all = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}` }));
  const server = makeServer(all, { pageSize: 100, total: 29 });
  const result = await fetchAllPages<Item>({
    fetchPage: server.fetchPage,
    pageSize: 100,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 20);
  assert.equal(result.complete, false, '上游声称 29 但只回 20，必须判未取全');
  assert.equal(result.expected, 29);
});

/** ⑥ 首页失败必须抛出（让调用方走既有降级，而不是当成 0 条） */
test('首页失败：抛错（不得伪装成空列表）', async () => {
  await assert.rejects(
    fetchAllPages<Item>({
      pageSize: 20,
      fetchPage: async () => {
        throw new Error('boom');
      },
    }),
    /boom/,
  );
});

/** ⑦ 第 2 页失败：保留已取到的数据，但 complete=false */
test('次页失败：保留已取数据 + complete=false', async () => {
  const all = Array.from({ length: 29 }, (_, i) => ({ id: `b${i}` }));
  const server = makeServer(all, { pageSize: 20 });
  const result = await fetchAllPages<Item>({
    fetchPage: async (page) => {
      if (page === 2) throw new Error('page2 down');
      return server.fetchPage(page);
    },
    pageSize: 20,
    keyOf: (item) => item.id,
  });
  assert.equal(result.items.length, 20);
  assert.equal(result.complete, false);
  assert.equal(result.stoppedBy, 'error');
  assert.ok(result.error?.includes('page2 down'));
});

/** ⑧ 无去重键时也不能死循环（空页即停） */
test('空页即停：不提供 keyOf 也不会死循环', async () => {
  const result = await fetchAllPages<Item>({
    pageSize: 20,
    maxPages: 10,
    fetchPage: async (page) => ({
      items: page === 1 ? Array.from({ length: 20 }, (_, i) => ({ id: `b${i}` })) : [],
      total: null,
    }),
  });
  assert.equal(result.items.length, 20);
  assert.equal(result.stoppedBy, 'short-page');
  assert.equal(result.pages, 2);
});

/**
 * ⑨ 游标分页的适配层（千问办公 `/user/billings` 的写法）：
 *    上游只给 `has_more` + `next_cursor`，适配器把它翻译成
 *      - has_more=false → total = 已取条数（收敛，判取全）
 *      - has_more=true  → total = 已取条数 + 1（「还有下一页」）
 *    最后一页恰好是满页时，也不能多打一页或判成未取全。
 */
test('游标分页：has_more → total 的翻译在满页末页下仍判取全', async () => {
  const all = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}` }));
  const pageSize = 20;
  const seen = new Set<string>();
  let calls = 0;
  const result = await fetchAllPages<Item>({
    pageSize,
    keyOf: (item) => item.id,
    fetchPage: async (page) => {
      calls += 1;
      const start = (page - 1) * pageSize;
      const items = all.slice(start, start + pageSize);
      for (const item of items) seen.add(item.id);
      const hasMore = start + pageSize < all.length;
      return { items, total: hasMore ? seen.size + 1 : seen.size };
    },
  });
  assert.equal(result.items.length, 40);
  assert.equal(result.complete, true, '满页末页必须判取全');
  assert.equal(calls, 2, '不应在取全后再多打一页');
});

/** ⑪ stopWhen：调用方声明「窗口已覆盖」即停，并判取全（省掉多余页请求） */
test('窗口已覆盖：stopWhen 命中即停且 complete=true', async () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` }));
  const calls: number[] = [];
  const result = await fetchAllPages<Item>({
    pageSize: 20,
    maxPages: 10,
    keyOf: (item) => item.id,
    stopWhen: (items) => items.length >= 40,
    fetchPage: async (page) => {
      calls.push(page);
      const start = (page - 1) * 20;
      return { items: all.slice(start, start + 20), total: all.length };
    },
  });
  assert.equal(result.items.length, 40);
  assert.equal(result.complete, true, '窗口覆盖应判取全（不再需要更早的数据）');
  assert.equal(result.pages, 2);
  assert.equal(result.stoppedBy, 'window-covered');
  assert.deepEqual(calls, [1, 2], '命中后不得再多打一页');
});

/** ⑩ 游标分页超上限：仍要如实判未取全（不允许静默截断） */
test('游标分页超上限：complete=false 且条数等于实际上限', async () => {
  const all = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}` }));
  const pageSize = 20;
  const seen = new Set<string>();
  const result = await fetchAllPages<Item>({
    pageSize,
    maxPages: 2,
    keyOf: (item) => item.id,
    fetchPage: async (page) => {
      const start = (page - 1) * pageSize;
      const items = all.slice(start, start + pageSize);
      for (const item of items) seen.add(item.id);
      const hasMore = start + pageSize < all.length;
      return { items, total: hasMore ? seen.size + 1 : seen.size };
    },
  });
  assert.equal(result.items.length, 40);
  assert.equal(result.complete, false);
  assert.equal(result.stoppedBy, 'max-pages');
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
console.log(`\n分页不变式：${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
