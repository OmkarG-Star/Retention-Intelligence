"""Authentication and authorisation.

Session cookies over a SQLite store, scrypt password hashing from the standard
library (no native build step, which matters when this has to install on a
locked-down office laptop), and a CSRF token required on every mutating request.

Roles:
  admin        everything, including retraining and user management
  hr_manager   full read plus interventions
  viewer       read-only dashboards, no employee-level notes
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, Header, HTTPException, Request, status

from ..config import settings
from ..data.warehouse import connect, init_app_db, paths

SESSION_COOKIE = "sri_session"
ROLES = ("admin", "hr_manager", "viewer")
ROLE_RANK = {"viewer": 1, "hr_manager": 2, "admin": 3}

DEFAULT_USERS = [
    ("admin", "Platform Admin", "admin", "Admin@2026"),
    ("hr.manager", "HR Manager", "hr_manager", "HrManager@2026"),
    ("viewer", "Leadership Viewer", "viewer", "Viewer@2026"),
]


# ---------------------------------------------------------------- passwords
def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                            n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


# ---------------------------------------------------------------- users
def seed_users() -> list[str]:
    init_app_db()
    out = []
    with connect(paths.app_db) as c:
        for username, full_name, role, password in DEFAULT_USERS:
            exists = c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone()
            if exists:
                out.append(f"{username:12s} already exists ({role})")
                continue
            c.execute(
                "INSERT INTO users (username, full_name, role, password_hash, created_at)"
                " VALUES (?,?,?,?,datetime('now'))",
                (username, full_name, role, hash_password(password)))
            out.append(f"{username:12s} created  role={role:10s} password={password}")
    return out


def get_user(username: str):
    with connect(paths.app_db) as c:
        return c.execute("SELECT * FROM users WHERE username=? AND is_active=1",
                         (username,)).fetchone()


def authenticate(username: str, password: str):
    user = get_user(username)
    if not user or not verify_password(password, user["password_hash"]):
        return None
    with connect(paths.app_db) as c:
        c.execute("UPDATE users SET last_login=datetime('now') WHERE id=?", (user["id"],))
    return user


# ---------------------------------------------------------------- sessions
def create_session(user_id: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    expires = datetime.now(timezone.utc) + timedelta(hours=settings.session_ttl_hours)
    with connect(paths.app_db) as c:
        c.execute("INSERT INTO sessions (token, user_id, csrf, created_at, expires_at)"
                  " VALUES (?,?,?,datetime('now'),?)",
                  (token, user_id, csrf, expires.isoformat(timespec="seconds")))
    return token, csrf


def destroy_session(token: str) -> None:
    with connect(paths.app_db) as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token,))


def purge_expired() -> None:
    with connect(paths.app_db) as c:
        c.execute("DELETE FROM sessions WHERE expires_at < ?",
                  (datetime.now(timezone.utc).isoformat(timespec="seconds"),))


def session_user(token: str | None):
    if not token:
        return None
    with connect(paths.app_db) as c:
        row = c.execute(
            "SELECT s.token, s.csrf, s.expires_at, u.id, u.username, u.full_name, u.role"
            " FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token=? AND u.is_active=1", (token,)).fetchone()
    if not row:
        return None
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        destroy_session(token)
        return None
    return row


# ---------------------------------------------------------------- dependencies
async def current_user(sri_session: str | None = Cookie(default=None)):
    user = session_user(sri_session)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue")
    return user


def require_role(minimum: str):
    async def guard(user=Depends(current_user)):
        if ROLE_RANK.get(user["role"], 0) < ROLE_RANK[minimum]:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                f"This action needs the {minimum} role")
        return user
    return guard


async def csrf_guard(request: Request, x_csrf_token: str | None = Header(default=None),
                     user=Depends(current_user)):
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return user
    if not x_csrf_token or not hmac.compare_digest(x_csrf_token, user["csrf"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")
    return user

