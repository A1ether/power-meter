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

echo "调试 profile：$PROFILE"
echo "调试端口：   http://127.0.0.1:$PORT"

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-features=Translate,OptimizationHints \
  about:blank
