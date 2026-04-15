"""
NurseScheduler v4 - 진입점
FastAPI 서버를 백그라운드 스레드에서 시작하고 브라우저를 자동으로 엽니다.
"""
import sys
import os
import socket
import threading
import time
import webbrowser
import urllib.request
import urllib.error

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


def wait_for_server(url: str, timeout: float = 30.0) -> bool:
    """서버가 응답할 때까지 최대 timeout초 대기.
    /health 엔드포인트를 폴링하여 실제 준비 완료 시점에 True 반환."""
    deadline = time.time() + timeout
    health_url = url.rstrip("/") + "/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=1) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionRefusedError, OSError):
            pass
        time.sleep(0.25)
    return False


def main():
    port = find_free_port()
    url  = f"http://localhost:{port}"

    # 서버를 별도 스레드에서 시작
    def run_server():
        # sys.path에 패키지 경로 추가 (번들 환경 대응)
        sys.path.insert(0, get_resource_path("."))
        from server.api import app
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # 서버가 실제로 응답할 때까지 폴링 대기 (최대 30초)
    if wait_for_server(url, timeout=30.0):
        webbrowser.open(url)
        print(f"[NurseScheduler] 서버 실행 중: {url}")
        print("[NurseScheduler] 종료하려면 이 창을 닫으세요.")
    else:
        print(f"[NurseScheduler] 서버 시작 실패: {url}")
        print("[NurseScheduler] 프로세스를 종료합니다.")
        return

    # 메인 스레드는 대기
    try:
        server_thread.join()
    except KeyboardInterrupt:
        print("\n[NurseScheduler] 종료합니다.")


if __name__ == "__main__":
    main()
