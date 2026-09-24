"""Accounts on a hosted server (ARCHITECTURE "Hosted container"): sign in with an Immich API key.

Off unless SLIDESTATION_AUTH=immich. Then SLIDESTATION_IMMICH_URL names the one Immich the server
belongs to, and signing in means handing over an API key of it: `GET /api/users/me` with that key
says who you are, and your id picks your folder, `<SLIDESTATION_HOME>/users/<id>/` (config.json with
the key, library/). The URL is the server's, never the user's: whoever answers /users/me decides
which folder you get, so letting a user name their own "Immich" would let them name any id.

Sessions are random tokens in an HttpOnly cookie; `auth.json` keeps only their SHA-256 with the
user id, so a copy of it signs nobody in. Immich's own OAuth isn't usable here: Immich is an OAuth
*client* of an identity provider, not a provider other apps can sign in with.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from . import store
from .immich import Immich, ImmichError

MODE = os.environ.get("SLIDESTATION_AUTH", "").strip().lower()
COOKIE = "slidestation_session"
TTL = 30 * 86400  # a sign-in lasts a month from the last visit
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")  # Immich user ids are UUIDs
_lock = threading.Lock()


def enabled() -> bool:
    return MODE == "immich"


def _tokens_file() -> Path:
    return store.CONFIG_DIR / "auth.json"


def _load() -> dict:
    try:
        return json.loads(_tokens_file().read_text())
    except (OSError, ValueError):
        return {}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def user_dir(uid: str) -> Path:
    if not ID_RE.match(uid or ""):
        raise ValueError("Not an Immich user id")
    return store.CONFIG_DIR / "users" / uid


def profile(home: Path) -> dict:
    try:
        return json.loads((home / "user.json").read_text())
    except (OSError, ValueError):
        return {"id": home.name}


def login(api_key: str) -> tuple[str, dict]:
    """Check the key with the server's Immich; (session token, {"id", "name", "email"})."""
    if not store.USER_IMMICH_URL:
        raise RuntimeError("The server has no SLIDESTATION_IMMICH_URL: accounts need it")
    if not (api_key or "").strip():
        raise ImmichError("Paste an API key from Immich (Account settings → API keys)")
    c = Immich(store.USER_IMMICH_URL, api_key)
    try:
        me = c.me()
    finally:
        c.close()
    uid = str(me.get("id") or "")
    home = user_dir(uid)
    user = {"id": uid, "name": me.get("name") or "", "email": me.get("email") or ""}
    home.mkdir(parents=True, exist_ok=True)
    store._atomic_write(home / "user.json", user)
    with store.as_home(home):
        cfg = {k: v for k, v in store.load_config().items() if k not in ("library", "immich_url")}
        cfg["immich_key"] = api_key.strip()  # a new key replaces the old one (e.g. with more permissions)
        store.save_config(cfg)
    token = secrets.token_urlsafe(32)
    with _lock:
        d = {h: v for h, v in _load().items() if v.get("seen", 0) > time.time() - TTL}
        d[_hash(token)] = {"user": uid, "created": time.time(), "seen": time.time()}
        store._atomic_write(_tokens_file(), d)
        os.chmod(_tokens_file(), 0o600)
    return token, user


def resolve(token: str | None) -> Path | None:
    """The signed-in user's home for a session cookie, or None."""
    if not token:
        return None
    with _lock:
        d = _load()
        rec = d.get(_hash(token))
        if not rec or rec.get("seen", 0) < time.time() - TTL:
            return None
        if time.time() - rec.get("seen", 0) > 3600:  # keep it alive, without a write per request
            rec["seen"] = time.time()
            store._atomic_write(_tokens_file(), d)
    try:
        return user_dir(rec["user"])
    except ValueError:
        return None


def logout(token: str | None) -> None:
    if not token:
        return
    with _lock:
        d = _load()
        if d.pop(_hash(token), None):
            store._atomic_write(_tokens_file(), d)
