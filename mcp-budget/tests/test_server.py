"""Test avec un jeu de données fictif. Lancer : .venv/bin/python tests/test_server.py"""
import json, os, sys, tempfile, asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BUDGET = {
    "transactions": [
        {"id": "1", "date": "2026-03-01", "label": "VIREMENT SALAIRE ACME", "amount": 2000, "category": "Salaire"},
        {"id": "2", "date": "2026-03-03", "label": "CARREFOUR MARKET", "amount": -85.5, "category": "Alimentation & restauration"},
        {"id": "3", "date": "2026-03-05", "label": "LOYER", "amount": -600, "category": "Logement & factures"},
        {"id": "4", "date": "2026-03-06", "label": "VIR LIVRET A", "amount": -200, "category": "Épargne / placements"},
        {"id": "5", "date": "2026-03-09", "label": "MYSTERE SARL", "amount": -12, "category": "À catégoriser"},
        {"id": "6", "date": "2026-03-10", "label": "AIDE PARENTS", "amount": 150, "category": "Aide famille"},
        {"id": "7", "date": "2026-02-15", "label": "CARREFOUR CITY", "amount": -40, "category": "Alimentation & restauration"},
    ],
    "categories": [{"name": "Salaire", "kind": "revenu"}, {"name": "Alimentation & restauration", "kind": "depense"},
                   {"name": "Logement & factures", "kind": "depense"}, {"name": "Épargne / placements", "kind": "neutre"},
                   {"name": "Aide famille", "kind": "aide"}],
    "budgets": {"Alimentation & restauration": {"limit": 300, "period": "mois"}},
    "accounts": [{"id": "a", "name": "Compte courant", "balance": 1500, "bank": "Banque X"},
                 {"id": "b", "name": "PEL", "balance": 5000, "blocked": True, "until": "2030-01-01"}],
    "assets": [{"id": "v", "name": "Voiture", "kind": "vehicule", "value": 8000, "date": "2026-01-01", "depreciation": 10}],
    "history": [{"month": "2026-02", "cash": 6000, "pea": 900, "total": 6900}],
}
PEA = {
    "purchases": [
        {"id": "p1", "date": "2026-01-10", "ticker": "DCAM", "qty": 10, "price": 100, "fees": 5},
        {"id": "p2", "date": "2026-02-10", "ticker": "DCAM", "qty": 10, "price": 110, "fees": 5},
    ],
    "sales": [{"id": "s1", "date": "2026-02-20", "ticker": "DCAM", "qty": 5, "price": 120, "fees": 1}],
    "deposits": [{"id": "d1", "date": "2026-01-01", "amount": 3000}],
    "moves": [], "prices": {"DCAM": {"price": 125, "date": "2026-03-01"}}, "instruments": {},
}


def approx(a, b):
    assert abs(a - b) < 0.01, f"{a} != {b}"


def main():
    with tempfile.TemporaryDirectory() as d:
        os.environ["BUDGET_DATA_DIR"] = d
        import server

        # fichier absent
        assert "erreur" in server.resume_budget("2026-03"), "dossier vide doit donner une erreur claire"
        print("OK  erreur sans fichier :", server.resume_budget()["erreur"][:60], "...")
        Path(d, "budget-2026-03-31.json").write_text(json.dumps(BUDGET))
        Path(d, "pea-2026-03-31.json").write_text(json.dumps(PEA))

        r = server.resume_budget("2026-03")
        approx(r["revenus"], 2150); approx(r["dont_aide_recue"], 150); approx(r["depenses"], 697.5)
        approx(r["solde"], 1452.5)
        # un virement sortant en catégorie de revenu se compense avec les revenus (règle de l'appli)
        b2 = dict(BUDGET, transactions=BUDGET["transactions"] + [{"id": "9", "date": "2026-03-11", "label": "WERO", "amount": -50, "category": "Salaire"}])
        approx(server._summary(b2, "2026-03")["revenus"], 2100); assert r["operations_a_categoriser"] == 1
        print("OK  resume_budget", r)

        assert "erreur" in server.resume_budget("2025-01") and "2026-02" in server.resume_budget("2025-01")["erreur"]
        assert "erreur" in server.resume_budget("mars")
        print("OK  mois sans données / invalide")

        c = server.depenses_par_categorie("2026-03")
        approx(c["total_depenses"], 697.5); assert c["categories"][0]["categorie"] == "Logement & factures"
        assert c["categories"][1]["reste"] == 214.5
        print("OK  depenses_par_categorie")

        s = server.rechercher_operations("carrefour", "2026-03-01", "2026-03-31")
        assert s["total_trouve"] == 1 and server.rechercher_operations("carrefour")["total_trouve"] == 2
        assert "erreur" in server.rechercher_operations(date_debut="31/03/2026")
        print("OK  rechercher_operations")

        # PEA : coût 1005+1105=2110 pour 20 parts (PRU 105.5) ; vente 5 : coût 527.5, produit 599
        p = server.valeur_pea()
        approx(p["plus_moins_value_realisee"], 599 - 527.5)
        pos = p["positions"][0]
        approx(pos["quantite"], 15); approx(pos["pru"], 105.5); approx(pos["valeur"], 1875)
        approx(p["liquidites"], 3000 + 599 - 2110)
        print("OK  valeur_pea", pos)

        t = server.patrimoine_total()
        approx(t["comptes_disponible"], 1500); approx(t["comptes_bloque"], 5000)
        approx(t["patrimoine_total"], 6500 + p["total_pea"] + t["vehicules"])
        print("OK  patrimoine_total", t["patrimoine_total"])

        # lecture seule : aucun fichier créé/modifié
        assert sorted(x.name for x in Path(d).iterdir()) == ["budget-2026-03-31.json", "pea-2026-03-31.json"]

        # fichier corrompu
        Path(d, "budget-2026-04-01.json").write_text("{pas du json")
        os.utime(Path(d, "budget-2026-04-01.json"), (9999999999, 9999999999))
        assert "erreur" in server.resume_budget() and "Impossible de lire" in server.resume_budget()["erreur"]
        print("OK  fichier corrompu")

        # protocole MCP stdio réel
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        Path(d, "budget-2026-04-01.json").unlink()

        async def run():
            params = StdioServerParameters(command=sys.executable, args=[str(Path(server.__file__))],
                                           env={**os.environ, "BUDGET_DATA_DIR": d})
            async with stdio_client(params) as (rd, wr):
                async with ClientSession(rd, wr) as sess:
                    await sess.initialize()
                    tools = [x.name for x in (await sess.list_tools()).tools]
                    res = await sess.call_tool("resume_budget", {"mois": "2026-03"})
                    return tools, res.content[0].text
        tools, text = asyncio.run(run())
        print("OK  stdio :", tools); assert "1452.5" in text
    print("\nTous les tests passent.")


if __name__ == "__main__":
    main()
