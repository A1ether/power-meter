#!/usr/bin/env bash
#
# CodeArts 登录态刷新（可无人值守）。
#
# 背景（决定了本脚本的策略）：
#   - 余额走 AK/SK（永久有效），本脚本与它无关；
#   - 「活动福利逐笔」只能来自控制台登录态；codearts 的会话 Cookie
#     `devclouddevuibjJ_SESSION_ID` 是**会话级**（不落盘），但这不影响使用：
#     `.env` 里存着它的副本，才是真正的持久存储 —— **关闭 Chrome 不影响看板**，
#     浏览器只在「需要重新取一次 Cookie」时才用得上，用完即可关闭。
#
# 流程（先验证、后抓取，尽量不打扰人）：
#   ① 校验 .env 里现有 Cookie：有效 → 只做「顺手续期」，浏览器侧没会话也不要求登录；
#   ② 现有 Cookie 失效且浏览器侧有会话 → 抓取刷新；
#   ③ 都没有 → 先打开用量页尝试华为云 SSO「静默重登」（账号长期登录态还在，
#      多数情况无需输密码）→ 成功即自动抓取；仍不行才打开登录页 + 系统通知，退出码 3。
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
    echo "[refresh] ② 浏览器侧没有会话（Chrome 关过或未登录）：本次不做抓取，也不需要开浏览器"
    echo "[refresh]    .env 里的 Cookie 就是持久副本，关 Chrome 不影响看板；"
    echo "[refresh]    等它过期后，脚本会自动打开用量页尝试 SSO 静默重登"
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

# ③ 尝试华为云 SSO 静默重登：账号级登录态（auth.huaweicloud.com 的刷新令牌）是长期有效的，
#    打开用量页后通常无需输密码即可重新拿到 codearts 会话。
echo "[refresh] ③ 打开用量页，等待华为云 SSO 静默重登（多数情况无需输密码）…"
open_login_page
for i in $(seq 1 4); do
  sleep 5
  if chrome_has_session; then
    echo "[refresh] ✓ SSO 已静默恢复会话（等待 $((i * 5))s），抓取中…"
    if capture_codearts && env_cookie_valid; then
      echo "[refresh] ✓ 已刷新登录态；看板下次刷新即显示活动逐笔（Chrome 现在可以关掉了）"
      notify "登录态已自动恢复，活动逐笔正常"
      exit 0
    fi
    echo "[refresh] ⚠ SSO 恢复后抓取/校验仍失败："
    show_probe_tail
    break
  fi
done

echo "[refresh] ⚠ 需要人工登录一次（已在调试 Chrome 打开页面）"
echo "[refresh]    ${LOGIN_URL}"
echo "[refresh]    登录后重跑：npm run codearts:refresh（之后可以正常关闭 Chrome）"
echo "[refresh]    说明：这一步是华为云服务端会话过期的硬边界，无法用程序绕过；"
echo "[refresh]    但余额与增量不依赖它，看板其余部分照常。"
notify "登录态已过期，需要登录一次（余额不受影响）"
exit 3
