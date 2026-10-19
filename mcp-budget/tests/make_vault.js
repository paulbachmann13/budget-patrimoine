// Chiffre un jeu fictif avec le VRAI code de l'appli (sync.js) : sert à vérifier la compatibilité.
const { SyncCrypto: C } = require('../../sync.js');
(async () => {
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const salt = C.randomB64(16);
  const key = await C.deriveKey(process.argv[2], salt, 1000);
  const box = await C.encrypt(key, data);
  console.log(JSON.stringify({ salt, iterations: 1000, iv: box.iv, data: box.data, rev: 3, updated_at: '2026-10-19T10:00:00Z' }));
})();
