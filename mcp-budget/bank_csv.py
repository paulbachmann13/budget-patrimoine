"""Import d'un CSV bancaire : port fidèle de BudgetCore (budget.js) — lecture du CSV, détection des colonnes,
extraction, doublons et catégorisation — pour que l'import par Claude donne EXACTEMENT le même résultat que le
bouton d'import de l'appli. Les tests comparent ce module au vrai budget.js (tests/test_csv.py)."""
from __future__ import annotations

import json
import math
import re
import unicodedata
from datetime import date
from pathlib import Path
from typing import Any

UNCATEGORIZED = "À catégoriser"
DEFAULT_RULES: list[dict[str, Any]] = json.loads((Path(__file__).parent / "default_rules.json").read_text(encoding="utf-8"))
_SPACES = re.compile("[  -   　﻿]")


def norm_label(s: Any) -> str:
    s = unicodedata.normalize("NFD", _SPACES.sub(" ", str("" if s is None else s)))
    s = "".join(c for c in s if not "̀" <= c <= "ͯ").lower()
    s = re.sub(r"\b(paiement|achat)?\s*(par\s*)?(cb|carte)\b\s*(x{0,2}\d{3,4})?", " ", s, flags=re.A)
    s = re.sub(r"\b\d{2}[/.-]\d{2}([/.-]\d{2,4})?\b", " ", s, flags=re.A)
    s = re.sub(r"\bx{2,}\d+\b", " ", s, flags=re.A)
    s = re.sub(r"[^a-z0-9&+'./ -]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_date(raw: Any) -> str | None:
    s = str("" if raw is None else raw).strip()
    r = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s, flags=re.A)
    if r:
        y, m, d = int(r[1]), int(r[2]), int(r[3])
    else:
        r = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?!\d)", s, flags=re.A)
        if not r:
            return None
        d, m, y = int(r[1]), int(r[2]), int(r[3])
        if y < 100:
            y += 2000
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None


def parse_amount(raw: Any) -> float:
    """Nombre ou NaN (mêmes formats que l'appli : « -1 234,56 € », « (15,00) », « 12,30- »…)."""
    nan = float("nan")
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str("" if raw is None else raw).strip()
    if not s:
        return nan
    neg = False
    if re.fullmatch(r"\(.*\)", s, flags=re.S):
        neg, s = True, s[1:-1]
    s = re.sub(r"[\s  €]|eur\b", "", s, flags=re.I).removeprefix("+").replace("−", "-")
    if s.endswith("-"):
        neg, s = not neg, s[:-1]
    if not re.fullmatch(r"-?[\d.,]+", s):
        return nan
    has_c, has_d = "," in s, "." in s
    if has_c and has_d:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
        thou = "." if dec == "," else ","
        s = s.replace(thou, "").replace(dec, ".", 1)
    elif has_c:
        s = s.replace(",", "") if s.count(",") > 1 else s.replace(",", ".", 1)
    elif has_d and s.count(".") > 1:
        s = s.replace(".", "")
    try:
        v = float(s)
    except ValueError:
        return nan
    if not math.isfinite(v):
        return nan
    return -abs(v) if neg else v


def detect_delimiter(text: str) -> str:
    lines = [l for l in re.split(r"\r?\n", text) if l.strip()][:15]
    best, best_score = ";", -1
    for d in (";", "\t", ",", "|"):
        counts = []
        for l in lines:
            n, q = 0, False
            for ch in l:
                if ch == '"':
                    q = not q
                elif ch == d and not q:
                    n += 1
            counts.append(n)
        nz = [c for c in counts if c > 0]
        if not nz:
            continue
        freq: dict[int, int] = {}
        for c in nz:
            freq[c] = freq.get(c, 0) + 1
        mode, times = sorted(freq.items(), key=lambda kv: (-kv[1], -kv[0]))[0]
        score = times * 10 + mode
        if score > best_score:
            best, best_score = d, score
    return best


def parse_csv(text: str, delim: str | None = None) -> tuple[list[list[str]], str]:
    t = text[1:] if text.startswith("﻿") else text
    d = delim or detect_delimiter(t)
    rows: list[list[str]] = []
    row: list[str] = []
    cell, q, i = "", False, 0
    while i < len(t):
        ch = t[i]
        if q:
            if ch == '"':
                if i + 1 < len(t) and t[i + 1] == '"':
                    cell += '"'
                    i += 1
                else:
                    q = False
            else:
                cell += ch
        elif ch == '"':
            q = True
        elif ch == d:
            row.append(cell)
            cell = ""
        elif ch in "\n\r":
            if ch == "\r" and i + 1 < len(t) and t[i + 1] == "\n":
                i += 1
            row.append(cell)
            cell = ""
            if any(c.strip() for c in row):
                rows.append(row)
            row = []
        else:
            cell += ch
        i += 1
    row.append(cell)
    if any(c.strip() for c in row):
        rows.append(row)
    return rows, d


def detect_columns(rows: list[list[str]]) -> dict[str, Any]:
    header_row = -1
    for i in range(min(len(rows), 40)):
        hs = [norm_label(c) for c in rows[i]]
        has_date = any(re.search("date", h) for h in hs)
        has_amt = any(re.search(r"montant|amount|somme|debit|credit|valeur en euro", h) for h in hs)
        has_label = any(re.search(r"libelle|label|description|intitule|detail|motif|operation", h) for h in hs)
        if has_date and (has_amt or has_label):
            header_row = i
            break
    cols = {"date": -1, "label": -1, "amount": -1, "debit": -1, "credit": -1}
    if header_row >= 0:
        headers = [str(h).strip() for h in rows[header_row]]
        hs = [norm_label(h) for h in headers]

        def find(*res: str) -> int:
            for rx in res:
                for i, h in enumerate(hs):
                    if re.search(rx, h, flags=re.A):
                        return i
            return -1

        cols["date"] = find(r"date.*(operation|comptabilisation|completed|opération)", r"^date$", r"date(?!.*(valeur|value))", r"date")
        cols["label"] = find(r"^(label|libelle|description|intitule|detail|motif)\b", r"(libelle|label|description|intitule|detail|motif)", r"operation")
        cols["debit"] = find(r"debit")
        cols["credit"] = find(r"credit")
        cols["amount"] = find(r"^(montant|amount)\b", r"montant|amount|somme")
        if cols["amount"] >= 0 and cols["debit"] >= 0 and cols["credit"] >= 0 and not re.search(r"montant|amount", hs[cols["amount"]]):
            cols["amount"] = -1
    else:
        sample = rows[:30]
        width = max(len(r) for r in sample)

        def score(fn) -> list[int]:
            return [sum(1 for r in sample if c < len(r) and fn(r[c])) for c in range(width)]

        d_score = score(lambda v: parse_date(v))
        a_score = score(lambda v: not parse_date(v) and not math.isnan(parse_amount(v)) and re.search(r"\d", v))
        t_len = [sum(len(str(r[c])) if c < len(r) and r[c] and math.isnan(parse_amount(r[c])) and not parse_date(r[c]) else 0 for r in sample)
                 for c in range(width)]
        cols["date"], cols["amount"], cols["label"] = d_score.index(max(d_score)), a_score.index(max(a_score)), t_len.index(max(t_len))
        headers = [f"Colonne {i + 1}" for i in range(width)]
    return {"header_row": header_row, "cols": cols, "headers": headers}


def _round2(x: float) -> float:
    return math.floor(x * 100 + 0.5) / 100


def _cell(r: list[str], i: int) -> Any:
    return r[i] if 0 <= i < len(r) else None


def extract_transactions(rows: list[list[str]], header_row: int, cols: dict[str, int]) -> tuple[list[dict[str, Any]], list[int]]:
    out: list[dict[str, Any]] = []
    skipped: list[int] = []
    nan = float("nan")
    for i in range(header_row + 1, len(rows)):
        r = rows[i]
        dt = parse_date(_cell(r, cols["date"])) if cols["date"] >= 0 else None
        amount = nan
        if cols["amount"] >= 0:
            amount = parse_amount(_cell(r, cols["amount"]))
        elif cols["debit"] >= 0 or cols["credit"] >= 0:
            deb = parse_amount(_cell(r, cols["debit"])) if cols["debit"] >= 0 else nan
            cre = parse_amount(_cell(r, cols["credit"])) if cols["credit"] >= 0 else nan
            if not math.isnan(cre) and cre != 0:
                amount = abs(cre)
            elif not math.isnan(deb) and deb != 0:
                amount = -abs(deb)
            elif not math.isnan(deb) or not math.isnan(cre):
                amount = 0.0
        label = re.sub(r"\s+", " ", str(_cell(r, cols["label"]) or "")).strip() if cols["label"] >= 0 else ""
        if not dt or math.isnan(amount):
            skipped.append(i + 1)
            continue
        out.append({"date": dt, "label": label or "(sans libellé)", "amount": _round2(amount)})
    return out, skipped


def categorize(tx: dict[str, Any], user_rules: list[dict[str, Any]] | None = None) -> str:
    label = norm_label(tx["label"]) + " "
    for rule in [*(user_rules or []), *DEFAULT_RULES]:
        m = norm_label(rule["match"])
        if not m:
            continue
        if rule.get("sign") == "in" and not tx["amount"] > 0:
            continue
        if rule.get("sign") == "out" and not tx["amount"] < 0:
            continue
        hit = (" " + m + " ") in (" " + label) if rule["match"].endswith(" ") else m in label
        if hit:
            return rule["category"]
    return UNCATEGORIZED


def dedupe(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    key = lambda t: f"{t['date']}|{t['amount'] + 0.0:.2f}|{norm_label(t['label'])}"  # noqa: E731
    have: dict[str, int] = {}
    for t in existing:
        have[key(t)] = have.get(key(t), 0) + 1
    seen: dict[str, int] = {}
    fresh: list[dict[str, Any]] = []
    dups: list[dict[str, Any]] = []
    for t in incoming:
        k = key(t)
        seen[k] = seen.get(k, 0) + 1
        (dups if have.get(k, 0) >= seen[k] else fresh).append(t)
    return fresh, dups


def decode(raw: bytes) -> str:
    """UTF-8 sinon Windows-1252, comme l'appli."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")
