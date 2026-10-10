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
  const files = ['budget.js', 'app.js', 'index.html', 'style.css', 'sw.js', 'README.md', 'manifest.webmanifest',
    ...fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.js')).map((f) => `tests/${f}`),
    ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.js')).map((f) => `tools/${f}`)];
  // Règles personnelles locales (hors dépôt) : si le fichier est là, ses libellés de plusieurs mots
  // (nom + prénom, commerce) sont aussi interdits ; un mot seul peut être générique (« lydia »).
  const localRules = path.join(root, 'regles-perso.json');
  const localMatches = fs.existsSync(localRules)
    ? JSON.parse(fs.readFileSync(localRules, 'utf8')).rules.map((r) => B.normLabel(r.match)).filter((m) => m.includes(' '))
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
