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
`etat_donnees`, `resume_budget`, `depenses_par_categorie`, `rechercher_operations`, `plafonds_budget`, `valeur_pea`, `patrimoine_total` (lecture) ; `proposer_achat`, `proposer_vente`, `proposer_versement`, `confirmer_ajout` (écriture PEA).
