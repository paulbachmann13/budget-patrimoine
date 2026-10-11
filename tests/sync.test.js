/* Tests de la synchronisation chiffrée — lancer avec : node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SyncCrypto: C, SyncCore: M } = require('../sync.js');
const { APP_VERSION } = require('../app.js');

const FAST = 1000; // itérations réduites pour les tests (600 000 dans l'appli)

test('chiffrement : aller-retour, données illisibles sans la phrase', async () => {
  const salt = C.randomB64(16);
  const key = await C.deriveKey('une phrase assez longue', salt, FAST);
  const data = { budget: { transactions: [{ id: 'a', label: 'Café', amount: -2.5 }] }, pea: { purchases: [] } };
  const box = await C.encrypt(key, data);
  assert.ok(!box.data.includes('Caf'), 'le contenu ne doit pas apparaître en clair');
  assert.deepEqual(await C.decrypt(key, box), data);
  const other = await C.deriveKey('une autre phrase longue', salt, FAST);
  await assert.rejects(C.decrypt(other, box), /phrase de chiffrement incorrecte/);
});

test('chiffrement : un IV neuf à chaque envoi', async () => {
  const key = await C.deriveKey('une phrase assez longue', C.randomB64(16), FAST);
  const a = await C.encrypt(key, { x: 1 });
  const b = await C.encrypt(key, { x: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('chiffrement : données modifiées refusées (AES-GCM authentifié)', async () => {
  const key = await C.deriveKey('une phrase assez longue', C.randomB64(16), FAST);
  const box = await C.encrypt(key, { montant: 100 });
  const bytes = C.fromB64(box.data); bytes[0] ^= 1;
  await assert.rejects(C.decrypt(key, { iv: box.iv, data: C.toB64(bytes) }), /incorrecte|abîmées/);
});

test('sauvegarde chiffrée : fichier autonome (sel et itérations inclus)', async () => {
  const data = { budget: { transactions: [] }, pea: { purchases: [{ id: 'p1' }] } };
  const env = await C.makeEnvelope('phrase du fichier', data, FAST);
  assert.equal(env.format, C.FORMAT);
  assert.equal(env.kdf.iterations, FAST);
  const back = await C.openEnvelope('phrase du fichier', JSON.parse(JSON.stringify(env)));
  assert.deepEqual(back, data);
  await assert.rejects(C.openEnvelope('mauvaise phrase', env), /incorrecte/);
  await assert.rejects(C.openEnvelope('x', { format: 'autre' }), /pas une sauvegarde chiffrée/);
});

test('base64 : gros volumes (plus de 32 Ko)', () => {
  const big = new Uint8Array(100000).map((_, i) => i % 256);
  assert.deepEqual(C.fromB64(C.toB64(big)), big);
});

test('fusion de listes : ajouts des deux côtés, suppressions, modifications', () => {
  const id = (x) => x.id;
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }, { id: 'd', v: 1 }];
  const local = [{ id: 'a', v: 2 }, { id: 'c', v: 1 }, { id: 'd', v: 1 }, { id: 'l', v: 1 }];   // a modifié, b supprimé, l ajouté
  const remote = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 3 }, { id: 'r', v: 1 }]; // c modifié, d supprimé, r ajouté
  assert.deepEqual(M.mergeList(base, local, remote, id), [{ id: 'a', v: 2 }, { id: 'c', v: 3 }, { id: 'l', v: 1 }, { id: 'r', v: 1 }]);
});

test('fusion de listes : supprimé d\'un côté mais modifié de l\'autre → gardé', () => {
  const id = (x) => x.id;
  assert.deepEqual(M.mergeList([{ id: 'a', v: 1 }], [], [{ id: 'a', v: 2 }], id), [{ id: 'a', v: 2 }]);
  assert.deepEqual(M.mergeList([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }], [], id), [{ id: 'a', v: 2 }]);
});

test('fusion de listes : modifié des deux côtés → version de l\'appareil', () => {
  const id = (x) => x.id;
  assert.deepEqual(M.mergeList([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }], [{ id: 'a', v: 3 }], id), [{ id: 'a', v: 2 }]);
});

test('fusion sans base (nouvel appareil) : union, rien n\'est supprimé', () => {
  const id = (x) => x.id;
  assert.deepEqual(M.mergeList(null, [{ id: 'a' }], [{ id: 'b' }], id), [{ id: 'a' }, { id: 'b' }]);
});

test('fusion complète : budget + PEA, règles, réglages', () => {
  const base = {
    budget: { transactions: [{ id: 't1', category: 'À catégoriser' }], rules: [], accounts: [], categories: [{ name: 'Ski', kind: 'depense' }] },
    pea: { purchases: [], deposits: [], openingDate: '2024-01-01', theme: 'dark' },
  };
  const local = {
    budget: { transactions: [{ id: 't1', category: 'Ski' }], rules: [{ match: 'praloup', category: 'Ski' }], accounts: [], categories: [{ name: 'Ski', kind: 'depense' }] },
    pea: { purchases: [], deposits: [], openingDate: '2024-01-01', theme: 'light' },
  };
  const remote = {
    budget: { transactions: [{ id: 't1', category: 'À catégoriser' }, { id: 't2', category: 'Bar / Café' }], rules: [{ match: 'PRALOUP', category: 'Voyages' }], accounts: [{ id: 'c1', balance: 10 }], categories: [{ name: 'Ski', kind: 'depense' }] },
    pea: { purchases: [{ id: 'p1' }], deposits: [], openingDate: '2023-06-01', theme: 'dark' },
  };
  const m = M.merge(base, local, remote);
  assert.deepEqual(m.budget.transactions.map((t) => [t.id, t.category]), [['t1', 'Ski'], ['t2', 'Bar / Café']]);
  assert.equal(m.budget.rules.length, 1, 'même règle (casse ignorée) : une seule');
  assert.equal(m.budget.rules[0].category, 'Ski');
  assert.deepEqual(m.budget.accounts, [{ id: 'c1', balance: 10 }]);
  assert.deepEqual(m.pea.purchases, [{ id: 'p1' }]);
  assert.equal(m.pea.openingDate, '2023-06-01', 'modifié sur le serveur seulement');
  assert.equal(m.pea.theme, 'light', 'modifié sur l\'appareil seulement');
  assert.deepEqual(M.merge(base, local, null), local);
});

test('adresses versionnées : sync.js chargé après app.js et mis en cache', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(html.includes(`src="sync.js?v=${APP_VERSION}"`));
  assert.ok(html.indexOf('app.js?v=') < html.indexOf('sync.js?v='));
  assert.match(sw, /'\.\/sync\.js\?v=' \+ VERSION/);
});

test('synchro : jamais la clé service_role dans le code public', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
  const { SUPABASE } = require('../sync.js');
  if (SUPABASE.key) {
    const payload = JSON.parse(Buffer.from(SUPABASE.key.split('.')[1] || 'e30', 'base64').toString());
    assert.notEqual(payload.role, 'service_role');
    assert.ok(!SUPABASE.key.startsWith('sb_secret_'));
  }
  assert.ok(!/service_role"?\s*[:=]\s*['"]ey/.test(src));
});

test('fusion : historique du patrimoine par mois', () => {
  const base = { budget: { history: [{ month: '2026-09', total: 1 }] }, pea: {} };
  const local = { budget: { history: [{ month: '2026-09', total: 1 }, { month: '2026-10', total: 5 }] }, pea: {} };
  const remote = { budget: { history: [{ month: '2026-09', total: 2 }] }, pea: {} };
  assert.deepEqual(M.merge(base, local, remote).budget.history, [{ month: '2026-09', total: 2 }, { month: '2026-10', total: 5 }]);
});

/* ---------- Une suppression ne doit pas être annulée par une simple différence de représentation ---------- */
const { BudgetStore } = require('../budget.js');
const normalize = (d) => ({ budget: BudgetStore.clean(d.budget).state, pea: Store.clean(d.pea).state });
const { Store } = require('../app.js');

test('fusion : suppression conservée même si les appareils n\'ont pas la même représentation (ancienne version)', () => {
  // Bien créé par une ancienne version de l'appli : pas de champ « depreciation »
  const oldCar = { id: 'car', name: 'Voiture', kind: 'vehicule', value: 16000, date: '2026-10-11' };
  const empty = { transactions: [], rules: [], accounts: [], categories: [], history: [] };
  const pea = { purchases: [], deposits: [] };
  const base = { budget: { ...empty, assets: [oldCar] }, pea };            // dernière synchro (représentation ancienne)
  const remote = { budget: { ...empty, assets: [oldCar] }, pea };          // le serveur a toujours la voiture
  const local = { budget: { ...empty, assets: [] }, pea };                 // l'utilisateur vient de la supprimer
  // Sans normalisation : tout va bien tant que base et serveur sont identiques
  assert.deepEqual(M.merge(base, local, remote).budget.assets, []);
  // L'AUTRE appareil (a mis à jour : sa copie contient maintenant depreciation: 0) n'a pas encore vu la suppression
  const otherLocal = { budget: { ...empty, assets: [{ ...oldCar, depreciation: 0 }] }, pea };
  const serverAfterDelete = { budget: { ...empty, assets: [] }, pea };
  const bug = M.merge(base, otherLocal, serverAfterDelete);
  assert.equal(bug.budget.assets.length, 1, 'sans normalisation : la voiture est « modifiée localement » et revient (bug d\'origine)');
  // Avec normalisation : la copie locale et la base sont comparées sur la même représentation
  assert.deepEqual(M.merge(base, otherLocal, serverAfterDelete, normalize).budget.assets, [], 'la suppression est bien propagée');
  // Une vraie modification reste prioritaire sur une suppression
  const edited = { budget: { ...empty, assets: [{ ...oldCar, depreciation: 0, value: 15000 }] }, pea };
  assert.deepEqual(M.merge(base, edited, serverAfterDelete, normalize).budget.assets.map((a) => a.value), [15000]);
  // Et la suppression locale gagne contre une copie distante inchangée (ancienne représentation)
  assert.deepEqual(M.merge(base, local, remote, normalize).budget.assets, []);
});
