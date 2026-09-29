/** 解析宽泛数字：数字 / "1,234" / "12.5%" / "$3.2" */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[%,\s$¥€]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 在多个候选 key 中取第一个非空字符串 */
export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全取值：read(obj, 'a', 'A') 兼容 camelCase / snake_case */
export function pick(source: unknown, ...keys: string[]): unknown {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * 按路径取值，支持 `data.quotaSummary.usedValue` 与 `list[0].remain`，
 * 也支持用 `a|b` 表示候选 key。用于自定义平台的 JSON 字段映射。
 */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

  let current: unknown = source;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    for (const key of segment.split('|')) {
      const candidate = Array.isArray(current)
        ? current[Number(key)]
        : isRecord(current)
          ? current[key]
          : undefined;
      if (candidate !== undefined && candidate !== null) {
        current = candidate;
        break;
      }
      current = undefined;
    }
  }
  return current;
}

/** 把各种时间表示归一为 ISO 字符串 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 兼容秒 / 毫秒 / 微秒时间戳
    const ms = value > 1e15 ? value / 1000 : value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return toIso(Number(raw));
    const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function daysBetween(fromMs: number, iso: string): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return Number.NaN;
  return Math.round(((target - fromMs) / 86_400_000) * 100) / 100;
}
