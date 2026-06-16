#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  NurseScheduler v4 — macOS 빌드 (Electron 데스크톱 앱)
#  사용법: ./build-mac.sh
#  결과:
#    dist/electron/NurseScheduler-darwin-<arch>/NurseScheduler.app
#    dist/NurseScheduler_v4_mac_<arch>.zip   (포터블)
#    dist/NurseScheduler_v4_mac_<arch>.dmg   (디스크 이미지)
#  서명: 유료 Apple Developer 계정 없이 ad-hoc 서명만 (arm64 실행 요건 충족).
#        배포본은 공증(notarization)이 없으므로 첫 실행 시 우클릭→열기 또는
#        `xattr -dr com.apple.quarantine <앱>` 필요.
#  요구: Node 20 LTS (Node 24는 @electron/packager의 electron 추출 단계에서 크래시),
#        Python 3.11 (highspy/ortools 휠 호환). CI(.github/workflows/release.yml)는 고정 사용.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ]; then PKG_ARCH="x64"; else PKG_ARCH="arm64"; fi
APPVER="$(grep -E '#define AppVersion' installer/setup.iss | sed -E 's/.*"([0-9.]+)".*/\1/')"
PY="${PYTHON:-python3}"

echo "▶ NurseScheduler v$APPVER macOS 빌드 (arch=$PKG_ARCH, python=$PY)"

echo "[1/6] 이전 빌드 정리"
rm -rf build/NurseScheduler dist/NurseScheduler dist/electron dist/installer
rm -f dist/NurseScheduler_v4_mac_*.zip dist/NurseScheduler_v4_mac_*.dmg

echo "[2/6] Python 의존성"
"$PY" -m pip install -q -r requirements.txt
"$PY" -m pip install -q pyinstaller

echo "[3/6] PyInstaller 서버 번들 → dist/NurseScheduler/"
"$PY" -m PyInstaller NurseScheduler.spec --noconfirm --log-level WARN

echo "[4/6] Electron 의존성"
( cd electron && npm install --silent )

echo "[5/6] Electron 패키지 (darwin $PKG_ARCH)"
( cd electron && npx electron-packager . NurseScheduler \
    --platform=darwin --arch="$PKG_ARCH" --out=../dist/electron --overwrite \
    --app-version="$APPVER" --app-bundle-id=com.nursescheduler.v4 \
    --app-copyright="Hospital Nursing Team" --icon=../build/icon \
    --extra-resource=../dist/NurseScheduler )

APP="dist/electron/NurseScheduler-darwin-$PKG_ARCH/NurseScheduler.app"

echo "[6/6] ad-hoc 서명 + 배포물(zip/dmg)"
# Apple Silicon은 실행에 서명이 필요 — 무료 ad-hoc 서명("-")으로 충족(개발자 계정 불필요)
codesign --force --deep --sign - "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/NurseScheduler_v4_mac_$PKG_ARCH.zip"
hdiutil create -volname "NurseScheduler v4" -srcfolder "$APP" -ov -format UDZO \
    "dist/NurseScheduler_v4_mac_$PKG_ARCH.dmg" >/dev/null

echo
echo "✓ 빌드 완료:"
echo "  • $APP"
echo "  • dist/NurseScheduler_v4_mac_$PKG_ARCH.zip"
echo "  • dist/NurseScheduler_v4_mac_$PKG_ARCH.dmg"
