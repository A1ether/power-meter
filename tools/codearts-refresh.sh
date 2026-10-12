#!/usr/bin/env bash
#
# 一键刷新 CodeArts 登录态（可无人值守）：
#   ① 确保带 CDP 调试端口的 Chrome 在跑 —— 不在则自动拉起 tools/chrome-debug.sh 并等待就绪
#   ② 抓取 codearts 登录态写入 .env（服务按 mtime 热加载，无需重启）
#   ③ 用控制台接口校验登录态是否真的有效，并给出明确结论
#
# 背景：CodeArts 的「余额」走 AK/SK（永久有效，不需要本脚本）；
#       只有「活动福利逐笔」需要登录态，而华为云会话说最长 24 小时 ——
#       本脚本把「手动跑两条命令」压缩成一条，且可挂定时任务无人运行。
#
# 退出码：
#   0  登录态有效
#   3  需要人工登录：调试 Chrome 里没有有效会话 → 在窗口里登录后重跑
#   2  调试 Chrome 不可用（自动拉起也失败）
#   1  抓取失败
#
# 定时示例（macOS 用 launchd：npm run codearts:schedule；Linux 用 cron）：
#   30 9,21 * * * cd /Users/a1ether/DevSpace/power-meter && bash tools/codearts-refresh.sh >> .run/codearts-refresh.log 2>&1
#
set -uo pipefail
cd "$(dirname "$0")/.."

CDP="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
PORT="${CDP##*:}"
LOGIN_URL="https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn"
RUN_DIR="$(pwd)/.run"
CHROME_LOG="$RUN_DIR/chrome-debug.log"

mkdir -p "$RUN_DIR"

# CDP 就绪判定：
#   - --noproxy '*' 绕开系统代理（否则 localhost 请求可能被代理返回 200，造成误判）
#   - 必须能看到 webSocketDebuggerUrl，才算真正的 CDP 端点
cdp_ready() {
  curl -s --noproxy '*' -m 3 "$CDP/json/version" 2>/dev/null | grep -q '"webSocketDebuggerUrl"'
}

ensure_chrome() {
  if cdp_ready; then
    echo "[refresh] CDP 已就绪：$CDP"
    return 0
  fi
  echo "[refresh] 调试 Chrome 未运行，自动拉起（端口 ${PORT}，日志 ${CHROME_LOG}）…"
  # nohup：避免父 shell/任务退出时 Chrome 被 SIGHUP 带走（launchd 场景同样受益）
  nohup bash tools/chrome-debug.sh "$PORT" >>"$CHROME_LOG" 2>&1 &
  for i in $(seq 1 40); do
    sleep 1
    if cdp_ready; then
      echo "[refresh] ✓ 调试 Chrome 就绪（等待 ${i}s）"
      return 0
    fi
  done
  echo "[refresh] ✗ 自动拉起失败；Chrome 日志末尾（${CHROME_LOG}）："
  tail -n 12 "$CHROME_LOG" 2>/dev/null | sed 's/^/    /' || true
  return 1
}

capture_codearts() { npx --no-install tsx src/cli/capture.ts codearts; }

# 需要人工登录时，顺手在调试 Chrome 里打开登录/用量页，省掉手动找地址
open_login_page() {
  npx --no-install playwright cli -s=pm attach --cdp="$CDP" >/dev/null 2>&1 || true
  npx --no-install playwright cli -s=pm goto "$LOGIN_URL" >/dev/null 2>&1 || true
}

# 系统通知（launchd 任务里由 POWER_METER_NOTIFY=1 打开），失败即提醒登录
notify() {
  if [ "${POWER_METER_NOTIFY:-0}" = "1" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Power Meter · CodeArts\"" >/dev/null 2>&1 || true
  fi
}

if ! ensure_chrome; then
  echo "[refresh] 请手动执行 npm run chrome:debug（并登录 ${LOGIN_URL}）后重试。"
  exit 2
fi

echo "[refresh] ① 抓取 CodeArts 登录态（顺便会打开用量页）…"
if ! capture_codearts; then
  echo "[refresh] 抓取失败，重新确认调试 Chrome 后重试一次…"
  if ! ensure_chrome || ! capture_codearts; then
    echo "[refresh] ✗ 抓取仍失败；请手动运行 npm run chrome:debug 检查窗口是否正常。"
    exit 1
  fi
fi

echo "[refresh] ② 校验登录态有效性…"
npx --no-install tsx src/cli/codearts-console-probe.ts
CODE=$?

if [ "$CODE" -eq 0 ]; then
  echo "[refresh] ✓ 登录态有效；看板下次刷新即显示活动逐笔（余额始终来自 AK/SK，不受影响）"
  notify "登录态已刷新，活动逐笔恢复"
else
  echo "[refresh] ⚠ 登录态无效（退出码 ${CODE}）：请在调试 Chrome 窗口里登录"
  echo "[refresh]    已尝试为你打开登录页：$LOGIN_URL"
  open_login_page
  echo "[refresh]    登录后重跑：npm run codearts:refresh"
  echo "[refresh]    说明：华为云会话超时上限 24 小时，这一步无法用程序绕过；"
  echo "[refresh]    但余额与增量不依赖它，看板其余部分照常。"
  notify "登录态已过期，需要登录一次（余额不受影响）"
fi
exit "$CODE"
