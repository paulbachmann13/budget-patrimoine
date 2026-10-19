"""Écriture PEA : faux Supabase local + vérification avec le vrai sync.js. Lancer : .venv/bin/python tests/test_write.py"""
import json, os, subprocess, sys, tempfile, threading, copy
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import test_server as ts  # noqa: E402

PASS = "phrase fictive é de test"
def node(mode, obj):
    r = subprocess.run(["node", str(HERE / "node_check.js"), PASS, mode], input=json.dumps(obj), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)

row = json.loads(subprocess.run(["node", str(HERE / "make_vault.js"), PASS], input=json.dumps({"budget": ts.BUDGET, "pea": ts.PEA}),
                                capture_output=True, text=True, check=True).stdout)
state = {"row": row, "conflict_next": False}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self._send(200, {"access_token": "tok", "expires_at": 9999999999, "user": {"id": "uid-1"}})
    def do_GET(self): self._send(200, [state["row"]])
    def do_PATCH(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        want = int(self.path.split("rev=eq.")[1])
        if state["conflict_next"]:  # un autre appareil écrit juste avant nous
            state["row"] = {**state["row"], "rev": state["row"]["rev"] + 1}; state["conflict_next"] = False
        if state["row"]["rev"] != want: return self._send(200, [])
        state["row"] = {**state["row"], **{k: body[k] for k in ("iv", "data", "rev")}}
        self._send(200, [state["row"]])


srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
tmp = tempfile.mkdtemp()
os.environ.update(SUPABASE_URL=f"http://127.0.0.1:{srv.server_port}", SUPABASE_KEY="pk", SUPABASE_EMAIL="a@b.test",
                  SUPABASE_PASSWORD="x", SUPABASE_PASSPHRASE=PASS, BUDGET_DATA_DIR=tmp)
import vault, server  # noqa: E402
vault.KEYCHAIN_SERVICE = "service-inexistant-test"

def fresh(): vault._cache["data"] = None

# 1. aperçu : rien n'est écrit
fresh(); p = server.proposer_achat(ticker="dcam.pa", quantite=2, prix=130, date_achat="2026-03-02", frais=1.5)
assert "code_confirmation" in p and p["a_ajouter"]["ticker"] == "DCAM", p
assert state["row"]["rev"] == 3 and not Path(tmp, "sauvegardes").exists(), "l'aperçu ne doit rien écrire"
print("OK  aperçu sans écriture :", p["position_apres"], "| liquidités", p["avant"]["liquidites"], "→", p["apres"]["liquidites"])

# 2. mauvais code / confirmation
assert "erreur" in server.confirmer_ajout("zzzzzz")
res = server.confirmer_ajout(p["code_confirmation"])
assert res.get("version") == 4, res
print("OK  écrit :", res["ecrit"]["type"], "| sauvegarde", res["sauvegarde_avant"])
assert "erreur" in server.confirmer_ajout(p["code_confirmation"]), "un code ne sert qu'une fois"

# 3. le vrai sync.js relit le coffre ; le reste est intact
new = node("row", state["row"])
assert len(new["pea"]["purchases"]) == 3 and new["pea"]["purchases"][-1]["ticker"] == "DCAM"
assert new["budget"] == ts.BUDGET and new["pea"]["sales"] == ts.PEA["sales"], "budget et reste du PEA inchangés"
print("OK  sync.js déchiffre le coffre modifié ; budget et reste du PEA intacts")

# 4. la fusion de l'appli adopte l'ajout (appareil non modifié)
old = {"budget": ts.BUDGET, "pea": ts.PEA}
merged = node("merge", {"base": old, "local": old, "remote": new})
assert len(merged["pea"]["purchases"]) == 3
print("OK  SyncCore.merge de l'appli récupère le nouvel achat")

# 5. la sauvegarde d'avant s'importe dans l'appli et contient l'ancien état
bk = next(Path(tmp, "sauvegardes").glob("coffre-*.json"))
assert node("envelope", json.loads(bk.read_text()))["pea"]["purchases"].__len__() == 2
assert oct(bk.stat().st_mode)[-3:] == "600"
print("OK  sauvegarde = ancien état, importable par l'appli (openEnvelope), droits 600")

# 6. doublon, vente trop grosse, date future, ticker/ISIN
fresh(); assert "doublon" in server.proposer_achat(ticker="DCAM", quantite=2, prix=130, date_achat="2026-03-02", frais=1.5)["erreur"].lower()
assert "Vente impossible" in server.proposer_vente(ticker="DCAM", quantite=999, prix=1)["erreur"]
assert "futur" in server.proposer_achat(ticker="DCAM", quantite=1, prix=1, date_achat="2999-01-01")["erreur"]
assert "ticker" in server.proposer_achat(isin="XX0000000000", quantite=1, prix=1)["erreur"].lower()
assert server.proposer_achat(isin="FR001400U5Q4", quantite=1, prix=1)["a_ajouter"]["ticker"] == "DCAM"
assert "erreur" in server.proposer_achat(ticker="DCAM", quantite=-1, prix=10)
assert "erreur" in server.proposer_achat(ticker="DCAM", quantite="abc", prix=10)
print("OK  doublon / vente excessive / date future / ISIN / valeurs invalides refusés")

# 7. conflit : un autre appareil écrit entre lecture et écriture → rien d'écrit
fresh(); q = server.proposer_versement(montant=100, date_versement="2026-03-03")
state["conflict_next"] = True; rev_before = state["row"]["rev"]
r = server.confirmer_ajout(q["code_confirmation"])
assert "autre appareil" in r["erreur"] and state["row"]["rev"] == rev_before + 1
assert len(node("row", state["row"])["pea"]["deposits"]) == 1
print("OK  conflit de version : écriture annulée, coffre intact")

# 8. vente valide + liquidités négatives signalées
fresh(); v = server.proposer_versement(montant=100)  # sert juste à tester que ça répond
fresh(); a = server.proposer_achat(ticker="DCAM", quantite=100, prix=100)
assert any("négatives" in w for w in a["avertissements"]), a
print("OK  avertissement liquidités négatives")
print("\nTous les tests passent.")
