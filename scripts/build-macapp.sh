#!/usr/bin/env bash
# Build PortaSSH.app — a native macOS application bundle (no console window).
#
#   scripts/build-macapp.sh [VERSION] [GOARCH]
#
# Requires macOS tools: go (with cgo), sips, iconutil.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-dev}"
ARCH="${2:-$(go env GOARCH)}"
APP="dist/PortaSSH.app"
CONTENTS="$APP/Contents"

echo "→ building PortaSSH.app  (version=$VERSION arch=$ARCH)"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# 1) native binary (cgo/WebView) into the bundle
CGO_ENABLED=1 GOOS=darwin GOARCH="$ARCH" go build -trimpath \
  -ldflags "-s -w -X main.version=$VERSION" \
  -o "$CONTENTS/MacOS/portassh" .

# 2) icon.icns from the existing PNGs
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
cp assets/icon/icon-16.png   "$ICONSET/icon_16x16.png"
cp assets/icon/icon-32.png   "$ICONSET/icon_16x16@2x.png"
cp assets/icon/icon-32.png   "$ICONSET/icon_32x32.png"
cp assets/icon/icon-64.png   "$ICONSET/icon_32x32@2x.png"
cp assets/icon/icon-128.png  "$ICONSET/icon_128x128.png"
cp assets/icon/icon-256.png  "$ICONSET/icon_128x128@2x.png"
cp assets/icon/icon-256.png  "$ICONSET/icon_256x256.png"
cp assets/icon/icon-512.png  "$ICONSET/icon_256x256@2x.png"
cp assets/icon/icon-512.png  "$ICONSET/icon_512x512.png"
cp assets/icon/icon-1024.png "$ICONSET/icon_512x512@2x.png"
iconutil -c icns -o "$CONTENTS/Resources/icon.icns" "$ICONSET"

# 3) Info.plist
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>PortaSSH</string>
  <key>CFBundleDisplayName</key>       <string>PortaSSH</string>
  <key>CFBundleIdentifier</key>        <string>at.tornoreanu.portassh</string>
  <key>CFBundleVersion</key>           <string>${VERSION#v}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION#v}</string>
  <key>CFBundleExecutable</key>        <string>portassh</string>
  <key>CFBundleIconFile</key>          <string>icon</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>LSMinimumSystemVersion</key>    <string>10.13</string>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

echo "✓ built $APP"
