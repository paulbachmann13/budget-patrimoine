/* ==========================================================================
   Budget & Patrimoine — module Budget
   --------------------------------------------------------------------------
   Organisation :
     A. BudgetCore  — calculs purs (CSV, dates, montants, catégories, synthèses)
                      → sans DOM, testables avec Node (tests/budget.test.js)
     B. BudgetStore — stockage local (localStorage) + export / import JSON
     C. Budget      — interface (onglets Patrimoine et Budget)

   Confidentialité : les transactions restent dans le navigateur (localStorage).
   Aucune donnée bancaire ne doit être mise dans le dépôt GitHub : les règles
   personnelles (noms de commerçants, de personnes) s'importent depuis un
   fichier JSON gardé à part (voir « Règles de catégorisation »).
   ========================================================================== */
'use strict';

/* ==========================================================================
   A. CALCULS PURS
   ========================================================================== */
const BudgetCore = (() => {
  const NEUTRAL = 'neutre';
  const AID = 'aide'; // revenu reçu (aide familiale…) : compté dans les revenus, mais affiché à part
  const KINDS = ['depense', 'revenu', AID, NEUTRAL];

  /** Catégories de départ. kind : 'depense' | 'revenu' | 'aide' | 'neutre' (hors totaux). */
  const DEFAULT_CATEGORIES = [
    { name: 'Alimentation & restauration', kind: 'depense' },
    { name: 'Bar / Café', kind: 'depense' },
    { name: 'Transport', kind: 'depense' },
    { name: 'Carburant', kind: 'depense' },
    { name: 'Logement & factures', kind: 'depense' },
    { name: 'Abonnements', kind: 'depense' },
    { name: 'Santé', kind: 'depense' },
    { name: 'Sport / Loisirs', kind: 'depense' },
    { name: 'Shopping', kind: 'depense' },
    { name: 'Voyages', kind: 'depense' },
    { name: 'Études', kind: 'depense' },
    { name: 'Espèces', kind: 'depense' },
    { name: 'Frais bancaires', kind: 'depense' },
    { name: "Jeux d'argent", kind: 'depense' },
    { name: 'Autre dépense', kind: 'depense' },
    { name: 'Salaire', kind: 'revenu' },
    { name: 'Remboursement', kind: 'revenu' },
    { name: 'Virements reçus', kind: 'revenu' },
    { name: 'Autre revenu', kind: 'revenu' },
    { name: 'Épargne / placements', kind: NEUTRAL },
    { name: 'Virement interne', kind: NEUTRAL },
  ];
  const UNCATEGORIZED = 'À catégoriser';

  /** Règles génériques (aucune donnée personnelle). Les règles de l'utilisateur passent avant. */
  const DEFAULT_RULES = [
    // Alimentation & restauration
    // (un mot suivi d'une espace = mot entier : « esso » ne doit pas attraper « espresso »)
    ...['carrefour', 'leclerc', 'auchan', 'lidl', 'intermarche', 'monoprix', 'franprix', 'picard', 'super u', 'u express', 'casino shop', 'biocoop', 'aldi ', 'netto ', 'boulangerie', 'boucherie', 'mcdo', 'mc donald', 'burger king', 'kfc', 'quick ', 'subway', 'uber eats', 'deliveroo', 'just eat', 'restaurant', 'sushi', 'pizza', 'kebab', 'tacos', 'crous', 'eurest', 'sodexo', 'izly', 'swile', 'edeka', 'rewe ', 'scheck-in', 'kaufland', 'penny ']
      .map((m) => ({ match: m, category: 'Alimentation & restauration' })),
    ...['bar ', 'cafe', 'brasserie', 'pub ', 'starbucks', 'coffee'].map((m) => ({ match: m, category: 'Bar / Café' })),
    // Transport & carburant
    ...['total energies', 'totalenergies', 'esso ', 'shell ', 'station service', 'carburant', 'avia ', 'aral '].map((m) => ({ match: m, category: 'Carburant' })),
    ...['sncf', 'ouigo', 'ratp', 'tcl ', 'rtm ', 'blablacar', 'uber', 'bolt ', 'flixbus', 'peage', 'vinci autoroutes', 'sanef', 'aprr', 'asf ', 'navigo', 'ter ', 'trainline', 'easypark', 'parking', 'parkhaus', 'contipark', 'parken ', 'lavage', 'elephant bleu', 'norauto'].map((m) => ({ match: m, category: 'Transport' })),
    // Abonnements & factures
    ...['netflix', 'spotify', 'disney', 'canal+', 'youtube', 'apple.com/bill', 'icloud', 'google one', 'amazon prime', 'deezer', 'openai', 'anthropic', 'github'].map((m) => ({ match: m, category: 'Abonnements' })),
    ...['edf ', 'engie', 'loyer', 'free mobile', 'orange ', 'sfr ', 'bouygues', 'assurance', 'macif', 'maif', 'axa ', 'eau '].map((m) => ({ match: m, category: 'Logement & factures' })),
    // Santé, sport, shopping, voyages
    ...['pharmacie', 'docteur', 'medecin', 'dentiste', 'mutuelle', 'optique'].map((m) => ({ match: m, category: 'Santé' })),
    ...['decathlon', 'basic fit', 'basic-fit', 'fitness', 'padel', 'cinema', 'steam ', 'playstation', 'playtomic', 'helloasso', 'hello asso', 'shotgun', 'bowling', 'sony interactive'].map((m) => ({ match: m, category: 'Sport / Loisirs' })),
    ...['amazon', 'zalando', 'fnac', 'ikea', 'cdiscount', 'vinted', 'zara ', 'h&m', 'leroy merlin', 'darty', 'boulanger '].map((m) => ({ match: m, category: 'Shopping' })),
    ...['airbnb', 'booking', 'ryanair', 'easyjet', 'air france', 'transavia', 'hotel', 'lufthansa', 'edreams', 'opodo', 'expedia'].map((m) => ({ match: m, category: 'Voyages' })),
    // Revenus & épargne
    ...['salaire', 'salary', 'lohn', 'gehalt', 'paie ', 'gratification', 'indemnite stage'].map((m) => ({ match: m, category: 'Salaire', sign: 'in' })),
    ...['bforbank', 'livret', 'pea ', 'trade republic', 'boursorama bourse'].map((m) => ({ match: m, category: 'Épargne / placements' })),
    // Banque : espèces, frais, jeux
    ...['retrait au distributeur', 'retrait dab', 'retrait especes'].map((m) => ({ match: m, category: 'Espèces' })),
    { match: "versement d'especes", category: 'Virement interne' },
    ...['cotisation offre', 'frais bancaires', 'frais de tenue', 'agios', 'commission '].map((m) => ({ match: m, category: 'Frais bancaires' })),
    ...['winamax', 'betclic', 'unibet', 'pari mutuel', 'pmu ', 'parions sport', 'fdj ', 'francaise des jeux'].map((m) => ({ match: m, category: "Jeux d'argent" })),
    // En dernier : tout virement reçu non reconnu (libellé du Crédit Agricole)
    { match: 'virement en votre faveur', category: 'Virements reçus', sign: 'in' },
  ];

  /* ---------- Texte ---------- */

  /** Minuscules, sans accents ni numéros de carte / dates : sert à comparer des libellés. */
  function normLabel(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\b(paiement|achat)?\s*(par\s*)?(cb|carte)\b\s*(x{0,2}\d{3,4})?/g, ' ')
      .replace(/\b\d{2}[\/.-]\d{2}([\/.-]\d{2,4})?\b/g, ' ')
      .replace(/\bx{2,}\d+\b/g, ' ')
      .replace(/[^a-z0-9&+'.\/ -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Clé de règle « apprise » à partir d'un libellé : les 2 premiers mots utiles, consécutifs
   * (la clé doit se retrouver telle quelle dans les libellés similaires). Les types
   * d'opération (« Virement en votre faveur », « Wero vers », « WEB M. »…) sont sautés.
   */
  function ruleKey(label) {
    const stop = new Set(['prlv', 'vir', 'virement', 'sepa', 'de', 'du', 'la', 'le', 'les', 'des', 'a', 'et', 'achat', 'paiement', 'par', 'retrait', 'inst', 'instantane', 'recu', 'emis',
      'en', 'votre', 'faveur', 'vers', 'web', 'wero', 'au', 'ou', 'm', 'mme', 'mr', 'mle', 'mlle', 'prelevement', 'cotisation', 'avoir']);
    const useful = (w) => {
      const b = (w || '').replace(/[.'\/-]+$/, '');
      return b.length > 1 && !/^\d+$/.test(b) && !stop.has(b);
    };
    const words = normLabel(label).split(' ');
    const i = words.findIndex(useful);
    if (i < 0) return '';
    return useful(words[i + 1]) ? `${words[i]} ${words[i + 1]}` : words[i];
  }

  /* ---------- Dates & montants ---------- */

  /** '12/03/2026', '12-03-26', '2026-03-12', '12.03.2026 14:05' → 'AAAA-MM-JJ' ou null. */
  function parseDate(raw) {
    const s = String(raw || '').trim();
    let y; let m; let d;
    let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (r) { y = +r[1]; m = +r[2]; d = +r[3]; } else {
      r = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})(?!\d)/);
      if (!r) return null;
      d = +r[1]; m = +r[2]; y = +r[3];
      if (y < 100) y += 2000;
    }
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /** '-1 234,56 €', '12.50', '(15,00)', '12,30-', '+20,00' → nombre ou NaN. */
  function parseAmount(raw) {
    if (typeof raw === 'number') return raw;
    let s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[\s  €]|eur\b/gi, '').replace(/^\+/, '').replace('−', '-');
    if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (!/^-?[\d.,]+$/.test(s)) return NaN;
    const hasC = s.includes(','); const hasD = s.includes('.');
    if (hasC && hasD) {
      const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      const thou = dec === ',' ? '.' : ',';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (hasC) {
      if ((s.match(/,/g) || []).length > 1) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (hasD && (s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, ''); // 1.234.567 : points = milliers
    } // un seul point (« 1.234 ») reste un décimal
    const v = Number(s);
    if (!Number.isFinite(v)) return NaN;
    return neg ? -Math.abs(v) : v;
  }

  /* ---------- CSV ---------- */

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
    let best = ';'; let bestScore = -1;
    for (const d of [';', '\t', ',', '|']) {
      const counts = lines.map((l) => {
        let n = 0; let q = false;
        for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
        return n;
      });
      const nz = counts.filter((c) => c > 0);
      if (!nz.length) continue;
      const freq = new Map();
      nz.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
      const [mode, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const score = times * 10 + mode; // beaucoup de lignes avec le même nombre de séparateurs
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function parseCsv(text, delim) {
    const t = String(text).replace(/^﻿/, '');
    const d = delim || detectDelimiter(t);
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) {
        if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    return { rows, delimiter: d };
  }

  /**
   * Devine la ligne d'en-tête et les colonnes (date, libellé, montant ou débit/crédit).
   * Retourne { headerRow, cols: {date, label, amount, debit, credit}, headers }.
   */
  function detectColumns(rows) {
    const norm = (s) => normLabel(s);
    const isDateHdr = (h) => /date/.test(h);
    let headerRow = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const hs = rows[i].map(norm);
      const hasDate = hs.some(isDateHdr);
      const hasAmt = hs.some((h) => /montant|amount|somme|debit|credit|valeur en euro/.test(h));
      const hasLabel = hs.some((h) => /libelle|label|description|intitule|detail|motif|operation/.test(h));
      if (hasDate && (hasAmt || hasLabel)) { headerRow = i; break; }
    }
    const cols = { date: -1, label: -1, amount: -1, debit: -1, credit: -1 };
    let headers = [];
    if (headerRow >= 0) {
      headers = rows[headerRow].map((h) => String(h).trim());
      const hs = headers.map(norm);
      const find = (...res) => { for (const re of res) { const i = hs.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
      cols.date = find(/date.*(operation|comptabilisation|completed|opération)/, /^date$/, /date(?!.*(valeur|value))/, /date/);
      cols.label = find(/^(label|libelle|description|intitule|detail|motif)\b/, /(libelle|label|description|intitule|detail|motif)/, /operation/);
      cols.debit = find(/debit/);
      cols.credit = find(/credit/);
      cols.amount = find(/^(montant|amount)\b/, /montant|amount|somme/);
      if (cols.amount >= 0 && cols.debit >= 0 && cols.credit >= 0 && /montant|amount/.test(hs[cols.amount]) === false) cols.amount = -1;
    } else {
      // Pas d'en-tête : on devine à partir du contenu
      const sample = rows.slice(0, 30);
      const width = Math.max(...sample.map((r) => r.length));
      const score = (fn) => Array.from({ length: width }, (_, c) => sample.filter((r) => r[c] !== undefined && fn(r[c])).length);
      const dScore = score((v) => parseDate(v));
      const aScore = score((v) => !parseDate(v) && !Number.isNaN(parseAmount(v)) && /[\d]/.test(v));
      const tLen = Array.from({ length: width }, (_, c) => sample.reduce((s, r) => s + (r[c] && Number.isNaN(parseAmount(r[c])) && !parseDate(r[c]) ? String(r[c]).length : 0), 0));
      cols.date = dScore.indexOf(Math.max(...dScore));
      cols.amount = aScore.indexOf(Math.max(...aScore));
      cols.label = tLen.indexOf(Math.max(...tLen));
      headers = Array.from({ length: width }, (_, i) => `Colonne ${i + 1}`);
    }
    return { headerRow, cols, headers };
  }

  /**
   * Transforme les lignes CSV en transactions { date, label, amount }.
   * Une ligne illisible est comptée dans skipped (jamais ignorée en silence).
   */
  function extractTransactions(rows, headerRow, cols) {
    const out = []; const skipped = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i];
      const date = cols.date >= 0 ? parseDate(r[cols.date]) : null;
      let amount = NaN;
      if (cols.amount >= 0) amount = parseAmount(r[cols.amount]);
      else if (cols.debit >= 0 || cols.credit >= 0) {
        const deb = cols.debit >= 0 ? parseAmount(r[cols.debit]) : NaN;
        const cre = cols.credit >= 0 ? parseAmount(r[cols.credit]) : NaN;
        if (!Number.isNaN(cre) && cre !== 0) amount = Math.abs(cre);
        else if (!Number.isNaN(deb) && deb !== 0) amount = -Math.abs(deb);
        else if (!Number.isNaN(deb) || !Number.isNaN(cre)) amount = 0;
      }
      const label = cols.label >= 0 ? String(r[cols.label] || '').replace(/\s+/g, ' ').trim() : '';
      if (!date || Number.isNaN(amount)) { skipped.push(i + 1); continue; }
      out.push({ date, label: label || '(sans libellé)', amount: Math.round(amount * 100) / 100 });
    }
    return { transactions: out, skipped };
  }

  /* ---------- Catégorisation ---------- */

  /** Catégorie d'après les règles (celles de l'utilisateur d'abord), ou UNCATEGORIZED. */
  function categorize(tx, userRules = [], defaultRules = DEFAULT_RULES) {
    const label = normLabel(tx.label) + ' ';
    for (const rule of [...userRules, ...defaultRules]) {
      const m = normLabel(rule.match);
      if (!m) continue;
      if (rule.sign === 'in' && !(tx.amount > 0)) continue;
      if (rule.sign === 'out' && !(tx.amount < 0)) continue;
      // « mot » suivi d'une espace = mot entier (début et fin) : « esso » n'attrape pas « espresso »
      if (rule.match.endsWith(' ') ? (' ' + label).includes(' ' + m + ' ') : label.includes(m)) return rule.category;
    }
    return UNCATEGORIZED;
  }

  function kindOf(category, categories) {
    const c = categories.find((x) => x.name === category);
    if (c) return c.kind;
    return 'depense';
  }

  /* ---------- Synthèses ---------- */

  const monthOf = (iso) => iso.slice(0, 7);

  /** Totaux d'un mois : revenus, dépenses, net, taux d'épargne, détail par catégorie. */
  function summarizeMonth(transactions, month, categories) {
    let income = 0; let aid = 0; let expense = 0; let neutralIn = 0; let neutralOut = 0;
    const byCat = new Map();
    for (const t of transactions) {
      if (monthOf(t.date) !== month) continue;
      const kind = t.category === UNCATEGORIZED ? (t.amount > 0 ? 'revenu' : 'depense') : kindOf(t.category, categories);
      if (kind === NEUTRAL) { if (t.amount > 0) neutralIn += t.amount; else neutralOut += -t.amount; continue; }
      byCat.set(t.category, (byCat.get(t.category) || 0) + t.amount);
      if (kind === 'revenu' || kind === AID) { income += t.amount; if (kind === AID) aid += t.amount; } else expense += -t.amount;
    }
    // Un remboursement positif dans une catégorie de dépenses réduit la dépense (déjà net via expense += -amount)
    const net = income - expense;
    const cats = [...byCat.entries()].map(([name, sum]) => ({ name, sum, kind: name === UNCATEGORIZED ? (sum > 0 ? 'revenu' : 'depense') : kindOf(name, categories) }));
    const spending = cats.filter((c) => c.kind === 'depense' && c.sum < 0).map((c) => ({ name: c.name, amount: -c.sum })).sort((a, b) => b.amount - a.amount);
    const incomes = cats.filter((c) => (c.kind === 'revenu' || c.kind === AID) && c.sum > 0).map((c) => ({ name: c.name, amount: c.sum, aid: c.kind === AID })).sort((a, b) => b.amount - a.amount);
    return {
      month, income, expense, net,
      aid, ownIncome: income - aid,
      savingsRate: income > 0 ? net / income : null,
      neutralIn, neutralOut, spending, incomes,
    };
  }

  /* ---------- Mois ---------- */

  /** Les n mois qui finissent par month (inclus), du plus ancien au plus récent. */
  function lastMonths(month, n) {
    let [y, m] = month.split('-').map(Number);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.unshift(`${y}-${String(m).padStart(2, '0')}`);
      m--; if (m < 1) { m = 12; y--; }
    }
    return out;
  }

  /** Nombre de jours entre deux dates 'AAAA-MM-JJ' (b − a). */
  function daysBetween(a, b) {
    const t = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    return Math.round((t(b) - t(a)) / 86400000);
  }

  /* ---------- Libellés lisibles ---------- */

  /**
   * Libellé court pour l'affichage (le libellé complet reste stocké et cherchable).
   * Formats Crédit Agricole : « Paiement par carte X1234 COMMERCE VILLE 12/05 - Nom »,
   * « Virement en votre faveur … », « Virement émis … », « Prélèvement … », « Retrait au distributeur … ».
   */
  function displayLabel(label) {
    const s = String(label || '').replace(/\s+/g, ' ').trim();
    // Références techniques (longues suites de lettres et de chiffres), « NOTPROVID »
    const clean = (x) => x
      .replace(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}\b/g, ' ')
      .replace(/\bNOTPROVID\b/g, ' ')
      .replace(/\s+-\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cut = (x) => (x.length > 60 ? x.slice(0, 59).trimEnd() + '…' : x);
    let m = s.match(/^(Paiement par carte|Avoir)\s+(?:CARTE\s+)?X\d{4}\s+(.*?)(?:\s+\d{2}\/\d{2}(?:\s+\d{2}H\d{2})?)?(?:\s+-\s+(.+))?$/i);
    if (m) {
      const name = clean(m[3] || m[2]) || clean(m[2]);
      return cut(/^avoir/i.test(m[1]) ? `Avoir · ${name}` : name);
    }
    m = s.match(/^Retrait au distributeur\s+(?:X\d{4}\s+)?(.*?)(?:\s+\d{2}\/\d{2}.*)?$/i);
    if (m) return cut(`Retrait · ${clean(m[1])}`.replace(/ · $/, ''));
    m = s.match(/^Virement en votre faveur\s*(.*)$/i);
    if (m) return cut(`Virement reçu · ${clean(m[1].replace(/^(VIR INST (WERO )?de |DE )/i, ''))}`.replace(/ · $/, ''));
    m = s.match(/^Virement [ée]mis\s*(.*)$/i);
    if (m) return cut(`Virement émis · ${clean(m[1].replace(/^(VIR INST (WERO )?vers |Wero vers |WEB )/i, ''))}`.replace(/ · $/, ''));
    m = s.match(/^Pr[ée]l[èe]vement\s*(.*)$/i);
    if (m) return cut(`Prélèvement · ${clean(m[1].split(' - ')[0].replace(/^\d+\s+/, ''))}`.replace(/ · $/, ''));
    return cut(clean(s) || s);
  }

  /* ---------- Plafonds par catégorie ---------- */

  /** Dépense nette d'une catégorie sur une liste de mois (un remboursement la réduit). */
  function spentIn(transactions, category, months) {
    const set = new Set(months);
    let sum = 0;
    for (const t of transactions) if (t.category === category && set.has(monthOf(t.date))) sum += t.amount;
    return Math.max(0, Math.round(-sum * 100) / 100);
  }

  /**
   * État des plafonds pour le mois affiché.
   * budgets : { catégorie: { limit, period: 'mois' | 'an' } } — 'an' = 12 mois glissants jusqu'au mois affiché.
   * level : 'ok' (< 80 %), 'warn' (80 à 100 %), 'over' (dépassé).
   */
  function budgetStatus(transactions, month, budgets) {
    return Object.entries(budgets || {})
      .filter(([, b]) => b && b.limit > 0)
      .map(([name, b]) => {
        const period = b.period === 'an' ? 'an' : 'mois';
        const spent = spentIn(transactions, name, period === 'an' ? lastMonths(month, 12) : [month]);
        const ratio = spent / b.limit;
        return { name, limit: b.limit, period, spent, ratio, level: ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok' };
      })
      .sort((a, b) => b.ratio - a.ratio || a.name.localeCompare(b.name));
  }

  /* ---------- Évolution d'une catégorie ---------- */

  /**
   * Montants mensuels d'une catégorie sur n mois finissant par endMonth, et total des
   * n mois précédents (comparaison). Dépense : montant positif ; revenu : montant reçu.
   */
  function categorySeries(transactions, category, endMonth, categories, n = 12) {
    const kind = kindOf(category, categories);
    const sign = kind === 'revenu' || kind === AID ? 1 : -1;
    const months = lastMonths(endMonth, n * 2);
    const sums = new Map(months.map((m) => [m, 0]));
    for (const t of transactions) {
      if (t.category !== category) continue;
      const m = monthOf(t.date);
      if (!sums.has(m)) continue;
      sums.set(m, sums.get(m) + t.amount);
    }
    const prev = months.slice(0, n);
    const cur = months.slice(n);
    // Comparaison seulement si l'historique couvre toute la période précédente
    const firstDate = transactions.reduce((min, t) => (!min || t.date < min ? t.date : min), null);
    const previousHasData = !!firstDate && monthOf(firstDate) <= prev[0];
    const round = (v) => Math.round(v * 100) / 100;
    const series = cur.map((m) => ({ month: m, amount: round(sign * sums.get(m)) }));
    return {
      series,
      total: round(series.reduce((s, x) => s + x.amount, 0)),
      previousTotal: previousHasData ? round(sign * prev.reduce((s, m) => s + sums.get(m), 0)) : null,
    };
  }

  /* ---------- PEA dans le patrimoine ---------- */

  /**
   * Valeur du PEA = actions + liquidités non investies (versements − achats).
   * dep : résultat de Calc.deposits. Liquidités négatives (versement oublié) : ignorées, jamais retranchées.
   */
  function peaTotal(value, dep) {
    const v = Number(value) || 0;
    const cash = dep && dep.hasDeposits && dep.cash > 0 ? Math.round(dep.cash * 100) / 100 : 0;
    return { value: v, cash, total: Math.round((v + cash) * 100) / 100 };
  }

  /* ---------- Argent disponible / bloqué ---------- */

  /**
   * Sépare l'argent utilisable tout de suite de l'argent bloqué.
   * accounts : [{name, balance, blocked, until}] — un compte bloqué dont la date de
   *            déblocage est passée compte comme disponible.
   * pea      : { amount, until } — bloqué jusqu'aux 5 ans du PEA (until = 'AAAA-MM-JJ').
   */
  function availability(accounts, pea, today) {
    const items = (accounts || []).map((a) => {
      const blocked = !!a.blocked && !(a.until && a.until <= today);
      return { name: a.bank ? `${a.name} (${a.bank})` : a.name, amount: a.balance, blocked, until: blocked ? a.until || '' : '' };
    });
    if (pea && pea.amount) {
      const blocked = !!pea.until && pea.until > today;
      items.push({ name: 'PEA', amount: pea.amount, blocked, until: blocked ? pea.until : '', pea: true });
    }
    const round = (v) => Math.round(v * 100) / 100;
    const available = round(items.filter((i) => !i.blocked).reduce((s, i) => s + i.amount, 0));
    const blocked = round(items.filter((i) => i.blocked).reduce((s, i) => s + i.amount, 0));
    const dated = items.filter((i) => i.blocked && i.until).sort((a, b) => a.until.localeCompare(b.until));
    return {
      available, blocked,
      items: items.sort((a, b) => a.blocked - b.blocked || (a.until || '9').localeCompare(b.until || '9') || b.amount - a.amount),
      nextRelease: dated.length ? { name: dated[0].name, date: dated[0].until, amount: dated[0].amount } : null,
    };
  }

  /** Banques proposées dans le menu des comptes (données publiques). « Autre… » permet d'en saisir une. */
  const BANKS = {
    'France · banques': [
      'Banque Populaire', 'BNP Paribas', 'BRED', 'Caisse d\'Épargne', 'CCF', 'CIC', 'Crédit Agricole', 'Crédit Coopératif',
      'Crédit Maritime', 'Crédit Mutuel', 'Crédit Mutuel Arkéa', 'Crédit Mutuel de Bretagne', 'Banque Française Mutualiste',
      'Banque Palatine', 'Banque Transatlantique', 'La Banque Postale', 'LCL', 'Milleis Banque', 'Société Générale',
      'Banque Courtois', 'Banque Kolb', 'Banque Laydernier', 'Banque Nuger', 'Banque Rhône-Alpes', 'Banque Tarneaud',
      'Banque de Savoie', 'Banque Chaabi', 'Neuflize OBC', 'Rothschild & Co', 'Edmond de Rothschild', 'Banque Hottinguer',
    ],
    'France · banques en ligne et néobanques': [
      'BforBank', 'BoursoBank', 'Fortuneo', 'Hello bank!', 'Monabanq', 'Ma French Bank', 'Orange Bank', 'Sumeria (Lydia)',
      'Nickel', 'Green-Got', 'Helios', 'OnlyOne', 'Kard', 'Pixpay', 'Xaalys', 'Qonto', 'Shine',
      'Revolut', 'N26', 'bunq', 'Wise', 'Vivid Money',
    ],
    'Courtiers, assurance-vie et crypto': [
      'Trade Republic', 'Scalable Capital', 'Saxo Banque', 'Bourse Direct', 'DEGIRO', 'Interactive Brokers', 'XTB',
      'Linxea', 'Lucya Cardif', 'Yomoni', 'Nalo', 'Ramify', 'Goodvest', 'Distingo Bank',
      'Binance', 'Coinbase', 'Bitpanda', 'Bitstack', 'Deblock', 'Kraken',
    ],
    'Épargne salariale et crédit': [
      'Amundi Épargne Salariale', 'Natixis Interépargne', 'Esalia', 'BNP Paribas Épargne Salariale', 'Epsens',
      'Cetelem', 'Cofidis', 'Franfinance', 'Oney', 'Carrefour Banque', 'Floa', 'My Money Bank', 'Younited',
    ],
    'Allemagne': [
      'Commerzbank', 'comdirect', 'Consorsbank', 'DKB', 'Deutsche Bank', 'HypoVereinsbank', 'ING Deutschland',
      'Postbank', 'Santander Deutschland', 'Sparkasse', 'Targobank', 'Volksbank / Raiffeisenbank', 'C24', 'Tomorrow',
    ],
  };

  /**
   * Groupes du menu des banques : « Mes banques » (déjà utilisées mais absentes de la liste) d'abord,
   * puis la liste, chaque groupe trié par ordre alphabétique.
   */
  function bankOptions(used = []) {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const known = new Set(Object.values(BANKS).flat().map(norm));
    const mine = [];
    for (const s of (used || []).map((x) => String(x || '').trim())) {
      if (s && !known.has(norm(s))) { known.add(norm(s)); mine.push(s); } // sans doublon, majuscules ignorées
    }
    const sort = (list) => [...list].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    return [
      ...(mine.length ? [{ label: 'Mes banques', banks: sort(mine) }] : []),
      ...Object.entries(BANKS).map(([label, banks]) => ({ label, banks: sort(banks) })),
    ];
  }

  /** Comptes regroupés par banque (ordre alphabétique, « sans banque » à la fin), avec le total de chaque banque. */
  function groupAccounts(accounts) {
    const groups = new Map();
    for (const a of accounts || []) {
      const bank = String(a.bank || '').trim();
      const key = bank.toLowerCase();
      if (!groups.has(key)) groups.set(key, { bank, total: 0, accounts: [] });
      const g = groups.get(key);
      g.accounts.push(a);
      g.total = Math.round((g.total + a.balance) * 100) / 100;
    }
    return [...groups.values()].sort((a, b) => (!a.bank) - (!b.bank) || a.bank.localeCompare(b.bank, 'fr'));
  }

  /* ---------- Historique du patrimoine ---------- */

  /** Enregistre (ou met à jour) le total du mois. Retourne { history, changed }. */
  function upsertSnapshot(history, month, { cash, pea }) {
    // À l'euro près : évite d'enregistrer (et de synchroniser) chaque petite variation du cours
    const r = (v) => Math.round(Number(v) || 0);
    const snap = { month, cash: r(cash), pea: r(pea), total: r(r(cash) + r(pea)) };
    const list = (Array.isArray(history) ? history : []).filter((h) => h.month !== month);
    const old = (history || []).find((h) => h.month === month);
    const changed = !old || old.cash !== snap.cash || old.pea !== snap.pea;
    list.push(changed ? snap : old);
    list.sort((a, b) => a.month.localeCompare(b.month));
    return { history: list.slice(-240), changed };
  }

  /* ---------- Rappels ---------- */

  /**
   * Rappels à afficher : import bancaire ancien (> 31 jours), sauvegarde chiffrée
   * absente ou ancienne (> 60 jours). Sans transaction, aucun rappel.
   */
  function reminders(state, today) {
    const out = [];
    const tx = state.transactions || [];
    if (!tx.length) return out;
    const lastTx = tx.reduce((max, t) => (t.date > max ? t.date : max), tx[0].date);
    const lastImport = state.lastImport && state.lastImport > lastTx ? state.lastImport : lastTx;
    const d = daysBetween(lastImport, today);
    if (d > 31) out.push({ id: 'import', text: `Dernier import bancaire il y a ${d} jours : exportez le CSV « Depuis le dernier téléchargement » et importez-le.` });
    if (!state.lastEncryptedExport) out.push({ id: 'backup', text: 'Aucune sauvegarde chiffrée pour l\'instant : exportez-en une (onglet Patrimoine) et gardez-la dans iCloud Drive.' });
    else {
      const b = daysBetween(state.lastEncryptedExport, today);
      if (b > 60) out.push({ id: 'backup', text: `Dernière sauvegarde chiffrée il y a ${b} jours : pensez à en refaire une (onglet Patrimoine).` });
    }
    return out;
  }

  /** Liste triée des mois présents ('AAAA-MM'). */
  function monthsOf(transactions) {
    return [...new Set(transactions.map((t) => monthOf(t.date)))].sort();
  }

  /** Ajoute des mois « vides » entre le premier et le dernier (pour un graphique continu). */
  function fillMonths(months) {
    if (!months.length) return [];
    const out = []; let [y, m] = months[0].split('-').map(Number);
    const [ye, me] = months[months.length - 1].split('-').map(Number);
    while (y < ye || (y === ye && m <= me)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  /**
   * Fusionne des transactions importées dans l'existant sans doublons.
   * Deux transactions identiques le même jour (même libellé, même montant) sont
   * légitimes : on compte les occurrences plutôt que d'écarter tout doublon.
   */
  function dedupe(existing, incoming) {
    const key = (t) => `${t.date}|${t.amount.toFixed(2)}|${normLabel(t.label)}`;
    const have = new Map();
    existing.forEach((t) => have.set(key(t), (have.get(key(t)) || 0) + 1));
    const seen = new Map();
    const fresh = []; const dups = [];
    for (const t of incoming) {
      const k = key(t);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if ((have.get(k) || 0) >= n) dups.push(t); else fresh.push(t);
    }
    return { fresh, dups };
  }

  return {
    NEUTRAL, AID, KINDS, DEFAULT_CATEGORIES, DEFAULT_RULES, UNCATEGORIZED,
    normLabel, ruleKey, parseDate, parseAmount,
    detectDelimiter, parseCsv, detectColumns, extractTransactions,
    categorize, kindOf, summarizeMonth, monthsOf, fillMonths, dedupe, monthOf,
    lastMonths, daysBetween, displayLabel, spentIn, budgetStatus, categorySeries, peaTotal, availability, BANKS, bankOptions, groupAccounts, upsertSnapshot, reminders,
  };
})();

/* ==========================================================================
   B. STOCKAGE — localStorage + export / import JSON
   ========================================================================== */
const BudgetStore = {
  KEY: 'budget-patrimoine:budget:v1',
  BACKUP_KEY: 'budget-patrimoine:budget:v1:secours',

  defaults() {
    return {
      version: 1,
      transactions: [],   // [{id, date, label, amount, category, manual}] — amount < 0 : dépense
      rules: [],          // règles de l'utilisateur [{match, category, sign?}]
      categories: BudgetCore.DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      accounts: [],       // comptes de patrimoine saisis à la main [{id, name, balance, date}]
      budgets: {},        // plafonds { catégorie: { limit, period: 'mois' | 'an' } }
      history: [],        // patrimoine mois par mois [{month, cash, pea, total}]
      lastExport: null,
      lastImport: null,           // dernier import bancaire (rappel)
      lastEncryptedExport: null,  // dernière sauvegarde chiffrée (rappel)
    };
  },

  newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); },

  /** Valide et nettoie ; une ligne invalide est écartée (et comptée). */
  clean(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.transactions)) {
      throw new Error('Fichier invalide : liste des transactions absente.');
    }
    const def = BudgetStore.defaults();
    let dropped = 0;
    const ids = new Set();
    const uid = (id) => { let v = id ? String(id) : BudgetStore.newId(); if (ids.has(v)) v = BudgetStore.newId(); ids.add(v); return v; };
    const text = (v, max = 200) => String(v === undefined || v === null ? '' : v).slice(0, max);

    const categories = [];
    const seenCat = new Set();
    for (const c of [...(Array.isArray(data.categories) ? data.categories : []), ...def.categories]) {
      const name = text(c && c.name, 60).trim();
      if (!name || seenCat.has(name) || name === BudgetCore.UNCATEGORIZED) continue;
      seenCat.add(name);
      categories.push({ name, kind: BudgetCore.KINDS.includes(c.kind) ? c.kind : 'depense' });
    }
    const transactions = [];
    for (const t of data.transactions) {
      const amount = typeof t.amount === 'string' ? BudgetCore.parseAmount(t.amount) : Number(t && t.amount);
      const date = BudgetCore.parseDate(t && t.date);
      if (!date || !Number.isFinite(amount)) { dropped++; continue; }
      transactions.push({
        id: uid(t.id), date, label: text(t.label, 200) || '(sans libellé)',
        amount: Math.round(amount * 100) / 100,
        category: text(t.category, 60) || BudgetCore.UNCATEGORIZED,
        manual: !!t.manual,
      });
    }
    const rules = [];
    for (const r of Array.isArray(data.rules) ? data.rules : []) {
      const match = text(r && r.match, 80).trim();
      const category = text(r && r.category, 60).trim();
      if (!match || !category) { dropped++; continue; }
      rules.push({ match, category, ...(r.sign === 'in' || r.sign === 'out' ? { sign: r.sign } : {}) });
      if (!seenCat.has(category) && category !== BudgetCore.UNCATEGORIZED) { seenCat.add(category); categories.push({ name: category, kind: 'depense' }); }
    }
    const accounts = [];
    for (const a of Array.isArray(data.accounts) ? data.accounts : []) {
      const balance = Number(a && a.balance);
      const name = text(a && a.name, 60).trim();
      if (!name || !Number.isFinite(balance)) { dropped++; continue; }
      accounts.push({
        id: uid(a.id), name, balance, date: BudgetCore.parseDate(a.date) || '',
        bank: text(a.bank, 40).trim(),
        blocked: !!a.blocked, until: a.blocked ? BudgetCore.parseDate(a.until) || '' : '', // argent bloqué (PEL, CEL…)
      });
    }
    const budgets = {};
    for (const [name, b] of Object.entries(data.budgets && typeof data.budgets === 'object' ? data.budgets : {})) {
      const limit = Number(b && b.limit);
      const n = text(name, 60).trim();
      if (!n || !(limit > 0) || !Number.isFinite(limit)) continue;
      budgets[n] = { limit: Math.round(limit * 100) / 100, period: b.period === 'an' ? 'an' : 'mois' };
    }
    const history = [];
    const seenMonth = new Set();
    for (const h of Array.isArray(data.history) ? data.history : []) {
      const month = String(h && h.month);
      const cash = Number(h && h.cash); const pea = Number(h && h.pea);
      if (!/^\d{4}-\d{2}$/.test(month) || seenMonth.has(month) || !Number.isFinite(cash) || !Number.isFinite(pea)) continue;
      seenMonth.add(month);
      history.push({ month, cash, pea, total: Math.round((cash + pea) * 100) / 100 });
    }
    history.sort((a, b) => a.month.localeCompare(b.month));
    return {
      state: {
        version: 1, transactions, rules, categories, accounts, budgets, history,
        lastExport: BudgetCore.parseDate(data.lastExport) || null,
        lastImport: BudgetCore.parseDate(data.lastImport) || null,
        lastEncryptedExport: BudgetCore.parseDate(data.lastEncryptedExport) || null,
      },
      dropped,
    };
  },

  load() {
    let raw = null;
    try {
      raw = localStorage.getItem(BudgetStore.KEY);
      if (!raw) return BudgetStore.defaults();
      const { state, dropped } = BudgetStore.clean(JSON.parse(raw));
      if (dropped) { try { localStorage.setItem(BudgetStore.BACKUP_KEY, raw); } catch (e) { /* quota */ } }
      return state;
    } catch (e) {
      console.warn('Lecture du budget impossible, copie de secours conservée.', e);
      if (raw) { try { localStorage.setItem(BudgetStore.BACKUP_KEY, raw); } catch (e2) { /* quota */ } }
      return BudgetStore.defaults();
    }
  },

  save(state) {
    try { localStorage.setItem(BudgetStore.KEY, JSON.stringify(state)); } catch (e) { console.error('Sauvegarde du budget impossible', e); }
    if (typeof Sync !== 'undefined') Sync.schedule(); // envoi chiffré groupé, si la synchro est active
  },
};

/* ==========================================================================
   C. INTERFACE
   ========================================================================== */
const Budget = {
  state: null,
  month: null,         // 'AAAA-MM' affiché
  catFilter: null,     // catégorie filtrée dans la liste
  search: '',
  pending: null,       // import CSV en cours { rows, delimiter, headerRow, cols, headers, fileName }

  $: (id) => document.getElementById(id),

  init() {
    Budget.state = BudgetStore.load();
    const months = BudgetCore.monthsOf(Budget.state.transactions);
    Budget.month = months.length ? months[months.length - 1] : BudgetCore.monthOf(Dates.today());
    Budget.bind();
    Budget.render();
  },

  persist() { BudgetStore.save(Budget.state); },

  /* ---------- Liaisons ---------- */
  bind() {
    Budget.$('btn-month-prev').addEventListener('click', () => Budget.shiftMonth(-1));
    Budget.$('btn-month-next').addEventListener('click', () => Budget.shiftMonth(1));
    Budget.$('csv-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Budget.readCsvFile(f); });
    Budget.$('csv-cancel').addEventListener('click', () => Budget.$('csv-dialog').close());
    Budget.$('csv-confirm').addEventListener('click', Budget.confirmImport);
    for (const id of ['csv-col-date', 'csv-col-label', 'csv-col-amount', 'csv-col-debit', 'csv-col-credit']) {
      Budget.$(id).addEventListener('change', Budget.updateCsvPreview);
    }
    Budget.$('budget-search').addEventListener('input', (e) => { Budget.search = e.target.value; Budget.renderList(); });
    Budget.$('btn-clear-filter').addEventListener('click', () => { Budget.catFilter = null; Budget.renderMonth(); });
    Budget.$('btn-budget-export').addEventListener('click', Budget.exportJSON);
    Budget.$('budget-import-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Budget.importJSON(f); });
    Budget.$('rules-import-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Budget.importRules(f); });
    Budget.$('btn-rules-export').addEventListener('click', Budget.exportRules);
    Budget.$('btn-recategorize').addEventListener('click', () => {
      const n = Budget.recategorize(false);
      Budget.toast(`${n} transaction(s) recatégorisée(s)`);
    });
    Budget.$('account-form').addEventListener('submit', Budget.addAccount);
    Budget.$('btn-import-old-pea').addEventListener('click', Budget.importOldPea);
  },

  toast(msg) { if (typeof App !== 'undefined') App.toast(msg); },

  shiftMonth(delta) {
    const [y, m] = Budget.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    Budget.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    Budget.catFilter = null;
    Budget.renderMonth();
  },

  /* ---------- Rendu ---------- */
  render() {
    Budget.renderMonth();
    Budget.renderCategoriesCard();
    Budget.renderPatrimoine();
  },

  renderCharts() { if (Budget.state) { Budget.renderBars(); Budget.renderTrend(); Budget.renderHistory(); } },

  monthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  },

  renderMonth() {
    const s = Budget.state;
    const sum = BudgetCore.summarizeMonth(s.transactions, Budget.month, s.categories);
    Budget.$('month-label').textContent = Budget.monthLabel(Budget.month);
    const empty = !s.transactions.length;
    Budget.$('budget-empty').hidden = !empty;
    Budget.$('budget-body').hidden = empty;
    if (empty) return;

    Budget.$('b-income').textContent = Fmt.eur(sum.income);
    Budget.$('b-expense').textContent = Fmt.eur(sum.expense);
    const netEl = Budget.$('b-net');
    netEl.textContent = Fmt.signedEur(sum.net);
    netEl.className = 'kpi-value ' + Fmt.trend(sum.net);
    Budget.$('b-rate').textContent = sum.savingsRate === null ? '—' : Fmt.pct(sum.savingsRate);
    Budget.$('b-neutral').textContent = sum.neutralIn || sum.neutralOut
      ? `Hors totaux : ${Fmt.eur(sum.neutralOut)} sortis, ${Fmt.eur(sum.neutralIn)} entrés (épargne, virements internes).`
      : '';
    // Revenus propres et aide reçue, séparés
    const split = Budget.$('b-income-split');
    if (sum.aid) {
      const own = sum.ownIncome - sum.expense;
      split.textContent = `Dont revenus propres ${Fmt.eur(sum.ownIncome)} et aide reçue ${Fmt.eur(sum.aid)}. Sans l'aide, le solde du mois serait de ${Fmt.signedEur(own)}.`;
    } else split.textContent = '';

    // Dépenses par catégorie (barres horizontales ; touche = filtre la liste)
    const box = Budget.$('b-categories');
    box.replaceChildren();
    const total = sum.expense || 1;
    sum.spending.forEach((c, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cat-row' + (Budget.catFilter === c.name ? ' active' : '');
      const head = document.createElement('div'); head.className = 'cat-head';
      const name = document.createElement('span'); name.textContent = c.name;
      const val = document.createElement('b'); val.textContent = `${Fmt.eur(c.amount)} · ${Math.round((c.amount / total) * 100)} %`;
      head.append(name, val);
      const bar = document.createElement('div'); bar.className = 'cat-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(2, (c.amount / sum.spending[0].amount) * 100)}%`;
      fill.style.background = Budget.catColor(c.name, i);
      bar.appendChild(fill);
      row.append(head, bar);
      row.addEventListener('click', () => { Budget.catFilter = Budget.catFilter === c.name ? null : c.name; Budget.renderMonth(); });
      box.appendChild(row);
    });
    Budget.$('b-categories-empty').hidden = sum.spending.length > 0;
    Budget.$('b-categories-hint').hidden = !sum.spending.length || !!Budget.catFilter;
    Budget.$('btn-clear-filter').hidden = !Budget.catFilter;

    Budget.renderBars();
    Budget.renderBudgets();
    Budget.renderTrend();
    Budget.renderList();
    Budget.renderPatrimoine();
  },

  /** Plafonds du mois affiché : jauge par catégorie, alerte si dépassement. */
  renderBudgets() {
    const s = Budget.state;
    const list = BudgetCore.budgetStatus(s.transactions, Budget.month, s.budgets);
    const box = Budget.$('b-budgets');
    box.replaceChildren();
    list.forEach((b) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `cat-row budget-row ${b.level}` + (Budget.catFilter === b.name ? ' active' : '');
      const head = document.createElement('div'); head.className = 'cat-head';
      const name = document.createElement('span'); name.textContent = b.period === 'an' ? `${b.name} (12 mois)` : b.name;
      const val = document.createElement('b'); val.textContent = `${Fmt.eur0(b.spent)} / ${Fmt.eur0(b.limit)}`;
      head.append(name, val);
      const bar = document.createElement('div'); bar.className = 'cat-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.min(100, Math.max(2, b.ratio * 100))}%`;
      bar.appendChild(fill);
      row.append(head, bar);
      row.addEventListener('click', () => { Budget.catFilter = Budget.catFilter === b.name ? null : b.name; Budget.renderMonth(); });
      box.appendChild(row);
    });
    Budget.$('b-budgets-empty').hidden = list.length > 0;
    const over = list.filter((b) => b.level === 'over');
    const alert = Budget.$('b-budget-alert');
    alert.hidden = !over.length;
    alert.textContent = over.length
      ? `⚠︎ ${over.length} plafond${over.length > 1 ? 's' : ''} dépassé${over.length > 1 ? 's' : ''} : ` + over.map((b) => `${b.name} (+${Fmt.eur0(b.spent - b.limit)})`).join(', ')
      : '';
  },

  /** Évolution sur 12 mois de la catégorie touchée (et comparaison avec les 12 mois d'avant). */
  renderTrend() {
    const box = Budget.$('b-trend');
    const cat = Budget.catFilter;
    box.hidden = !cat;
    if (!cat) return;
    const s = Budget.state;
    const { series, total, previousTotal } = BudgetCore.categorySeries(s.transactions, cat, Budget.month, s.categories);
    Budget.$('b-trend-title').textContent = `${cat} : 12 derniers mois`;
    const months = series.filter((x) => x.amount > 0).length || 1;
    let summary = `Total ${Fmt.eur0(total)} · moyenne ${Fmt.eur0(total / months)} par mois actif.`;
    if (previousTotal !== null) {
      const diff = total - previousTotal;
      summary += ` 12 mois d'avant : ${Fmt.eur0(previousTotal)} (${diff >= 0 ? '+' : '−'}${Fmt.eur0(Math.abs(diff))}).`;
    } else summary += ' Pas encore assez d\'historique pour comparer avec l\'année d\'avant.';
    Budget.$('b-trend-summary').textContent = summary;

    const el = Budget.$('b-trend-chart');
    el.innerHTML = '';
    const W = el.clientWidth || 320; const H = el.clientHeight || 150;
    const m = { top: 8, right: 4, bottom: 22, left: 4 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, el);
    const max = Math.max(1, ...series.map((x) => x.amount));
    const slot = (W - m.left - m.right) / series.length;
    const bw = Math.min(18, slot * 0.6);
    series.forEach((x, i) => {
      const cx = m.left + slot * i + slot / 2;
      const h = (Math.max(0, x.amount) / max) * (H - m.top - m.bottom);
      if (x.month === Budget.month) svgEl('rect', { x: cx - slot / 2 + 1, y: 0, width: slot - 2, height: H, rx: 6, style: 'fill: var(--surface-2)' }, svg);
      svgEl('rect', { x: cx - bw / 2, y: H - m.bottom - h, width: bw, height: h, rx: 2, style: `fill: ${Budget.catColor(cat, 0)}` }, svg);
      const lab = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, svg);
      lab.textContent = new Date(+x.month.slice(0, 4), +x.month.slice(5) - 1, 1).toLocaleDateString('fr-FR', { month: 'narrow' });
      const hit = svgEl('rect', { x: cx - slot / 2, y: 0, width: slot, height: H, fill: 'transparent', style: 'cursor:pointer' }, svg);
      const tip = svgEl('title', {}, hit); tip.textContent = `${Budget.monthLabel(x.month)} : ${Fmt.eur(x.amount)}`;
      hit.addEventListener('click', () => { Budget.month = x.month; Budget.renderMonth(); });
    });
    svgEl('line', { x1: m.left, x2: W - m.right, y1: H - m.bottom, y2: H - m.bottom, class: 'baseline' }, svg);
  },

  catColor(name, i) {
    if (name === BudgetCore.UNCATEGORIZED) return 'var(--muted)';
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 55%)`;
  },

  /** Barres mensuelles : revenus et dépenses sur 12 mois ; touche = choisit le mois. */
  renderBars() {
    const el = Budget.$('b-bars');
    if (!el || !Budget.state.transactions.length) return;
    const s = Budget.state;
    let months = BudgetCore.fillMonths(BudgetCore.monthsOf(s.transactions));
    if (!months.includes(Budget.month)) months = BudgetCore.fillMonths([...months, Budget.month].sort());
    months = months.slice(-12);
    const data = months.map((m) => BudgetCore.summarizeMonth(s.transactions, m, s.categories));
    el.innerHTML = '';
    const W = el.clientWidth || 320; const H = el.clientHeight || 180;
    const m = { top: 8, right: 8, bottom: 22, left: 8 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, el);
    const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.expense)));
    const slot = (W - m.left - m.right) / months.length;
    const bw = Math.min(14, slot * 0.36);
    const sy = (v) => (v / max) * (H - m.top - m.bottom);
    data.forEach((d, i) => {
      const cx = m.left + slot * i + slot / 2;
      if (months[i] === Budget.month) svgEl('rect', { x: cx - slot / 2 + 1, y: 0, width: slot - 2, height: H, rx: 6, style: 'fill: var(--surface-2)' }, svg);
      svgEl('rect', { x: cx - bw - 1, y: H - m.bottom - sy(d.income), width: bw, height: Math.max(0, sy(d.income)), rx: 2, style: 'fill: var(--series-gains)' }, svg);
      svgEl('rect', { x: cx + 1, y: H - m.bottom - sy(d.expense), width: bw, height: Math.max(0, sy(d.expense)), rx: 2, style: 'fill: var(--series-rate)' }, svg);
      const lab = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, svg);
      lab.textContent = new Date(+months[i].slice(0, 4), +months[i].slice(5) - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '');
      const hit = svgEl('rect', { x: cx - slot / 2, y: 0, width: slot, height: H, fill: 'transparent', style: 'cursor:pointer' }, svg);
      hit.addEventListener('click', () => { Budget.month = months[i]; Budget.catFilter = null; Budget.renderMonth(); });
    });
    svgEl('line', { x1: m.left, x2: W - m.right, y1: H - m.bottom, y2: H - m.bottom, class: 'baseline' }, svg);
  },

  renderList() {
    const s = Budget.state;
    const box = Budget.$('b-list');
    box.replaceChildren();
    const q = BudgetCore.normLabel(Budget.search);
    const rows = s.transactions
      .filter((t) => BudgetCore.monthOf(t.date) === Budget.month)
      .filter((t) => !Budget.catFilter || t.category === Budget.catFilter)
      .filter((t) => !q || BudgetCore.normLabel(t.label).includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || a.label.localeCompare(b.label));
    Budget.$('b-list-count').textContent = rows.length ? `${rows.length} transaction${rows.length > 1 ? 's' : ''}` : '';
    Budget.$('b-list-empty').hidden = rows.length > 0;
    const uncat = s.transactions.filter((t) => t.category === BudgetCore.UNCATEGORIZED).length;
    const warn = Budget.$('b-uncat');
    warn.hidden = !uncat;
    warn.textContent = uncat ? `${uncat} transaction(s) à catégoriser (tous mois confondus) : choisissez une catégorie dans la liste.` : '';

    rows.forEach((t) => {
      const li = document.createElement('div');
      li.className = 'tx';
      const top = document.createElement('div'); top.className = 'tx-top';
      // Libellé court ; une touche affiche le libellé complet de la banque
      const label = document.createElement('span'); label.className = 'tx-label'; label.textContent = BudgetCore.displayLabel(t.label);
      label.title = t.label;
      label.addEventListener('click', () => {
        const full = label.classList.toggle('full');
        label.textContent = full ? t.label : BudgetCore.displayLabel(t.label);
      });
      const amt = document.createElement('b'); amt.className = Fmt.trend(t.amount); amt.textContent = Fmt.signedEur(t.amount);
      top.append(label, amt);
      const bottom = document.createElement('div'); bottom.className = 'tx-bottom';
      const date = document.createElement('span'); date.className = 'hint'; date.textContent = Fmt.date(t.date);
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Catégorie');
      const names = [BudgetCore.UNCATEGORIZED, ...s.categories.map((c) => c.name)];
      names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
      const add = document.createElement('option'); add.value = '__new'; add.textContent = '+ Nouvelle catégorie…'; sel.appendChild(add);
      sel.value = t.category;
      sel.addEventListener('change', () => Budget.setCategory(t.id, sel.value));
      bottom.append(date, sel);
      li.append(top, bottom);
      box.appendChild(li);
    });
  },

  /** Change la catégorie d'une transaction ; propose d'en faire une règle pour les libellés similaires. */
  setCategory(id, value) {
    const s = Budget.state;
    const t = s.transactions.find((x) => x.id === id);
    if (!t) return;
    let cat = value;
    if (cat === '__new') {
      const name = (prompt('Nom de la nouvelle catégorie :') || '').trim().slice(0, 60);
      if (!name) { Budget.renderList(); return; }
      const kind = confirm(`« ${name} » est-elle une dépense ?\n\nOK = dépense · Annuler = revenu`) ? 'depense' : 'revenu';
      if (!s.categories.some((c) => c.name === name)) s.categories.push({ name, kind });
      cat = name;
    }
    t.category = cat; t.manual = true;
    const key = BudgetCore.ruleKey(t.label);
    if (cat !== BudgetCore.UNCATEGORIZED && key) {
      const similar = s.transactions.filter((x) => x.id !== t.id && !x.manual && BudgetCore.normLabel(x.label).includes(key));
      const existing = s.rules.find((r) => BudgetCore.normLabel(r.match) === key && (r.sign || '') === (t.amount > 0 ? 'in' : 'out'));
      if (similar.length || !existing) {
        const msg = similar.length
          ? `Appliquer « ${cat} » aux ${similar.length} autre(s) transaction(s) « ${key} » (et aux prochains imports) ?`
          : `Retenir « ${key} » → « ${cat} » pour les prochains imports ?`;
        if (confirm(msg)) {
          const sign = t.amount > 0 ? 'in' : 'out';
          if (existing) existing.category = cat; else s.rules.unshift({ match: key, category: cat, sign });
          similar.forEach((x) => { x.category = cat; });
        }
      }
    }
    Budget.persist();
    Budget.renderMonth();
    Budget.renderCategoriesCard();
  },

  /** Recalcule les catégories avec les règles actuelles (sauf celles choisies à la main, sauf si all). */
  recategorize(all) {
    let n = 0;
    for (const t of Budget.state.transactions) {
      if (t.manual && !all) continue;
      const c = BudgetCore.categorize(t, Budget.state.rules);
      if (c !== t.category) { t.category = c; n++; }
    }
    Budget.persist();
    Budget.renderMonth();
    Budget.renderCategoriesCard();
    return n;
  },

  renderCategoriesCard() {
    Budget.$('rules-count').textContent = Budget.state.rules.length
      ? `${Budget.state.rules.length} règle(s) personnelle(s) enregistrée(s).`
      : 'Aucune règle personnelle : seules les règles génériques sont utilisées.';
    Budget.renderCategoriesManage();
  },

  KIND_LABELS: { depense: 'Dépense', revenu: 'Revenu', aide: 'Aide reçue', neutre: 'Hors totaux' },

  /** Type de chaque catégorie et plafond de dépense (par mois ou 12 mois glissants). */
  renderCategoriesManage() {
    const s = Budget.state;
    const box = Budget.$('cat-manage');
    box.replaceChildren();
    const used = new Set(s.transactions.map((t) => t.category));
    const ordered = [...s.categories].sort((a, b) => (used.has(b.name) - used.has(a.name)) || a.name.localeCompare(b.name));
    ordered.forEach((c) => {
      const row = document.createElement('div'); row.className = 'cat-manage-row';
      const name = document.createElement('p'); name.className = 'label'; name.textContent = c.name;
      const line = document.createElement('div'); line.className = 'cat-manage-line';
      const kind = document.createElement('select');
      kind.setAttribute('aria-label', `Type de ${c.name}`);
      BudgetCore.KINDS.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = Budget.KIND_LABELS[k]; kind.appendChild(o); });
      kind.value = c.kind;
      kind.addEventListener('change', () => { c.kind = kind.value; if (c.kind !== 'depense') delete s.budgets[c.name]; Budget.persist(); Budget.render(); });
      line.appendChild(kind);
      if (c.kind === 'depense') {
        const b = s.budgets[c.name];
        const limit = document.createElement('input');
        limit.type = 'text'; limit.inputMode = 'decimal'; limit.placeholder = 'Plafond €';
        limit.value = b ? Fmt.input(b.limit) : '';
        limit.setAttribute('aria-label', `Plafond de ${c.name} en euros`);
        const period = document.createElement('select');
        period.setAttribute('aria-label', `Période du plafond de ${c.name}`);
        [['mois', '/ mois'], ['an', '/ 12 mois']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; period.appendChild(o); });
        period.value = b ? b.period : 'mois';
        const save = () => {
          const v = BudgetCore.parseAmount(limit.value);
          if (!limit.value.trim() || !(v > 0)) { delete s.budgets[c.name]; limit.value = ''; } else s.budgets[c.name] = { limit: Math.round(v * 100) / 100, period: period.value };
          Budget.persist(); Budget.renderMonth();
        };
        limit.addEventListener('change', save);
        period.addEventListener('change', () => { if (s.budgets[c.name]) save(); });
        line.append(limit, period);
      }
      row.append(name, line);
      box.appendChild(row);
    });
  },

  /** Bandeaux de rappel (import bancaire, sauvegarde chiffrée) en haut des onglets Patrimoine et Budget. */
  renderReminders() {
    const list = BudgetCore.reminders(Budget.state, Dates.today());
    for (const id of ['p-reminders', 'b-reminders']) {
      const box = Budget.$(id);
      if (!box) continue;
      box.replaceChildren();
      list.forEach((r) => {
        const div = document.createElement('div'); div.className = 'banner';
        const p = document.createElement('p'); p.textContent = r.text;
        div.appendChild(p);
        if (r.id === 'backup' && typeof Sync !== 'undefined') {
          const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-small btn-primary'; btn.textContent = 'Sauvegarder';
          btn.addEventListener('click', () => Sync.exportEncrypted());
          div.appendChild(btn);
        }
        box.appendChild(div);
      });
    }
  },

  /* ---------- Import CSV ---------- */
  async readCsvFile(file) {
    try {
      const buf = await file.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
      const { rows, delimiter } = BudgetCore.parseCsv(text);
      if (rows.length < 2) throw new Error('Le fichier semble vide.');
      const { headerRow, cols, headers } = BudgetCore.detectColumns(rows);
      Budget.pending = { rows, delimiter, headerRow, cols, headers, fileName: file.name };
      Budget.openCsvDialog();
    } catch (err) {
      alert('Import impossible : ' + err.message);
    }
  },

  openCsvDialog() {
    const p = Budget.pending;
    Budget.$('csv-file-name').textContent = p.fileName;
    const fill = (id, none) => {
      const sel = Budget.$(id);
      sel.replaceChildren();
      if (none) { const o = document.createElement('option'); o.value = '-1'; o.textContent = none; sel.appendChild(o); }
      p.headers.forEach((h, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = h || `Colonne ${i + 1}`; sel.appendChild(o); });
    };
    fill('csv-col-date'); fill('csv-col-label', '(aucune)'); fill('csv-col-amount', '(aucune)'); fill('csv-col-debit', '(aucune)'); fill('csv-col-credit', '(aucune)');
    Budget.$('csv-col-date').value = String(Math.max(0, p.cols.date));
    Budget.$('csv-col-label').value = String(p.cols.label);
    Budget.$('csv-col-amount').value = String(p.cols.amount);
    Budget.$('csv-col-debit').value = String(p.cols.debit);
    Budget.$('csv-col-credit').value = String(p.cols.credit);
    Budget.updateCsvPreview();
    Budget.$('csv-dialog').showModal();
  },

  currentCols() {
    const v = (id) => Number(Budget.$(id).value);
    return { date: v('csv-col-date'), label: v('csv-col-label'), amount: v('csv-col-amount'), debit: v('csv-col-debit'), credit: v('csv-col-credit') };
  },

  updateCsvPreview() {
    const p = Budget.pending; if (!p) return;
    const cols = Budget.currentCols();
    const { transactions, skipped } = BudgetCore.extractTransactions(p.rows, p.headerRow, cols);
    const { fresh, dups } = BudgetCore.dedupe(Budget.state.transactions, transactions);
    p.result = { transactions, fresh, dups, skipped };
    const sum = Budget.$('csv-summary');
    sum.textContent = transactions.length
      ? `${fresh.length} nouvelle(s) transaction(s), ${dups.length} déjà présente(s)` + (skipped.length ? `, ${skipped.length} ligne(s) illisible(s) ignorée(s)` : '') + '.'
      : 'Aucune transaction lue : vérifiez les colonnes choisies.';
    const box = Budget.$('csv-preview');
    box.replaceChildren();
    transactions.slice(0, 5).forEach((t) => {
      const row = document.createElement('div'); row.className = 'tx-top';
      const l = document.createElement('span'); l.className = 'tx-label'; l.textContent = `${Fmt.date(t.date)} · ${BudgetCore.displayLabel(t.label)}`;
      const a = document.createElement('b'); a.className = Fmt.trend(t.amount); a.textContent = Fmt.signedEur(t.amount);
      row.append(l, a); box.appendChild(row);
    });
    Budget.$('csv-confirm').disabled = !fresh.length;
  },

  confirmImport() {
    const p = Budget.pending;
    if (!p || !p.result) return;
    const rules = Budget.state.rules;
    const added = p.result.fresh.map((t) => ({
      id: BudgetStore.newId(), date: t.date, label: t.label, amount: t.amount,
      category: BudgetCore.categorize(t, rules), manual: false,
    }));
    Budget.state.transactions.push(...added);
    Budget.state.lastImport = Dates.today();
    Budget.persist();
    Budget.$('csv-dialog').close();
    const months = BudgetCore.monthsOf(added);
    if (months.length) Budget.month = months[months.length - 1];
    Budget.catFilter = null;
    Budget.pending = null;
    Budget.render();
    const uncat = added.filter((t) => t.category === BudgetCore.UNCATEGORIZED).length;
    Budget.toast(`${added.length} transaction(s) importée(s)` + (uncat ? ` · ${uncat} à catégoriser` : ''));
  },

  /* ---------- Sauvegarde ---------- */
  download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  exportJSON() {
    Budget.state.lastExport = Dates.today();
    Budget.persist();
    Budget.download(`budget-${Dates.today()}.json`, JSON.stringify(Budget.state, null, 1));
    Budget.toast('Budget exporté');
  },

  importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { state, dropped } = BudgetStore.clean(JSON.parse(reader.result));
        if (Budget.state.transactions.length && !confirm('Remplacer le budget actuel par cette sauvegarde ?')) return;
        Budget.state = state;
        Budget.persist();
        const months = BudgetCore.monthsOf(state.transactions);
        if (months.length) Budget.month = months[months.length - 1];
        Budget.render();
        Budget.toast('Budget importé' + (dropped ? ` · ${dropped} ligne(s) ignorée(s)` : ''));
      } catch (err) { alert('Import impossible : ' + err.message); }
    };
    reader.readAsText(file);
  },

  exportRules() {
    Budget.download('regles-categories.json', JSON.stringify({ rules: Budget.state.rules }, null, 1));
  },

  /** Fichier de règles : { "rules": [{ "match": "...", "category": "...", "sign": "in|out" }] } — ajoutées en tête. */
  importRules(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const list = Array.isArray(data) ? data : data.rules;
        if (!Array.isArray(list)) throw new Error('Format inattendu : liste « rules » absente.');
        const probe = BudgetStore.clean({ transactions: [], rules: list, categories: data.categories || [] });
        const known = new Set(Budget.state.categories.map((c) => c.name));
        probe.state.categories.forEach((c) => { if (!known.has(c.name)) Budget.state.categories.push(c); });
        const sig = (r) => `${BudgetCore.normLabel(r.match)}|${r.sign || ''}`;
        const have = new Set(Budget.state.rules.map(sig));
        const add = probe.state.rules.filter((r) => !have.has(sig(r)));
        Budget.state.rules = [...add, ...Budget.state.rules];
        const n = Budget.recategorize(false);
        Budget.toast(`${add.length} règle(s) ajoutée(s) · ${n} transaction(s) recatégorisée(s)`);
      } catch (err) { alert('Import impossible : ' + err.message); }
    };
    reader.readAsText(file);
  },

  /* ---------- Patrimoine ---------- */
  renderPatrimoine() {
    if (typeof App === 'undefined' || !App.state || !Budget.state) return;
    const pf = Calc.portfolio(App.lots(), App.state.prices);
    const dep = App.cashInfo();
    const pea = BudgetCore.peaTotal(pf.value, dep);
    const accounts = Budget.state.accounts;
    const cash = accounts.reduce((s, a) => s + a.balance, 0);
    const total = cash + pea.total;
    Budget.$('p-total').textContent = Fmt.eur(total);

    // Historique : total du mois enregistré (une seule ligne par mois, mise à jour si elle change)
    if (accounts.length || pea.total) {
      const { history, changed } = BudgetCore.upsertSnapshot(Budget.state.history, BudgetCore.monthOf(Dates.today()), { cash, pea: pea.total });
      if (changed) { Budget.state.history = history; Budget.persist(); }
    }
    Budget.renderHistory();
    Budget.renderReminders();
    Budget.$('p-cash').textContent = Fmt.eur(cash);
    Budget.$('p-pea').textContent = Fmt.eur(pea.total);
    const pvEl = Budget.$('p-pea-pv');
    pvEl.textContent = pf.invested ? `${Fmt.signedEur(pf.pvGross)} (${Fmt.signedPct(pf.pvGrossPct)})` : '—';
    Budget.$('p-pea-cash').textContent = pea.cash ? `dont ${Fmt.eur(pea.cash)} non investis` : '';
    pvEl.className = 'hint ' + (pf.invested ? Fmt.trend(pf.pvGross) : '');

    // Répartition : barre empilée comptes / PEA
    const bar = Budget.$('p-split');
    bar.replaceChildren();
    if (total > 0) {
      const parts = [['Comptes', cash, 'var(--series-invested)'], ['PEA', pea.total, 'var(--series-gains)']].filter((p) => p[1] > 0);
      parts.forEach(([name, v, color]) => {
        const seg = document.createElement('span');
        seg.style.width = `${(v / total) * 100}%`; seg.style.background = color;
        seg.title = `${name} : ${Fmt.eur(v)}`;
        bar.appendChild(seg);
      });
    }

    Budget.renderAvailability(pea.total);

    // Épargne du mois courant du budget
    const months = BudgetCore.monthsOf(Budget.state.transactions);
    const last = months.length ? months[months.length - 1] : null;
    const sum = last ? BudgetCore.summarizeMonth(Budget.state.transactions, last, Budget.state.categories) : null;
    Budget.$('p-month').textContent = sum ? `${Budget.monthLabel(last)} : ${Fmt.signedEur(sum.net)} (revenus ${Fmt.eur(sum.income)} − dépenses ${Fmt.eur(sum.expense)})` : 'Importez un export de banque dans l\'onglet Budget.';

    // Liste des comptes
    const box = Budget.$('p-accounts');
    box.replaceChildren();
    const groups = BudgetCore.groupAccounts(accounts);
    const showHeads = groups.length > 1 || (groups[0] && groups[0].bank);
    groups.forEach((g) => {
      if (showHeads) {
        const head = document.createElement('div'); head.className = 'bank-head';
        const n = document.createElement('span'); n.textContent = g.bank || 'Sans banque';
        const t = document.createElement('b'); t.textContent = Fmt.eur(g.total);
        head.append(n, t); box.appendChild(head);
      }
      g.accounts.forEach((a) => Budget.renderAccount(box, a));
    });
    Budget.$('p-accounts-empty').hidden = accounts.length > 0;
    Budget.renderBankList();

    // Reprise des données du Suivi PEA d'origine (même navigateur) si la copie est vide
    let canImport = false;
    try { canImport = !App.state.purchases.length && !!localStorage.getItem('suivi-pea:v1'); } catch (e) { /* stockage inaccessible */ }
    Budget.$('p-import-old').hidden = !canImport;
  },

  /** Menu des banques du formulaire d'ajout (garde le choix en cours). */
  renderBankList() {
    const sel = Budget.$('account-form') && Budget.$('account-form').bank;
    if (sel && document.activeElement !== sel) Budget.fillBankSelect(sel, sel.value);
  },

  /**
   * Remplit un menu de banques : « Sans banque », les groupes (Mes banques, France, Allemagne…)
   * et « Autre… », qui demande le nom et l'ajoute au menu.
   */
  fillBankSelect(sel, current = '') {
    const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
    const used = [...Budget.state.accounts.map((a) => a.bank), current];
    const groups = BudgetCore.bankOptions(used).map((g) => {
      const og = document.createElement('optgroup'); og.label = g.label;
      g.banks.forEach((b) => og.appendChild(opt(b, b)));
      return og;
    });
    sel.replaceChildren(opt('', 'Sans banque'), ...groups, opt('__other', 'Autre (saisir le nom)…'));
    sel.value = current || '';
    if (!sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => {
        if (sel.value !== '__other') { sel.dataset.last = sel.value; return; }
        const name = (prompt('Nom de la banque :') || '').trim().slice(0, 40);
        Budget.fillBankSelect(sel, name || sel.dataset.last || '');
      });
    }
    sel.dataset.last = sel.value;
  },

  /** Fenêtre « Changer la banque » d'un compte existant. */
  pickBank(a) {
    const dlg = Budget.$('bank-dialog');
    const sel = Budget.$('bank-dialog-select');
    Budget.$('bank-dialog-title').textContent = `Banque de « ${a.name} »`;
    Budget.fillBankSelect(sel, a.bank || '');
    const ok = Budget.$('bank-dialog-ok');
    const onOk = () => {
      if (sel.value !== '__other') { a.bank = sel.value; Budget.persist(); Budget.renderPatrimoine(); }
      dlg.close();
    };
    ok.onclick = onOk;
    Budget.$('bank-dialog-cancel').onclick = () => dlg.close();
    dlg.showModal();
  },

  /** Un compte : nom (touche = changer de banque), solde modifiable, disponibilité. */
  renderAccount(box, a) {
    const row = document.createElement('div'); row.className = 'account-row';
    const name = document.createElement('button');
    name.type = 'button'; name.className = 'account-name';
    name.textContent = a.name;
    name.title = 'Changer la banque';
    name.setAttribute('aria-label', `${a.name} : changer la banque`);
    name.addEventListener('click', () => Budget.pickBank(a));
    const bal = document.createElement('input');
    bal.type = 'text'; bal.inputMode = 'decimal'; bal.value = Fmt.input(a.balance); bal.setAttribute('aria-label', `Solde de ${a.name}`);
    bal.addEventListener('change', () => {
      const v = BudgetCore.parseAmount(bal.value);
      if (Number.isNaN(v)) { bal.value = Fmt.input(a.balance); return; }
      a.balance = v; a.date = Dates.today(); Budget.persist(); Budget.renderPatrimoine();
    });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn small'; del.textContent = '×'; del.setAttribute('aria-label', `Supprimer ${a.name}`);
    del.addEventListener('click', () => {
      if (!confirm(`Supprimer le compte « ${a.name} » ?`)) return;
      Budget.state.accounts = Budget.state.accounts.filter((x) => x.id !== a.id);
      Budget.persist(); Budget.renderPatrimoine();
    });
    row.append(name, bal, del);
    box.appendChild(row);
    // Disponible tout de suite, ou bloqué (avec date de déblocage facultative)
    const meta = document.createElement('div'); meta.className = 'account-meta';
    const d = document.createElement('span'); d.className = 'hint'; d.textContent = a.date ? `mis à jour le ${Fmt.date(a.date)}` : '';
    const sel = document.createElement('select'); sel.setAttribute('aria-label', `Disponibilité de ${a.name}`);
    [['dispo', 'Disponible'], ['bloque', 'Bloqué']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
    sel.value = a.blocked ? 'bloque' : 'dispo';
    const until = document.createElement('input'); until.type = 'date'; until.value = a.until || '';
    until.setAttribute('aria-label', `${a.name} : bloqué jusqu'au (facultatif)`); until.title = 'Bloqué jusqu\'au (facultatif)';
    until.hidden = !a.blocked;
    const untilLbl = document.createElement('span'); untilLbl.className = 'until-label'; untilLbl.textContent = 'jusqu\'au'; untilLbl.hidden = !a.blocked;
    sel.addEventListener('change', () => { a.blocked = sel.value === 'bloque'; if (!a.blocked) a.until = ''; Budget.persist(); Budget.renderPatrimoine(); });
    until.addEventListener('change', () => { a.until = BudgetCore.parseDate(until.value) || ''; Budget.persist(); Budget.renderPatrimoine(); });
    meta.append(d, sel, untilLbl, until);
    box.appendChild(meta);
  },

  /** Argent disponible tout de suite / bloqué (PEA avant 5 ans, PEL, CEL…). */
  renderAvailability(peaAmount) {
    const until = App.state.openingDate ? Calc.peaCountdown(App.state.openingDate).targetISO : '';
    const av = BudgetCore.availability(Budget.state.accounts, { amount: peaAmount, until }, Dates.today());
    Budget.$('p-available').textContent = Fmt.eur(av.available);
    Budget.$('p-blocked').textContent = Fmt.eur(av.blocked);
    const bar = Budget.$('p-avail-bar');
    bar.replaceChildren();
    const tot = av.available + av.blocked;
    if (tot > 0) {
      [[av.available, 'var(--good)', 'Disponible'], [av.blocked, 'var(--muted)', 'Bloqué']].filter((x) => x[0] > 0).forEach(([v, color, name]) => {
        const seg = document.createElement('span');
        seg.style.width = `${(v / tot) * 100}%`; seg.style.background = color; seg.title = `${name} : ${Fmt.eur(v)}`;
        bar.appendChild(seg);
      });
    }
    const list = Budget.$('p-avail-list');
    list.replaceChildren();
    for (const group of [false, true]) {
      const items = av.items.filter((i) => i.blocked === group && i.amount);
      if (!items.length) continue;
      const h = document.createElement('p'); h.className = 'label'; h.textContent = group ? 'Bloqué' : 'Disponible maintenant';
      list.appendChild(h);
      items.forEach((i) => {
        const row = document.createElement('div'); row.className = 'tx-top';
        const n = document.createElement('span');
        n.textContent = i.blocked ? `${i.name} · ${i.until ? `jusqu'au ${Fmt.date(i.until)}` : 'sans date'}` : i.name;
        const b = document.createElement('b'); b.textContent = Fmt.eur(i.amount);
        row.append(n, b); list.appendChild(row);
      });
    }
    Budget.$('p-avail-hint').textContent = av.nextRelease
      ? `Prochain déblocage : ${av.nextRelease.name} le ${Fmt.date(av.nextRelease.date)} (${Fmt.eur(av.nextRelease.amount)} aujourd'hui).`
      : (tot ? 'Marquez un compte « Bloqué » (PEL, CEL…) dans Mes comptes pour le sortir du disponible.' : '');
  },

  /** Courbe du patrimoine total, un point par mois. */
  renderHistory() {
    const el = Budget.$('p-history');
    if (!el) return;
    const h = Budget.state.history;
    const hint = Budget.$('p-history-hint');
    el.innerHTML = '';
    el.hidden = h.length < 2;
    if (h.length < 2) {
      hint.textContent = h.length
        ? `La courbe se construit mois après mois : premier point en ${Budget.monthLabel(h[0].month)} (${Fmt.eur0(h[0].total)}). Le total du mois est enregistré à chaque ouverture.`
        : 'Ajoutez vos comptes : le total sera enregistré chaque mois pour tracer la courbe.';
      return;
    }
    const first = h[0]; const last = h[h.length - 1];
    const diff = last.total - first.total;
    hint.textContent = `Depuis ${Budget.monthLabel(first.month)} : ${diff >= 0 ? '+' : '−'}${Fmt.eur0(Math.abs(diff))} (comptes ${Fmt.eur0(last.cash)}, PEA ${Fmt.eur0(last.pea)}).`;
    const W = el.clientWidth || 320; const H = el.clientHeight || 150;
    const m = { top: 12, right: 10, bottom: 22, left: 10 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, el);
    const vals = h.map((x) => x.total);
    let lo = Math.min(...vals); let hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const sx = (i) => m.left + (i / (h.length - 1)) * (W - m.left - m.right);
    const sy = (v) => m.top + (1 - (v - lo) / (hi - lo)) * (H - m.top - m.bottom);
    const pts = h.map((x, i) => `${sx(i)},${sy(x.total)}`).join(' ');
    svgEl('polyline', { points: pts, fill: 'none', style: 'stroke: var(--series-value); stroke-width: 2' }, svg);
    h.forEach((x, i) => {
      const dot = svgEl('circle', { cx: sx(i), cy: sy(x.total), r: 3, style: 'fill: var(--series-value)' }, svg);
      const tip = svgEl('title', {}, dot); tip.textContent = `${Budget.monthLabel(x.month)} : ${Fmt.eur0(x.total)}`;
    });
    const tick = (i, anchor) => {
      const t = svgEl('text', { x: sx(i), y: H - 6, 'text-anchor': anchor, class: 'tick' }, svg);
      t.textContent = new Date(+h[i].month.slice(0, 4), +h[i].month.slice(5) - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    };
    tick(0, 'start'); tick(h.length - 1, 'end');
    svgEl('line', { x1: m.left, x2: W - m.right, y1: H - m.bottom, y2: H - m.bottom, class: 'baseline' }, svg);
  },

  addAccount(ev) {
    ev.preventDefault();
    const form = Budget.$('account-form');
    const name = form.name.value.trim();
    const balance = BudgetCore.parseAmount(form.balance.value);
    const err = Budget.$('account-error');
    if (!name || Number.isNaN(balance)) { err.textContent = 'Nom et solde valide (ex. 1 250,50) requis.'; err.hidden = false; return; }
    err.hidden = true;
    const blocked = form.availability.value === 'bloque';
    const bank = form.bank.value.trim().slice(0, 40);
    Budget.state.accounts.push({ id: BudgetStore.newId(), name: name.slice(0, 60), bank, balance, date: Dates.today(), blocked, until: '' });
    form.reset();
    Budget.persist(); Budget.renderPatrimoine();
  },

  /** Copie (lecture seule) des achats du Suivi PEA d'origine : l'original n'est jamais modifié. */
  importOldPea() {
    try {
      const raw = localStorage.getItem('suivi-pea:v1');
      if (!raw) throw new Error('Aucune donnée du Suivi PEA d\'origine dans ce navigateur.');
      const state = Store.sanitize(JSON.parse(raw));
      App.state = state; App.persist(); App.renderAll();
      Budget.toast(`${state.purchases.length} achat(s) repris du Suivi PEA d'origine`);
    } catch (err) { alert('Reprise impossible : ' + err.message); }
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BudgetCore, BudgetStore };
}
