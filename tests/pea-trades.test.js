/* Tests des ventes, mouvements d'argent et bilans du PEA — lancer avec : node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Calc, Store } = require('../app.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} attendu ${b}, obtenu ${a}`);
const buy = (id, date, qty, price, fees = 0, ticker = 'ETF') => ({ id, date, ticker, qty, price, fees });
const sell = (id, date, qty, price, fees = 0, ticker = 'ETF') => ({ id, date, ticker, qty, price, fees });

test('trades : vente au PRU (frais d\'achat inclus), plus-value réalisée', () => {
  const purchases = [buy('a', '2026-01-10', 10, 50, 2), buy('b', '2026-03-10', 10, 60, 2)];
  // PRU = (500 + 2 + 600 + 2) / 20 = 55,20
  const { lots, realized } = Calc.trades(purchases, [sell('s', '2026-06-01', 5, 70, 1)]);
  assert.equal(realized.length, 1);
  near(realized[0].cost, 5 * 55.2, 'coût des parts vendues');
  near(realized[0].proceeds, 349, 'produit net');
  near(realized[0].gain, 349 - 276, 'plus-value');
  // Restent 15 parts, PRU inchangé
  const pf = Calc.portfolio(lots, { ETF: { price: 70, date: '2026-06-01' } });
  near(pf.qty, 15, 'parts restantes');
  near(pf.positions[0].pru, 55.2, 'PRU inchangé après une vente');
});

test('trades : une vente ne touche que les achats antérieurs et le bon titre', () => {
  const purchases = [buy('a', '2026-01-10', 10, 50), buy('x', '2026-01-10', 4, 20, 0, 'AUTRE'), buy('b', '2026-07-01', 10, 40)];
  const { lots } = Calc.trades(purchases, [sell('s', '2026-06-01', 10, 55)]);
  assert.deepEqual(lots.map((l) => [l.id, l.qty]), [['x', 4], ['b', 10]], 'le lot vendu disparaît, le suivant reste entier');
});

test('trades : vente le jour d\'un achat, vente trop grande bornée, vente sans parts ignorée', () => {
  const { realized } = Calc.trades([buy('a', '2026-01-10', 3, 10)], [sell('s', '2026-01-10', 5, 12), sell('t', '2026-02-01', 1, 12)]);
  assert.equal(realized.length, 1, 'la seconde vente n\'a plus de parts');
  assert.equal(realized[0].qty, 3);
});

test('liquidités : versements, ventes, régularisations, frais, retraits — plafond sur les versements', () => {
  const purchases = [buy('a', '2026-06-05', 10, 60)];        // 600 €
  const sales = [sell('s', '2026-09-01', 2, 70, 0.5)];      // + 139,50 €
  const moves = [
    { id: 'm1', date: '2026-10-05', amount: 2.2, kind: 'credit' },   // régularisation de frais
    { id: 'm2', date: '2026-10-06', amount: 1, kind: 'frais' },
    { id: 'm3', date: '2026-10-07', amount: 100, kind: 'retrait' },
  ];
  const d = Calc.deposits([{ id: 'd1', date: '2026-06-03', amount: 100 }, { id: 'd2', date: '2026-10-01', amount: 700 }], purchases, sales, moves);
  assert.equal(d.base, 800, 'seuls les versements comptent pour le plafond');
  near(d.cash, 800 + 139.5 + 2.2 - 600 - 1 - 100, 'liquidités');
  near(d.proceeds, 139.5);
  // Compatibilité : sans ventes ni mouvements
  assert.equal(Calc.deposits([{ id: 'd', date: '2026-01-01', amount: 800 }], purchases).cash, 200);
});

test('bilan d\'une position vendue : durée, gain, rendement annualisé, opérations', () => {
  const purchases = [buy('a', '2025-01-02', 10, 100, 1), buy('b', '2025-07-01', 10, 110, 1)];
  const sales = [sell('s1', '2025-10-01', 5, 120, 1), sell('s2', '2026-01-02', 15, 130, 1)];
  const histories = { ETF: [['2024-12-31', 99], ['2025-01-02', 100], ['2025-07-01', 110], ['2026-01-02', 130], ['2026-03-01', 140]] };
  const r = Calc.positionReport(purchases, sales, 'etf', {}, histories, '2026-06-01');
  assert.equal(r.closed, true);
  assert.equal(r.start, '2025-01-02');
  assert.equal(r.end, '2026-01-02');
  assert.equal(r.days, 365);
  near(r.invested, 2102);
  near(r.received, 599 + 1949);
  near(r.gain, 599 + 1949 - 2102);
  near(r.realizedGain, r.gain, 'tout est réalisé');
  assert.ok(r.xirr > 0.2 && r.xirr < 0.4, `TRI plausible (${r.xirr})`);
  assert.deepEqual(r.prices.map((p) => p[0]), ['2025-01-02', '2025-07-01', '2026-01-02'], 'cours limités à la période détenue');
  assert.deepEqual(r.operations.map((o) => o.type), ['achat', 'achat', 'vente', 'vente']);
});

test('bilan d\'une position en cours : valeur restante comptée, pas de date de fin', () => {
  const r = Calc.positionReport([buy('a', '2026-01-01', 10, 50)], [sell('s', '2026-03-01', 4, 60)], 'ETF', { ETF: { price: 55, date: '2026-06-01' } }, {}, '2026-06-01');
  assert.equal(r.closed, false);
  assert.equal(r.end, '2026-06-01');
  near(r.held, 6);
  near(r.value, 330);
  near(r.gain, 240 + 330 - 500);
  near(r.realizedGain, 40);
  assert.equal(Calc.positionReport([], [], 'ETF'), null);
});

test('TRI du portefeuille : les ventes comptent comme de l\'argent récupéré', () => {
  const purchases = [buy('a', '2025-01-01', 10, 100)];
  const without = Calc.portfolioXirr(purchases, 600, '2026-01-01');
  const withSale = Calc.portfolioXirr(purchases, 600, '2026-01-01', [sell('s', '2025-07-01', 5, 110)]);
  assert.ok(withSale.rate > without.rate);
});

test('stockage : ventes et mouvements validés et conservés', () => {
  const { state, errors } = Store.clean({
    purchases: [buy('a', '2026-01-01', 1, 10)],
    sales: [sell('s', '2026-02-01', 1, 12), { date: 'x', ticker: 'ETF', qty: 1, price: 1 }],
    moves: [{ id: 'm', date: '2026-02-02', amount: '2,20', kind: 'credit' }, { date: '2026-02-02', amount: 5, kind: 'inconnu' }],
  });
  assert.equal(state.sales.length, 1);
  assert.equal(state.moves.length, 1);
  assert.equal(state.moves[0].amount, 2.2);
  assert.equal(errors.length, 2);
  // Anciennes sauvegardes (Suivi PEA d'origine) : listes vides
  const old = Store.clean({ purchases: [] }).state;
  assert.deepEqual([old.sales, old.moves], [[], []]);
});
