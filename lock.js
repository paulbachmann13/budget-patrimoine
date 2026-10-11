/* ==========================================================================
   Budget & Patrimoine — verrouillage (code + Face ID / Touch ID)
   --------------------------------------------------------------------------
     A. LockCore — calculs purs (code, délais) → testables avec Node (tests/lock.test.js)
     B. Lock     — écran de verrouillage, réglages, Face ID (WebAuthn, passkey de l'appareil)

   C'est un verrou d'accès : il empêche d'ouvrir l'appli sans le code ou Face ID.
   Les données restent stockées sur l'appareil comme avant (pas de chiffrement
   supplémentaire). Le code n'est jamais enregistré : seule son empreinte PBKDF2.
   Réglage propre à chaque appareil (pas synchronisé).
   ========================================================================== */
'use strict';

/* ==========================================================================
   A. CALCULS PURS
   ========================================================================== */
const LockCore = (() => {
  const ITERATIONS = 150000;
  const DELAYS = [0, 1, 5, 15]; // minutes avant reverrouillage quand l'appli passe en arrière-plan

  const validPin = (pin) => /^\d{4,6}$/.test(String(pin || ''));

  const toB64 = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  const fromB64 = (str) => { const s = atob(String(str)); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  const randomB64 = (n) => toB64(globalThis.crypto.getRandomValues(new Uint8Array(n)));

  /** Empreinte du code (PBKDF2-SHA-256) en base64. */
  async function hashPin(pin, saltB64, iterations = ITERATIONS) {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations }, key, 256);
    return toB64(bits);
  }

  /** Comparaison sans court-circuit (temps constant). */
  function sameHash(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** Attente imposée après des erreurs : rien jusqu'à 4, puis 30 s, 1 min, 2 min… (15 min au plus). */
  function backoffMs(failures) {
    if (failures < 5) return 0;
    return Math.min(15 * 60000, 30000 * 2 ** (failures - 5));
  }

  /** Faut-il reverrouiller au retour ? delayMin = minutes tolérées en arrière-plan. */
  function shouldRelock(hiddenAt, now, delayMin) {
    if (!hiddenAt) return false;
    return now - hiddenAt >= (Number(delayMin) || 0) * 60000;
  }

  return { ITERATIONS, DELAYS, validPin, toB64, fromB64, randomB64, hashPin, sameHash, backoffMs, shouldRelock };
})();

/* ==========================================================================
   B. ÉCRAN DE VERROUILLAGE ET RÉGLAGES
   ========================================================================== */
const Lock = {
  KEY: 'budget-patrimoine:lock', // { enabled, hash, salt, iterations, credentialId, delay, failures, blockedUntil }
  cfg: null,
  locked: false,
  entry: '',
  hiddenAt: 0,
  onUnlock: null, // action en attente d'un déverrouillage (désactivation…)

  $: (id) => document.getElementById(id),

  read() { try { return JSON.parse(localStorage.getItem(Lock.KEY)) || {}; } catch (e) { return {}; } },
  write() { try { localStorage.setItem(Lock.KEY, JSON.stringify(Lock.cfg)); } catch (e) { console.warn('Réglage du verrou non enregistré', e); } },

  /** Appelé dès le chargement du script : masque le contenu avant tout affichage. */
  early() {
    Lock.cfg = Lock.read();
    if (Lock.cfg.enabled && typeof document !== 'undefined') document.documentElement.classList.add('locked');
  },

  init() {
    Lock.cfg = Lock.read();
    Lock.bind();
    Lock.renderSettings();
    if (Lock.cfg.enabled) Lock.lock();
    document.addEventListener('visibilitychange', () => {
      if (!Lock.cfg.enabled) return;
      if (document.hidden) {
        Lock.hiddenAt = Date.now();
        document.documentElement.classList.add('privacy'); // rien de visible dans le sélecteur d'applis
      } else {
        document.documentElement.classList.remove('privacy');
        if (!Lock.locked && LockCore.shouldRelock(Lock.hiddenAt, Date.now(), Lock.cfg.delay)) Lock.lock();
      }
    });
  },

  bind() {
    Lock.$('lock-keys').addEventListener('click', (e) => {
      const k = e.target.closest('button'); if (!k) return;
      if (k.dataset.k === 'del') Lock.entry = Lock.entry.slice(0, -1);
      else if (k.dataset.k === 'bio') { Lock.biometric(); return; } else if (Lock.entry.length < Lock.pinLength()) Lock.entry += k.dataset.k;
      Lock.renderDots();
      if (Lock.entry.length === Lock.pinLength()) Lock.tryPin();
    });
    document.addEventListener('keydown', (e) => {
      if (!Lock.locked) return;
      if (/^\d$/.test(e.key) && Lock.entry.length < Lock.pinLength()) { Lock.entry += e.key; Lock.renderDots(); if (Lock.entry.length === Lock.pinLength()) Lock.tryPin(); }
      if (e.key === 'Backspace') { Lock.entry = Lock.entry.slice(0, -1); Lock.renderDots(); }
    });
    Lock.$('lock-forgot').addEventListener('click', Lock.forgot);
    Lock.$('lock-cancel').addEventListener('click', () => { Lock.onUnlock = null; Lock.hide(); });
    Lock.$('lock-form').addEventListener('submit', Lock.onSetup);
    Lock.$('btn-lock-now').addEventListener('click', () => Lock.lock());
    Lock.$('btn-lock-off').addEventListener('click', () => Lock.requireUnlock(() => { Lock.cfg = {}; Lock.write(); Lock.renderSettings(); Budget.toast('Verrouillage désactivé'); }));
    Lock.$('btn-lock-change').addEventListener('click', () => Lock.requireUnlock(() => { Lock.$('lock-form').hidden = false; Lock.$('lock-on').hidden = true; Lock.$('lock-form').pin.focus(); }));
    Lock.$('btn-lock-bio').addEventListener('click', Lock.enrollBiometric);
    Lock.$('lock-delay').addEventListener('change', (e) => { Lock.cfg.delay = Number(e.target.value); Lock.write(); });
  },

  /* ---------- Réglages ---------- */
  async renderSettings() {
    const on = !!Lock.cfg.enabled;
    Lock.$('lock-off').hidden = on;
    Lock.$('lock-on').hidden = !on;
    Lock.$('lock-form').hidden = on;
    Lock.$('lock-delay').value = String(Lock.cfg.delay || 0);
    const bioOk = await Lock.biometricAvailable();
    Lock.$('btn-lock-bio').hidden = !on || !bioOk || !!Lock.cfg.credentialId;
    Lock.$('lock-status').textContent = on
      ? `Activé · code${Lock.cfg.credentialId ? ' + Face ID / Touch ID' : ''}`
      : '';
    Lock.$('lock-bio-hint').textContent = !bioOk ? 'Face ID / Touch ID indisponible sur cet appareil ou ce navigateur : le code suffit.' : '';
  },

  async onSetup(ev) {
    ev.preventDefault();
    const f = ev.target;
    const err = Lock.$('lock-error');
    const pin = f.pin.value; const confirm2 = f.confirm.value;
    if (!LockCore.validPin(pin)) { err.textContent = 'Le code doit faire 4 à 6 chiffres.'; err.hidden = false; return; }
    if (pin !== confirm2) { err.textContent = 'Les deux codes ne correspondent pas.'; err.hidden = false; return; }
    err.hidden = true;
    const salt = LockCore.randomB64(16);
    const hash = await LockCore.hashPin(pin, salt);
    Lock.cfg = { ...Lock.cfg, enabled: true, hash, salt, length: pin.length, iterations: LockCore.ITERATIONS, delay: Lock.cfg.delay || 0, failures: 0, blockedUntil: 0 };
    Lock.write();
    f.reset();
    await Lock.renderSettings();
    Budget.toast('Verrouillage activé');
    if (!Lock.cfg.credentialId && await Lock.biometricAvailable() && confirm('Utiliser aussi Face ID / Touch ID pour déverrouiller ?')) Lock.enrollBiometric();
  },

  /* ---------- Face ID / Touch ID (WebAuthn, authentificateur de l'appareil) ---------- */
  async biometricAvailable() {
    try {
      return !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
        && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) { return false; }
  },

  async enrollBiometric() {
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'Budget & Patrimoine', id: location.hostname },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'budget-patrimoine', displayName: 'Budget & Patrimoine (verrou)' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          timeout: 60000,
        },
      });
      Lock.cfg.credentialId = LockCore.toB64(cred.rawId);
      Lock.write();
      await Lock.renderSettings();
      Budget.toast('Face ID / Touch ID activé');
    } catch (e) {
      if (e.name !== 'NotAllowedError') alert('Face ID / Touch ID impossible à activer : ' + e.message);
    }
  },

  /** Demande Face ID / Touch ID ; vrai si l'utilisateur a bien été vérifié. */
  async biometric() {
    if (!Lock.cfg.credentialId) return false;
    try {
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: LockCore.fromB64(Lock.cfg.credentialId) }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      const flags = new Uint8Array(cred.response.authenticatorData)[32];
      if (!(flags & 0x04)) throw new Error('utilisateur non vérifié');
      Lock.success();
      return true;
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') Lock.showError('Face ID indisponible : utilisez le code.');
      return false;
    }
  },

  /* ---------- Écran de verrouillage ---------- */
  lock(mode = 'lock') {
    if (!Lock.cfg.enabled) return;
    Lock.locked = true;
    Lock.entry = '';
    document.documentElement.classList.add('locked');
    const scr = Lock.$('lock-screen');
    scr.hidden = false;
    Lock.$('lock-title').textContent = mode === 'confirm' ? 'Confirmez avec votre code' : 'Budget & Patrimoine';
    Lock.$('lock-cancel').hidden = mode !== 'confirm';
    Lock.$('lock-bio').hidden = !Lock.cfg.credentialId;
    Lock.showError('');
    Lock.renderDots();
    Lock.renderBlocked();
    if (Lock.cfg.credentialId && mode === 'lock') Lock.biometric(); // propose Face ID tout de suite (sinon : bouton)
  },

  hide() {
    Lock.locked = false;
    Lock.entry = '';
    Lock.$('lock-screen').hidden = true;
    document.documentElement.classList.remove('locked');
  },

  /** Exige un déverrouillage avant une action sensible (désactiver, changer le code). */
  requireUnlock(fn) {
    if (!Lock.cfg.enabled) { fn(); return; }
    Lock.onUnlock = fn;
    Lock.lock('confirm');
  },

  success() {
    Lock.cfg.failures = 0; Lock.cfg.blockedUntil = 0; Lock.write();
    const fn = Lock.onUnlock; Lock.onUnlock = null;
    Lock.hide();
    if (fn) fn();
  },

  /** Longueur du code choisi (4 à 6) : la vérification se fait dès qu'elle est atteinte. */
  pinLength() { return Lock.cfg.length >= 4 && Lock.cfg.length <= 6 ? Lock.cfg.length : 4; },

  renderDots() {
    const dots = Lock.$('lock-dots');
    dots.replaceChildren(...Array.from({ length: Lock.pinLength() }, (_, i) => {
      const s = document.createElement('span');
      s.className = i < Lock.entry.length ? 'on' : '';
      return s;
    }));
  },

  showError(msg) { const e = Lock.$('lock-error-screen'); e.textContent = msg; },

  renderBlocked() {
    const left = (Lock.cfg.blockedUntil || 0) - Date.now();
    const keys = Lock.$('lock-keys');
    keys.classList.toggle('disabled', left > 0);
    if (left > 0) {
      Lock.showError(`Trop d'essais : réessayez dans ${Math.ceil(left / 1000)} s.`);
      clearTimeout(Lock._t); Lock._t = setTimeout(Lock.renderBlocked, 1000);
    } else if (keys.dataset.wasBlocked) Lock.showError('');
    keys.dataset.wasBlocked = left > 0 ? '1' : '';
  },

  async tryPin() {
    if ((Lock.cfg.blockedUntil || 0) > Date.now()) { Lock.entry = ''; Lock.renderDots(); return; }
    const pin = Lock.entry;
    const hash = await LockCore.hashPin(pin, Lock.cfg.salt, Lock.cfg.iterations || LockCore.ITERATIONS);
    if (LockCore.sameHash(hash, Lock.cfg.hash)) { Lock.success(); return; }
    Lock.cfg.failures = (Lock.cfg.failures || 0) + 1;
    const wait = LockCore.backoffMs(Lock.cfg.failures);
    Lock.cfg.blockedUntil = wait ? Date.now() + wait : 0;
    Lock.write();
    Lock.entry = '';
    Lock.renderDots();
    Lock.$('lock-dots').classList.remove('shake'); void Lock.$('lock-dots').offsetWidth; Lock.$('lock-dots').classList.add('shake');
    Lock.showError('Code incorrect.');
    Lock.renderBlocked();
  },

  /** Code oublié : efface les données de CET appareil (elles reviennent par la synchronisation). */
  async forgot() {
    const msg = 'Code oublié : effacer toutes les données de cet appareil ?\n\n'
      + 'Si la synchronisation est active, elles reviendront en vous reconnectant (e-mail, mot de passe, phrase de chiffrement). '
      + 'Sinon, seule une sauvegarde chiffrée permet de les récupérer.';
    if (!confirm(msg) || !confirm('Confirmer l\'effacement des données de cet appareil ?')) return;
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('budget-patrimoine:')).forEach((k) => localStorage.removeItem(k));
      if (window.indexedDB) indexedDB.deleteDatabase('budget-patrimoine-sync');
    } catch (e) { /* rien */ }
    location.reload();
  },
};

if (typeof document !== 'undefined') Lock.early();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LockCore };
}
