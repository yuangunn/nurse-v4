# NurseScheduler v4 — 빌드 가이드

## 아키텍처

**Electron 데스크톱 앱**이 **Python FastAPI 서버**를 자식 프로세스로 실행합니다.

```
NurseScheduler.exe (Electron)
  ├── BrowserWindow (독립 창, 주소창 없음)
  │   └── HTML/CSS/JS (Alpine.js)
  └── 자식 프로세스: Python FastAPI (127.0.0.1:5757)
      ├── PuLP + HiGHS 솔버
      └── SQLite DB (Fernet 암호화)
```

사용자는 **브라우저 없이** 독립된 네이티브 창에서 앱을 사용합니다.

## 원클릭 빌드

```cmd
build.bat
```

자동 수행:
1. 이전 빌드 정리
2. Python 의존성 설치
3. PyInstaller로 Python 서버 번들
4. Electron 의존성 설치 (`npm install`)
5. electron-packager로 Electron 앱 빌드
6. 포터블 ZIP + Inno Setup 설치파일 생성

## 산출물

| 파일 | 용도 | 크기 |
|------|------|------|
| `dist/electron/NurseScheduler-win32-x64/NurseScheduler.exe` | 개발용 직접 실행 | — |
| `dist/NurseScheduler_v4_portable.zip` | **포터블 배포** (압축) | ~200MB |
| `dist/installer/NurseScheduler_Setup_v4.0.exe` | **설치 마법사** | ~140MB |

## 배포 방법

### 설치 버전 (권장)
`NurseScheduler_Setup_v4.0.exe` 전달 → 사용자는 설치 마법사 실행
- 바탕화면/시작메뉴 바로가기 자동 생성
- 제어판에서 언인스톨 가능
- 사용자 데이터 보존 (`%APPDATA%\NurseScheduler\`)

### 포터블
`NurseScheduler_v4_portable.zip` 전달 → 사용자는 임의 폴더에 압축 해제
- `NurseScheduler.exe` 더블클릭 → 앱 창 자동 실행

## 사용자 데이터 위치

```
%APPDATA%\NurseScheduler\
  ├─ profiles.json        (프로필 목록)
  ├─ guest.db              (게스트)
  └─ <프로필>.db.enc       (Fernet 암호화 DB)
```

언인스톨해도 데이터는 보존됩니다.

## 요구사항

**빌드 PC:**
- Python 3.11+
- Node.js 18+
- Windows 10/11 x64
- Inno Setup 6 (설치 마법사 생성용)

**사용자 PC:**
- Windows 10/11 x64
- Python / Node.js 설치 **불필요** (전부 번들됨)
- 인터넷 연결 **불필요**

## 첫 실행 동작

1. Electron 앱 시작
2. 자식 프로세스로 `python_server/NurseScheduler.exe` 실행
3. Python이 `PORT:5757`을 stdout으로 출력
4. Electron이 `/health` 폴링 → 200 OK 확인
5. `BrowserWindow` 생성 → `http://127.0.0.1:5757` 로드
6. 프로필 선택 화면 표시

## 수동 빌드 단계

```cmd
REM 1. Python 서버 번들
py -m PyInstaller NurseScheduler.spec --noconfirm

REM 2. Electron 의존성
cd electron
npm install

REM 3. Electron 패키지
node_modules\.bin\electron-packager.cmd . NurseScheduler ^
  --platform=win32 --arch=x64 ^
  --out=..\dist\electron --overwrite ^
  --extra-resource=..\dist\NurseScheduler
cd ..

REM 4. 포터블 ZIP
powershell Compress-Archive dist\electron\NurseScheduler-win32-x64\* dist\NurseScheduler_v4_portable.zip

REM 5. Inno Setup 설치파일
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\setup.iss
```

## 트러블슈팅

### "Windows가 PC를 보호했습니다"
SmartScreen 경고 → **추가 정보 → 실행**. 해결: 코드 서명 인증서 구매 (선택).

### 방화벽 차단
첫 실행 시 Windows 방화벽 허용 팝업 → **액세스 허용**.

### 안티바이러스 오탐
기업 환경에서는 IT 팀에 `NurseScheduler.exe` 예외 등록 요청.

### 포트 충돌
5757 포트 사용 중이면 5758, 5759 순차 시도. Electron이 Python stdout에서 포트를 자동 감지합니다.

### Electron 개발 모드
```cmd
cd electron
npm start
```
개발 모드는 `../dist/NurseScheduler/NurseScheduler.exe`를 사용하므로 먼저 PyInstaller 빌드가 필요합니다.
