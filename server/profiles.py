"""
프로필 관리 모듈 — 병동별 DB 분리 + Fernet 암호화
"""
import json
import os
import hashlib
import base64
import shutil
import tempfile
from pathlib import Path
from typing import Optional, Dict, List

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


def _app_dir() -> Path:
    app_data = os.environ.get("APPDATA", "")
    if app_data:
        d = Path(app_data) / "NurseScheduler"
    else:
        d = Path(__file__).parent.parent / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _profiles_path() -> Path:
    return _app_dir() / "profiles.json"


def _load_profiles() -> Dict:
    """profiles.json 로드 (없으면 기본 구조 생성)"""
    path = _profiles_path()
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    # 기본 구조
    return {
        "master_password_hash": None,
        "master_password_salt": None,
        "profiles": [],
        "developer_unlocked": False,
    }


def _save_profiles(data: Dict):
    path = _profiles_path()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _hash_password(password: str, salt: Optional[bytes] = None) -> tuple:
    """PBKDF2-SHA256으로 비밀번호 해시. (hash_hex, salt_hex) 반환"""
    if salt is None:
        salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
    return dk.hex(), salt.hex()


def _verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    import hmac
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
    return hmac.compare_digest(dk.hex(), hash_hex)  # 상수시간 비교


def _derive_fernet_key(password: str, salt: bytes) -> bytes:
    """비밀번호에서 Fernet 키 유도"""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))
    return key


def _db_path_for_profile(profile_id: str) -> Path:
    """프로필별 DB 파일 경로 (암호화: .db.enc, 비암호화: .db)"""
    return _app_dir() / f"{profile_id}.db"


def _enc_path_for_profile(profile_id: str) -> Path:
    return _app_dir() / f"{profile_id}.db.enc"


# ── 공개 API ──────────────────────────────────────────────────────────────


def list_profiles() -> List[Dict]:
    """프로필 목록 반환 (비밀번호 해시 제외)"""
    data = _load_profiles()
    result = []
    for p in data.get("profiles", []):
        result.append({
            "id": p["id"],
            "name": p["name"],
            "has_password": bool(p.get("password_hash")),
            "is_guest": p.get("is_guest", False),
            "created_at": p.get("created_at", ""),
        })
    return result


def has_master_password() -> bool:
    data = _load_profiles()
    return bool(data.get("master_password_hash"))


def verify_master_password(password: str) -> bool:
    data = _load_profiles()
    h = data.get("master_password_hash")
    s = data.get("master_password_salt")
    if not h or not s:
        return False
    return _verify_password(password, h, s)


def set_master_password(password: str) -> bool:
    data = _load_profiles()
    h, s = _hash_password(password)
    data["master_password_hash"] = h
    data["master_password_salt"] = s
    _save_profiles(data)
    return True


def remove_master_password() -> bool:
    data = _load_profiles()
    data["master_password_hash"] = None
    data["master_password_salt"] = None
    _save_profiles(data)
    return True


_PROFILE_ID_RE = None


def _valid_profile_id(profile_id: str) -> bool:
    """profile_id는 파일 경로({id}.db)에 들어가므로 경로 조작 문자를 차단한다."""
    global _PROFILE_ID_RE
    if _PROFILE_ID_RE is None:
        import re
        _PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9가-힣_-]{1,64}$")
    return bool(profile_id) and bool(_PROFILE_ID_RE.match(profile_id))


def create_profile(profile_id: str, name: str, password: str = "",
                   is_guest: bool = False) -> Dict:
    """새 프로필 생성"""
    from datetime import datetime

    if not _valid_profile_id(profile_id):
        return {"ok": False,
                "error": "프로필 ID는 한글/영문/숫자/-/_ 만 사용할 수 있습니다 (64자 이내)."}

    data = _load_profiles()

    # 중복 체크
    for p in data["profiles"]:
        if p["id"] == profile_id:
            return {"ok": False, "error": "이미 존재하는 프로필 ID입니다."}

    profile = {
        "id": profile_id,
        "name": name,
        "is_guest": is_guest,
        "created_at": datetime.now().isoformat(),
    }

    if password and not is_guest:
        h, s = _hash_password(password)
        profile["password_hash"] = h
        profile["password_salt"] = s
        profile["enc_salt"] = os.urandom(16).hex()  # Fernet 키 유도용 salt
    else:
        profile["password_hash"] = None
        profile["password_salt"] = None
        profile["enc_salt"] = None

    data["profiles"].append(profile)
    _save_profiles(data)

    # 게스트가 아니면 빈 DB 생성
    if not is_guest:
        db_path = _db_path_for_profile(profile_id)
        if not db_path.exists():
            # DB 초기화 (database.py의 init_db 호출)
            from . import database as db
            original_path = db.get_db_path
            db.get_db_path = lambda: str(db_path)
            db.init_db()
            db.get_db_path = original_path

            # 비밀번호가 있으면 암호화
            if password:
                _encrypt_db(profile_id, password)

    return {"ok": True, "profile": {
        "id": profile_id,
        "name": name,
        "has_password": bool(password and not is_guest),
        "is_guest": is_guest,
    }}


def delete_profile(profile_id: str) -> Dict:
    """프로필 삭제 (DB 파일 포함)"""
    data = _load_profiles()
    found = None
    for i, p in enumerate(data["profiles"]):
        if p["id"] == profile_id:
            found = i
            break

    if found is None:
        return {"ok": False, "error": "프로필을 찾을 수 없습니다."}

    if data["profiles"][found].get("is_guest"):
        return {"ok": False, "error": "게스트 프로필은 삭제할 수 없습니다."}

    data["profiles"].pop(found)
    _save_profiles(data)

    # DB 파일 삭제
    for path in [_db_path_for_profile(profile_id),
                 _enc_path_for_profile(profile_id)]:
        if path.exists():
            path.unlink()

    return {"ok": True}


def open_profile(profile_id: str, password: str = "") -> Dict:
    """
    프로필 열기 — 암호 검증 + DB 복호화.
    성공 시 평문 DB 경로 반환.
    """
    data = _load_profiles()
    profile = None
    for p in data["profiles"]:
        if p["id"] == profile_id:
            profile = p
            break

    if not profile:
        return {"ok": False, "error": "프로필을 찾을 수 없습니다."}

    # 게스트: 임시 DB 사용
    if profile.get("is_guest"):
        guest_db = _db_path_for_profile("_guest_temp")
        # 기존 게스트 DB가 있으면 삭제 시도, 잠겨있으면 테이블만 초기화
        if guest_db.exists():
            try:
                guest_db.unlink()
            except (PermissionError, OSError):
                # 파일 잠금 — 테이블 내용만 지움
                import sqlite3
                try:
                    c = sqlite3.connect(str(guest_db))
                    tables = [r[0] for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                    for t in tables:
                        c.execute(f"DELETE FROM {t}")
                    c.commit()
                    c.close()
                except Exception:
                    pass
        from . import database as db
        original_fn = db.get_db_path
        db.get_db_path = lambda: str(guest_db)
        db.init_db()
        db.get_db_path = original_fn
        return {"ok": True, "db_path": str(guest_db), "is_guest": True}

    # 암호 검증
    if profile.get("password_hash"):
        if not password:
            return {"ok": False, "error": "비밀번호를 입력해주세요."}
        if not _verify_password(password, profile["password_hash"],
                                profile["password_salt"]):
            return {"ok": False, "error": "비밀번호가 틀렸습니다."}

    # 암호화된 DB가 있으면 복호화
    enc_path = _enc_path_for_profile(profile_id)
    db_path = _db_path_for_profile(profile_id)

    if enc_path.exists() and profile.get("enc_salt"):
        # 직전 세션이 재암호화 없이 끝났다면(크래시·강제종료) 평문 .db가
        # .db.enc보다 최신이다. 비밀번호는 위에서 해시로 이미 검증됐으므로
        # 낡은 암호화본으로 최신 평문을 덮어쓰지 않는다.
        if db_path.exists() and db_path.stat().st_mtime > enc_path.stat().st_mtime:
            return {"ok": True, "db_path": str(db_path), "is_guest": False}
        try:
            _decrypt_db(profile_id, password)
        except InvalidToken:
            return {"ok": False, "error": "DB 복호화 실패. 비밀번호를 확인해주세요."}
    elif not db_path.exists():
        # DB가 아예 없으면 생성
        from . import database as db
        original_fn = db.get_db_path
        db.get_db_path = lambda: str(db_path)
        db.init_db()
        db.get_db_path = original_fn

    return {"ok": True, "db_path": str(db_path), "is_guest": False}


def close_profile(profile_id: str, password: str = ""):
    """프로필 닫기 — DB 암호화 후 평문 삭제"""
    data = _load_profiles()
    profile = None
    for p in data["profiles"]:
        if p["id"] == profile_id:
            profile = p
            break

    if not profile:
        return

    if profile.get("is_guest"):
        # 게스트 DB 삭제
        guest_db = _db_path_for_profile("_guest_temp")
        if guest_db.exists():
            try:
                guest_db.unlink()
            except PermissionError:
                pass  # 파일 잠금 시 무시 (다음 열기 시 덮어씀)
        return

    # 비밀번호가 있으면 암호화
    if profile.get("enc_salt") and password:
        _encrypt_db(profile_id, password)


def change_password(profile_id: str, old_password: str,
                    new_password: str, is_open: bool = False) -> Dict:
    """프로필 비밀번호 변경.

    is_open: 현재 세션에서 열려 있는 프로필이면 True — 변경 후 평문 DB를
    복원해 세션이 계속 동작하게 한다.
    """
    data = _load_profiles()
    profile = None
    for i, p in enumerate(data["profiles"]):
        if p["id"] == profile_id:
            profile = p
            break

    if not profile:
        return {"ok": False, "error": "프로필을 찾을 수 없습니다."}

    # 기존 비밀번호 검증
    if profile.get("password_hash"):
        if not _verify_password(old_password, profile["password_hash"],
                                profile["password_salt"]):
            return {"ok": False, "error": "기존 비밀번호가 틀렸습니다."}

    enc_path = _enc_path_for_profile(profile_id)
    db_path = _db_path_for_profile(profile_id)

    # 닫힌(암호화된) 프로필: enc_salt를 갈기 전에 반드시 '옛 비밀번호+옛 salt'로
    # 복호화부터 한다. 이 단계를 건너뛰고 salt를 덮어쓰면 .db.enc는 영구 복호화
    # 불능이 된다.
    was_closed = enc_path.exists() and not db_path.exists()
    if was_closed:
        if not profile.get("enc_salt"):
            return {"ok": False, "error": "프로필 메타데이터 손상: 복호화 salt가 없습니다."}
        try:
            _decrypt_db(profile_id, old_password)
        except InvalidToken:
            return {"ok": False, "error": "기존 비밀번호로 DB를 복호화할 수 없습니다."}

    # 새 비밀번호 설정 (복호화 성공 이후에만 salt 교체)
    h, s = _hash_password(new_password)
    profile["password_hash"] = h
    profile["password_salt"] = s
    profile["enc_salt"] = os.urandom(16).hex()

    data["profiles"][data["profiles"].index(profile)] = profile
    _save_profiles(data)

    # DB 재암호화 (새 salt + 새 비밀번호)
    if db_path.exists():
        _encrypt_db(profile_id, new_password)
        # 열려 있는 프로필이면 평문을 복원해 세션을 유지한다 — 복원하지 않으면
        # 다음 DB 요청이 빈 스텁을 만들고, close 시 그 스텁이 .db.enc를 덮어쓴다.
        if is_open and not was_closed:
            _decrypt_db(profile_id, new_password)

    return {"ok": True}


def force_reset_password(profile_id: str) -> Dict:
    """개발자 모드: 비밀번호 강제 제거"""
    data = _load_profiles()
    profile = None
    for p in data["profiles"]:
        if p["id"] == profile_id:
            profile = p
            break
    if not profile:
        return {"ok": False, "error": "프로필을 찾을 수 없습니다."}

    # 암호화된 DB가 있으면 복호화 불가능하므로, 평문 DB가 있는 경우에만 처리
    enc_path = _enc_path_for_profile(profile_id)
    db_path = _db_path_for_profile(profile_id)
    if enc_path.exists() and not db_path.exists():
        return {"ok": False, "error": "암호화된 DB가 있어 비밀번호 제거 불가. 먼저 프로필을 열어야 합니다."}

    profile["password_hash"] = None
    profile["password_salt"] = None
    profile["enc_salt"] = None
    data["profiles"][data["profiles"].index(profile)] = profile
    _save_profiles(data)

    # 암호화 파일 삭제 (평문 DB 유지)
    if enc_path.exists():
        enc_path.unlink()

    return {"ok": True}


# ── 암호화/복호화 헬퍼 ─────────────────────────────────────────────────


def _encrypt_db(profile_id: str, password: str):
    """평문 DB → 암호화 .db.enc, 평문 삭제"""
    data = _load_profiles()
    profile = next((p for p in data["profiles"] if p["id"] == profile_id), None)
    if not profile or not profile.get("enc_salt"):
        return

    salt = bytes.fromhex(profile["enc_salt"])
    key = _derive_fernet_key(password, salt)
    f = Fernet(key)

    db_path = _db_path_for_profile(profile_id)
    enc_path = _enc_path_for_profile(profile_id)

    if not db_path.exists():
        return

    with open(db_path, "rb") as fp:
        plaintext = fp.read()

    # 빈/손상 스텁으로 정상 암호화본을 덮어쓰지 않도록 방어 —
    # sqlite3.connect가 만든 0바이트 스텁(SQLite 헤더 100바이트 미만)이면
    # 기존 .db.enc를 보존하고 스텁만 제거한다.
    if len(plaintext) < 100 and enc_path.exists():
        db_path.unlink()
        return

    ciphertext = f.encrypt(plaintext)
    tmp_path = enc_path.with_name(enc_path.name + ".tmp")
    with open(tmp_path, "wb") as fp:
        fp.write(ciphertext)
    os.replace(tmp_path, enc_path)

    # 평문 DB 삭제
    db_path.unlink()


def _decrypt_db(profile_id: str, password: str):
    """암호화 .db.enc → 평문 DB"""
    data = _load_profiles()
    profile = next((p for p in data["profiles"] if p["id"] == profile_id), None)
    if not profile or not profile.get("enc_salt"):
        return

    salt = bytes.fromhex(profile["enc_salt"])
    key = _derive_fernet_key(password, salt)
    f = Fernet(key)

    enc_path = _enc_path_for_profile(profile_id)
    db_path = _db_path_for_profile(profile_id)

    if not enc_path.exists():
        return

    with open(enc_path, "rb") as fp:
        ciphertext = fp.read()

    plaintext = f.decrypt(ciphertext)  # InvalidToken if wrong password
    tmp_path = db_path.with_name(db_path.name + ".tmp")
    with open(tmp_path, "wb") as fp:
        fp.write(plaintext)
    os.replace(tmp_path, db_path)


def init_default_profiles():
    """기본 프로필 초기화 (최초 실행 시)"""
    data = _load_profiles()
    if data.get("profiles"):
        return  # 이미 프로필이 있으면 스킵

    # 게스트 프로필
    data["profiles"].append({
        "id": "guest",
        "name": "게스트",
        "is_guest": True,
        "password_hash": None,
        "password_salt": None,
        "enc_salt": None,
        "created_at": "",
    })

    _save_profiles(data)
