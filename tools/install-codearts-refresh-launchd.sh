#!/usr/bin/env bash
#
# 安装 / 卸载 CodeArts 相关 launchd 定时任务（macOS LaunchAgent）。
#
# 安装两个任务：
#   ① com.powermeter.chrome-debug      —— 登录时启动「调试 Chrome」并常驻。
#      必要性：codearts 的会话 Cookie（devclouddevuibjJ_SESSION_ID）是**会话级、不落盘**，
#      Chrome 一退出就等于退出登录；让 Chrome 常驻是「不用反复登录」的前提。
#   ② com.powermeter.codearts-refresh  —— 每天 09:30 / 21:30 执行 tools/codearts-refresh.sh：
#      先校验 .env 里现有 Cookie，只有真的失效且浏览器无会话时才提醒登录（并弹系统通知）。
#
# 用法：
#   bash tools/install-codearts-refresh-launchd.sh              # 安装（幂等）
#   bash tools/install-codearts-refresh-launchd.sh --status     # 查看两个任务状态
#   bash tools/install-codearts-refresh-launchd.sh --run        # 立即跑一次刷新
#   bash tools/install-codearts-refresh-launchd.sh --uninstall  # 卸载两个任务
#
set -uo pipefail

UID_NUM="$(id -u)"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/.run"
FRESH_LABEL="com.powermeter.codearts-refresh"
CHROME_LABEL="com.powermeter.chrome-debug"
FRESH_PLIST="$PLIST_DIR/${FRESH_LABEL}.plist"
CHROME_PLIST="$PLIST_DIR/${CHROME_LABEL}.plist"
PATH_VALUE="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "该脚本仅支持 macOS（launchd）。Linux 请用 cron。" >&2
  exit 1
fi

write_plist() {
  local target="$1"
  shift
  cat > "$target"
}

install_jobs() {
  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  # ① 调试 Chrome 常驻（登录时启动；用户手动关掉后不强行拉起）
  write_plist "$CHROME_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CHROME_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROJECT_DIR}/tools/chrome-debug.sh</string>
    <string>9222</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${LOG_DIR}/chrome-debug.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/chrome-debug.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH_VALUE}</string>
  </dict>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

  # ② 登录态刷新（每天 09:30 / 21:30）
  write_plist "$FRESH_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${FRESH_LABEL}</string>
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

  for label in "$CHROME_LABEL" "$FRESH_LABEL"; do
    plist="$PLIST_DIR/${label}.plist"
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
    if ! launchctl bootstrap "gui/${UID_NUM}" "$plist" 2>/dev/null; then
      echo "[install] bootstrap 失败（${label}），改用 launchctl load -w"
      launchctl load -w "$plist"
    fi
  done

  echo "✓ 已安装两个 launchd 任务"
  echo "  ① ${CHROME_LABEL}：登录时启动调试 Chrome 并常驻（会话 Cookie 才留得住）"
  echo "     文件：${CHROME_PLIST}"
  echo "  ② ${FRESH_LABEL}：每天 09:30 / 21:30 刷新登录态（先校验，过期才提醒登录）"
  echo "     文件：${FRESH_PLIST}"
  echo "  日志：${LOG_DIR}/{chrome-debug,codearts-refresh}.log"
  echo "  校验：bash tools/install-codearts-refresh-launchd.sh --status"
}

case "${1:-install}" in
  --status)
    for label in "$CHROME_LABEL" "$FRESH_LABEL"; do
      if launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
        echo "== ${label} =="
        launchctl print "gui/${UID_NUM}/${label}" | grep -E "state|runs|last exit" || true
      else
        echo "== ${label} == 未安装"
      fi
    done
    ;;
  --run)
    launchctl kickstart -k "gui/${UID_NUM}/${FRESH_LABEL}"
    echo "已触发一次刷新；日志：${LOG_DIR}/codearts-refresh.log"
    ;;
  --uninstall)
    for label in "$FRESH_LABEL" "$CHROME_LABEL"; do
      launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
      rm -f "$PLIST_DIR/${label}.plist"
      echo "已卸载：${label}"
    done
    ;;
  install|--install)
    install_jobs
    ;;
  *)
    echo "未知参数：$1（支持 --install / --status / --run / --uninstall）" >&2
    exit 1
    ;;
esac
