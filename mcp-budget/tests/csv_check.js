// Vérifie avec le VRAI budget.js : usage  node csv_check.js <fichier.csv> <règles-utilisateur.json> <existant.json>
// Affiche en JSON ce que fait le bouton d'import de l'appli (colonnes, transactions, doublons, catégories).
const fs = require('fs');
const { BudgetCore: B } = require('../../budget.js');
const [file, rulesFile, existingFile] = process.argv.slice(2);
const buf = fs.readFileSync(file);
let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
const { rows, delimiter } = B.parseCsv(text);
const det = B.detectColumns(rows);
const { transactions, skipped } = B.extractTransactions(rows, det.headerRow, det.cols);
const { fresh, dups } = B.dedupe(existing, transactions);
console.log(JSON.stringify({ delimiter, headerRow: det.headerRow, cols: det.cols, headers: det.headers, transactions, skipped,
  fresh, dups, cats: fresh.map((t) => B.categorize(t, rules)), defaults: B.DEFAULT_RULES }));
