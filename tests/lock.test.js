/* Tests du verrouillage (code, délais) — node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LockCore: L } = require('../lock.js');
const { APP_VERSION } = require('../app.js');

test('code : 4 à 6 chiffres', () => {
  for (const ok of ['1234', '00000', '987654']) assert.ok(L.validPin(ok), ok);
  for (const ko of ['123', '1234567', '12a4', '', null, ' 1234']) assert.ok(!L.validPin(ko), String(ko));
});

test('empreinte du code : stable avec le même sel, différente sinon, jamais le code en clair', async () => {
  const salt = L.randomB64(16);
  const a = await L.hashPin('2468', salt, 1000);
  assert.equal(a, await L.hashPin('2468', salt, 1000));
  assert.notEqual(a, await L.hashPin('2469', salt, 1000));
  assert.notEqual(a, await L.hashPin('2468', L.randomB64(16), 1000));
  assert.ok(!a.includes('2468'));
  assert.ok(L.sameHash(a, a));
  assert.ok(!L.sameHash(a, a.slice(0, -1) + (a.endsWith('A') ? 'B' : 'A')));
  assert.ok(!L.sameHash(a, undefined));
});

test('attente après erreurs : progressive et plafonnée', () => {
  assert.deepEqual([0, 1, 4].map(L.backoffMs), [0, 0, 0]);
  assert.equal(L.backoffMs(5), 30000);
  assert.equal(L.backoffMs(6), 60000);
  assert.equal(L.backoffMs(50), 15 * 60000);
});

test('reverrouillage selon le temps passé en arrière-plan', () => {
  const t0 = 1_000_000;
  assert.equal(L.shouldRelock(0, t0, 0), false, 'jamais passé en arrière-plan');
  assert.equal(L.shouldRelock(t0, t0, 0), true, 'immédiatement');
  assert.equal(L.shouldRelock(t0, t0 + 59_000, 1), false);
  assert.equal(L.shouldRelock(t0, t0 + 60_000, 1), true);
  assert.equal(L.shouldRelock(t0, t0 + 14 * 60_000, 15), false);
});

test('adresses versionnées : lock.js chargé après sync.js et mis en cache', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(html.includes(`src="lock.js?v=${APP_VERSION}"`));
  assert.ok(html.indexOf('sync.js?v=') < html.indexOf('lock.js?v='));
  assert.match(sw, /'\.\/lock\.js\?v=' \+ VERSION/);
});
