#!/bin/bash
# 打包成 macOS App：dist/唱歌学日语.app
# 原生窗口（系统自带的 WebKit）+ 打包进去的 Node.js，用户电脑上不需要装 Node，也不需要浏览器。
# 用法：tools/build-app.sh            只打包
#       tools/build-app.sh --install  打包后装到 ~/Applications
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NAME="唱歌学日语"
APP="$ROOT/dist/$NAME.app"
# 先在普通文件夹里组装，最后再改名成 .app：macOS 的「App 管理」保护不让改动已经运行过的 App 包里的文件
STAGE="$ROOT/dist/.stage/$NAME.app"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "需要 Node.js（用来打包进 App）"; exit 1; }
NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE")"

echo "· 依赖"
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund

echo "· 编译外壳"
rm -rf "$ROOT/dist/.stage"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/app"
swiftc -O -o "$STAGE/Contents/MacOS/$NAME" macos/main.swift -framework AppKit -framework WebKit

echo "· 复制程序与 Node.js（$("$NODE" -v)）"
cp "$NODE" "$STAGE/Contents/Resources/node"
rsync -a --exclude '.DS_Store' --exclude 'node_modules/kuromoji/test' --exclude 'node_modules/kuromoji/demo' --exclude '*.map' --exclude '*.d.ts' --exclude '*.d.mts' --exclude '*.d.cts' --exclude '*.md' --exclude '/node_modules/.bin' server public node_modules package.json LICENSE "$STAGE/Contents/Resources/app/"

echo "· 图标"
ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s public/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) public/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$STAGE/Contents/Resources/icon.icns"

VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
cat > "$STAGE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.uta-nihongo</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>用来读取 Apple Music 的播放进度、控制播放，以及关闭 / 重新打开网易云音乐。</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

echo "· 签名（本机自签）"
codesign --force --deep --sign - "$STAGE"
rm -rf "$APP"
mv "$STAGE" "$APP"; rm -rf "$ROOT/dist/.stage"

echo "完成：$APP（$(du -sh "$APP" | cut -f1)）"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$NAME.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "已安装到 ~/Applications/$NAME.app"
fi
