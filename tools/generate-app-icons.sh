#!/usr/bin/env bash
#
# 从一个画法生成全平台 App 图标（macOS / iOS / Android）。
#
#   bash tools/generate-app-icons.sh              生成仓库内的图标资源
#   bash tools/generate-app-icons.sh --icns PATH  额外输出 macOS .icns
#
# 图形定义在 desktop/macos/AppIcon.swift（纯 AppKit，无设计源文件），
# macOS 版本是带透明留白与投影的 squircle，iOS/Android 版本是满幅方图。
#
# 产物：
#   app/macos/Runner/Assets.xcassets/AppIcon.appiconset/*.png
#   app/ios/Runner/Assets.xcassets/AppIcon.appiconset/*.png
#   app/android/app/src/main/res/mipmap-*/ic_launcher.png
#   desktop/build/appicon/AppIcon-1024.png（以及方图与 iconset，构建缓存）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

GEN="$ROOT/desktop/macos/AppIcon.swift"
BUILD="$ROOT/desktop/build/appicon"
RAW="$BUILD/AppIcon-macos-1024.png"
SQUARE="$BUILD/AppIcon-square-1024.png"
ICNS_OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --icns) ICNS_OUT="${2:?--icns 需要输出路径}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v swift >/dev/null || die "缺少 swift（安装 Xcode Command Line Tools）"
command -v sips  >/dev/null || die "缺少 sips"

rm -rf "$BUILD"
mkdir -p "$BUILD"

say "生成 1024 母图（macOS squircle + iOS/Android 满幅）"
swift "$GEN" "$RAW"
swift "$GEN" "$SQUARE" --square

# 无损尺寸缩放：每一档都从 1024 母图直接缩放，避免多代缩放累积模糊
resize() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }

# ---------------------------------------------------------------- macOS
MAC="$ROOT/app/macos/Runner/Assets.xcassets/AppIcon.appiconset"
say "写入 macOS AppIcon.appiconset"
mkdir -p "$MAC"
resize "$RAW" 16   "$MAC/app_icon_16.png"
resize "$RAW" 32   "$MAC/app_icon_32.png"
resize "$RAW" 64   "$MAC/app_icon_64.png"
resize "$RAW" 128  "$MAC/app_icon_128.png"
resize "$RAW" 256  "$MAC/app_icon_256.png"
resize "$RAW" 512  "$MAC/app_icon_512.png"
cp "$RAW" "$MAC/app_icon_1024.png"

# ---------------------------------------------------------------- iOS
IOS="$ROOT/app/ios/Runner/Assets.xcassets/AppIcon.appiconset"
say "写入 iOS AppIcon.appiconset"
mkdir -p "$IOS"
for spec in \
  "20:Icon-App-20x20@1x.png" "40:Icon-App-20x20@2x.png" "60:Icon-App-20x20@3x.png" \
  "29:Icon-App-29x29@1x.png" "58:Icon-App-29x29@2x.png" "87:Icon-App-29x29@3x.png" \
  "40:Icon-App-40x40@1x.png" "80:Icon-App-40x40@2x.png" "120:Icon-App-40x40@3x.png" \
  "120:Icon-App-60x60@2x.png" "180:Icon-App-60x60@3x.png" \
  "76:Icon-App-76x76@1x.png" "152:Icon-App-76x76@2x.png" \
  "167:Icon-App-83.5x83.5@2x.png"; do
  size="${spec%%:*}"; file="${spec#*:}"
  resize "$SQUARE" "$size" "$IOS/$file"
done
cp "$SQUARE" "$IOS/Icon-App-1024x1024@1x.png"

# ---------------------------------------------------------------- Android
RES="$ROOT/app/android/app/src/main/res"
say "写入 Android mipmap-*"
for spec in "mdpi:48" "hdpi:72" "xhdpi:96" "xxhdpi:144" "xxxhdpi:192"; do
  bucket="${spec%%:*}"; size="${spec#*:}"
  mkdir -p "$RES/mipmap-$bucket"
  resize "$SQUARE" "$size" "$RES/mipmap-$bucket/ic_launcher.png"
done

# ---------------------------------------------------------------- icns
if [ -n "$ICNS_OUT" ]; then
  command -v iconutil >/dev/null || die "缺少 iconutil"
  say "生成 macOS .icns"
  ICONSET="$BUILD/AppIcon.iconset"
  mkdir -p "$ICONSET"
  resize "$RAW" 16   "$ICONSET/icon_16x16.png"
  resize "$RAW" 32   "$ICONSET/icon_16x16@2x.png"
  resize "$RAW" 32   "$ICONSET/icon_32x32.png"
  resize "$RAW" 64   "$ICONSET/icon_32x32@2x.png"
  resize "$RAW" 128  "$ICONSET/icon_128x128.png"
  resize "$RAW" 256  "$ICONSET/icon_128x128@2x.png"
  resize "$RAW" 256  "$ICONSET/icon_256x256.png"
  resize "$RAW" 512  "$ICONSET/icon_256x256@2x.png"
  resize "$RAW" 512  "$ICONSET/icon_512x512.png"
  cp "$RAW" "$ICONSET/icon_512x512@2x.png"
  mkdir -p "$(dirname "$ICNS_OUT")"
  iconutil -c icns "$ICONSET" -o "$ICNS_OUT"
  ok "icns：$ICNS_OUT"
fi

ok "图标资源已更新：macOS / iOS / Android"