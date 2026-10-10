# Budget & Patrimoine

PWA (HTML/CSS/JS vanilla, sans build) qui réunit :

- **Patrimoine** : comptes saisis à la main + valeur du PEA, répartition.
- **Budget** : import d'exports bancaires CSV, catégorisation automatique, revenus / dépenses / taux d'épargne par mois, graphique sur 12 mois, détail par catégorie.
- **PEA** (onglets Bilan, Achats, Simu, PEA) : copie du « Suivi PEA » d'origine (DCA, PRU, plus-value, simulateur, cours Euronext).

Les données restent **dans le navigateur** (localStorage). Export / import JSON pour sauvegarder ou changer d'appareil.
L'appli d'origine (`suivie-pea`) n'est pas modifiée : cette copie utilise d'autres clés de stockage.

## Confidentialité (dépôt public)

Le code est public, les données ne le sont jamais :

- transactions, soldes et achats vivent uniquement dans le navigateur ;
- ne commitez ni CSV bancaire, ni export JSON, ni règles personnelles (le `.gitignore` les exclut) ;
- les règles de catégorisation **personnelles** (noms de commerçants, de personnes) s'importent depuis un fichier `regles-*.json` gardé à part (Budget → Règles de catégorisation). Le code ne contient que des règles génériques (un test le vérifie).

## Fichiers

| Fichier | Rôle |
|---|---|
| `budget.js` | Module Budget : CSV, catégories, synthèses, stockage, onglets Patrimoine et Budget |
| `app.js` | Partie PEA (calculs, cours, graphiques, interface) |
| `index.html`, `style.css` | Structure (6 onglets) et thème sombre/clair, mobile-first |
| `sw.js` | Service worker (hors ligne) |
| `tests/` | `node --test tests/*.test.js` |
| `tools/`, `.github/workflows/` | Cours des ETF (GitHub Action) et diagnostics, hérités du Suivi PEA |

## Import d'un export bancaire

1. Onglet **Budget** → « Importer un export bancaire (CSV) ».
2. L'appli détecte l'encodage, le séparateur, la ligne d'en-tête et les colonnes (date, libellé, montant ou débit/crédit). Corrigez si besoin dans la fenêtre d'aperçu.
3. Les doublons déjà importés sont ignorés (un ré-import est sans risque). Les lignes illisibles sont comptées, jamais importées en silence.
4. Une transaction non reconnue apparaît « À catégoriser » : choisissez une catégorie, l'appli propose de retenir la règle.

## Mettre à jour l'appli

Incrémentez la version dans `app.js` (`APP_VERSION`), `sw.js` (`VERSION`) **et** dans les `?v=` d'`index.html` (les tests vérifient qu'elles concordent).

## Synchronisation entre appareils (étape suivante)

Prévue en dernier : Supabase avec chiffrement côté client. En attendant : export JSON dans iCloud Drive, import sur l'autre appareil.
