/* Tests des abonnements, de la prévision de fin de mois et du récap mensuel — node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetCore: B } = require('../budget.js');

const cats = [...B.DEFAULT_CATEGORIES, { name: 'Famille', kind: 'aide' }];
const tx = (date, label, amount, category) => ({ date, label, amount, category });
const card = (name) => `Paiement par carte X1234 ${name.toUpperCase()} PARIS 01/01 - ${name}`;

test('dates : addDays, addMonths, endOfMonth', () => {
  assert.equal(B.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(B.addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(B.addMonths('2025-03-14', 12), '2026-03-14');
  assert.equal(B.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(B.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(B.endOfMonth('2026-02'), '2026-02-28');
  assert.equal(B.endOfMonth('2028-02'), '2028-02-29');
  assert.equal(B.endOfMonth('2026-12'), '2026-12-31');
});

test('abonnements : mensuel détecté, hausse de prix signalée, prochain paiement', () => {
  const list = [
    ...['2026-05-03', '2026-06-03', '2026-07-03', '2026-08-03'].map((d) => tx(d, card('StreamFlix'), -9.99, 'Abonnements')),
    tx('2026-09-03', card('StreamFlix'), -11.99, 'Abonnements'),
    // Courses : fréquentes et montants variables → pas un abonnement
    ...['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30'].map((d, i) => tx(d, card('Supermarche'), -(20 + i * 7), 'Alimentation & restauration')),
    // Virements à des amis et retraits : exclus même s'ils sont réguliers
    ...['2026-06-05', '2026-07-05', '2026-08-05'].map((d) => tx(d, 'Virement émis Wero vers JEAN D', -10, 'Remboursement')),
    ...['2026-06-06', '2026-07-06', '2026-08-06'].map((d) => tx(d, 'Retrait au distributeur X1234 PARIS 05/06', -40, 'Espèces')),
  ];
  const s = B.subscriptions(list, cats, '2026-09-10');
  assert.equal(s.active.length, 1);
  const sub = s.active[0];
  assert.equal(sub.label, 'StreamFlix');
  assert.equal(sub.period, 'mois');
  assert.equal(sub.amount, 11.99);
  assert.equal(sub.monthly, 11.99);
  assert.equal(sub.yearly, 143.88);
  assert.equal(sub.next, '2026-10-03');
  assert.deepEqual(sub.change, { from: 9.99, to: 11.99, date: '2026-09-03' });
  assert.equal(sub.recentChange, true);
  assert.equal(s.alerts.length, 1);
});

test('abonnements : prélèvement reconnu dès 2 échéances, abonnement arrêté, annuel', () => {
  const list = [
    tx('2026-08-01', 'Prélèvement 0001 ASSUREUR EXEMPLE - Exemple - CONTRAT', -80, 'Logement & factures'),
    tx('2026-09-01', 'Prélèvement 0001 ASSUREUR EXEMPLE - Exemple - CONTRAT', -80, 'Logement & factures'),
    ...['2026-01-10', '2026-02-10', '2026-03-10'].map((d) => tx(d, card('VieuxService'), -5, 'Abonnements')),
    tx('2025-03-15', card('Antivirus'), -40, 'Abonnements'), tx('2026-03-14', card('Antivirus'), -42, 'Abonnements'),
  ];
  const s = B.subscriptions(list, cats, '2026-09-10');
  assert.deepEqual(s.active.map((x) => [x.label, x.period]), [['Prélèvement · ASSUREUR EXEMPLE', 'mois'], ['Antivirus', 'an']]);
  assert.equal(s.active[0].isNew, true);
  assert.deepEqual(s.ended.map((x) => x.label), ['VieuxService'], 'plus de paiement depuis mars : terminé');
  assert.equal(s.monthly, 83.5);
  assert.equal(s.yearly, 1002);
});

test('revenus réguliers (sign in), hors virements internes', () => {
  const list = ['2026-06-01', '2026-07-01', '2026-08-01'].flatMap((d) => [
    tx(d, 'Virement en votre faveur DE M. DUPONT PIERRE', 400, 'Famille'),
    tx(d, 'Virement en votre faveur DE MOI MEME', 100, 'Virement interne'),
  ]);
  const r = B.recurring(list, cats, '2026-08-10', 'in');
  assert.deepEqual(r.map((x) => [x.label, x.amount]), [['Virement reçu · M. DUPONT PIERRE', 400]]);
});

test('prévision de fin de mois : passé + attendu + dépenses courantes', () => {
  const list = [
    // 3 mois de référence : 300 € de dépenses courantes par mois + un gros achat ponctuel ignoré
    // (dates irrégulières : ce ne sont pas des dépenses récurrentes)
    ...[['2026-06', '03', '20'], ['2026-07', '22', '08'], ['2026-08', '09', '27']].flatMap(([m, d1, d2]) => [
      tx(`${m}-${d1}`, card('Boulangerie'), -100, 'Alimentation & restauration'),
      tx(`${m}-${d2}`, card('Cafe'), -200, 'Bar / Café'),
      tx(`${m}-05`, card('StreamFlix'), -10, 'Abonnements'),
      tx(`${m}-01`, 'Virement en votre faveur DE M. DUPONT PIERRE', 400, 'Famille'),
    ]),
    tx('2026-07-15', card('Ordinateur'), -1200, 'Shopping'),
    // Septembre jusqu'au 10 : 50 € dépensés, le virement et l'abonnement pas encore passés
    tx('2026-09-08', card('Boulangerie'), -50, 'Alimentation & restauration'),
  ];
  const f = B.forecastMonth(list, cats, '2026-09-10');
  assert.equal(f.remainingDays, 20);
  assert.equal(f.sofar.net, -50);
  assert.deepEqual(f.remainingOut.map((r) => [r.label, r.amount, r.date]), [['StreamFlix', 10, '2026-09-05'.replace('05', '10')]], 'en retard : compté pour aujourd\'hui');
  assert.deepEqual(f.remainingIn.map((r) => r.amount), [400]);
  assert.equal(f.basisMonths, 3);
  assert.equal(f.variable, Math.round((300 / 30.44) * 20 * 100) / 100, 'médiane hors récurrent et hors gros achat');
  assert.equal(f.projectedNet, Math.round((-50 + 400 - 10 - f.variable) * 100) / 100);
  // Sans historique : pas de dépenses courantes estimées
  assert.equal(B.forecastMonth([tx('2026-09-02', card('Cafe'), -5, 'Bar / Café')], cats, '2026-09-10').variable, null);
});

test('récap du mois : comparaison, top catégories vs moyenne, plus grosses dépenses, plafonds', () => {
  const list = [
    ...['2026-06', '2026-07', '2026-08'].map((m) => tx(`${m}-10`, card('Cafe'), -100, 'Bar / Café')),
    tx('2026-08-01', 'Virement en votre faveur DE M. DUPONT PIERRE', 400, 'Famille'),
    tx('2026-09-01', 'Virement en votre faveur DE M. DUPONT PIERRE', 400, 'Famille'),
    tx('2026-09-10', card('Cafe'), -160, 'Bar / Café'),
    tx('2026-09-12', card('Train'), -90, 'Transport'),
    tx('2026-09-13', card('Inconnu'), -5, B.UNCATEGORIZED),
  ];
  const state = { transactions: list, categories: cats, budgets: { 'Bar / Café': { limit: 150, period: 'mois' } }, history: [{ month: '2026-08', total: 1000 }, { month: '2026-09', total: 1200 }] };
  const r = B.monthRecap(state, '2026-09', '2026-09-30');
  assert.equal(r.summary.expense, 255);
  assert.deepEqual(r.versus, { income: 0, expense: 155, net: -155 });
  assert.deepEqual(r.top[0], { name: 'Bar / Café', amount: 160, average: 100, delta: 60 });
  assert.deepEqual(r.biggest.map((b) => b.label), ['Cafe', 'Train', 'Inconnu']);
  assert.equal(r.budgets.over.length, 1);
  assert.deepEqual(r.patrimoine, { total: 1200, delta: 200 });
  assert.equal(r.uncategorized, 1);
  assert.equal(r.count, 4);
});
