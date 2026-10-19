"""Lecture (seule) du coffre chiffré de la synchro Supabase de l'appli.

Même schéma que sync.js : connexion e-mail + mot de passe, ligne `vault` de l'utilisateur,
clé AES-GCM 256 dérivée de la phrase par PBKDF2-SHA256, contenu = {"budget": ..., "pea": ...}.
Seules des requêtes GET (et la connexion) sont émises : rien n'est écrit sur Supabase.

Configuration (aucun secret en dur) :
  SUPABASE_URL, SUPABASE_KEY   URL du projet et clé publishable (publiques, cf. sync.js)
  SUPABASE_EMAIL               e-mail du compte
  Mot de passe et phrase       trousseau macOS (service « budget-patrimoine-mcp », comptes
                               « password » et « passphrase »), ou à défaut les variables
                               SUPABASE_PASSWORD / SUPABASE_PASSPHRASE.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import secrets
import subprocess
import time
from datetime import datetime
from pathlib import Path
import unicodedata
import urllib.error
import urllib.request
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEYCHAIN_SERVICE = "budget-patrimoine-mcp"
CACHE_SECONDS = 30
TIMEOUT = 20

_cache: dict[str, Any] = {"at": 0.0, "data": None, "updated_at": None}
_token: dict[str, Any] = {"value": None, "exp": 0.0}


class VaultError(Exception):
    """Message lisible, renvoyé tel quel à l'utilisateur."""


def configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_KEY") and os.environ.get("SUPABASE_EMAIL"))


def _secret(account: str, env_var: str) -> str:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.rstrip("\n")
    except (OSError, subprocess.SubprocessError):
        pass
    value = os.environ.get(env_var)
    if value:
        return value
    raise VaultError(
        f"« {account} » introuvable. Ajoutez-le au trousseau :\n"
        f"  security add-generic-password -s {KEYCHAIN_SERVICE} -a {account} -w\n"
        f"(ou définissez {env_var})."
    )


def _request(path: str, *, body: dict | None = None, bearer: str | None = None,
             method: str | None = None, prefer: str | None = None) -> Any:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    headers = {"apikey": os.environ["SUPABASE_KEY"], "Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        base + path, headers=headers, method=method or ("POST" if body is not None else "GET"),
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode())
            detail = detail.get("msg") or detail.get("message") or detail.get("error_description") or ""
        except Exception:
            detail = ""
        raise VaultError(f"Supabase a répondu HTTP {e.code} {detail}".strip()) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise VaultError(f"Supabase injoignable ({e}).") from e
    return json.loads(text) if text else None


def _access_token() -> tuple[str, str]:
    if _token["value"] and _token["exp"] - 60 > time.time():
        return _token["value"], _token["uid"]
    s = _request(
        "/auth/v1/token?grant_type=password",
        body={"email": os.environ["SUPABASE_EMAIL"], "password": _secret("password", "SUPABASE_PASSWORD")},
    )
    _token.update(value=s["access_token"], uid=s["user"]["id"], exp=float(s.get("expires_at") or time.time() + 3600))
    return _token["value"], _token["uid"]


def decrypt_row(row: dict[str, Any], passphrase: str) -> dict[str, Any]:
    """Déchiffre une ligne `vault` (compatible avec SyncCrypto de sync.js)."""
    key = hashlib.pbkdf2_hmac(
        "sha256", unicodedata.normalize("NFC", passphrase).encode("utf-8"), base64.b64decode(row["salt"]), int(row["iterations"]), dklen=32
    )
    try:
        plain = AESGCM(key).decrypt(base64.b64decode(row["iv"]), base64.b64decode(row["data"]), None)
    except InvalidTag as e:
        raise VaultError("Déchiffrement impossible : phrase de chiffrement incorrecte (ou données abîmées).") from e
    return json.loads(plain.decode("utf-8"))


def fetch() -> dict[str, Any]:
    """Retourne {"budget": ..., "pea": ..., "_updated_at": ...} (cache de 30 s)."""
    if _cache["data"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["data"]
    token, uid = _access_token()
    rows = _request(f"/rest/v1/vault?select=salt,iterations,iv,data,rev,updated_at&user_id=eq.{uid}", bearer=token)
    if not rows:
        raise VaultError("Aucune donnée synchronisée sur Supabase : ouvrez l'appli et lancez une synchronisation.")
    row = rows[0]
    # le mot de passe et la phrase ne sont lus qu'au moment utile, jamais conservés
    data = decrypt_row(row, _secret("passphrase", "SUPABASE_PASSPHRASE").replace("\r", ""))
    data["_updated_at"] = row.get("updated_at")
    _cache.update(at=time.time(), data=data)
    return data


# --------------------------------------------------------------------------- écriture (ajouts uniquement)

BACKUP_KEEP = 30


def _key(row: dict[str, Any], passphrase: str) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", unicodedata.normalize("NFC", passphrase).encode("utf-8"), base64.b64decode(row["salt"]), int(row["iterations"]), dklen=32
    )


def _backup(row: dict[str, Any]) -> Path:
    """Copie chiffrée de l'état AVANT écriture, au format « sauvegarde chiffrée » de l'appli
    (importable telle quelle : Patrimoine → Importer une sauvegarde chiffrée). Rien n'est stocké en clair."""
    d = Path(os.environ.get("BUDGET_DATA_DIR", "~/Documents/budget-data")).expanduser() / "sauvegardes"
    d.mkdir(parents=True, exist_ok=True)
    env = {
        "format": "budget-patrimoine-chiffre", "v": 1,
        "kdf": {"name": "PBKDF2", "hash": "SHA-256", "iterations": int(row["iterations"]), "salt": row["salt"]},
        "cipher": "AES-GCM", "iv": row["iv"], "data": row["data"],
    }
    path = d / f"coffre-{datetime.now():%Y%m%d-%H%M%S}-rev{row['rev']}.json"
    path.write_text(json.dumps(env), encoding="utf-8")
    path.chmod(0o600)
    for old in sorted(d.glob("coffre-*.json"))[:-BACKUP_KEEP]:
        old.unlink()
    return path


def update(modify) -> dict[str, Any]:
    """Lit le coffre à jour, sauvegarde, applique `modify(data)` (qui ajoute des éléments et renvoie un
    résumé), rechiffre avec la clé d'origine et écrit avec contrôle de version (`rev`).
    Refusé (sans rien écrire) si un autre appareil a écrit entre la lecture et l'écriture."""
    token, uid = _access_token()
    rows = _request(f"/rest/v1/vault?select=salt,iterations,iv,data,rev&user_id=eq.{uid}", bearer=token)
    if not rows:
        raise VaultError("Aucune donnée synchronisée : ouvrez l'appli et lancez une synchronisation d'abord.")
    row = rows[0]
    passphrase = _secret("passphrase", "SUPABASE_PASSPHRASE").replace("\r", "")
    data = decrypt_row(row, passphrase)
    before = copy.deepcopy(data)
    summary = modify(data)
    if data == before:
        raise VaultError("Aucune modification à écrire.")
    backup = _backup(row)
    iv = secrets.token_bytes(12)
    cipher = AESGCM(_key(row, passphrase)).encrypt(iv, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), None)
    rev = int(row["rev"])
    written = _request(
        f"/rest/v1/vault?user_id=eq.{uid}&rev=eq.{rev}", method="PATCH", bearer=token, prefer="return=representation",
        body={"iv": base64.b64encode(iv).decode(), "data": base64.b64encode(cipher).decode(), "rev": rev + 1,
              "device": "Claude (MCP)", "updated_at": datetime.utcnow().isoformat() + "Z"},
    )
    if not written:
        raise VaultError("Écriture annulée : le coffre a été modifié par un autre appareil entre-temps. Rien n'a été changé, réessayez.")
    _cache.update(at=0.0, data=None)
    return {**summary, "sauvegarde_avant": backup.name, "version": rev + 1}
