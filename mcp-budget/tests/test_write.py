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
# 9. régularisation : +2,20 € d'espèces, hors plafond ; écrite puis relue par le vrai sync.js
fresh(); before = server.valeur_pea()
m = server.proposer_mouvement("Régularisation", 2.2, "2026-03-04")
assert m["a_ajouter"]["kind"] == "credit" and abs(m["apres"]["liquidites"] - m["avant"]["liquidites"] - 2.2) < 0.001, m
r = server.confirmer_ajout(m["code_confirmation"]); assert r.get("version"), r
mv = node("row", state["row"])["pea"]["moves"]
assert mv[-1]["kind"] == "credit" and mv[-1]["amount"] == 2.2
fresh(); after = server.valeur_pea()
assert abs(after["liquidites"] - before["liquidites"] - 2.2) < 0.001 and after["versements_total"] == before["versements_total"]
for bad in (("truc", 1), ("frais", -1), ("dividende", 1)):
    assert "erreur" in server.proposer_mouvement(*bad), bad
fresh(); assert "doublon" in server.proposer_mouvement("credit", 2.2, "2026-03-04")["erreur"].lower()
print("OK  régularisation : espèces +2,20 €, versements/plafond inchangés, relue par sync.js")

# 10. modification d'une ligne existante (aperçu, écriture, relecture par sync.js, garde-fous)
fresh(); ops = server.lister_operations_pea()["operations"]
reg = next(o for o in ops if o["type"] == "mouvement"); ach = next(o for o in ops if o["id"] == "p1")
fresh(); before = server.valeur_pea(); rev0 = state["row"]["rev"]
m = server.proposer_modification(reg["id"], date="2026-03-03")
assert m["operation"]["avant"]["date"] == "2026-03-04" and m["operation"]["apres"]["date"] == "2026-03-03", m
assert state["row"]["rev"] == rev0, "l'aperçu ne doit rien écrire"
r = server.confirmer_modification(m["code_confirmation"]); assert r.get("version") == rev0 + 1, r
mv = node("row", state["row"])["pea"]["moves"]
assert [x for x in mv if x["id"] == reg["id"]][0]["date"] == "2026-03-03" and len(mv) == 1
assert "erreur" in server.confirmer_modification(m["code_confirmation"]), "un code ne sert qu'une fois"
fresh(); assert abs(server.valeur_pea()["liquidites"] - before["liquidites"]) < 1e-9, "changer une date ne change pas les espèces"
fresh(); m2 = server.proposer_modification("p1", prix=101, frais=2.5)
assert abs((m2["apres"]["liquidites"] - m2["avant"]["liquidites"]) - (-(1 * 10) + 2.5)) < 0.001, m2
server.confirmer_modification(m2["code_confirmation"])
pa = node("row", state["row"])["pea"]["purchases"]; assert [x for x in pa if x["id"] == "p1"][0]["price"] == 101
fresh(); assert "erreur" in server.proposer_modification("inconnu", date="2026-03-01")
fresh(); assert "erreur" in server.proposer_modification("p1", date="2026-03-01", montant=5), "champ hors type"
fresh(); assert "erreur" in server.proposer_modification("p1"), "aucun changement"
fresh(); assert "erreur" in server.proposer_modification("p1", prix=101), "valeur identique"
fresh(); assert "erreur" in server.proposer_modification("s1", quantite=999), "vente excessive"
fresh(); assert "erreur" in server.proposer_modification("p1", date="2999-01-01")
fresh(); m3 = server.proposer_modification("p2", frais=9)
fresh(); m4 = server.proposer_modification("p2", frais=7); server.confirmer_modification(m4["code_confirmation"])
fresh(); assert "modifiée entre-temps" in server.confirmer_modification(m3["code_confirmation"])["erreur"]
print("OK  modification : aperçu, écriture, relue par sync.js, garde-fous (id, champ, vente, date, ligne changée)")

# 11. import d'un CSV bancaire : aperçu sans écriture, écriture, relecture par sync.js, doublons, garde-fous
csv_path = Path(tmp) / "export-banque.csv"
csv_path.write_text("Date;Libellé;Débit euros;Crédit euros\n12/03/2026;PAIEMENT PAR CARTE X1234 CARREFOUR MARKET 12/03;42,10;\n"
                    "13/03/2026;WINAMAX PARIS;10,00;\n14/03/2026;VIREMENT EN VOTRE FAVEUR M DUPONT;;100,00\n15/03/2026;TRUC INCONNU;5,00;\n"
                    "03/03/2026;CARREFOUR MARKET;85,50;\n", encoding="utf-8")
fresh(); n0 = len(ts.BUDGET["transactions"]); rev0 = state["row"]["rev"]
c = server.proposer_import_csv(chemin_fichier=str(csv_path))
assert c["lignes_lues"] == 5 and c["nouvelles"] == 4 and c["deja_presentes"] == 1, c
assert c["a_categoriser"]["nombre"] == 1 and "Jeux d'argent" in c["par_categorie"] and c["periode"] == ["2026-03-12", "2026-03-15"], c
assert state["row"]["rev"] == rev0, "l'aperçu ne doit rien écrire"
r = server.confirmer_import_csv(c["code_confirmation"]); assert r.get("importees") == 4 and r.get("version") == rev0 + 1, r
bud = node("row", state["row"])["budget"]
assert len(bud["transactions"]) == n0 + 4 and bud["lastImport"] and len({t["id"] for t in bud["transactions"]}) == n0 + 4
new = [t for t in bud["transactions"] if t["date"] >= "2026-03-12"]
assert {t["label"]: t["category"] for t in new}["WINAMAX PARIS"] == "Jeux d'argent" and all(t["manual"] is False for t in new)
assert "erreur" in server.confirmer_import_csv(c["code_confirmation"]), "un code ne sert qu'une fois"
fresh(); assert "déjà dans l'appli" in server.proposer_import_csv(chemin_fichier=str(csv_path))["erreur"], "réimport = rien à faire"
bad = Path(tmp) / "x.pdf"; bad.write_text("x")
fresh(); assert "erreur" in server.proposer_import_csv(chemin_fichier=str(bad)) and "erreur" in server.proposer_import_csv(chemin_fichier="/inexistant.csv")
fresh(); assert "erreur" in server.proposer_import_csv()
fresh(); assert "inexistante" in server.proposer_import_csv(contenu_csv="a;b\n1;2\n", colonne_date=9)["erreur"]
# colonnes forcées + texte collé
fresh(); c2 = server.proposer_import_csv(contenu_csv="x;y;z\n20/03/2026;-7,5;BOULANGERIE PAUL\n", colonne_date=1, colonne_montant=2, colonne_libelle=3)
assert c2["nouvelles"] == 1 and c2["par_categorie"].get("Alimentation & restauration"), c2
# doublon survenu entre l'aperçu et l'écriture (autre import) : refusé
server.confirmer_import_csv(c2["code_confirmation"])
fresh(); c3 = server.proposer_import_csv(contenu_csv="Date;Libellé;Montant\n21/03/2026;CAFE DU PORT;-3\n")
fresh(); c4 = server.proposer_import_csv(contenu_csv="Date;Libellé;Montant\n21/03/2026;CAFE DU PORT;-3\n"); server.confirmer_import_csv(c4["code_confirmation"])
fresh(); assert "déjà présent" in server.confirmer_import_csv(c3["code_confirmation"])["erreur"]
# multiplicité : 2 lignes identiques dans le CSV dont 1 déjà dans l'appli → 1 seule nouvelle, bien écrite
fresh(); c5 = server.proposer_import_csv(contenu_csv="Date;Libellé;Montant\n03/03/2026;CARREFOUR MARKET;-85,50\n03/03/2026;CARREFOUR MARKET;-85,50\n")
assert c5["nouvelles"] == 1 and c5["deja_presentes"] == 1, c5
nb = len(node("row", state["row"])["budget"]["transactions"])
assert server.confirmer_import_csv(c5["code_confirmation"]).get("importees") == 1
assert len(node("row", state["row"])["budget"]["transactions"]) == nb + 1
link = Path(tmp) / "lien.csv"; link.symlink_to(csv_path)
fresh(); assert "symboliques" in server.proposer_import_csv(chemin_fichier=str(link))["erreur"]
print("OK  import CSV : aperçu, écriture, relue par sync.js, doublons, colonnes forcées, garde-fous")

# 12. catégories des opérations : aperçu, écriture, règle, catégorie nouvelle, garde-fous
fresh(); lc = server.lister_categories(); assert lc["categories"] and "regles_personnelles" in lc, lc
fresh(); r1 = server.rechercher_operations(texte="mystere"); oid = r1["operations"][0]["id"]; assert oid, r1
fresh(); rev0 = state["row"]["rev"]
m = server.proposer_recategorisation("Logement & factures", ids=[oid])
assert m["operations_a_changer"] == 1 and m["exemples"][0]["avant"] == "À catégoriser" and state["row"]["rev"] == rev0, m
assert "2026-03" in m["effet_par_mois"] and m["effet_par_mois"]["2026-03"]["apres"]["operations_a_categoriser"] == m["effet_par_mois"]["2026-03"]["avant"]["operations_a_categoriser"] - 1, m
r = server.confirmer_recategorisation(m["code_confirmation"]); assert r.get("operations_changees") == 1 and r.get("version") == rev0 + 1, r
t = [x for x in node("row", state["row"])["budget"]["transactions"] if x["id"] == oid][0]
assert t["category"] == "Logement & factures" and t["manual"] is True and t["amount"] == -12
assert "erreur" in server.confirmer_recategorisation(m["code_confirmation"]), "un code ne sert qu'une fois"
# nouvelle catégorie + règle, par filtre de texte
fresh(); assert "type_nouvelle_categorie" in server.proposer_recategorisation("Sorties", texte="carrefour")["erreur"]
fresh(); assert "alimentation" in server.proposer_recategorisation("alimentation & restauration", texte="carrefour")["erreur"].lower()
fresh(); m2 = server.proposer_recategorisation("Courses bio", texte="carrefour", creer_regle=True, type_nouvelle_categorie="depense")
assert m2["operations_a_changer"] >= 2 and m2["nouvelle_categorie_creee"] == "depense" and m2["regle_retenue"]["match"] == "carrefour" and m2["regle_retenue"]["sign"] == "out", m2
server.confirmer_recategorisation(m2["code_confirmation"])
bud = node("row", state["row"])["budget"]
assert {"name": "Courses bio", "kind": "depense"} in bud["categories"] and bud["rules"][0] == {"match": "carrefour", "category": "Courses bio", "sign": "out"}
assert all(x["category"] == "Courses bio" for x in bud["transactions"] if "carrefour" in x["label"].lower() and x["date"] < "2026-03-12")
fresh(); assert "Rien à changer" in server.proposer_recategorisation("Courses bio", texte="carrefour")["erreur"]
fresh(); assert "critère" in server.proposer_recategorisation("Courses bio")["erreur"], "jamais tout le budget d'un coup"
fresh(); assert "erreur" in server.proposer_recategorisation("Courses bio", ids=["inconnu"])
fresh(); assert "3 caractères" in server.proposer_recategorisation("Courses bio", texte="x", creer_regle=True)["erreur"]
# l'opération a changé entre l'aperçu et l'écriture : refusé
fresh(); a = server.proposer_recategorisation("Épargne / placements", texte="loyer")
fresh(); b2 = server.proposer_recategorisation("Aide famille", texte="loyer"); server.confirmer_recategorisation(b2["code_confirmation"])
fresh(); assert "modifiée entre-temps" in server.confirmer_recategorisation(a["code_confirmation"])["erreur"]
# garde-fous issus de la relecture : texte vide, ids + filtres, règle vers « À catégoriser », remise en « À catégoriser »
fresh(); assert "caractère utile" in server.proposer_recategorisation("Courses bio", texte="§§ ")["erreur"]
fresh(); assert "pas les deux" in server.proposer_recategorisation("Courses bio", ids=[oid], texte="loyer")["erreur"]
fresh(); assert "n'a pas de sens" in server.proposer_recategorisation("À catégoriser", texte="carrefour", creer_regle=True)["erreur"]
fresh(); u = server.proposer_recategorisation("À catégoriser", ids=[oid]); server.confirmer_recategorisation(u["code_confirmation"])
t = [x for x in node("row", state["row"])["budget"]["transactions"] if x["id"] == oid][0]
assert t["category"] == "À catégoriser" and t["manual"] is True, "comme setCategory de l'appli : choisie à la main"
# règle existante (même texte et même signe) : mise à jour, pas de doublon
fresh(); m5 = server.proposer_recategorisation("Alimentation & restauration", texte="carrefour", creer_regle=True)
server.confirmer_recategorisation(m5["code_confirmation"])
rules = node("row", state["row"])["budget"]["rules"]
assert [r["category"] for r in rules if r["match"] == "carrefour"] == ["Alimentation & restauration"], rules
print("OK  catégories : aperçu, écriture, règle, nouvelle catégorie, garde-fous, conflit")
print("\nTous les tests passent.")
