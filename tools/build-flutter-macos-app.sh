#!/usr/bin/env bash
#
# 构建 Power Meter 的 Flutter macOS 桌面版（.app + .dmg）
#
#   bash tools/build-flutter-macos-app.sh            只构建
#   bash tools/build-flutter-macos-app.sh --install  构建并安装到 /Applications
#
# 产物：
#   desktop/dist-flutter/PowerMeter.app
#   desktop/dist-flutter/PowerMeter-<version>.dmg
#
# 依赖：node/npm、bun、Flutter SDK、Xcode（swiftc / codesign / hdiutil）。
# 说明见 docs/plans/Flutter客户端-前端重写与多端应用-开发设计方案.md。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1（$2）"
}
need node "安装 Node.js 20+"
need npm  "安装 Node.js 20+"
need bun  "brew install oven-sh/bun/bun 或 https://bun.sh"
need flutter "安装 Flutter SDK 并把 flutter 放进 PATH"
need codesign "安装 Xcode Command Line Tools"
need hdiutil

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.1.0)"
OUT="$ROOT/desktop/dist-flutter"

say "1/5 编译 Node 服务为单文件 sidecar"
npm run build:sidecar

say "2/5 构建 Flutter macOS Release"
(cd app && flutter build macos --release)

# 构建产物若被 Spotlight 索引，Launchpad / 应用搜索会把它们和安装副本一起列出
# （同名同图标，出现两份甚至三份）。在构建目录放一个 never-index 标记，
# Spotlight 会跳过整棵子树；flutter clean 删掉标记后，下次构建会重新写入。
mkdir -p "$ROOT/app/build" "$OUT"
touch "$ROOT/app/build/.metadata_never_index" "$OUT/.metadata_never_index"

SRC_APP="$(find app/build/macos/Build/Products/Release -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$SRC_APP" ] || die "找不到 Flutter macOS 产物（app/build/macos/Build/Products/Release/*.app）"

say "3/5 组装 PowerMeter.app"
rm -rf "$OUT/PowerMeter.app"
mkdir -p "$OUT"
cp -R "$SRC_APP" "$OUT/PowerMeter.app"

APP="$OUT/PowerMeter.app"
RES="$APP/Contents/Resources"
mkdir -p "$RES/seed"
cp dist/power-meter-sidecar "$RES/power-meter-sidecar"
chmod +x "$RES/power-meter-sidecar"
cp desktop/macos/seed/accounts.template.json "$RES/seed/accounts.template.json"

/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Power Meter" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Power Meter" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Power Meter" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Power Meter" "$APP/Contents/Info.plist"

# 图标：与仓库内 appiconset 同一画法（desktop/macos/AppIcon.swift），
# 直接生成 .icns 覆盖 Flutter 产物，保证桌面版与 iOS/Android 视觉一致。
bash "$ROOT/tools/generate-app-icons.sh" --icns "$ROOT/desktop/build/flutter-appicon/AppIcon.icns" >/dev/null
cp "$ROOT/desktop/build/flutter-appicon/AppIcon.icns" "$RES/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$APP/Contents/Info.plist" 2>/dev/null || true

say "4/5 ad-hoc 签名"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || die "codesign 失败"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || die "签名校验失败"

say "5/5 生成 dmg"
rm -f "$OUT/PowerMeter-$VERSION.dmg"
hdiutil create -volname "Power Meter" -srcfolder "$APP" -ov -format UDZO "$OUT/PowerMeter-$VERSION.dmg" >/dev/null

ok "中间产物：${APP}（打包结束后清理，只保留 DMG 与安装副本）"
ok "安装包：$OUT/PowerMeter-$VERSION.dmg"
ok "sidecar：$RES/power-meter-sidecar（--port 0 --no-static --token 由 App 每次启动随机生成）"

if [ "$INSTALL" = "1" ]; then
  say "安装到 /Applications"
  rm -rf "/Applications/PowerMeter.app"
  cp -R "$APP" "/Applications/PowerMeter.app"
  ok "已安装 /Applications/PowerMeter.app"
fi

# 仓库内的 .app 副本会被 Spotlight / LaunchServices 收录，让 Launchpad 搜索与
# 应用列表同时出现「PowerMeter.app（安装副本）」和「power_meter.app（构建产物）」。
# DMG 与 /Applications 副本已经够用，这里注销注册并删除两个中间 .app；
# 下次 flutter build 会重新产出，不影响 flutter run。
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
for bundle in "$SRC_APP" "$APP"; do
  [ -n "$bundle" ] || continue
  if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -u "$bundle" >/dev/null 2>&1 || true
  fi
  rm -rf "$bundle"
done
