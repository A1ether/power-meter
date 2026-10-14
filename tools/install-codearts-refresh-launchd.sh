#!/usr/bin/env bash
#
# 安装 / 卸载 CodeArts 登录态刷新定时任务（macOS launchd LaunchAgent）。
#
# 任务：com.powermeter.codearts-refresh —— 每天 09:30 / 21:30 执行 tools/codearts-refresh.sh：
#   ① 校验 .env 里现有 Cookie（有效就不打扰你，也不需要开浏览器）；
#   ② 失效时先尝试打开用量页让华为云 SSO 静默重登，成功即自动抓取；
#   ③ 真的需要人工登录时才弹系统通知并打开登录页。
#
# 说明：**不需要让调试 Chrome 常驻** —— codearts 的会话 Cookie 已由 .env 持有，
#       关掉 Chrome 不影响看板；浏览器只在「需要重新取一次 Cookie」时才用得上。
#
# 用法：
#   bash tools/install-codearts-refresh-launchd.sh              # 安装（幂等）
#   bash tools/install-codearts-refresh-launchd.sh --status     # 查看状态
#   bash tools/install-codearts-refresh-launchd.sh --run        # 立即跑一次刷新
#   bash tools/install-codearts-refresh-launchd.sh --uninstall  # 卸载
#
set -uo pipefail

UID_NUM="$(id -u)"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/.run"
LABEL="com.powermeter.codearts-refresh"
PLIST="$PLIST_DIR/${LABEL}.plist"
LEGACY_LABEL="com.powermeter.chrome-debug"
LEGACY_PLIST="$PLIST_DIR/${LEGACY_LABEL}.plist"
PATH_VALUE="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "该脚本仅支持 macOS（launchd）。Linux 请用 cron。" >&2
  exit 1
fi

# 清理历史版本留下的「调试 Chrome 常驻」任务（该方案已废弃）
cleanup_legacy() {
  if [ -f "$LEGACY_PLIST" ]; then
    launchctl bootout "gui/${UID_NUM}/${LEGACY_LABEL}" 2>/dev/null || true
    rm -f "$LEGACY_PLIST"
    echo "[install] 已移除历史任务：${LEGACY_LABEL}"
  fi
}

case "${1:-install}" in
  --status)
    if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
      launchctl print "gui/${UID_NUM}/${LABEL}" | grep -E "state|runs|last exit" || true
    else
      echo "未安装（${LABEL}）"
    fi
    ;;
  --run)
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    echo "已触发一次刷新；日志：${LOG_DIR}/codearts-refresh.log"
    ;;
  --uninstall)
    launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载：${LABEL}"
    cleanup_legacy
    ;;
  install|--install)
    cleanup_legacy
    mkdir -p "$PLIST_DIR" "$LOG_DIR"

    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROJECT_DIR}/tools/codearts-refresh.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key><string>${LOG_DIR}/codearts-refresh.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/codearts-refresh.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH_VALUE}</string>
    <key>POWER_METER_NOTIFY</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

    launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
    if ! launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null; then
      echo "[install] bootstrap 失败，改用 launchctl load -w"
      launchctl load -w "$PLIST"
    fi

    echo "✓ 已安装定时任务：${LABEL}"
    echo "  触发：每天 09:30 / 21:30（睡眠错过后唤醒补跑）"
    echo "  行为：先校验 .env Cookie → 失效才尝试 SSO 静默重登 → 仍不行才提醒登录"
    echo "  日志：${LOG_DIR}/codearts-refresh.log"
    echo "  说明：关掉 Chrome 不影响看板；不需要让浏览器常驻。"
    ;;
  *)
    echo "未知参数：$1（支持 --install / --status / --run / --uninstall）" >&2
    exit 1
    ;;
esac
