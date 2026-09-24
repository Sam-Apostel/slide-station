"""Accounts on a hosted server (ARCHITECTURE "Hosted container"): sign in with an Immich API key.

Off unless SLIDESTATION_AUTH=immich. Then SLIDESTATION_IMMICH_URL names the one Immich the server
belongs to, and signing in means handing over an API key of it: `GET /api/users/me` with that key
says who you are, and your id picks your folder, `<SLIDESTATION_HOME>/users/<id>/` (config.json with
the key, library/). The URL is the server's, never the user's: whoever answers /users/me decides
which folder you get, so letting a user name their own "Immich" would let them name any id.

Sessions are random tokens in an HttpOnly cookie; `auth.json` keeps only their SHA-256 with the
user id, so a copy of it signs nobody in. Immich's own OAuth isn't usable here: Immich is an OAuth
*client* of an identity provider, not a provider other apps can sign in with.

Hardening (ARCHITECTURE §4e "Limits"): failed sign-ins slow down per client address and per key
prefix (`check_rate` / `failed`: a few free tries, then 429 with a wait that doubles up to 15
minutes), and a session re-checks its user's key with Immich every KEY_RECHECK seconds as it is
used: once Immich rejects the key (revoked) every session of that user ends and the sign-in screen
says why.
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
from .immich import Immich, ImmichError, Rejected

MODE = os.environ.get("SLIDESTATION_AUTH", "").strip().lower()
COOKIE = "slidestation_session"
TTL = 30 * 86400  # a sign-in lasts a month from the last visit
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")  # Immich user ids are UUIDs
# a signed-in user's API key is asked about again (GET /users/me) this long after the last time
KEY_RECHECK = float(os.environ.get("SLIDESTATION_KEY_RECHECK_MINUTES", "10")) * 60
KEY_RETRY = 60  # Immich didn't answer the re-check: keep the session, ask again this much later
REVOKED = "Immich no longer accepts the API key you signed in with (revoked?): sign in with a new one."
# failed sign-ins: this many are free per client address / key prefix, then each waits twice as long
SIGNIN_FREE = int(os.environ.get("SLIDESTATION_SIGNIN_FREE", "3"))
SIGNIN_MAX_WAIT = 15 * 60
SIGNIN_FORGET = 3600  # an hour without a failure starts over
KEY_PREFIX = 8  # characters of a key that identify it for the per-key limit (only hashed, in memory)
_lock = threading.Lock()
_attempts: dict[str, dict] = {}  # "ip:<addr>" / "key:<hash of prefix>" -> {"n": failures, "last": time}
_attempts_lock = threading.Lock()
_now = time.time  # the tests move this clock


class RateLimited(Exception):
    """Too many failed sign-ins from this address or for this key: wait `retry_after` seconds."""

    def __init__(self, retry_after: int):
        wait = f"{retry_after} seconds" if retry_after < 120 else f"{(retry_after + 59) // 60} minutes"
        super().__init__(f"Too many failed sign-ins: try again in {wait}.")
        self.retry_after = retry_after


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


# --------------------------------------------------------------------------- sign-in rate limit


def _buckets(client: str, api_key: str) -> list[str]:
    prefix = hashlib.sha256(api_key.strip()[:KEY_PREFIX].encode()).hexdigest()[:16]
    return [f"ip:{client or '?'}", f"key:{prefix}"]


def _wait(b: dict | None, now: float) -> float:
    """Seconds this bucket still has to wait before the next try (0: go ahead)."""
    if not b or now - b["last"] > SIGNIN_FORGET or b["n"] < SIGNIN_FREE:
        return 0
    return max(0.0, b["last"] + min(SIGNIN_MAX_WAIT, 2 ** (b["n"] - SIGNIN_FREE + 1)) - now)


def check_rate(client: str, api_key: str) -> None:
    """Raises RateLimited while this address or this key's prefix has to wait after failed tries.
    Checked before Immich is asked, so guessing never reaches it faster than the limit."""
    now = _now()
    with _attempts_lock:
        wait = max(_wait(_attempts.get(k), now) for k in _buckets(client, api_key))
    if wait > 0:
        raise RateLimited(int(wait) + 1)


def failed(client: str, api_key: str) -> None:
    """A key Immich rejected: counts against the address and the key's prefix."""
    now = _now()
    with _attempts_lock:
        for k, b in list(_attempts.items()):  # forget the quiet ones, so the dict can't grow forever
            if now - b["last"] > SIGNIN_FORGET:
                del _attempts[k]
        for k in _buckets(client, api_key):
            b = _attempts.setdefault(k, {"n": 0, "last": now})
            b["n"], b["last"] = b["n"] + 1, now


def succeeded(client: str, api_key: str) -> None:
    """A good key clears its own prefix's count. The address keeps its count (it may be guessing
    other people's keys between sign-ins with its own) until it has been quiet for an hour."""
    with _attempts_lock:
        _attempts.pop(_buckets(client, api_key)[1], None)


# --------------------------------------------------------------------------- sessions


def login(api_key: str, client: str = "") -> tuple[str, dict]:
    """Check the key with the server's Immich; (session token, {"id", "name", "email"}). Raises
    RateLimited after too many failed tries from `client` (the address) or for this key."""
    if not store.USER_IMMICH_URL:
        raise RuntimeError("The server has no SLIDESTATION_IMMICH_URL: accounts need it")
    if not (api_key or "").strip():
        raise ImmichError("Paste an API key from Immich (Account settings → API keys)")
    check_rate(client, api_key)
    c = Immich(store.USER_IMMICH_URL, api_key)
    try:
        me = c.me()
    except Rejected:
        failed(client, api_key)
        raise
    finally:
        c.close()
    succeeded(client, api_key)
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
        d[_hash(token)] = {"user": uid, "created": time.time(), "seen": time.time(), "checked": _now()}
        store._atomic_write(_tokens_file(), d)
        os.chmod(_tokens_file(), 0o600)
    return token, user


def resolve(token: str | None) -> Path | None:
    """The signed-in user's home for a session cookie, or None. Every KEY_RECHECK the user's key is
    asked about again: once Immich rejects it, the session (every one of that user's) is over."""
    if not token:
        return None
    with _lock:
        d = _load()
        rec = d.get(_hash(token))
        if not rec or rec.get("ended") or rec.get("seen", 0) < time.time() - TTL:
            return None
        write = False
        if time.time() - rec.get("seen", 0) > 3600:  # keep it alive, without a write per request
            rec["seen"] = time.time()
            write = True
        due = _now() - rec.get("checked", 0) > KEY_RECHECK
        if due:  # claimed now, so the requests arriving meanwhile don't all ask Immich too
            rec["checked"] = _now()
            write = True
        if write:
            store._atomic_write(_tokens_file(), d)
    try:
        home = user_dir(rec["user"])
    except ValueError:
        return None
    if due and not _key_still_good(home, rec["user"]):
        end_sessions(rec["user"], REVOKED)
        return None
    return home


def _key_still_good(home: Path, uid: str) -> bool:
    """Does Immich still take this user's key as theirs? Only a clear no (401, or a key of someone
    else) counts: Immich being down keeps the session, and it is asked again KEY_RETRY later."""
    with store.as_home(home):
        key = store.load_config().get("immich_key") or ""
    if not key:
        return False
    try:
        c = Immich(store.USER_IMMICH_URL, key)
        try:
            me = c.me()
        finally:
            c.close()
    except Rejected:
        return False
    except Exception as e:  # unreachable, 5xx, a key without user.read (403): not a revocation
        print("re-checking an API key:", e)
        with _lock:
            d = _load()
            for rec in d.values():
                if rec.get("user") == uid and not rec.get("ended"):
                    rec["checked"] = _now() - KEY_RECHECK + KEY_RETRY
            store._atomic_write(_tokens_file(), d)
        return True
    return str(me.get("id") or "") == uid


def end_sessions(uid: str, reason: str) -> None:
    """Sign a user out everywhere (their key was revoked). The records stay, marked as ended with
    the reason, so the sign-in screen can say what happened; the key itself is forgotten."""
    with _lock:
        d = _load()
        for rec in d.values():
            if rec.get("user") == uid:
                rec["ended"] = reason
        store._atomic_write(_tokens_file(), d)
    try:
        with store.as_home(user_dir(uid)):
            cfg = store.load_config()
            if cfg.pop("immich_key", None):
                store.save_config({k: v for k, v in cfg.items() if k not in ("library", "immich_url")})
    except (OSError, ValueError) as e:
        print("forgetting a revoked key:", e)


def ended(token: str | None) -> str:
    """Why this cookie's session ended by itself ("" if it didn't), for the sign-in screen."""
    if not token:
        return ""
    with _lock:
        rec = _load().get(_hash(token)) or {}
    return str(rec.get("ended") or "")


def key_owner_ok(api_key: str) -> None:
    """A signed-in user changing their key in Settings: it has to be a key of the same Immich user
    (the account is that user). Raises ImmichError otherwise."""
    home = store.user_home()
    if home is None:
        return
    c = Immich(store.USER_IMMICH_URL, api_key)
    try:
        me = c.me()
    finally:
        c.close()
    if str(me.get("id") or "") != home.name:
        raise ImmichError("That API key belongs to another Immich user: use one of your own.")


def logout(token: str | None) -> None:
    if not token:
        return
    with _lock:
        d = _load()
        if d.pop(_hash(token), None):
            store._atomic_write(_tokens_file(), d)
