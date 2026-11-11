/**
 * 分页取全的唯一入口。
 *
 * 为什么需要它：上游「列表」接口几乎都分页，且**不带参数时只返回默认页**。
 * 只发一次请求就会静默丢掉超出部分，而这类缺失极难被发现 ——
 * CodeArts 的 29 笔每日签到被截断成 20 笔，缺的 9 笔被「账户级桶 − 逐笔合计」
 * 的对账差额吸收成一条「未明细部分」调节项，看起来像正常数据（见
 * docs/fixes/CodeArts-活动奖励逐笔分页截断-修复方案.md）。
 *
 * 因此本模块把「取全」变成**必须显式回答的问题**：
 *   - 返回值里 `complete` 是必填字段，调用方无法「忘了看」；
 *   - `expected` 优先取上游自报的 total；上游不给 total 时用「短页」判据，
 *     但**短页与 total 矛盾时判为未取全**（上游可能按 status 过滤，不能当取全）；
 *   - 失败语义分级：第 1 页失败抛出（交给调用方既有降级），后续页失败则保留已取到的
 *     数据并标记 `complete=false`，绝不把「取了一半」当成完整。
 *
 * 用法约束（写代码时请遵守）：
 *   - 任何「列表 + 可能分页」的接口都必须走这里，不要手写 for 循环翻页；
 *   - `complete === false` 时，要么退回聚合/本地采样口径，要么在 note 里明写未取全，
 *     **禁止**把截断后的合计当作完整值使用。
 */

export type PageStopReason =
  | 'total'
  | 'short-page'
  | 'no-progress'
  | 'max-pages'
  | 'window-covered'
  | 'error';

export interface PagedResult<T> {
  items: T[];
  /** 上游自报的总条数；全程没拿到为 null */
  expected: number | null;
  /** 是否确认取全（唯一可信的完整性判据） */
  complete: boolean;
  /** 实际请求的页数（诊断用） */
  pages: number;
  /** 终止原因（诊断用） */
  stoppedBy: PageStopReason;
  /** 非首页失败时的错误信息（用于日志与 note） */
  error: string | null;
}

export interface PagedOptions<T> {
  /** 单页拉取：返回本页条目与上游 total（拿不到给 null） */
  fetchPage: (page: number) => Promise<{ items: T[]; total: number | null }>;
  pageSize: number;
  /** 翻页上限，防御上游忽略分页参数导致的死循环 */
  maxPages?: number;
  /** 去重键：提供后用于跨页去重与「本页零新增」判定（参数不被识别时会命中） */
  keyOf?: (item: T) => string;
  /** 活动/资源标识，仅用于错误信息 */
  label?: string;
  /**
   * 「所需窗口已覆盖」判定：返回 true 即停止翻页并判 `complete=true`。
   *
   * 给「只要最近一段数据」的调用方用（时间窗已翻过 / 各桶剩余已被发放覆盖），
   * 免得把上限页数全部打完 —— 那既慢，也容易触发上游限流。
   * 它表达的是「不再需要更多」，不是「上游已无更多数据」；因此只应在
   * 「更早的数据按业务规则一定不影响结论」时使用（例如先到期先消耗，
   * 更早的批次已经没有剩余）。拿不准就交给 `total` / 短页判据。
   */
  stopWhen?: (items: T[]) => boolean;
}

const DEFAULT_MAX_PAGES = 10;

export async function fetchAllPages<T>(options: PagedOptions<T>): Promise<PagedResult<T>> {
  const { fetchPage, pageSize, keyOf, label } = options;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const collected = new Map<string, T>();
  const items: T[] = [];
  let expected: number | null = null;
  let pages = 0;

  const push = (page: T[]): number => {
    if (!keyOf) {
      items.push(...page);
      return page.length;
    }
    let added = 0;
    for (const item of page) {
      const key = keyOf(item);
      if (collected.has(key)) continue;
      collected.set(key, item);
      items.push(item);
      added += 1;
    }
    return added;
  };

  /** 有 total 就以 total 为准；没有 total 时，短页即末页 */
  const reachedTotal = (): boolean => expected !== null && items.length >= expected;

  for (let page = 1; page <= maxPages; page += 1) {
    let payload: { items: T[]; total: number | null };
    try {
      payload = await fetchPage(page);
    } catch (error) {
      const message = (error as Error).message;
      // 首页就失败：保持调用方原有降级路径（不能假装「取到 0 条」）
      if (page === 1) throw error;
      return { items, expected, complete: false, pages, stoppedBy: 'error', error: message };
    }
    pages = page;
    if (payload.total !== null && Number.isFinite(payload.total)) expected = payload.total;

    const added = push(payload.items);
    // 调用方声明「需要的窗口已被这批记录覆盖」→ 判取全并停（见 PagedOptions.stopWhen）
    if (options.stopWhen && options.stopWhen(items)) {
      return {
        items,
        expected,
        complete: true,
        pages,
        stoppedBy: 'window-covered',
        error: null,
      };
    }
    if (reachedTotal()) {
      return { items, expected, complete: true, pages, stoppedBy: 'total', error: null };
    }
    if (payload.items.length === 0) {
      // 空页：上游已无更多数据。若 total 声称还有，说明被过滤/参数未被识别
      return {
        items,
        expected,
        complete: reachedTotal(),
        pages,
        stoppedBy: 'short-page',
        error: null,
      };
    }
    // 本页零新增：分页参数未被识别（每页都返回同一批），或确有重复
    if (keyOf && added === 0) {
      return { items, expected, complete: reachedTotal(), pages, stoppedBy: 'no-progress', error: null };
    }
    if (payload.items.length < pageSize) {
      // 短页：正常语义是「最后一页」。但有 total 且没达到时**不判取全** ——
      // 上游可能按 status 过滤掉了部分记录，此时「没有更多页」不等于「没有更多数据」。
      // 没有 total 时短页即可确认取全（后面不会再有数据）。
      return {
        items,
        expected,
        complete: expected === null || reachedTotal(),
        pages,
        stoppedBy: 'short-page',
        error: null,
      };
    }
  }

  return {
    items,
    expected,
    complete: reachedTotal(),
    pages,
    stoppedBy: 'max-pages',
    error: label ? `${label} 达到翻页上限 ${maxPages} 页` : `达到翻页上限 ${maxPages} 页`,
  };
}

/** 未取全时的统一说明文案（note / 日志共用，避免各写一套） */
export function incompleteNote<T>(result: PagedResult<T>, unit = '条'): string | null {
  if (result.complete) return null;
  const got = `${result.items.length} ${unit}`;
  const want = result.expected !== null ? ` / 上游声称 ${result.expected} ${unit}` : '';
  const why =
    result.stoppedBy === 'max-pages'
      ? `翻页达上限 ${result.pages} 页`
      : result.stoppedBy === 'no-progress'
        ? '分页参数未被识别（每页返回同一批）'
        : result.stoppedBy === 'error'
          ? `第 ${result.pages + 1} 页失败：${result.error ?? '未知错误'}`
          : '上游声称的条数与实际返回不一致（可能被服务端过滤）';
  return `分页未取全：已取 ${got}${want}；${why}`;
}
