// Vérifie avec le VRAI code de l'appli (sync.js) : usage  node node_check.js <phrase> <mode>  (JSON sur stdin)
//  mode "row"      : stdin = ligne vault   → affiche le contenu déchiffré
//  mode "envelope" : stdin = sauvegarde    → idem via SyncCrypto.openEnvelope (import de l'appli)
//  mode "merge"    : stdin = {base, local, remote} → affiche SyncCore.merge (ce que l'appli fait à la synchro)
const { SyncCrypto: C, SyncCore: M } = require('../../sync.js');
(async () => {
  const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const [phrase, mode] = process.argv.slice(2);
  let out;
  if (mode === 'row') out = await C.decrypt(await C.deriveKey(phrase, input.salt, Number(input.iterations)), input);
  else if (mode === 'envelope') out = await C.openEnvelope(phrase, input);
  else out = M.merge(input.base, input.local, input.remote);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exit(1); });
