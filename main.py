"""
NurseScheduler v4 — 서버 진입점
Electron 래퍼에서 자식 프로세스로 실행되는 FastAPI 서버.
"""
import sys
import os
import socket

import uvicorn


def find_free_port(start: int = 5757, tries: int = 10) -> int:
    """사용 가능한 포트를 찾아 반환"""
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def get_resource_path(relative: str) -> str:
    """PyInstaller 번들 또는 일반 실행 모두 대응하는 리소스 경로"""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS  # type: ignore
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, relative)


def main():
    # Electron에서 환경변수로 포트 지정 가능
    port_env = os.environ.get("NURSE_PORT")
    port = int(port_env) if port_env else find_free_port()

    # sys.path에 패키지 경로 추가 (번들 환경 대응)
    sys.path.insert(0, get_resource_path("."))
    from server.api import app

    # 포트를 stdout에 기록 → Electron이 읽어서 BrowserWindow에 사용
    sys.stdout.write(f"PORT:{port}\n")
    sys.stdout.flush()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
