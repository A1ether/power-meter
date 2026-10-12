#!/usr/bin/env bash
#
# CodeArts 登录态刷新（可无人值守）。
#
# 背景（决定了本脚本的策略）：
#   - 余额走 AK/SK（永久有效），本脚本与它无关；
#   - 「活动福利逐笔」只能来自控制台登录态，而 codearts 的会话 Cookie
#     `devclouddevuibjJ_SESSION_ID` 是**会话级**（不落盘）：Chrome 一旦退出，
#     即使 profile 未变，也等于未登录 —— 所以调试 Chrome 必须常驻（见 tools/chrome-debug.sh）。
#
# 流程（先验证、后抓取，尽量不打扰人）：
#   ① 校验 .env 里现有 Cookie：有效 → 只做「顺手续期」，浏览器侧没会话也不要求登录；
#   ② 现有 Cookie 失效且浏览器侧有会话 → 抓取刷新；
#   ③ 两边都没有 → 自动打开登录页 + 系统通知，退出码 3（这时才真的需要登录一次）。
#
# 退出码：0 有效（已续期或现有仍可用）/ 3 需要人工登录 / 2 调试 Chrome 不可用 / 1 抓取失败
#
# 定时：macOS 用 launchd（npm run codearts:schedule），Linux 用 cron。
#
set -uo pipefail
cd "$(dirname "$0")/.."

CDP="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
PORT="${CDP##*:}"
LOGIN_URL="https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn"
RUN_DIR="$(pwd)/.run"
CHROME_LOG="${RUN_DIR}/chrome-debug.log"
PROBE_LOG="${RUN_DIR}/codearts-probe.log"
mkdir -p "${RUN_DIR}"

# ---------------------------------------------------------------- 基础能力

# CDP 就绪判定：绕开系统代理，并要求返回里确实有 webSocketDebuggerUrl
cdp_ready() {
  curl -s --noproxy '*' -m 3 "${CDP}/json/version" 2>/dev/null | grep -q '"webSocketDebuggerUrl"'
}

notify() {
  if [ "${POWER_METER_NOTIFY:-0}" = "1" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Power Meter · CodeArts\"" >/dev/null 2>&1 || true
  fi
}

# .env 里现有 Cookie 是否仍然有效（只读接口校验，不碰浏览器）
env_cookie_valid() {
  npx --no-install tsx src/cli/codearts-console-probe.ts >"${PROBE_LOG}" 2>&1
}

show_probe_tail() {
  tail -n 8 "${PROBE_LOG}" 2>/dev/null | sed 's/^/    /' || true
}

# 浏览器侧是否还有 codearts 会话 Cookie（走 CDP，不发上游请求）
chrome_has_session() {
  cdp_ready || return 1
  npx --no-install playwright cli -s=pm attach --cdp="${CDP}" >/dev/null 2>&1 || true
  npx --no-install playwright cli -s=pm --raw cookie-list 2>/dev/null \
    | grep -q 'devclouddevuibjJ_SESSION_ID'
}

ensure_chrome() {
  if cdp_ready; then
    echo "[refresh] 调试 Chrome 已在运行"
    return 0
  fi
  echo "[refresh] 调试 Chrome 未运行，自动拉起（端口 ${PORT}，日志 ${CHROME_LOG}）…"
  nohup bash tools/chrome-debug.sh "${PORT}" >>"${CHROME_LOG}" 2>&1 &
  disown 2>/dev/null || true
  for i in $(seq 1 40); do
    sleep 1
    if cdp_ready; then
      echo "[refresh] ✓ 调试 Chrome 就绪（等待 ${i}s）"
      return 0
    fi
  done
  echo "[refresh] ✗ 自动拉起失败；Chrome 日志末尾（${CHROME_LOG}）："
  tail -n 12 "${CHROME_LOG}" 2>/dev/null | sed 's/^/    /' || true
  return 1
}

capture_codearts() { npx --no-install tsx src/cli/capture.ts codearts; }

# 需要人工登录时，顺手在调试 Chrome 里打开登录/用量页
open_login_page() {
  cdp_ready || return 0
  npx --no-install playwright cli -s=pm attach --cdp="${CDP}" >/dev/null 2>&1 || true
  npx --no-install playwright cli -s=pm goto "${LOGIN_URL}" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- 主流程

echo "[refresh] ① 校验 .env 里现有 Cookie…"
if env_cookie_valid; then
  echo "[refresh] ✓ 现有 Cookie 仍然有效（看板不受影响）"
  if chrome_has_session; then
    echo "[refresh] ② 浏览器侧仍有登录态，顺手抓取续期…"
    if capture_codearts; then
      echo "[refresh] ✓ 已续期到最新登录态"
    else
      echo "[refresh] ⚠ 抓取续期失败，但现有 Cookie 仍有效，看板不受影响"
    fi
  else
    echo "[refresh] ② 浏览器侧没有会话（调试 Chrome 重启过或未登录）：本次不做抓取"
    echo "[refresh]    现有 Cookie 仍有效；等它过期后再登录一次即可（余额始终来自 AK/SK）"
  fi
  exit 0
fi

echo "[refresh] 现有 Cookie 已失效，需要浏览器侧登录态："
show_probe_tail

if ! ensure_chrome; then
  echo "[refresh] 请手动执行 npm run chrome:debug（并登录 ${LOGIN_URL}）后重试。"
  exit 2
fi

if chrome_has_session; then
  echo "[refresh] ② 浏览器侧仍有登录态（会话级 Cookie 还在），抓取中…"
  if ! capture_codearts; then
    echo "[refresh] ✗ 抓取失败；请手动运行 npm run chrome:debug 检查窗口是否正常。"
    exit 1
  fi
  if env_cookie_valid; then
    echo "[refresh] ✓ 已刷新登录态；看板下次刷新即显示活动逐笔"
    notify "登录态已刷新，活动逐笔恢复"
    exit 0
  fi
  echo "[refresh] 抓取完成但校验仍失败："
  show_probe_tail
fi

echo "[refresh] ⚠ 浏览器里没有有效登录态：需要登录一次"
open_login_page
echo "[refresh]    已在调试 Chrome 打开登录页：${LOGIN_URL}"
echo "[refresh]    登录后重跑：npm run codearts:refresh"
echo "[refresh]    说明：华为云会话上限 24 小时且会话 Cookie 不落盘，这一步无法用程序绕过；"
echo "[refresh]    但余额与增量不依赖它，看板其余部分照常。"
notify "登录态已过期，需要登录一次（余额不受影响）"
exit 3
