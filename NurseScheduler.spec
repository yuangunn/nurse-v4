# -*- mode: python ; coding: utf-8 -*-
"""
NurseScheduler v4 PyInstaller 스펙
빌드: py -m PyInstaller NurseScheduler.spec
"""
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

# highspy는 C 확장 + DLL 번들이 필요
highspy_datas, highspy_binaries, highspy_hiddenimports = collect_all('highspy')

# cryptography 전체 수집
crypto_datas, crypto_binaries, crypto_hiddenimports = collect_all('cryptography')

# pulp 전체 수집 (내부 솔버 파일)
pulp_datas, pulp_binaries, pulp_hiddenimports = collect_all('pulp')

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=highspy_binaries + crypto_binaries + pulp_binaries,
    datas=[
        ('frontend', 'frontend'),
    ] + highspy_datas + crypto_datas + pulp_datas,
    hiddenimports=[
        'highspy',
        'highspy._core',
        'pulp',
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
    ] + highspy_hiddenimports + crypto_hiddenimports + pulp_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy.tests',
        'scipy',
        'pandas',
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
    icon='build/icon.ico',
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
