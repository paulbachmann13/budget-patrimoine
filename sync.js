/* ==========================================================================
   Budget & Patrimoine — synchronisation chiffrée (Supabase)
   --------------------------------------------------------------------------
   Organisation :
     A. SyncCrypto — chiffrement AES-GCM, clé dérivée de la phrase (PBKDF2)
     B. SyncCore   — fusion à trois (appareil / serveur / dernière synchro), pure
                     → testables avec Node (tests/sync.test.js)
     C. Sync       — connexion Supabase (REST), envoi / réception, interface

   Confidentialité : tout est chiffré dans le navigateur AVANT l'envoi. Supabase
   ne reçoit que l'e-mail du compte et un bloc illisible. La phrase de
   chiffrement n'est jamais envoyée ni enregistrée : seule la clé qui en est
   dérivée reste sur l'appareil (IndexedDB, non exportable).
   L'URL et la clé « anon » ci-dessous sont publiques par conception : l'accès
   aux données est protégé par la RLS (une ligne par utilisateur) et les
   inscriptions sont désactivées côté Supabase.
   ========================================================================== */
'use strict';

const SUPABASE = {
  url: 'https://gwsomltfixhoikwkpqmd.supabase.co',
  key: 'sb_publishable_ZtC6h8l38XYDa8WXo1-Zmw_tIrTIhmh', // clé publishable (jamais la clé secret / service_role)
};

/* ==========================================================================
   A. CHIFFREMENT
   ========================================================================== */
const SyncCrypto = (() => {
  const ITERATIONS = 600000;
  const FORMAT = 'budget-patrimoine-chiffre';
  const subtle = () => globalThis.crypto.subtle;

  function toB64(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const s = atob(String(str));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const randomB64 = (n) => toB64(globalThis.crypto.getRandomValues(new Uint8Array(n)));

  /** Clé AES-GCM 256 (non exportable) dérivée de la phrase et du sel. */
  async function deriveKey(passphrase, saltB64, iterations = ITERATIONS) {
    if (!passphrase) throw new Error('Phrase de chiffrement vide.');
    const base = await subtle().importKey('raw', new TextEncoder().encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  /** Objet → { iv, data } (base64). */
  async function encrypt(key, obj) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { iv: toB64(iv), data: toB64(data) };
  }

  /** { iv, data } → objet. Mauvaise phrase ou données modifiées → erreur claire. */
  async function decrypt(key, box) {
    let plain;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
    } catch (e) {
      throw new Error('Déchiffrement impossible : phrase de chiffrement incorrecte (ou données abîmées).');
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** Fichier de sauvegarde autonome (sel et paramètres inclus). */
  async function makeEnvelope(passphrase, obj, iterations = ITERATIONS) {
    const salt = randomB64(16);
    const key = await deriveKey(passphrase, salt, iterations);
    const box = await encrypt(key, obj);
    return { format: FORMAT, v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt }, cipher: 'AES-GCM', ...box };
  }

  async function openEnvelope(passphrase, env) {
    if (!env || env.format !== FORMAT || !env.kdf || !env.iv || !env.data) throw new Error('Ce fichier n\'est pas une sauvegarde chiffrée de l\'appli.');
    const key = await deriveKey(passphrase, env.kdf.salt, Number(env.kdf.iterations) || ITERATIONS);
    return decrypt(key, env);
  }

  return { ITERATIONS, FORMAT, toB64, fromB64, randomB64, deriveKey, encrypt, decrypt, makeEnvelope, openEnvelope };
})();

/* ==========================================================================
   B. FUSION
   ========================================================================== */
const SyncCore = (() => {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Fusion à trois d'une liste d'éléments identifiés par keyFn.
   * - modifié d'un seul côté → cette version ; des deux côtés → celle de l'appareil
   * - ajouté d'un côté → gardé ; supprimé d'un côté (et pas modifié de l'autre) → supprimé
   * Ordre : celui de l'appareil, puis les ajouts du serveur.
   */
  function mergeList(base, local, remote, keyFn) {
    const idx = (list) => new Map((Array.isArray(list) ? list : []).map((x) => [keyFn(x), x]));
    const B = idx(base); const L = idx(local); const R = idx(remote);
    const out = [];
    const pick = (k) => {
      const b = B.get(k); const l = L.get(k); const r = R.get(k);
      if (l !== undefined && r !== undefined) return same(l, b) ? r : l;
      if (l !== undefined) return b !== undefined && same(l, b) ? undefined : l; // absent du serveur
      if (r !== undefined) return b !== undefined && same(r, b) ? undefined : r; // absent de l'appareil
      return undefined;
    };
    for (const k of L.keys()) { const v = pick(k); if (v !== undefined) out.push(v); }
    for (const k of R.keys()) { if (!L.has(k)) { const v = pick(k); if (v !== undefined) out.push(v); } }
    return out;
  }

  /** Fusion champ par champ : listes connues via specs, autres valeurs en bloc. */
  function mergeObject(base, local, remote, specs) {
    const b = base || {}; const l = local || {}; const r = remote || {};
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      if (specs[k]) out[k] = mergeList(b[k], l[k], r[k], specs[k]);
      else if (!(k in r)) out[k] = l[k];
      else if (!(k in l)) out[k] = r[k];
      else out[k] = same(l[k], b[k]) ? r[k] : l[k];
    }
    return out;
  }

  const byId = (x) => String(x && x.id);
  const BUDGET_SPECS = {
    transactions: byId, accounts: byId,
    history: (x) => x.month,
    assets: byId,
    rules: (x) => `${String(x.match).toLowerCase()}|${x.sign || ''}`,
    categories: (x) => x.name,
  };
  const PEA_SPECS = { purchases: byId, deposits: byId, sales: byId, moves: byId };

  /**
   * Données complètes : { budget, pea }. base = dernière version synchronisée (ou null).
   * normalize (facultatif) ramène les trois copies à la même forme avant de les comparer : sans cela,
   * un champ ajouté par une mise à jour de l'appli ou un ordre de clés différent fait croire qu'un élément
   * a été « modifié » et une suppression faite sur un autre appareil est annulée.
   */
  function merge(base, local, remote, normalize) {
    if (!remote) return local;
    if (!local) return remote;
    if (normalize) { base = base ? normalize(base) : base; local = normalize(local); remote = normalize(remote); }
    const b = base || {};
    return {
      budget: mergeObject(b.budget, local.budget, remote.budget, BUDGET_SPECS),
      pea: mergeObject(b.pea, local.pea, remote.pea, PEA_SPECS),
    };
  }

  return { same, mergeList, mergeObject, merge };
})();

/* ==========================================================================
   C. CONNEXION ET INTERFACE
   ========================================================================== */
const Sync = {
  SESSION_KEY: 'budget-patrimoine:sync:session',
  BASE_KEY: 'budget-patrimoine:sync:base',   // dernière version synchronisée (en clair, comme le reste des données locales)
  META_KEY: 'budget-patrimoine:sync:meta',   // { rev, salt, iterations, lastSync }
  DB_NAME: 'budget-patrimoine-sync',

  session: null,   // { access_token, refresh_token, expires_at, user: {id, email} }
  key: null,       // CryptoKey
  meta: null,
  busy: false,
  timer: null,
  pendingPush: false,

  $: (id) => document.getElementById(id),
  configured: () => !!(SUPABASE.url && SUPABASE.key),

  /* ---------- Démarrage ---------- */
  async init() {
    Sync.session = Sync.readJSON(Sync.SESSION_KEY);
    Sync.meta = Sync.readJSON(Sync.META_KEY);
    Sync.bind();
    if (Sync.session && Sync.configured()) {
      try { Sync.key = await Sync.loadKey(); } catch (e) { Sync.key = null; }
    }
    Sync.render();
    if (Sync.ready()) Sync.syncNow({ silent: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Sync.ready()) Sync.syncNow({ silent: true });
    });
  },

  ready: () => !!(Sync.configured() && Sync.session && Sync.key),

  readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  writeJSON(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Stockage impossible', e); } },

  /* ---------- Clé sur l'appareil (IndexedDB) ---------- */
  idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(Sync.DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async saveKey(key) {
    try {
      const db = await Sync.idb();
      await new Promise((res, rej) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(key, 'vault'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn('Clé gardée en mémoire seulement', e); }
  },
  async loadKey() {
    const db = await Sync.idb();
    return new Promise((res, rej) => { const r = db.transaction('keys').objectStore('keys').get('vault'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
  },
  async forgetKey() {
    try { const db = await Sync.idb(); db.transaction('keys', 'readwrite').objectStore('keys').delete('vault'); } catch (e) { /* rien */ }
  },

  /* ---------- Supabase (REST) ---------- */
  async api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    if (auth) await Sync.ensureFreshToken();
    const res = await fetch(SUPABASE.url.replace(/\/$/, '') + path, {
      method,
      headers: {
        apikey: SUPABASE.key,
        'Content-Type': 'application/json',
        ...(auth && Sync.session ? { Authorization: `Bearer ${Sync.session.access_token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      const msg = (json && (json.msg || json.message || json.error_description || json.error)) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; err.code = json && json.code; throw err;
    }
    return json;
  },

  storeSession(s) {
    Sync.session = {
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      user: { id: s.user.id, email: s.user.email },
    };
    Sync.writeJSON(Sync.SESSION_KEY, Sync.session);
  },

  async signIn(email, password) {
    const s = await Sync.api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false });
    Sync.storeSession(s);
  },

  async ensureFreshToken() {
    const s = Sync.session;
    if (!s) throw new Error('Non connecté.');
    if (s.expires_at - 60 > Date.now() / 1000) return;
    try {
      const n = await Sync.api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token }, auth: false });
      Sync.storeSession(n);
    } catch (e) {
      if (e.status === 400 || e.status === 401) { Sync.session = null; Sync.writeJSON(Sync.SESSION_KEY, null); Sync.render(); }
      throw e;
    }
  },

  async fetchVault() {
    const rows = await Sync.api(`/rest/v1/vault?select=salt,iterations,iv,data,rev,updated_at&user_id=eq.${Sync.session.user.id}`);
    return rows && rows[0] ? rows[0] : null;
  },

  /** Envoi avec contrôle de version : refusé si un autre appareil a écrit entre-temps. */
  async writeVault(box, rev) {
    const device = (navigator.userAgent.match(/iPhone|iPad|Macintosh|Windows|Android/) || ['?'])[0];
    if (rev === 0) {
      try {
        await Sync.api('/rest/v1/vault', { method: 'POST', body: { salt: Sync.meta.salt, iterations: Sync.meta.iterations, ...box, rev: 1, device }, headers: { Prefer: 'return=minimal' } });
        return 1;
      } catch (e) { if (e.status === 409) return null; throw e; }
    }
    const rows = await Sync.api(`/rest/v1/vault?user_id=eq.${Sync.session.user.id}&rev=eq.${rev}`, {
      method: 'PATCH', body: { ...box, rev: rev + 1, device, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' },
    });
    return rows && rows.length ? rev + 1 : null;
  },

  /* ---------- Données locales ---------- */
  snapshot() { return { budget: Budget.state, pea: App.state }; },

  /** Même forme pour toutes les copies (appareil, serveur, dernière synchro) : celle de l'appli à jour. */
  normalize(data) { return { budget: BudgetStore.clean(data.budget).state, pea: Store.clean(data.pea).state }; },

  applyLocal(data) {
    Budget.state = BudgetStore.clean(data.budget).state;
    App.state = Store.clean(data.pea).state;
    Sync.saveQuietly();
    Budget.render();
    App.renderAll();
  },

  /** Sauvegarde locale sans relancer un envoi. */
  saveQuietly() {
    Sync.muted = true;
    try { Budget.persist(); App.persist(); } finally { Sync.muted = false; }
  },

  /** Appelé à chaque sauvegarde locale : envoi groupé quelques secondes plus tard. */
  schedule() {
    if (Sync.muted || !Sync.ready()) return;
    clearTimeout(Sync.timer);
    Sync.timer = setTimeout(() => Sync.syncNow({ silent: true }), 4000);
  },

  /**
   * Synchronise : lit le serveur, fusionne, envoie si besoin. Recommence si un
   * autre appareil a écrit pendant ce temps (au plus 3 fois).
   */
  async syncNow({ silent = false } = {}) {
    if (!Sync.ready()) return;
    if (Sync.busy) { Sync.pendingPush = true; return; }
    Sync.busy = true; Sync.setStatus('Synchronisation…');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await Sync.fetchVault();
        const base = Sync.readJSON(Sync.BASE_KEY);
        const local = Sync.normalize(Sync.snapshot());
        let merged = local; let rev = 0;
        if (row) {
          const remote = Sync.normalize(await SyncCrypto.decrypt(Sync.key, row));
          merged = SyncCore.merge(base, local, remote, Sync.normalize);
          rev = Number(row.rev);
          if (!SyncCore.same(merged, local)) Sync.applyLocal(merged);
          if (SyncCore.same(merged, remote)) { Sync.done(merged, rev); break; }
        }
        const newRev = await Sync.writeVault(await SyncCrypto.encrypt(Sync.key, merged), rev);
        if (newRev) { Sync.done(merged, newRev); break; }
        if (attempt === 2) throw new Error('Conflit persistant avec un autre appareil, réessayez.');
      }
      if (!silent) Budget.toast('Synchronisé');
    } catch (e) {
      console.warn('Synchronisation impossible', e);
      Sync.setStatus(`Échec : ${e.message}`);
      if (!silent) alert('Synchronisation impossible : ' + e.message);
    } finally {
      Sync.busy = false;
      if (Sync.pendingPush) { Sync.pendingPush = false; Sync.schedule(); }
    }
  },

  done(data, rev) {
    Sync.writeJSON(Sync.BASE_KEY, data);
    Sync.meta = { ...Sync.meta, rev, lastSync: new Date().toISOString() };
    Sync.writeJSON(Sync.META_KEY, Sync.meta);
    Sync.render();
  },

  /* ---------- Interface ---------- */
  bind() {
    Sync.$('sync-login').addEventListener('submit', Sync.onLogin);
    Sync.$('sync-unlock').addEventListener('submit', Sync.onUnlock);
    Sync.$('btn-sync-now').addEventListener('click', () => Sync.syncNow());
    Sync.$('btn-sync-logout').addEventListener('click', Sync.logout);
    Sync.$('btn-export-encrypted').addEventListener('click', Sync.exportEncrypted);
    Sync.$('encrypted-import-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Sync.importEncrypted(f); });
  },

  setStatus(msg) { const el = Sync.$('sync-status'); if (el) el.textContent = msg; },

  render() {
    const conf = Sync.configured();
    Sync.$('sync-unconfigured').hidden = conf;
    Sync.$('sync-login').hidden = !conf || !!Sync.session;
    Sync.$('sync-unlock').hidden = !conf || !Sync.session || !!Sync.key;
    Sync.$('sync-connected').hidden = !Sync.ready();
    if (Sync.session) Sync.$('sync-email').textContent = Sync.session.user.email;
    const last = Sync.meta && Sync.meta.lastSync;
    Sync.setStatus(last ? `Dernière synchro : ${new Date(last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Jamais synchronisé sur cet appareil.');
  },

  showError(id, msg) { const el = Sync.$(id); el.textContent = msg; el.hidden = !msg; },

  async onLogin(ev) {
    ev.preventDefault();
    const f = ev.target;
    Sync.showError('sync-login-error', '');
    try {
      await Sync.signIn(f.email.value.trim(), f.password.value);
      f.password.value = '';
      // Coffre déjà créé ? → phrase à saisir ; sinon → phrase à choisir (et confirmer)
      const row = await Sync.fetchVault();
      Sync.pendingRow = row;
      Sync.$('sync-confirm-wrap').hidden = !!row;
      Sync.$('sync-unlock-hint').textContent = row
        ? 'Saisissez votre phrase de chiffrement pour déverrouiller les données.'
        : 'Première connexion : choisissez une phrase de chiffrement (longue, différente du mot de passe). Sans elle, les données synchronisées sont perdues.';
      Sync.render();
    } catch (e) {
      const msg = /invalid login credentials/i.test(e.message) ? 'e-mail ou mot de passe incorrect (ceux du compte créé dans Supabase).'
        : /email not confirmed/i.test(e.message) ? 'e-mail non confirmé (cochez « Auto Confirm User » dans Supabase).' : e.message;
      Sync.showError('sync-login-error', 'Connexion impossible : ' + msg);
    }
  },

  async onUnlock(ev) {
    ev.preventDefault();
    const f = ev.target;
    const pass = f.passphrase.value;
    Sync.showError('sync-unlock-error', '');
    try {
      const row = Sync.pendingRow !== undefined ? Sync.pendingRow : await Sync.fetchVault();
      if (!row) {
        if (pass.length < 12) throw new Error('12 caractères minimum.');
        if (pass !== f.confirm.value) throw new Error('Les deux phrases ne correspondent pas.');
        Sync.meta = { salt: SyncCrypto.randomB64(16), iterations: SyncCrypto.ITERATIONS, rev: 0 };
        Sync.key = await SyncCrypto.deriveKey(pass, Sync.meta.salt, Sync.meta.iterations);
      } else {
        const key = await SyncCrypto.deriveKey(pass, row.salt, Number(row.iterations));
        await SyncCrypto.decrypt(key, row); // vérifie la phrase avant de garder la clé
        Sync.key = key;
        Sync.meta = { salt: row.salt, iterations: Number(row.iterations), rev: 0 };
        // Appareil qui rejoint : pas de « dernière synchro » → fusion sans base (rien n'est supprimé)
        Sync.writeJSON(Sync.BASE_KEY, null);
      }
      Sync.writeJSON(Sync.META_KEY, Sync.meta);
      f.passphrase.value = ''; f.confirm.value = '';
      Sync.pendingRow = undefined;
      await Sync.saveKey(Sync.key);
      Sync.render();
      await Sync.syncNow();
    } catch (e) { Sync.showError('sync-unlock-error', e.message); }
  },

  async logout() {
    if (!confirm('Se déconnecter sur cet appareil ? Les données restent sur l\'appareil, la synchro s\'arrête.')) return;
    try { await Sync.api('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* hors ligne : tant pis */ }
    Sync.session = null; Sync.key = null;
    Sync.writeJSON(Sync.SESSION_KEY, null); Sync.writeJSON(Sync.BASE_KEY, null); Sync.writeJSON(Sync.META_KEY, null);
    await Sync.forgetKey();
    Sync.render();
  },

  /* ---------- Sauvegarde chiffrée (secours, sans Supabase) ---------- */
  askPassphrase(msg) {
    const p = prompt(msg);
    return p === null ? null : p;
  },

  async exportEncrypted() {
    const p = Sync.askPassphrase('Phrase de chiffrement pour ce fichier (12 caractères minimum) :');
    if (p === null) return;
    if (p.length < 12) { alert('12 caractères minimum.'); return; }
    if (Sync.askPassphrase('Confirmez la phrase :') !== p) { alert('Les deux phrases ne correspondent pas.'); return; }
    try {
      const env = await SyncCrypto.makeEnvelope(p, Sync.snapshot());
      Budget.download(`budget-patrimoine-chiffre-${Dates.today()}.json`, JSON.stringify(env));
      Budget.state.lastEncryptedExport = Dates.today(); // pour le rappel de sauvegarde
      Budget.persist();
      Budget.renderReminders();
      Budget.toast('Sauvegarde chiffrée exportée');
    } catch (e) { alert('Export impossible : ' + e.message); }
  },

  importEncrypted(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const env = JSON.parse(reader.result);
        const p = Sync.askPassphrase('Phrase de chiffrement de ce fichier :');
        if (p === null) return;
        const data = await SyncCrypto.openEnvelope(p, env);
        if (!data || !data.budget || !data.pea) throw new Error('Contenu inattendu.');
        if (!confirm('Remplacer toutes les données de cet appareil (budget, comptes, PEA) par cette sauvegarde ?')) return;
        Sync.applyLocal(data);
        Sync.schedule();
        Budget.toast('Sauvegarde chiffrée importée');
      } catch (e) { alert('Import impossible : ' + e.message); }
    };
    reader.readAsText(file);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SyncCrypto, SyncCore, SUPABASE };
}
