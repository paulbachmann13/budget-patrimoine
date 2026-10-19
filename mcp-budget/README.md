# mcp-budget — serveur MCP local (lecture seule)

Permet à Claude de lire vos exports « Budget & Patrimoine » sans captures d'écran.
Aucune donnée dans le code ; le serveur ne fait que lire.

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

## Outils
`etat_donnees`, `resume_budget`, `depenses_par_categorie`, `rechercher_operations`, `plafonds_budget`, `valeur_pea`, `patrimoine_total`.
