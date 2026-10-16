#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  NurseScheduler v4 — macOS 빌드 (Electron 데스크톱 앱)
#  사용법: ./build-mac.sh
#  결과:
#    dist/electron/NurseScheduler-darwin-<arch>/NurseScheduler.app
#    dist/NurseScheduler_v4_mac_<arch>.zip   (포터블)
#    dist/NurseScheduler_v4_mac_<arch>.dmg   (디스크 이미지)
#  링크: PyInstaller 는 _internal 안에 상대 경로 링크(libX.dylib → ortools/.libs/libX.dylib)를
#        만든다. electron-packager --extra-resource 로 복사하면 그것이 이 컴퓨터의 절대 경로로
#        바뀌어 다른 맥에서 전부 끊어진다 (v4.13.1·v4.14.0 맥 판 103개, 2026-10-15). 그래서
#        packager 가 끝난 뒤 ditto 로 직접 넣고, 끊어지거나 절대 경로인 링크가 하나라도 있으면 멈춘다.
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

# 앱 밖을 가리키거나 끊어진 링크가 있으면 멈춘다 — 다른 맥에서는 그 파일이 없다
check_links() {
  local dir="$1" bad=0 l t
  while IFS= read -r -d '' l; do
    t="$(readlink "$l")"
    case "$t" in
      /*) echo "  ✗ 절대 경로 링크: ${l#"$dir"/} -> $t"; bad=$((bad + 1)); continue ;;
    esac
    [ -e "$l" ] || { echo "  ✗ 끊어진 링크: ${l#"$dir"/} -> $t"; bad=$((bad + 1)); }
  done < <(find "$dir" -type l -print0)
  if [ "$bad" -gt 0 ]; then
    echo "✗ $dir 에 잘못된 링크 ${bad}개 — 이대로 내보내면 다른 맥에서 엔진이 켜지지 않습니다"
    exit 1
  fi
}

echo "[1/7] 이전 빌드 정리"
rm -rf build/NurseScheduler dist/NurseScheduler dist/electron dist/installer dist/dmg
rm -f dist/NurseScheduler_v4_mac_*.zip dist/NurseScheduler_v4_mac_*.dmg

echo "[2/7] Python 의존성"
"$PY" -m pip install -q -r requirements.txt
"$PY" -m pip install -q pyinstaller

echo "[3/7] PyInstaller 서버 번들 → dist/NurseScheduler/"
"$PY" -m PyInstaller NurseScheduler.spec --noconfirm --log-level WARN
check_links dist/NurseScheduler

echo "[4/7] Electron 의존성"
( cd electron && npm install --silent )

echo "[5/7] Electron 패키지 (darwin $PKG_ARCH)"
# --extra-resource 는 쓰지 않는다 — 복사하면서 상대 링크를 절대 경로로 바꾼다 (맨 위 '링크')
( cd electron && npx electron-packager . NurseScheduler \
    --platform=darwin --arch="$PKG_ARCH" --out=../dist/electron --overwrite \
    --app-version="$APPVER" --app-bundle-id=com.nursescheduler.v4 \
    --app-copyright="Hospital Nursing Team" --icon=../build/icon )

APP="dist/electron/NurseScheduler-darwin-$PKG_ARCH/NurseScheduler.app"
RES="$APP/Contents/Resources/NurseScheduler"   # electron/main.js 가 여기서 서버를 찾는다

echo "[6/7] 서버 번들 넣기 + ad-hoc 서명 + 엔진 켜 보기"
rm -rf "$RES"
ditto dist/NurseScheduler "$RES"               # ditto 는 링크를 그대로 옮긴다
check_links "$APP"
# Apple Silicon은 실행에 서명이 필요 — 무료 ad-hoc 서명("-")으로 충족(개발자 계정 불필요)
codesign --force --deep --sign - "$APP"

# 앱 안 서버를 켜고 두 엔진(HiGHS·CP-SAT)이 실리는지 본다. 데이터는 임시 폴더에 — 앱·내 데이터를 건드리지 않는다
SMOKE="$(mktemp -d)"
SMOKE_PORT="${SMOKE_PORT:-57990}"
APPDATA="$SMOKE" NURSE_NO_BROWSER=1 NURSE_PORT="$SMOKE_PORT" "$RES/NurseScheduler" >"$SMOKE/server.log" 2>&1 &
SMOKE_PID=$!
smoke_ok=0
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then smoke_ok=1; break; fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.5
done
if [ "$smoke_ok" = 1 ]; then
  for t in highs cpsat; do
    r="$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/dev/$t-selftest" || true)"
    echo "  $t: $r"
    case "$r" in *'"ok":true'*) ;; *) smoke_ok=0 ;; esac
  done
fi
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
if [ "$smoke_ok" != 1 ]; then
  echo "✗ 앱 안 서버나 엔진이 켜지지 않았습니다 — 서버 기록:"
  tail -40 "$SMOKE/server.log"
  exit 1
fi
rm -rf "$SMOKE"
codesign --verify --deep "$APP"                # 켜 보는 동안 앱 안이 바뀌지 않았는지

echo "[7/7] 배포물(zip/dmg)"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/NurseScheduler_v4_mac_$PKG_ARCH.zip"
# dmg 를 열면 앱과 '응용 프로그램' 바로가기가 나란히 — 끌어 넣으면 설치된다
STAGE="dist/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/NurseScheduler.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "NurseScheduler v4" -srcfolder "$STAGE" -ov -format UDZO \
    "dist/NurseScheduler_v4_mac_$PKG_ARCH.dmg" >/dev/null
rm -rf "$STAGE"

echo
echo "✓ 빌드 완료:"
echo "  • $APP"
echo "  • dist/NurseScheduler_v4_mac_$PKG_ARCH.zip"
echo "  • dist/NurseScheduler_v4_mac_$PKG_ARCH.dmg"
