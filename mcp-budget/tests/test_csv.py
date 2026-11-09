"""Import CSV : compare bank_csv.py au VRAI budget.js (même résultat que le bouton d'import de l'appli).
Lancer : .venv/bin/python tests/test_csv.py"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import bank_csv as b  # noqa: E402

EXISTING = [{"date": "2026-03-03", "label": "PAIEMENT PAR CARTE X1234 CARREFOUR MARKET 03/03", "amount": -85.5},
            {"date": "2026-03-05", "label": "LOYER", "amount": -600}]
USER_RULES = [{"match": "mystere", "category": "Shopping"}, {"match": "aide parents", "category": "Aide famille", "sign": "in"}]

CASES = {
    # style Crédit Agricole : ; , débit / crédit séparés, virgule décimale, en-tête précédé de lignes de titre
    "ca_debit_credit": ("Compte;Courant\nExport du 01/03/2026\nDate;Libellé;Débit euros;Crédit euros;\n"
                        "03/03/2026;PAIEMENT PAR CARTE X1234 CARREFOUR MARKET 03/03;85,50;;\n"
                        "05/03/2026;LOYER;600,00;;\n06/03/2026;VIREMENT EN VOTRE FAVEUR M DUPONT;;150,00;\n"
                        "07/03/2026;WINAMAX PARIS;12,30;;\n07/03/2026;WINAMAX PARIS;12,30;;\n08/03/2026;TRUC INCONNU;3,00;;\nligne;cassée\n", "utf-8"),
    # style banque en ligne : montant signé, date de valeur à côté, guillemets, milliers à espace
    "montant_signe": ('dateOp;dateVal;label;category;amount;accountNum\n2026-03-01;2026-03-01;"VIR SALAIRE ""ACME"" SAS";Salaire;"2 000,00";123\n'
                      '2026-03-02;2026-03-03;"NETFLIX.COM";Abonnements;-13,49;123\n2026-03-04;2026-03-04;MYSTERE SARL;Autre;-12;123\n', "utf-8"),
    # anglais : virgule, point décimal, dates JJ/MM/AA, montant à signe final
    "anglais": ("Date,Description,Amount\n03/03/26,Spotify AB,-9.99\n04/03/26,Refund Amazon,25.00\n05/03/26,Café du coin,(4.50)\n06/03/26,Parking,12.30-\n", "utf-8"),
    # sans en-tête, tabulation
    "sans_entete": ("03/03/2026\tESSO STATION\t-45,20\n04/03/2026\tESPRESSO BAR\t-2,50\n05/03/2026\tSALAIRE MARS\t1800,00\n", "utf-8"),
    # Windows-1252 (accents)
    "cp1252": ("Date;Libellé;Montant\n03/03/2026;PHARMACIE DE L'ÉGLISE;-8,90\n04/03/2026;BOULANGERIE CAFÉ;-3,20\n", "cp1252"),
}

tmp = Path(tempfile.mkdtemp())
ex, ru = tmp / "existing.json", tmp / "rules.json"
ex.write_text(json.dumps(EXISTING)); ru.write_text(json.dumps(USER_RULES))
default_ok = False
for name, (text, enc) in CASES.items():
    f = tmp / f"{name}.csv"; f.write_bytes(text.encode(enc))
    js = json.loads(subprocess.run(["node", str(HERE / "csv_check.js"), str(f), str(ru), str(ex)], capture_output=True, text=True, check=True).stdout)
    if not default_ok:
        assert js["defaults"] == b.DEFAULT_RULES, "default_rules.json n'est plus à jour : regénérez-le depuis budget.js (voir README)"
        default_ok = True
    rows, delim = b.parse_csv(b.decode(f.read_bytes()))
    det = b.detect_columns(rows)
    assert delim == js["delimiter"], (name, delim, js["delimiter"])
    assert det["header_row"] == js["headerRow"] and det["cols"] == js["cols"] and det["headers"] == js["headers"], (name, det, js)
    txs, skipped = b.extract_transactions(rows, det["header_row"], det["cols"])
    assert txs == js["transactions"] and skipped == js["skipped"], (name, txs, js["transactions"])
    fresh, dups = b.dedupe(EXISTING, txs)
    assert fresh == js["fresh"] and dups == js["dups"], (name, "doublons")
    cats = [b.categorize(t, USER_RULES) for t in fresh]
    assert cats == js["cats"], (name, cats, js["cats"])
    print(f"OK  {name:16} → {len(txs)} lignes, {len(fresh)} nouvelles, {len(dups)} doublons, illisibles {skipped}, catégories {sorted(set(cats))}")
print("\nbank_csv.py = budget.js sur tous les cas.")
