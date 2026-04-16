"""
NurseScheduler v4 — 서버 진입점
Electron 래퍼에서 자식 프로세스로 실행되는 FastAPI 서버.
독립 실행(PyInstaller --windowed) 시에도 동작.
"""
import sys
import os
import io
import socket
import webbrowser
import time
import threading

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


def _ensure_stdio():
    """--windowed 모드에서 sys.stdout/stderr가 None이면 devnull로 대체"""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _wait_and_open_browser(url: str, timeout: float = 30.0):
    """서버가 응답할 때까지 대기 후 브라우저 오픈 (독립 실행 시)"""
    import urllib.request
    import urllib.error
    deadline = time.time() + timeout
    health = url.rstrip("/") + "/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health, timeout=1) as r:
                if r.status == 200:
                    webbrowser.open(url)
                    return
        except Exception:
            pass
        time.sleep(0.25)


def main():
    _ensure_stdio()

    # Electron에서 환경변수로 포트 지정 가능
    port_env = os.environ.get("NURSE_PORT")
    port = int(port_env) if port_env else find_free_port()

    # sys.path에 패키지 경로 추가 (번들 환경 대응)
    sys.path.insert(0, get_resource_path("."))
    from server.api import app

    url = f"http://localhost:{port}"

    # 포트를 stdout에 기록 → Electron이 읽어서 BrowserWindow에 사용
    try:
        sys.stdout.write(f"PORT:{port}\n")
        sys.stdout.flush()
    except Exception:
        pass

    # Electron에서 실행 중이 아니면 (독립 실행) 브라우저 자동 오픈
    is_electron = os.environ.get("ELECTRON_RUN_AS_NODE") or os.path.exists(
        os.path.join(os.path.dirname(sys.executable), "resources", "app.asar")
    )
    if not is_electron:
        threading.Thread(
            target=_wait_and_open_browser,
            args=(url,),
            daemon=True,
        ).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
