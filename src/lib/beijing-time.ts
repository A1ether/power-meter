/**
 * 北京时间（UTC+8）的日 / 月边界。
 *
 * 本项目服务的是国内平台，「当日 24:00 失效」「当月有效」这类规则一律按北京时间计算，
 * **不跟随容器时区**——否则在西半球机器上会整体偏移一天。
 *
 * 抽到 lib 层的原因：商汤小浣熊（每日赠送）与千问办公（每日刷新 / 每月订阅）
 * 用的是同一条规则，两个适配器各写一份容易出现一处改、另一处漏。
 */

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 北京时间「今天 24:00」（= 明天 00:00）。
 *
 * 边界：东 13 区这类时区在「北京时间刚过零点」的窗口里，算出来会略早于当前时刻；
 * 此时顺延一天，避免把还能用的当日积分误判成「已过期」而移出列表。
 */
export function endOfBeijingDay(now: number): number {
  const shifted = now + BEIJING_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  const end = dayStart + DAY_MS - BEIJING_OFFSET_MS;
  return end > now ? end : end + DAY_MS;
}

/**
 * 北京时间「本月末 24:00」（= 下月 1 日 00:00）。
 *
 * 用于「当月有效」但上游没给具体刷新时间的月度积分：这是**规则推算**，
 * 调用方必须在 note 里写明是推算值，不能当成上游返回的时间。
 * 与 `endOfBeijingDay` 同一理由：算出来已过去则顺延一个月。
 */
export function endOfBeijingMonth(now: number): number {
  const shifted = now + BEIJING_OFFSET_MS;
  const date = new Date(shifted);
  const nextMonthStartShifted = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const end = nextMonthStartShifted - BEIJING_OFFSET_MS;
  if (end > now) return end;
  const after = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 1);
  return after - BEIJING_OFFSET_MS;
}
