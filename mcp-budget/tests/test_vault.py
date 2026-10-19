"""Teste la source Supabase avec un faux serveur HTTP local et un chiffrement fait par le vrai sync.js.
Lancer : .venv/bin/python tests/test_vault.py"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import test_server as ts  # noqa: E402  (réutilise le jeu fictif ; n'exécute rien grâce au garde)

PASSPHRASE = "phrase fictive é de test"
payload = json.dumps({"budget": ts.BUDGET, "pea": ts.PEA})
row = json.loads(subprocess.run(["node", str(HERE / "make_vault.js"), PASSPHRASE], input=payload,
                                capture_output=True, text=True, check=True).stdout)
calls = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        calls.append(("POST", self.path))
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body["password"] != "mdp-fictif": return self._send(400, {"msg": "Invalid login credentials"})
        self._send(200, {"access_token": "tok", "expires_at": 9999999999, "user": {"id": "uid-1"}})
    def do_GET(self):
        calls.append(("GET", self.path))
        if self.headers.get("Authorization") != "Bearer tok": return self._send(401, {"msg": "no"})
        self._send(200, [row])


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ.update(SUPABASE_URL=f"http://127.0.0.1:{srv.server_port}", SUPABASE_KEY="pk", SUPABASE_EMAIL="a@b.test",
                  SUPABASE_PASSWORD="mdp-fictif", SUPABASE_PASSPHRASE=PASSPHRASE,
                  BUDGET_DATA_DIR=tempfile.mkdtemp())
import vault, server  # noqa: E402

vault.KEYCHAIN_SERVICE = "service-inexistant-test"  # ne jamais toucher au vrai trousseau en test
r = server.resume_budget("2026-03")
assert r["solde"] == 1452.5 and "Supabase" in r["source"], r
print("OK  lecture + déchiffrement (sync.js → Python) :", r["source"])
assert server.valeur_pea()["positions"][0]["quantite"] == 15
assert all(m == "GET" or p.startswith("/auth/") for m, p in calls), calls
print("OK  uniquement des GET (hors connexion)")

vault._cache["data"] = None
os.environ["SUPABASE_PASSPHRASE"] = "mauvaise phrase"
r = server.resume_budget("2026-03")
assert "erreur" in r and "phrase" in r["erreur"], r
print("OK  mauvaise phrase :", r["erreur"][:70])

os.environ["SUPABASE_PASSPHRASE"] = PASSPHRASE
os.environ["SUPABASE_PASSWORD"] = "faux"; vault._token["value"] = None; vault._cache["data"] = None
r = server.resume_budget("2026-03")
assert "erreur" in r and "400" in r["erreur"], r
print("OK  mauvais mot de passe :", r["erreur"][:70])

os.environ["SUPABASE_URL"] = "http://127.0.0.1:9"; vault._cache["data"] = None
Path(os.environ["BUDGET_DATA_DIR"], "budget-2026-03-31.json").write_text(json.dumps(ts.BUDGET))
r = server.resume_budget("2026-03")
assert r["solde"] == 1452.5 and "FICHIERS" in r["source"], r
print("OK  repli sur fichiers, signalé :", r["source"][:60])
print("\nTous les tests passent.")
