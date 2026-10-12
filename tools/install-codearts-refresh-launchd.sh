#!/usr/bin/env bash
#
# 安装 / 卸载 CodeArts 登录态自动刷新定时任务（macOS launchd LaunchAgent）。
#
# 用途：每天 09:30 / 21:30 自动执行 tools/codearts-refresh.sh ——
#       「确保调试 Chrome 在跑 → 抓取登录态 → 校验」，让「活动福利逐笔」尽量长期在线；
#       余额与增量不依赖登录态（走 AK/SK），所以即使校验失败也不影响看板主体。
#
# 用法：
#   bash tools/install-codearts-refresh-launchd.sh              # 安装（幂等，可重复执行）
#   bash tools/install-codearts-refresh-launchd.sh --status     # 查看已加载状态
#   bash tools/install-codearts-refresh-launchd.sh --run        # 立即触发一次
#   bash tools/install-codearts-refresh-launchd.sh --uninstall  # 卸载
#
# 说明：
#   - 登录态失效时任务会退出码 3 并弹出系统通知，此时需要在调试 Chrome 窗口里登录一次
#     （华为云会话上限 24 小时，这一步无法用程序绕过）；
#   - 调试 Chrome 使用持久化 profile（~/.power-meter/chrome-profile），浏览器保持登录时
#     可长期无人值守；launchd 会在 macOS 睡眠后补跑错过的任务。
#
set -euo pipefail

LABEL="com.powermeter.codearts-refresh"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$PROJECT_DIR/.run"
LOG="$LOG_DIR/codearts-refresh.log"
UID_NUM="$(id -u)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "该脚本仅支持 macOS（launchd）。Linux 请用 cron。" >&2
  exit 1
fi

case "${1:-install}" in
  --status)
    if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
      launchctl print "gui/${UID_NUM}/${LABEL}" | grep -E "state|program|runs|last exit" || true
    else
      echo "未安装（${LABEL}）"
    fi
    exit 0
    ;;
  --run)
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    echo "已触发一次；日志：${LOG}"
    exit 0
    ;;
  --uninstall)
    launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载：${LABEL}"
    exit 0
    ;;
  install|--install) ;;
  *)
    echo "未知参数：$1（支持 --install / --status / --run / --uninstall）" >&2
    exit 1
    ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROJECT_DIR}/tools/codearts-refresh.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key><integer>9</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
    <dict>
      <key>Hour</key><integer>21</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>POWER_METER_NOTIFY</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

# 幂等重载：先卸载旧定义（忽略失败），再加载新定义
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
if ! launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null; then
  # 少数会话（如非 Aqua 会话的终端）bootstrap 会失败，退回旧式 load
  echo "[install] bootstrap 失败，改用 launchctl load -w"
  launchctl load -w "$PLIST"
fi

echo "✓ 已安装 launchd 定时任务"
echo "  文件：${PLIST}"
echo "  触发：每天 09:30 / 21:30（睡眠错过的任务唤醒后补跑）"
echo "  日志：${LOG}"
echo "  校验：bash tools/install-codearts-refresh-launchd.sh --status"
echo "  立即跑一次：bash tools/install-codearts-refresh-launchd.sh --run"
echo "  卸载：bash tools/install-codearts-refresh-launchd.sh --uninstall"
