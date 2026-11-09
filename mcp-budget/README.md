# mcp-budget — serveur MCP local (lecture seule)

Permet à Claude de lire vos exports « Budget & Patrimoine » sans captures d'écran.
Aucune donnée dans le code. Lecture seule, sauf l'ajout d'opérations PEA décrit plus bas.

## Source en direct : synchro Supabase (recommandé)
Le serveur lit le coffre chiffré de la synchro (lecture seule, déchiffrement en local), sans export manuel.
Variables : `SUPABASE_URL`, `SUPABASE_KEY` (publiques, voir `sync.js`), `SUPABASE_EMAIL`.
Mot de passe et phrase de chiffrement : trousseau macOS, jamais dans un fichier :

    security add-generic-password -s budget-patrimoine-mcp -a password -w
    security add-generic-password -s budget-patrimoine-mcp -a passphrase -w

Si la synchro est injoignable, le serveur se replie sur les fichiers ci-dessous et le signale (champ `source`).

## Source de secours : fichiers exportés
1. Dans l'appli : Budget → **Exporter** (`budget-AAAA-MM-JJ.json`) et PEA → **Sauvegarder** (`pea-AAAA-MM-JJ.json`).
2. Déposez les fichiers dans `~/Documents/budget-data` (ou le dossier de `BUDGET_DATA_DIR`). Le plus récent est lu.
3. Variables : `BUDGET_DATA_DIR`, ou `BUDGET_FILE` / `PEA_FILE` pour des chemins précis.

## Installation
    /opt/homebrew/bin/python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python tests/test_server.py

## Ajouter une opération PEA (photo → appli)
Envoyez à Claude une photo ou une capture de l'avis d'exécution : il lit titre, quantité, prix, frais, date,
appelle `proposer_achat` (ou `proposer_vente`, `proposer_versement`) et vous montre un récapitulatif.
**Rien n'est écrit** tant que vous n'avez pas dit oui : Claude appelle alors `confirmer_ajout`.

Garde-fous : ajouts uniquement (jamais de modification ni suppression) ; doublons, ventes supérieures aux parts
détenues, dates futures et valeurs invalides refusés ; avertissement si les liquidités deviennent négatives ;
sauvegarde chiffrée avant chaque écriture dans `BUDGET_DATA_DIR/sauvegardes/` (importable dans l'appli :
Patrimoine → Importer une sauvegarde chiffrée) ; écriture avec contrôle de version, annulée si un autre appareil
a écrit entre-temps. L'appli récupère l'ajout à sa prochaine synchro (~1 min). Tests : `tests/test_write.py`.

## Outils
`etat_donnees`, `resume_budget`, `depenses_par_categorie`, `rechercher_operations`, `plafonds_budget`, `valeur_pea`, `patrimoine_total` (lecture) ; `proposer_achat`, `proposer_vente`, `proposer_versement`, `proposer_mouvement` (régularisation, frais, retrait, dividende), `confirmer_ajout` (écriture PEA) ; `lister_operations_pea`, `proposer_modification`, `proposer_import_csv`, `confirmer_import_csv` (import d'un export CSV de la banque dans le budget, comme le bouton de l'appli : colonnes détectées, doublons écartés, catégories d'après vos règles ; aperçu puis confirmation) ; `lister_categories`, `proposer_recategorisation`, `confirmer_recategorisation` (changer la catégorie d'opérations du budget, par identifiants ou par filtres ; option règle personnelle pour les prochains imports ; nouvelle catégorie possible ; aperçu de l'effet sur chaque mois ; jamais tout le budget d'un coup) ; `confirmer_modification` (correction d'une ligne existante du PEA : date, quantité, prix, frais, montant, type ; mêmes garde-fous, jamais de suppression, refusée si elle crée une vente excessive ou si la ligne a changé entre-temps).


## Import d'un CSV bancaire

`proposer_import_csv(chemin_fichier=...)` (ou `contenu_csv=` pour du texte collé) lit l'export de la banque avec **la même logique que le bouton « Importer un CSV » de l'appli** (`bank_csv.py`, port de `budget.js`) : séparateur et colonnes détectés, dates et montants français/anglais, UTF-8 ou Windows-1252, doublons écartés (date + montant + libellé), catégories d'après vos règles puis les règles par défaut. Si la détection échoue, on force les colonnes (`colonne_date`, `colonne_libelle`, `colonne_montant` ou `colonne_debit` + `colonne_credit`, numérotées depuis 1). Rien n'est écrit avant `confirmer_import_csv` ; sauvegarde chiffrée avant écriture, doublons revérifiés au moment d'écrire. Les lignes à « catégoriser » se terminent dans l'appli.

`default_rules.json` est une copie des règles par défaut de `budget.js`. Si on les modifie dans l'appli, le test `tests/test_csv.py` échoue : regénérer avec
`node -e "require('fs').writeFileSync('mcp-budget/default_rules.json', JSON.stringify(require('./budget.js').BudgetCore.DEFAULT_RULES, null, 1))"` (depuis la racine du dépôt).
