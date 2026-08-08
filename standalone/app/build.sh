#!/usr/bin/env bash
# ── 어싸인 배정표 단일 exe 빌드 (macOS/Linux 에서 윈도우용으로) ──────────────
#   준비:  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0
#   사용:  ./build.sh          런타임까지 품은 단일 exe
#          ./build.sh lite     작은 exe (.NET 8 데스크톱 런타임 필요)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.dotnet:$PATH"
# 화면에 뜨는 버전(v260809a)을 그대로 쓴다 — assign.html 에 이미 박혀 있다
VER="$(sed -n "s/.*const BUILD={ver:'\([^']*\)'.*/\1/p" ../assign.html | head -1)"
VER="${VER:-v$(date +%y%m%d)a}"
NUM="$(date +%y).$(date +%-m).$(date +%-d)"     # 파일 속성용 숫자 버전

[ -f ../assign.html ] || { echo "[!] ../assign.html 없음 — node scripts/build-assign-standalone.mjs 먼저"; exit 1; }

if [ "${1:-}" = "lite" ]; then
  dotnet publish AssignApp.csproj -c Release -r win-x64 --self-contained false -p:Version=$NUM -p:InformationalVersion=$VER \
    -p:PublishSingleFile=true -p:DebugType=none -p:AllowedReferenceRelatedFileExtensions=none -o dist
else
  dotnet publish AssignApp.csproj -c Release -r win-x64 --self-contained true -p:Version=$NUM -p:InformationalVersion=$VER \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:EnableCompressionInSingleFile=true -p:DebugType=none \
    -p:AllowedReferenceRelatedFileExtensions=none -o dist
fi
ls -la dist/*.exe
