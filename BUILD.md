# NurseScheduler v4 — 빌드 가이드

## 원클릭 빌드

```cmd
build.bat
```

실행하면 다음을 **자동으로** 수행합니다:
1. 의존성 설치 (PyInstaller 포함)
2. 이전 빌드 정리
3. PyInstaller로 EXE 번들 생성
4. 포터블 ZIP 생성
5. Inno Setup 설치파일 생성 (Inno Setup 설치되어 있는 경우)

## 산출물

빌드 후 `dist/` 폴더에 생성됩니다:

| 파일 | 용도 | 배포 대상 |
|------|------|-----------|
| `dist/NurseScheduler/NurseScheduler.exe` | 개발용 직접 실행 | — |
| `dist/NurseScheduler_v4_portable.zip` | **포터블 배포** | USB, 공유폴더 |
| `dist/installer/NurseScheduler_Setup_v4.0.exe` | **설치 버전** | 바탕화면 바로가기 + 언인스톨 |

## 배포 방법

### A. 포터블 (간단)
1. `NurseScheduler_v4_portable.zip` 사용자에게 전달
2. 사용자는 임의 폴더에 압축 해제
3. `NurseScheduler.exe` 더블클릭 → 자동으로 브라우저 열림

### B. 설치 버전 (권장)
1. `NurseScheduler_Setup_v4.0.exe` 사용자에게 전달
2. 사용자는 설치 마법사 실행
3. 시작메뉴 / 바탕화면 바로가기 자동 생성
4. 제어판 → 프로그램에서 언인스톨 가능

## 사용자 데이터 위치

모든 프로필 DB는 다음 경로에 저장됩니다:
```
%APPDATA%\NurseScheduler\
  ├─ profiles.json          (프로필 목록)
  ├─ guest.db                (게스트)
  ├─ <프로필ID>.db.enc      (암호화된 프로필 DB)
```

언인스톨 후에도 사용자 데이터는 보존됩니다.

## 요구사항

빌드 PC:
- Python 3.11+
- Windows 10/11 x64
- (선택) Inno Setup 6 — `NurseScheduler_Setup.exe` 생성용

사용자 PC:
- Windows 10/11 x64
- **Python 설치 불필요** (EXE에 모두 포함됨)
- **인터넷 연결 불필요** (인트라넷 동작)

## 첫 실행 시

1. 포트 5757 자동 할당 (점유 시 5758, 5759 순차)
2. 기본 브라우저에서 `http://localhost:5757` 자동 오픈
3. 프로필 선택 화면 표시 (게스트 또는 새 프로필 생성)

## 트러블슈팅

### "Windows가 PC를 보호했습니다" 경고
- Windows Defender SmartScreen이 서명되지 않은 EXE를 막습니다
- **추가 정보** → **실행** 클릭
- 해결: 코드 서명 인증서 구매 (선택)

### 방화벽 차단
- 첫 실행 시 Windows 방화벽이 localhost 접근을 허용하는지 묻습니다
- **액세스 허용** 클릭

### 안티바이러스 오탐
- PyInstaller 번들은 휴리스틱 오탐 가능성 있음
- 기업 환경에서는 IT 팀에 예외 등록 요청 필요
