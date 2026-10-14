#!/usr/bin/env bash
#
# 启动一个带 CDP 调试端口的独立 Chrome，供 src/cli/capture.ts 抓取各平台登录态。
#
# 为什么要独立 profile：
#   Chrome 136+ 出于安全考虑，禁止对「默认 user-data-dir」开启 --remote-debugging-port
#   （传了也会被静默忽略）。因此必须指定一个独立 profile 目录。
#   该目录与日常使用的 Chrome 完全隔离，不影响你的正常浏览与登录状态。
#
# 用法：
#   tools/chrome-debug.sh              # 默认端口 9222
#   tools/chrome-debug.sh 9333         # 自定义端口
#
set -euo pipefail

PORT="${1:-9222}"
PROFILE="${POWER_METER_CHROME_PROFILE:-$HOME/.power-meter/chrome-profile}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "找不到 Chrome：$CHROME" >&2
  echo "可通过环境变量 CHROME_BIN 指定路径。" >&2
  exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，说明调试 Chrome 可能已在运行。"
  echo "直接执行 npm run capture 即可；如需重启请先关闭那个窗口。"
  exit 0
fi

mkdir -p "$PROFILE"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$REPO_DIR/.run"
CHROME_LOG="$LOG_DIR/chrome-debug.log"
mkdir -p "$LOG_DIR"

echo "调试 profile：$PROFILE"
echo "调试端口：   http://127.0.0.1:$PORT"
echo "日志：       $CHROME_LOG"

# 后台启动（nohup + disown）：
#   不再 `exec`（那会让终端被 Chrome 占住，且关终端即关浏览器）。
#   这样命令立即返回、关终端也不影响它；**是否关闭这个 Chrome 由你决定**——
#   华为云会话 Cookie 的持久副本存在 `.env` 里，关掉浏览器不影响看板取数。
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-features=Translate,OptimizationHints \
  about:blank >>"$CHROME_LOG" 2>&1 &
disown 2>/dev/null || true

echo "✓ 调试 Chrome 已在后台启动（关闭终端不影响它；需要退出时请直接关掉 Chrome 窗口）"
