"""어싸인 배정표 — 로컬 도우미 (exe 로 묶어 배포)

무엇을 하나
    ① 같은 폴더(또는 exe 안에 넣어 둔) assign.html 을 127.0.0.1 의 빈 포트로 서빙
    ② 데이터 파일(JSON)을 읽고 쓰는 작은 API 제공
    ③ 브라우저를 앱 창(--app)으로 띄우고, 창을 닫으면 스스로 종료

왜 필요한가
    브라우저로 file:// 를 직접 열면 보안 정책 때문에 파일을 쓰려면 매번 사용자가
    파일을 고르고 권한을 허용해야 한다. 도우미가 http://127.0.0.1 로 띄워 주면
    그 제약이 사라져 **폴더 선택도 권한창도 없이** 바로 읽고 쓴다.

한계 (README 참고)
    · 서명 없는 exe 는 SmartScreen/AppLocker 에 걸릴 수 있다.
    · 데이터 파일 경로가 NAS 라면 그 PC 에 그 경로가 보여야 한다.

실행 (개발 중):  python assign_server.py [데이터파일경로]
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = "assign-helper"
IDLE_EXIT_SEC = 180        # 창을 닫으면(핑이 끊기면) 스스로 종료
CONFIG_NAME = "assign.ini"  # data=<경로> 한 줄. exe 옆에 두면 NAS 경로 지정 가능
DATA_DEFAULT = "assign-data.json"

TOKEN = secrets.token_urlsafe(16)
_last_seen = time.time()
_lock = threading.Lock()


def base_dir() -> str:
    """exe(또는 스크립트)가 놓인 폴더 — 사용자가 파일을 두는 곳."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def bundled_dir() -> str:
    """PyInstaller 가 풀어 놓은 임시 폴더 (묶어 넣은 assign.html 이 여기 있다)."""
    return getattr(sys, "_MEIPASS", base_dir())


def find_html() -> str | None:
    """옆에 있는 assign.html 을 우선 — 새 버전을 exe 재빌드 없이 갈아끼울 수 있게."""
    for d in (base_dir(), bundled_dir()):
        p = os.path.join(d, "assign.html")
        if os.path.isfile(p):
            return p
    return None


def data_path() -> str:
    cfg = os.path.join(base_dir(), CONFIG_NAME)
    if os.path.isfile(cfg):
        try:
            with open(cfg, encoding="utf-8-sig") as f:
                for line in f:
                    k, _, v = line.partition("=")
                    if k.strip().lower() == "data" and v.strip():
                        p = os.path.expandvars(v.strip().strip('"'))
                        return p if os.path.isabs(p) else os.path.join(base_dir(), p)
        except OSError:
            pass
    if len(sys.argv) > 1 and sys.argv[1].strip():
        p = sys.argv[1].strip()
        return p if os.path.isabs(p) else os.path.join(base_dir(), p)
    return os.path.join(base_dir(), DATA_DEFAULT)


def read_data(path: str) -> dict:
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        txt = f.read().strip()
    if not txt:
        return {}
    # 자동 열림용 .js 래퍼(window.__ASSIGN_DATA={...};)도 그대로 읽는다
    if txt.startswith("window."):
        txt = txt[txt.index("=") + 1:].rstrip().rstrip(";")
    return json.loads(txt)


def write_data(path: str, obj: dict) -> None:
    """같은 폴더에 임시 파일로 쓴 뒤 교체 — 쓰는 도중 전원이 나가도 원본이 안 깨진다."""
    body = json.dumps(obj, ensure_ascii=False)
    if path.lower().endswith(".js"):
        body = "window.__ASSIGN_DATA=" + body + ";\n"
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ── 공통 ────────────────────────────────────────────────────────────
    def log_message(self, *a):        # 콘솔 없는 창에서 예외 나지 않게 침묵
        pass

    def _touch(self):
        global _last_seen
        _last_seen = time.time()

    def _ok_token(self) -> bool:
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return (q.get("t") or [""])[0] == TOKEN

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass          # 브라우저가 먼저 끊은 것 — 정상 상황이라 조용히 넘긴다

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    # ── 라우팅 ──────────────────────────────────────────────────────────
    def do_GET(self):
        self._touch()
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html", "/assign.html"):
            html = find_html()
            if not html:
                return self._send(500, "assign.html 을 찾지 못했습니다".encode(), "text/plain; charset=utf-8")
            with open(html, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/ping":
            if not self._ok_token():
                return self._json(403, {"error": "token"})
            p = data_path()
            d = os.path.dirname(p) or "."
            return self._json(200, {
                "app": APP, "file": os.path.basename(p), "path": p,
                "exists": os.path.isfile(p), "writable": os.access(d, os.W_OK),
            })
        if path == "/api/data":
            if not self._ok_token():
                return self._json(403, {"error": "token"})
            try:
                return self._json(200, read_data(data_path()))
            except (OSError, ValueError) as e:
                return self._json(500, {"error": str(e)})
        return self._send(404, b"not found", "text/plain")

    def do_PUT(self):
        self._touch()
        if self.path.split("?", 1)[0] != "/api/data":
            return self._send(404, b"not found", "text/plain")
        if not self._ok_token():
            return self._json(403, {"error": "token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            incoming = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError) as e:
            return self._json(400, {"error": str(e)})
        p = data_path()
        with _lock:
            try:
                cur = read_data(p)
            except (OSError, ValueError):
                # 파일을 읽을 수 없으면 덮어쓰지 않는다 (깨진/잠긴 파일 보호)
                return self._json(409, {"error": "read_failed"})
            file_rev = int(cur.get("rev") or 0)
            mine = int(incoming.get("rev") or 0)
            # 다른 PC가 먼저 저장했으면 알려만 준다 — 화면에서 판단
            if file_rev > mine and not self.headers.get("X-Force"):
                return self._json(409, {"error": "conflict", "file_rev": file_rev, "data": cur})
            incoming["rev"] = max(file_rev, mine) + 1
            incoming["saved"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            try:
                write_data(p, incoming)
            except OSError as e:
                return self._json(500, {"error": str(e)})
            return self._json(200, {"ok": True, "rev": incoming["rev"], "saved": incoming["saved"]})


def open_browser(url: str) -> None:
    """Edge/Chrome 앱 창(주소창 없음)으로. 없으면 기본 브라우저."""
    if sys.platform == "win32":
        cands = [
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        ]
        for exe in cands:
            if os.path.isfile(exe):
                try:
                    subprocess.Popen([exe, f"--app={url}"], close_fds=True)
                    return
                except OSError:
                    pass
    webbrowser.open(url)


def watchdog(httpd) -> None:
    """창을 닫아 핑이 끊기면 스스로 종료 — 좀비 프로세스를 남기지 않는다."""
    while True:
        time.sleep(10)
        if time.time() - _last_seen > IDLE_EXIT_SEC:
            httpd.shutdown()
            return


def main() -> int:
    if not find_html():
        print("assign.html 이 없습니다 — exe 와 같은 폴더에 두세요.", flush=True)
        return 1
    port = int(os.environ.get("ASSIGN_PORT") or 0)      # 0 = 빈 포트 자동 (검증용으로 고정 가능)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    port = httpd.socket.getsockname()[1]
    url = f"http://127.0.0.1:{port}/?t={TOKEN}"
    threading.Thread(target=watchdog, args=(httpd,), daemon=True).start()
    if not os.environ.get("ASSIGN_NO_BROWSER"):
        threading.Timer(0.3, open_browser, args=(url,)).start()
    print(f"어싸인 배정표 도우미 — {url}\n데이터 파일: {data_path()}\n(창을 닫으면 자동 종료)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                                  # noqa: BLE001
        # 창 없는 exe 에서도 원인을 남긴다
        try:
            with open(os.path.join(base_dir(), "assign_error.log"), "a", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + repr(e) + "\n")
        except OSError:
            pass
        raise
