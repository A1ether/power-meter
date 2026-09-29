interface Entry<T> {
  value: T;
  expiresAt: number;
  /** 刷新失败时用来兜底展示上次成功结果 */
  stale: T | null;
}

export interface ResolveOptions {
  force?: boolean;
}

/**
 * 带 TTL + 并发去重 + last-good 兜底的缓存。
 *
 * - 多个请求同时刷新同一平台时只发一次上游请求（in-flight 去重）
 * - 上游失败时保留上次成功值，看板不会整片变白
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private ttlMs: number) {}

  peek(key: string): { value: T; expired: boolean; stale: T | null } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      value: entry.value,
      expired: Date.now() >= entry.expiresAt,
      stale: entry.stale,
    };
  }

  set(key: string, value: T): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      stale: value,
    });
  }

  /** 标记为过期但保留旧值，用于手动强制刷新 */
  invalidate(key?: string): void {
    if (key === undefined) {
      for (const entry of this.entries.values()) entry.expiresAt = 0;
      return;
    }
    const entry = this.entries.get(key);
    if (entry) entry.expiresAt = 0;
  }

  resolve(key: string, producer: () => Promise<T>, options: ResolveOptions = {}): Promise<T> {
    const entry = this.entries.get(key);
    if (!options.force && entry && Date.now() < entry.expiresAt) {
      return Promise.resolve(entry.value);
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = producer()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .catch((error: unknown) => {
        // 失败时把 TTL 缩短到 15 秒，避免连续失败被无限打回上游
        this.entries.set(key, {
          value: (entry?.stale ?? null) as T,
          expiresAt: Date.now() + 15_000,
          stale: entry?.stale ?? null,
        });
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }
}
