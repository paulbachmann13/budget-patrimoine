# Budget & Patrimoine

PWA (HTML/CSS/JS vanilla, sans build, hébergée sur GitHub Pages) qui réunit :

- **Patrimoine** : comptes saisis à la main (regroupés par banque) + PEA calculé automatiquement ; argent **disponible maintenant / bloqué** (PEL, CEL, PEA avant 5 ans…) avec dates de déblocage ; courbe du patrimoine mois par mois.
- **Budget** : import d'exports bancaires CSV (format Crédit Agricole reconnu), libellés lisibles, catégorisation automatique, revenus / dépenses / taux d'épargne (aide reçue affichée à part), plafonds par catégorie, évolution d'une catégorie sur 12 mois, **abonnements et prélèvements détectés**, **fin de mois estimée**, **récap du mois**, rappels (import, sauvegarde).
- **PEA** (onglets Bilan, Achats, Simu, PEA) : achats et **ventes au PRU**, versements, régularisations, frais, retraits, bilan d'une position (gain, rendement annualisé, graphique), compteur des 5 ans, plafond, simulateur (projection ou objectif, fourchette pessimiste/optimiste, net de prélèvements sociaux, en euros d'aujourd'hui), cours Euronext.
- **Synchronisation chiffrée** entre appareils (Supabase) et **verrouillage** par code + Face ID / Touch ID.

Les données restent **dans le navigateur** (localStorage) ; elles ne quittent l'appareil que chiffrées.

## Confidentialité (dépôt public)

Le code est public, les données ne le sont jamais :

- transactions, soldes et achats vivent uniquement dans le navigateur (et chiffrés sur Supabase si la synchro est active) ;
- ne commitez ni CSV bancaire, ni export JSON, ni règles personnelles (le `.gitignore` les exclut) ;
- les règles de catégorisation **personnelles** (noms de commerçants, de personnes) s'importent depuis un fichier `regles-*.json` gardé à part (Budget → Règles de catégorisation). Le code ne contient que des règles génériques : un test le vérifie (empreintes des noms interdits, et règles locales de `regles-perso.json` si le fichier est présent, hors dépôt).

## Fichiers

| Fichier | Rôle |
|---|---|
| `budget.js` | Budget et Patrimoine : CSV, catégories, synthèses, plafonds, abonnements, prévision, récap, comptes, disponibilité |
| `app.js` | Partie PEA : calculs (PRU, ventes, liquidités, bilans, TRI), cours, graphiques, interface |
| `sync.js` | Synchronisation chiffrée (Supabase), sauvegarde chiffrée, fusion à trois |
| `lock.js` | Verrouillage : code (empreinte PBKDF2) et Face ID / Touch ID (WebAuthn) |
| `index.html`, `style.css` | Structure (6 onglets) et thème sombre/clair, mobile-first |
| `sw.js` | Service worker (hors ligne) |
| `supabase/setup.sql` | Table `vault` + RLS, fonction `ping()` |
| `tests/` | `node --test tests/*.test.js` |
| `tools/`, `.github/workflows/` | Cours des ETF (GitHub Action), diagnostics, réveil Supabase (`keepalive.yml`) |

## Import d'un export bancaire

1. Onglet **Budget** → « Importer un export bancaire (CSV) ». Au Crédit Agricole : export CSV « Depuis le dernier téléchargement ».
2. L'appli détecte l'encodage, le séparateur, la ligne d'en-tête et les colonnes (date, libellé, montant ou débit/crédit). Corrigez si besoin dans la fenêtre d'aperçu.
3. Les doublons déjà importés sont ignorés (un ré-import est sans risque). Les lignes illisibles sont comptées, jamais importées en silence.
4. Une transaction non reconnue apparaît « À catégoriser » : choisissez une catégorie, l'appli propose de retenir la règle.

## Mettre à jour l'appli

Incrémentez la version dans `app.js` (`APP_VERSION`), `sw.js` (`VERSION`) **et** dans les `?v=` d'`index.html` (les tests vérifient qu'elles concordent). Ordre de chargement : `budget.js`, `app.js`, `sync.js`, `lock.js`.

## Synchronisation entre appareils (Supabase, chiffrée)

- `sync.js` : tout est chiffré **dans le navigateur** (AES-GCM 256, clé dérivée de la phrase de chiffrement par PBKDF2, 600 000 itérations) avant l'envoi. Supabase ne stocke qu'une ligne illisible par utilisateur (table `vault`, RLS).
- La phrase n'est jamais envoyée ni enregistrée ; la clé dérivée reste sur l'appareil (IndexedDB, non exportable). **Phrase perdue = données synchronisées perdues** (les données locales restent).
- Fusion à trois (appareil / serveur / dernière synchro) : ajouts et suppressions faits sur deux appareils ne s'écrasent pas ; contrôle de version côté serveur (`rev`). Le bouton ↻ en haut synchronise aussi.
- Secours : « Exporter une sauvegarde chiffrée » (fichier autonome, même format de chiffrement).

Mise en place (une fois) :
1. Projet Supabase gratuit → SQL Editor → coller et exécuter `supabase/setup.sql`.
2. Authentication → Sign In / Providers : **désactiver les inscriptions** ; Users → *Add user* (e-mail + mot de passe).
3. Reporter l'URL du projet et la clé *publishable / anon* dans `SUPABASE` en haut de `sync.js` (jamais la clé *secret / service_role*).
4. Le projet gratuit se met en pause après 7 jours sans activité : la GitHub Action `keepalive.yml` l'appelle tous les 3 jours.

## Verrouillage

Réglage propre à chaque appareil (Patrimoine → Verrouillage) : code de 4 à 6 chiffres (seule son empreinte est stockée, attente croissante après 5 erreurs), Face ID / Touch ID via une passkey de l'appareil, délai de reverrouillage en arrière-plan. C'est un verrou d'accès : les données ne sont pas chiffrées davantage sur l'appareil. « Code oublié » efface les données de l'appareil ; elles reviennent par la synchronisation.
