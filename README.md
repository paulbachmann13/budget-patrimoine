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
| `sync.js` | Synchronisation chiffrée (Supabase) et sauvegarde chiffrée |
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

## Synchronisation entre appareils (Supabase, chiffrée)

- `sync.js` : tout est chiffré **dans le navigateur** (AES-GCM 256, clé dérivée de la phrase de chiffrement par PBKDF2, 600 000 itérations) avant l'envoi. Supabase ne stocke qu'une ligne illisible par utilisateur (table `vault`, RLS).
- La phrase n'est jamais envoyée ni enregistrée ; la clé dérivée reste sur l'appareil (IndexedDB, non exportable). **Phrase perdue = données synchronisées perdues** (les données locales restent).
- Fusion à trois (appareil / serveur / dernière synchro) : ajouts et suppressions faits sur deux appareils ne s'écrasent pas ; contrôle de version côté serveur (`rev`).
- Secours : « Exporter une sauvegarde chiffrée » (fichier autonome, même format de chiffrement).

Mise en place (une fois) :
1. Projet Supabase gratuit → SQL Editor → coller et exécuter `supabase/setup.sql`.
2. Authentication → Sign In / Providers : **désactiver les inscriptions** ; Users → *Add user* (e-mail + mot de passe).
3. Reporter l'URL du projet et la clé *publishable / anon* dans `SUPABASE` en haut de `sync.js` (jamais la clé *secret / service_role*).
4. Le projet gratuit se met en pause après 7 jours sans activité : la GitHub Action `keepalive.yml` l'appelle tous les 3 jours.
