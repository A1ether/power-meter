#!/usr/bin/env bash
#
# 构建 Power Meter 的 macOS 桌面版（.app + .dmg）
#
#   bash tools/build-macos-app.sh            只构建
#   bash tools/build-macos-app.sh --install  构建并安装到 /Applications
#
# 产物：
#   desktop/dist/PowerMeter.app
#   desktop/dist/PowerMeter-<version>.dmg
#
# 依赖：node/npm、bun、Xcode Command Line Tools（swiftc / lipo / sips / iconutil / hdiutil）。
# 首次构建会下载官方 bun 1.4.4 的 arm64 运行时并缓存到 desktop/.cache/（约 50MB），
# 之后离线可用。说明见 docs/plans/桌面版-macOS桌面应用打包-开发设计方案.md。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
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
need swiftc "安装 Xcode Command Line Tools"
need lipo
need sips
need iconutil
need hdiutil
need codesign

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.1.0)"
DIST="$ROOT/desktop/dist"
BUILD="$ROOT/desktop/build"
CACHE="$ROOT/desktop/.cache"
APP="$DIST/PowerMeter.app"
BUN_VERSION="1.4.4"
BUN_ARM_DIR="$CACHE/bun-darwin-aarch64"
BUN_ARM="$BUN_ARM_DIR/bun"

rm -rf "$BUILD"
mkdir -p "$BUILD" "$DIST" "$CACHE"

# ---------------------------------------------------------------- 1. 服务端
say "编译 TypeScript 服务端（npm run build）"
npm run build >/dev/null
[[ -f "$ROOT/dist/server.js" ]] || die "dist/server.js 不存在"

say "准备官方 bun ${BUN_VERSION} 的 arm64 运行时（minos 13.0）"
if [[ ! -x "$BUN_ARM" ]]; then
  ZIP="$CACHE/bun-darwin-aarch64.zip"
  if [[ ! -f "$ZIP" ]]; then
    curl -fsSL --retry 3 --connect-timeout 15 \
      -o "$ZIP" \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-aarch64.zip" \
      || die "下载官方 bun 运行时失败；请联网后重试，或手动把 bun-darwin-aarch64.zip 放进 desktop/.cache/"
  fi
  unzip -oq "$ZIP" -d "$CACHE"
  [[ -x "$BUN_ARM" ]] || die "解压后找不到 $BUN_ARM"
fi

say "编译 sidecar（arm64 + x86_64 → universal）"
"$BUN_ARM" build --compile --minify --target=bun-darwin-arm64 \
  "$ROOT/dist/server.js" --outfile "$BUILD/sidecar-arm64" >/dev/null
bun build --compile --minify --target=bun-darwin-x64 \
  "$ROOT/dist/server.js" --outfile "$BUILD/sidecar-x64" >/dev/null
lipo -create "$BUILD/sidecar-arm64" "$BUILD/sidecar-x64" -output "$BUILD/power-meter-sidecar"
file "$BUILD/power-meter-sidecar" | grep -q "universal binary" || die "sidecar 不是 universal binary"

# ---------------------------------------------------------------- 2. Swift 外壳
say "编译 Swift 外壳（arm64 + x86_64 → universal）"
swiftc -O -whole-module-optimization -parse-as-library \
  -target arm64-apple-macos13.0 -framework Cocoa -framework WebKit \
  "$ROOT/desktop/macos/PowerMeterApp.swift" -o "$BUILD/PowerMeter-arm64"
swiftc -O -whole-module-optimization -parse-as-library \
  -target x86_64-apple-macos13.0 -framework Cocoa -framework WebKit \
  "$ROOT/desktop/macos/PowerMeterApp.swift" -o "$BUILD/PowerMeter-x64"
lipo -create "$BUILD/PowerMeter-arm64" "$BUILD/PowerMeter-x64" -output "$BUILD/PowerMeter"

# ---------------------------------------------------------------- 3. 图标
say "生成 App 图标"
swift "$ROOT/desktop/macos/AppIcon.swift" "$BUILD/AppIcon-1024.png"
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
sips -z 16 16     "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$BUILD/AppIcon-1024.png" --out "$ICONSET/icon_512x512.png"    >/dev/null
cp "$BUILD/AppIcon-1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

# ---------------------------------------------------------------- 4. 组装
say "组装 PowerMeter.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/seed"
cp "$BUILD/PowerMeter" "$APP/Contents/MacOS/PowerMeter"
cp "$BUILD/power-meter-sidecar" "$APP/Contents/Resources/power-meter-sidecar"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
chmod +x "$APP/Contents/MacOS/PowerMeter" "$APP/Contents/Resources/power-meter-sidecar"

ditto "$ROOT/public" "$APP/Contents/Resources/public"
find "$APP/Contents/Resources/public" -name '.DS_Store' -delete
cp "$ROOT/desktop/macos/help.html" "$APP/Contents/Resources/help.html"
cp "$ROOT/desktop/macos/seed/accounts.template.json" "$APP/Contents/Resources/seed/accounts.json"
cp "$ROOT/.env.example" "$APP/Contents/Resources/seed/env.template"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Power Meter</string>
  <key>CFBundleName</key>
  <string>Power Meter</string>
  <key>CFBundleExecutable</key>
  <string>PowerMeter</string>
  <key>CFBundleIdentifier</key>
  <string>app.powermeter.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Power Meter · 本地多平台额度看板</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

plutil -lint "$APP/Contents/Info.plist" >/dev/null

say "ad-hoc 签名"
codesign --force --sign - "$APP/Contents/MacOS/PowerMeter" >/dev/null
codesign --force --sign - "$APP/Contents/Resources/power-meter-sidecar" >/dev/null
codesign --force --deep --sign - "$APP" >/dev/null
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || die "codesign 校验失败"
ok "App 就绪：$APP"

# ---------------------------------------------------------------- 5. DMG
say "生成 DMG"
DMG_ROOT="$BUILD/dmg-root"
mkdir -p "$DMG_ROOT"
ditto "$APP" "$DMG_ROOT/PowerMeter.app"
ln -s /Applications "$DMG_ROOT/Applications"
cat > "$DMG_ROOT/首次打开说明.txt" <<'TXT'
Power Meter（macOS 桌面版）

安装：
  1. 把 PowerMeter.app 拖进 Applications 文件夹。
  2. 首次打开：在「应用程序」里右键点 PowerMeter.app →「打开」→ 再点「打开」。
     如果仍被拦截：系统设置 → 隐私与安全性 → 点「仍要打开」。
     应用没有做 Apple 公证（无开发者证书），这是 macOS 对所有未签名应用的默认拦截。

首次使用：
  应用会从空账号开始。打开后点「＋ 添加平台账号」，选择平台并登录 / 填写凭证。
  扫码或网页端登录需要本机安装 Google Chrome。

数据位置：
  ~/Library/Application Support/PowerMeter/    （.env、accounts.json、.run/）
  菜单「Power Meter → 打开配置目录 / 打开日志」可直接查看。
  所有凭证只保存在本机，不上传。

说明：
  本应用是本地第三方看板，与各平台官方无关；余额与到期时间以平台接口返回为准。
TXT
rm -f "$DIST/PowerMeter-$VERSION.dmg"
hdiutil create -quiet -volname "Power Meter" -srcfolder "$DMG_ROOT" \
  -ov -format UDZO "$DIST/PowerMeter-$VERSION.dmg" >/dev/null
ok "DMG：$DIST/PowerMeter-$VERSION.dmg"

# ---------------------------------------------------------------- 6. 安装
if [[ "$INSTALL" == "1" ]]; then
  say "安装到 /Applications/PowerMeter.app"
  rm -rf "/Applications/PowerMeter.app"
  ditto "$APP" "/Applications/PowerMeter.app"
  xattr -dr com.apple.quarantine "/Applications/PowerMeter.app" 2>/dev/null || true
  ok "已安装：/Applications/PowerMeter.app"
fi

echo
ok "完成。架构：$(lipo -archs "$APP/Contents/MacOS/PowerMeter")；版本：$VERSION"