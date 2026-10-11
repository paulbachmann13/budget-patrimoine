/* Tests du module Budget — lancer avec : node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BudgetCore: B, BudgetStore } = require('../budget.js');
const { APP_VERSION } = require('../app.js');

test('parseAmount : formats français et anglais', () => {
  assert.equal(B.parseAmount('-1 234,56 €'), -1234.56);
  assert.equal(B.parseAmount('1.234,56'), 1234.56);
  assert.equal(B.parseAmount('1,234.56'), 1234.56);
  assert.equal(B.parseAmount('12.50'), 12.5);
  assert.equal(B.parseAmount('+20,00'), 20);
  assert.equal(B.parseAmount('(15,00)'), -15);
  assert.equal(B.parseAmount('12,30-'), -12.3);
  assert.equal(B.parseAmount('−7,5'), -7.5); // vrai signe moins
  assert.equal(B.parseAmount('1.234.567'), 1234567);
  assert.ok(Number.isNaN(B.parseAmount('')));
  assert.ok(Number.isNaN(B.parseAmount('abc')));
});

test('parseDate : JJ/MM/AAAA, JJ-MM-AA, ISO, dates impossibles', () => {
  assert.equal(B.parseDate('05/03/2026'), '2026-03-05');
  assert.equal(B.parseDate('5-3-26'), '2026-03-05');
  assert.equal(B.parseDate('2026-03-05 14:20:00'), '2026-03-05');
  assert.equal(B.parseDate('31.12.2025'), '2025-12-31');
  assert.equal(B.parseDate('30/02/2026'), null);
  assert.equal(B.parseDate('hier'), null);
});

test('CSV : séparateur détecté, guillemets et virgules dans un libellé', () => {
  const csv = 'Date;Libellé;Montant\n05/03/2026;"CARTE X1234 CARREFOUR; PARIS";-23,40\n06/03/2026;VIR SALAIRE;1 500,00\n';
  const { rows, delimiter } = B.parseCsv(csv);
  assert.equal(delimiter, ';');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'CARTE X1234 CARREFOUR; PARIS');
  assert.equal(B.detectDelimiter('a,b,c\n1,2,3\n4,5,6'), ',');
  assert.equal(B.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('colonnes : montant unique (style BNP / Boursorama)', () => {
  const csv = 'dateOp;dateVal;label;category;amount;accountbalance\n2026-03-05;2026-03-06;CB CARREFOUR;Alimentation;-23,40;1000,00\n2026-03-06;2026-03-06;VIR SALAIRE;Revenus;1500,00;2500,00\n';
  const { rows } = B.parseCsv(csv);
  const { headerRow, cols } = B.detectColumns(rows);
  assert.equal(headerRow, 0);
  assert.equal(cols.date, 0, 'date opération, pas date de valeur');
  assert.equal(cols.label, 2);
  assert.equal(cols.amount, 4);
  const { transactions, skipped } = B.extractTransactions(rows, headerRow, cols);
  assert.equal(skipped.length, 0);
  assert.deepEqual(transactions.map((t) => t.amount), [-23.4, 1500]);
});

test('colonnes : débit / crédit séparés, lignes de présentation avant l\'en-tête', () => {
  const csv = 'Compte courant 0001;;;\nExport du 10/10/2026;;;\nDate;Libellé;Débit euros;Crédit euros\n05/03/2026;PRLV EDF;45,10;\n07/03/2026;VIR LYDIA AMI;;12,00\nTotal;;;\n';
  const { rows } = B.parseCsv(csv);
  const { headerRow, cols } = B.detectColumns(rows);
  assert.equal(headerRow, 2);
  const { transactions, skipped } = B.extractTransactions(rows, headerRow, cols);
  assert.deepEqual(transactions.map((t) => t.amount), [-45.1, 12]);
  assert.deepEqual(skipped, [6], 'la ligne « Total » est signalée, pas importée');
});

test('colonnes : sans en-tête, déduites du contenu', () => {
  const csv = '05/03/2026;CB CARREFOUR PARIS;-23,40\n06/03/2026;VIR SALAIRE ENTREPRISE;1500,00\n07/03/2026;PRLV EDF;-45,10\n';
  const { rows } = B.parseCsv(csv);
  const { headerRow, cols } = B.detectColumns(rows);
  assert.equal(headerRow, -1);
  assert.deepEqual([cols.date, cols.label, cols.amount], [0, 1, 2]);
  assert.equal(B.extractTransactions(rows, headerRow, cols).transactions.length, 3);
});

test('catégorisation : règles perso d\'abord, mots entiers, signe', () => {
  const tx = (label, amount) => ({ label, amount });
  assert.equal(B.categorize(tx('CB CARREFOUR MARKET 12/03', -20)), 'Alimentation & restauration');
  assert.equal(B.categorize(tx('UBER EATS PARIS', -15)), 'Alimentation & restauration', 'Uber Eats avant Uber');
  assert.equal(B.categorize(tx('UBER *TRIP', -9)), 'Transport');
  assert.equal(B.categorize(tx('ESPRESSO HOUSE', -3)), B.UNCATEGORIZED, '« esso » ne doit pas attraper « espresso »');
  assert.equal(B.categorize(tx('CB ESSO LYON 4521', -50)), 'Carburant');
  assert.equal(B.categorize(tx('Boutique inconnue', -3)), B.UNCATEGORIZED);
  const mine = [{ match: 'ma salle', category: 'Sport / Loisirs' }, { match: 'lydia', category: 'Remboursement', sign: 'in' }];
  assert.equal(B.categorize(tx('PRLV MA SALLE DE SPORT', -30), mine), 'Sport / Loisirs');
  assert.equal(B.categorize(tx('VIR LYDIA PAUL', 12), mine), 'Remboursement');
  assert.equal(B.categorize(tx('VIR LYDIA PAUL', -12), mine), B.UNCATEGORIZED, 'règle « in » ignorée pour une sortie');
  assert.equal(B.categorize(tx('VIREMENT SALAIRE', 1500)), 'Salaire');
});

test('ruleKey : deux premiers mots utiles', () => {
  assert.equal(B.ruleKey('CARTE X1234 05/03 CARREFOUR MARKET PARIS 15'), 'carrefour market');
  assert.equal(B.ruleKey('PRLV SEPA EDF CLIENTS'), 'edf clients');
});

test('ruleKey : libellés Crédit Agricole (type d\'opération sauté, mots consécutifs)', () => {
  assert.equal(B.ruleKey('Virement en votre faveur DE M. DUPONT JEAN'), 'dupont jean');
  assert.equal(B.ruleKey('Virement émis WEB M. DUPONT JEAN'), 'dupont jean');
  assert.equal(B.ruleKey('Paiement par carte X1234 BOULANGERIE MARTIN 12/05 - Martin'), 'boulangerie martin');
  // « A » (initiale) n'est pas utile : la clé s'arrête à « durand », qui figure bien dans le libellé
  const label = 'Virement émis Wero vers DURAND A - pizza';
  const key = B.ruleKey(label);
  assert.equal(key, 'durand');
  assert.ok(B.normLabel(label).includes(key), 'la clé doit se retrouver dans le libellé');
  assert.equal(B.ruleKey('Cotisation Offre Essentiel'), 'offre essentiel');
  assert.equal(B.ruleKey('Virement en votre faveur'), '');
});

test('import CSV au format Crédit Agricole (préambule, libellés sur plusieurs lignes, débit/crédit)', () => {
  // Données fictives
  const csv = [
    '', 'Téléchargement du 10/10/2026;', '', '', 'M.       DUPONT JEAN',
    'Compte de Dépôt carte n° 00000000000;', 'Solde au 10/10/2026 1 000,00 €', '',
    'Liste des opérations du compte entre le 01/09/2026 et le 10/10/2026;', '',
    'Date;Libellé;Débit euros;Crédit euros;',
    '08/10/2026;"Paiement par carte', 'X1234 CARREFOUR CITY PARIS   07/10 - Carrefour', '', '', '', '";1 234,50;;',
    '07/10/2026;"Virement en votre faveur', 'VIR INST WERO de MARTIN PAUL', '', '', '', '01a1zz";;20,00;',
    '01/10/2026;"Retrait au distributeur', 'X1234 PARIS         30/09 10H00', '', '', '', '";40,00;;',
    '30/09/2026;"Cotisation', 'Offre Essentiel', '', '', '', '";3,00;;',
    '29/09/2026;"Virement en votre faveur', 'Société Exemple - SALARY 09-2026', '', '', '', 'REF123";;1 500,00;',
  ].join('\r\n');
  const { rows, delimiter } = B.parseCsv(csv);
  assert.equal(delimiter, ';');
  const { headerRow, cols } = B.detectColumns(rows);
  assert.deepEqual([cols.date, cols.label, cols.amount, cols.debit, cols.credit], [0, 1, -1, 2, 3]);
  const { transactions: tx, skipped } = B.extractTransactions(rows, headerRow, cols);
  assert.deepEqual(skipped, []);
  assert.deepEqual(tx.map((t) => [t.date, t.amount]), [
    ['2026-10-08', -1234.5], ['2026-10-07', 20], ['2026-10-01', -40], ['2026-09-30', -3], ['2026-09-29', 1500],
  ]);
  assert.equal(tx[0].label, 'Paiement par carte X1234 CARREFOUR CITY PARIS 07/10 - Carrefour', 'libellé sur une seule ligne');
  assert.deepEqual(tx.map((t) => B.categorize(t)), [
    'Alimentation & restauration', 'Virements reçus', 'Espèces', 'Frais bancaires', 'Salaire',
  ]);
});

test('catégories bancaires génériques : jeux, frais, virement reçu en dernier recours', () => {
  const tx = (label, amount) => ({ label, amount });
  assert.equal(B.categorize(tx('Paiement par carte X1234 WINAMAX france PARIS 06/07', -100)), "Jeux d'argent");
  assert.equal(B.categorize(tx('Virement en votre faveur VIR INST de WINAMAX - VOTRE RETRAIT', 100)), "Jeux d'argent", 'un gain réduit la dépense de jeu');
  assert.equal(B.categorize(tx('Virement en votre faveur DE M. DUPONT', 50)), 'Virements reçus');
  assert.equal(B.categorize(tx('Virement en votre faveur DE M. DUPONT', 50), [{ match: 'dupont', category: 'Virement interne' }]), 'Virement interne', 'règle perso avant le dernier recours');
  assert.equal(B.categorize(tx("Versement d'espèces", 100)), 'Virement interne');
  for (const name of ['Espèces', 'Frais bancaires', "Jeux d'argent"]) {
    assert.equal(B.kindOf(name, B.DEFAULT_CATEGORIES), 'depense');
  }
});

test('synthèse mensuelle : revenus, dépenses, net, catégories neutres exclues', () => {
  const cats = B.DEFAULT_CATEGORIES;
  const txs = [
    { date: '2026-03-01', amount: 1500, category: 'Salaire' },
    { date: '2026-03-02', amount: -200, category: 'Alimentation & restauration' },
    { date: '2026-03-03', amount: 20, category: 'Alimentation & restauration' }, // remboursement : réduit la dépense
    { date: '2026-03-04', amount: -300, category: 'Épargne / placements' },      // neutre
    { date: '2026-03-05', amount: -50, category: B.UNCATEGORIZED },
    { date: '2026-04-01', amount: -999, category: 'Shopping' },
  ];
  const s = B.summarizeMonth(txs, '2026-03', cats);
  assert.equal(s.income, 1500);
  assert.equal(s.expense, 230);
  assert.equal(s.net, 1270);
  assert.equal(s.neutralOut, 300);
  assert.ok(Math.abs(s.savingsRate - 1270 / 1500) < 1e-9);
  assert.deepEqual(s.spending.map((c) => [c.name, c.amount]), [['Alimentation & restauration', 180], [B.UNCATEGORIZED, 50]]);
});

test('dédoublonnage : mêmes opérations légitimes conservées, ré-import ignoré', () => {
  const a = { date: '2026-03-05', label: 'CAFE', amount: -2 };
  const existing = [{ ...a }];
  const incoming = [{ ...a }, { ...a }, { date: '2026-03-06', label: 'AUTRE', amount: -5 }];
  const { fresh, dups } = B.dedupe(existing, incoming);
  assert.equal(dups.length, 1, 'la première est déjà là');
  assert.equal(fresh.length, 2, 'le second café du même jour est bien nouveau');
  assert.equal(B.dedupe(fresh.map((t) => ({ ...t })), fresh).fresh.length, 0, 'ré-import identique : rien de neuf');
});

test('mois : liste continue, sans trou', () => {
  assert.deepEqual(B.fillMonths(['2025-11', '2026-02']), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(B.monthsOf([{ date: '2026-03-05' }, { date: '2026-01-01' }, { date: '2026-03-09' }]), ['2026-01', '2026-03']);
});

test('stockage : une ligne abîmée est écartée, le reste est conservé', () => {
  const { state, dropped } = BudgetStore.clean({
    transactions: [
      { id: 'a', date: '2026-03-05', label: 'CAFE', amount: '-2,50', category: 'Bar / Café' },
      { id: 'b', date: '2026-02-30', label: 'IMPOSSIBLE', amount: -1 },
      { id: 'c', date: '2026-03-06', label: 'X', amount: 'abc' },
    ],
    rules: [{ match: 'cafe', category: 'Bar / Café' }, { match: '', category: 'Autre' }],
    accounts: [{ name: 'Livret A', balance: 1250.5, date: '2026-03-01' }, { name: '', balance: 1 }],
  });
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].amount, -2.5);
  assert.equal(state.rules.length, 1);
  assert.equal(state.accounts.length, 1);
  assert.equal(dropped, 4);
  assert.throws(() => BudgetStore.clean({}), /invalide/);
});

test('stockage : une catégorie inconnue d\'une règle est créée', () => {
  const { state } = BudgetStore.clean({ transactions: [], rules: [{ match: 'x', category: 'Ma catégorie' }] });
  assert.ok(state.categories.some((c) => c.name === 'Ma catégorie'));
});

test('clés de stockage distinctes de l\'appli Suivi PEA d\'origine', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!/KEY: 'suivi-pea/.test(app), 'la copie ne doit jamais écrire dans les données de l\'original');
  assert.ok(app.includes("KEY: 'budget-patrimoine:pea:v1'"));
  assert.ok(BudgetStore.KEY.startsWith('budget-patrimoine:'));
});

test('aucune donnée personnelle dans le dépôt (règles génériques seulement)', () => {
  // Empreintes SHA-256 (16 premiers caractères) des noms interdits : le test ne doit
  // pas lui-même publier ces noms. Chaque mot des fichiers publics est comparé.
  const FORBIDDEN = new Set([
    '25b8b8b2146bc13f', 'ac814b9a6c969a1c', '85b2d30e323a856c', '8f7bca94da9408dd',
    'c99be70e1e06ca3c', '754fedaa846bfc7d', '1fd5fd6dc735c23f', '57a44ee245458056',
    '8d3e0bf685d07778', 'b737901092b6ecca', 'ca68c91636f5c3b0',
  ]);
  const crypto = require('node:crypto');
  const hash = (w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);
  const root = path.join(__dirname, '..');
  const files = ['budget.js', 'app.js', 'sync.js', 'index.html', 'style.css', 'sw.js', 'README.md', 'manifest.webmanifest',
    ...fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.js')).map((f) => `tests/${f}`),
    ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.js')).map((f) => `tools/${f}`)];
  // Règles personnelles locales (hors dépôt) : si le fichier est là, ses libellés de plusieurs mots
  // (nom + prénom, commerce) sont aussi interdits ; un mot seul peut être générique (« lydia »),
  // et une formule de la banque (« wero vers ») n'a aucun mot utile au sens de ruleKey.
  const localRules = path.join(root, 'regles-perso.json');
  const localMatches = fs.existsSync(localRules)
    ? JSON.parse(fs.readFileSync(localRules, 'utf8')).rules.map((r) => B.normLabel(r.match)).filter((m) => m.includes(' ') && B.ruleKey(m) !== '')
    : [];
  for (const f of files) {
    const text = B.normLabel(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const w of text.split(/[^a-z0-9]+/)) {
      assert.ok(!FORBIDDEN.has(hash(w)), `${f} : un nom personnel figure dans le code public`);
    }
    for (const m of localMatches) {
      assert.ok(!(' ' + text + ' ').includes(' ' + m + ' '), `${f} : une règle personnelle figure dans le code public`);
    }
  }
});

test('adresses versionnées : budget.js dans index.html et le service worker', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(html.includes(`src="budget.js?v=${APP_VERSION}"`));
  assert.match(sw, /'\.\/budget\.js\?v=' \+ VERSION/);
  assert.ok(html.indexOf('budget.js?v=') < html.indexOf('app.js?v='), 'budget.js doit se charger avant app.js');
});

/* ---------- v2.3 : libellés, plafonds, évolution, aide, historique, rappels ---------- */

test('displayLabel : libellés Crédit Agricole raccourcis (données fictives)', () => {
  const d = B.displayLabel;
  assert.equal(d('Paiement par carte X1234 MP*CARREFOUR DAC VL  28/07 - Carrefour'), 'Carrefour', 'nom du commerçant ajouté par la banque');
  assert.equal(d('Paiement par carte\nX1234 BOULANGERIE DU PORT 12/05\n\n'), 'BOULANGERIE DU PORT', 'sans nom ajouté : le libellé du terminal');
  assert.equal(d('Paiement par carte X1234 KIOSQUE NORD 8          04/07'), 'KIOSQUE NORD 8');
  assert.equal(d('Avoir CARTE X1234 UBER   *ONE ME 30/06'), 'Avoir · UBER *ONE ME');
  assert.equal(d('Retrait au distributeur X1234 NANTES         23/08 08H45 - Retrait d\'espèces'), 'Retrait · NANTES');
  assert.equal(d('Virement en votre faveur VIR INST WERO de JEAN DUPONT 01a0d5f85e6374338b946e7232c6ff72'), 'Virement reçu · JEAN DUPONT', 'référence technique retirée');
  assert.equal(d('Virement en votre faveur DE M.       DUPONT JEAN'), 'Virement reçu · M. DUPONT JEAN');
  assert.equal(d('Virement émis Wero vers JEAN D - pizza 01a0d21c7c547d9cb0ccd9cef90ecbd9'), 'Virement émis · JEAN D - pizza');
  assert.equal(d('Virement émis VIR INST vers PEA'), 'Virement émis · PEA');
  assert.equal(d('Prélèvement 0247817 ASSUREUR EXEMPLE - Exemple - CONTRAT 123'), 'Prélèvement · ASSUREUR EXEMPLE');
  assert.equal(d('CB CARREFOUR MARKET 12/03'), 'CB CARREFOUR MARKET 12/03', 'autre banque : inchangé');
  assert.ok(d('x'.repeat(100)).length <= 60);
});

test('aide reçue : comptée dans les revenus, affichée à part', () => {
  const cats = [...B.DEFAULT_CATEGORIES, { name: 'Famille', kind: 'aide' }];
  const txs = [
    { date: '2026-03-01', amount: 400, category: 'Famille' },
    { date: '2026-03-02', amount: 600, category: 'Salaire' },
    { date: '2026-03-03', amount: -700, category: 'Alimentation & restauration' },
  ];
  const s = B.summarizeMonth(txs, '2026-03', cats);
  assert.equal(s.income, 1000);
  assert.equal(s.aid, 400);
  assert.equal(s.ownIncome, 600);
  assert.equal(s.net, 300);
  assert.deepEqual(s.incomes.map((c) => [c.name, c.aid]), [['Salaire', false], ['Famille', true]]);
  assert.equal(B.summarizeMonth(txs.slice(1), '2026-03', cats).aid, 0);
});

test('lastMonths et daysBetween', () => {
  assert.deepEqual(B.lastMonths('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  assert.equal(B.lastMonths('2026-10', 12)[0], '2025-11');
  assert.equal(B.daysBetween('2026-09-30', '2026-10-11'), 11);
  assert.equal(B.daysBetween('2026-03-01', '2026-03-01'), 0);
});

test('plafonds : mois, 12 mois glissants, niveaux, remboursements déduits', () => {
  const txs = [
    { date: '2026-10-02', amount: -150, category: 'Bar / Café' },
    { date: '2026-10-05', amount: -80, category: 'Bar / Café' },
    { date: '2026-10-06', amount: 20, category: 'Bar / Café' },      // remboursé par un ami
    { date: '2026-09-10', amount: -999, category: 'Bar / Café' },    // autre mois
    { date: '2025-12-20', amount: -300, category: 'Ski' },
    { date: '2026-02-15', amount: -250, category: 'Ski' },
    { date: '2025-10-01', amount: -500, category: 'Ski' },           // hors des 12 mois
    { date: '2026-10-03', amount: -40, category: 'Transport' },
  ];
  const st = B.budgetStatus(txs, '2026-10', {
    'Bar / Café': { limit: 200, period: 'mois' },
    Ski: { limit: 600, period: 'an' },
    Transport: { limit: 100, period: 'mois' },
    Vide: { limit: 0, period: 'mois' },
  });
  assert.deepEqual(st.map((b) => [b.name, b.spent, b.level]), [
    ['Bar / Café', 210, 'over'], ['Ski', 550, 'warn'], ['Transport', 40, 'ok'],
  ]);
  assert.deepEqual(B.budgetStatus(txs, '2026-10', null), []);
});

test('évolution d\'une catégorie : 12 mois, total, comparaison si historique suffisant', () => {
  const cats = B.DEFAULT_CATEGORIES;
  const txs = [
    { date: '2026-10-02', amount: -100, category: 'Ski' },
    { date: '2026-01-02', amount: -50, category: 'Ski' },
    { date: '2026-01-03', amount: 10, category: 'Ski' },
    { date: '2025-09-01', amount: -30, category: 'Ski' },   // 12 mois d'avant
  ];
  const r = B.categorySeries(txs, 'Ski', '2026-10', cats);
  assert.equal(r.series.length, 12);
  assert.equal(r.series[11].month, '2026-10');
  assert.equal(r.series[11].amount, 100);
  assert.equal(r.series.find((x) => x.month === '2026-01').amount, 40);
  assert.equal(r.total, 140);
  assert.equal(r.previousTotal, null, 'historique commencé après le début de la période précédente');
  const older = [...txs, { date: '2024-10-01', amount: -5, category: 'Alimentation & restauration' }];
  assert.equal(B.categorySeries(older, 'Ski', '2026-10', cats).previousTotal, 30);
  const inc = B.categorySeries([{ date: '2026-10-01', amount: 500, category: 'Salaire' }], 'Salaire', '2026-10', cats);
  assert.equal(inc.total, 500, 'revenu : montant reçu positif');
});

test('PEA dans le patrimoine : actions + liquidités non investies', () => {
  // 800 € versés, 600 € d'actions achetées → 200 € de liquidités sur le PEA
  assert.deepEqual(B.peaTotal(612.5, { hasDeposits: true, cash: 200 }), { value: 612.5, cash: 200, total: 812.5 });
  assert.equal(B.peaTotal(600, { hasDeposits: false, cash: null }).total, 600, 'versements non saisis : actions seules');
  assert.equal(B.peaTotal(600, { hasDeposits: true, cash: -50 }).total, 600, 'versement oublié : rien retranché');
  assert.equal(B.peaTotal(0, { hasDeposits: true, cash: 800 }).total, 800, 'versé mais rien acheté');
});

test('disponibilité : comptes bloqués, date de déblocage, PEA avant / après 5 ans', () => {
  const accounts = [
    { name: 'Livret A', balance: 3000 },
    { name: 'Compte courant', balance: 850 },
    { name: 'PEL', balance: 5000, blocked: true, until: '' },
    { name: 'Dépôt à terme', balance: 1000, blocked: true, until: '2026-09-01' }, // date passée : disponible
    { name: 'CEL', balance: 5000, blocked: true, until: '2028-01-01' },
  ];
  const av = B.availability(accounts, { amount: 870, until: '2031-06-03' }, '2026-10-11');
  assert.equal(av.available, 4850);
  assert.equal(av.blocked, 10870);
  assert.deepEqual(av.items.filter((i) => i.blocked).map((i) => i.name), ['CEL', 'PEA', 'PEL'], 'dates les plus proches d\'abord, sans date en dernier');
  assert.deepEqual(av.nextRelease, { name: 'CEL', date: '2028-01-01', amount: 5000 });
  const after = B.availability([], { amount: 870, until: '2031-06-03' }, '2031-06-03');
  assert.equal(after.available, 870, 'PEA de plus de 5 ans : disponible');
  assert.equal(B.availability([], { amount: 0, until: '2031-06-03' }, '2026-10-11').items.length, 0);
});

test('comptes groupés par banque, avec total ; sans banque à la fin', () => {
  const g = B.groupAccounts([
    { name: 'Livret A', bank: 'Crédit Agricole', balance: 3000 },
    { name: 'Espèces', bank: '', balance: 50 },
    { name: 'Compte', bank: 'BforBank', balance: 200.1 },
    { name: 'Courant', bank: 'crédit agricole ', balance: 850.2 },
  ]);
  assert.deepEqual(g.map((x) => [x.bank, x.total, x.accounts.length]), [['BforBank', 200.1, 1], ['Crédit Agricole', 3850.2, 2], ['', 50, 1]]);
  assert.deepEqual(B.groupAccounts([]), []);
  const av = B.availability([{ name: 'Livret A', bank: 'Crédit Agricole', balance: 10 }], null, '2026-10-11');
  assert.equal(av.items[0].name, 'Livret A (Crédit Agricole)');
});

test('stockage : comptes bloqués conservés', () => {
  const { state } = BudgetStore.clean({ transactions: [], accounts: [
    { name: 'PEL', balance: 5000, blocked: true, until: '2028-01-01' },
    { name: 'Livret', balance: 10, until: '2028-01-01' },
  ] });
  assert.deepEqual(state.accounts.map((a) => [a.name, a.blocked, a.until]), [['PEL', true, '2028-01-01'], ['Livret', false, '']]);
});

test('historique du patrimoine : un point par mois, à l\'euro près', () => {
  let r = B.upsertSnapshot([], '2026-10', { cash: 853.1, pea: 812.4 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.history, [{ month: '2026-10', cash: 853, pea: 812, total: 1665 }]);
  r = B.upsertSnapshot(r.history, '2026-10', { cash: 853.3, pea: 812.2 });
  assert.equal(r.changed, false, 'variation de quelques centimes : rien à enregistrer');
  r = B.upsertSnapshot(r.history, '2026-10', { cash: 900, pea: 812 });
  assert.equal(r.changed, true);
  assert.equal(r.history.length, 1);
  r = B.upsertSnapshot(r.history, '2026-09', { cash: 100, pea: 0 });
  assert.deepEqual(r.history.map((h) => h.month), ['2026-09', '2026-10']);
});

test('rappels : import ancien, sauvegarde chiffrée absente ou ancienne', () => {
  const tx = [{ date: '2026-08-01', amount: -1 }];
  assert.deepEqual(B.reminders({ transactions: [] }, '2026-10-11'), []);
  const ids = (st, today) => B.reminders(st, today).map((r) => r.id);
  assert.deepEqual(ids({ transactions: tx }, '2026-10-11'), ['import', 'backup']);
  assert.deepEqual(ids({ transactions: tx, lastImport: '2026-10-01', lastEncryptedExport: '2026-09-01' }, '2026-10-11'), []);
  assert.deepEqual(ids({ transactions: tx, lastImport: '2026-10-01', lastEncryptedExport: '2026-07-01' }, '2026-10-11'), ['backup']);
  assert.match(B.reminders({ transactions: tx, lastEncryptedExport: '2026-10-01' }, '2026-10-11')[0].text, /il y a 71 jours/);
});

test('stockage : plafonds, historique, dates de rappel et type « aide » conservés', () => {
  const { state } = BudgetStore.clean({
    transactions: [],
    categories: [{ name: 'Famille', kind: 'aide' }, { name: 'Bizarre', kind: 'nimporte' }],
    budgets: { Ski: { limit: '600', period: 'an' }, 'Bar / Café': { limit: 200 }, Mauvais: { limit: -5 } },
    history: [{ month: '2026-10', cash: 10, pea: 5 }, { month: 'x', cash: 1, pea: 1 }, { month: '2026-09', cash: 1, pea: 1 }],
    lastImport: '2026-10-10', lastEncryptedExport: 'pas une date',
  });
  assert.equal(state.categories.find((c) => c.name === 'Famille').kind, 'aide');
  assert.equal(state.categories.find((c) => c.name === 'Bizarre').kind, 'depense');
  assert.deepEqual(state.budgets, { Ski: { limit: 600, period: 'an' }, 'Bar / Café': { limit: 200, period: 'mois' } });
  assert.deepEqual(state.history.map((h) => [h.month, h.total]), [['2026-09', 2], ['2026-10', 15]]);
  assert.equal(state.lastImport, '2026-10-10');
  assert.equal(state.lastEncryptedExport, null);
});
