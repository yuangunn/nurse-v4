# -*- mode: python ; coding: utf-8 -*-
"""
NurseScheduler v4 PyInstaller 스펙
빌드: py -m PyInstaller NurseScheduler.spec
"""
import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_dynamic_libs

# 플랫폼별 아이콘: Windows=.ico, macOS=.icns
_ICON = 'build/icon.ico' if sys.platform.startswith('win') else 'build/icon.icns'

# highspy는 C 확장 + DLL 번들이 필요
highspy_datas, highspy_binaries, highspy_hiddenimports = collect_all('highspy')

# cryptography 전체 수집
crypto_datas, crypto_binaries, crypto_hiddenimports = collect_all('cryptography')

# pulp 전체 수집 (내부 솔버 파일)
pulp_datas, pulp_binaries, pulp_hiddenimports = collect_all('pulp')

# ortools(CP-SAT): 네이티브 .pyd/.dll + protobuf. 오프라인 번들 필수 (인트라넷).
ort_datas, ort_binaries, ort_hiddenimports = collect_all('ortools')
ort_dynlibs = collect_dynamic_libs('ortools')

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=highspy_binaries + crypto_binaries + pulp_binaries + ort_binaries + ort_dynlibs,
    datas=[
        ('frontend', 'frontend'),
    ] + highspy_datas + crypto_datas + pulp_datas + ort_datas,
    hiddenimports=[
        'highspy',
        'highspy._core',
        'pulp',
        'ortools',
        'ortools.sat.python.cp_model',
        'ortools.sat.python.cp_model_helper',
        'google.protobuf',
        'cryptography',
        'cryptography.hazmat.primitives.kdf.pbkdf2',
        'cryptography.hazmat.primitives.hashes',
        'cryptography.fernet',
        'fastapi',
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        # 표 파일 파싱 (/api/parse-table-file) — api.py에서 지연 임포트하므로 명시
        'openpyxl',
        'et_xmlfile',
    ] + highspy_hiddenimports + crypto_hiddenimports + pulp_hiddenimports + ort_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy.tests',
        'scipy',
        # 'pandas' 제외 금지 — ortools 임포트 체인이 pandas를 요구함 (번들 게이트에서 확인)
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='NurseScheduler',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # --windowed
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_ICON,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='NurseScheduler',
)
