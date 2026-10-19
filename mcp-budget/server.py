"""Serveur MCP (stdio, lecture seule) pour l'appli « Budget & Patrimoine ».

Il lit les deux exports JSON de l'appli (budget-AAAA-MM-JJ.json et pea-AAAA-MM-JJ.json)
placés dans un dossier local. Il n'écrit, ne modifie et ne supprime jamais rien.

Configuration (variables d'environnement) :
Source 1 (prioritaire si configurée) : la synchro chiffrée Supabase, lue en direct (voir vault.py :
  SUPABASE_URL, SUPABASE_KEY, SUPABASE_EMAIL ; mot de passe et phrase dans le trousseau macOS).
Source 2 (secours / hors ligne) : les exports JSON de l'appli.
  BUDGET_DATA_DIR  dossier des exports (défaut : ~/Documents/budget-data)
  BUDGET_FILE      chemin explicite du fichier budget (optionnel)
  PEA_FILE         chemin explicite du fichier PEA (optionnel)
"""
from __future__ import annotations

import functools
import json
import os
import re
from datetime import date
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

import vault

mcp = FastMCP("budget-patrimoine")

NEUTRAL, AID = "neutre", "aide"
UNCATEGORIZED = "À catégoriser"


class DataError(Exception):
    """Erreur lisible renvoyée telle quelle à Claude."""


# --------------------------------------------------------------------------- lecture

def _data_dir() -> Path:
    return Path(os.environ.get("BUDGET_DATA_DIR", "~/Documents/budget-data")).expanduser()


def _find(prefix: str, env_var: str) -> Path:
    explicit = os.environ.get(env_var)
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_file():
            raise DataError(f"Fichier introuvable : {p} (variable {env_var}).")
        return p
    d = _data_dir()
    if not d.is_dir():
        raise DataError(
            f"Dossier de données introuvable : {d}. Créez-le, exportez vos données depuis l'appli "
            "(Budget → Exporter, PEA → Sauvegarder) puis déposez-y les fichiers, "
            "ou définissez BUDGET_DATA_DIR."
        )
    files = [f for f in d.glob(f"{prefix}-*.json") if f.is_file()]
    if not files:
        raise DataError(f"Aucun fichier {prefix}-*.json dans {d}. Exportez-le depuis l'appli.")
    return max(files, key=lambda f: (f.stat().st_mtime, f.name))


def _load(prefix: str, env_var: str) -> tuple[dict[str, Any], Path]:
    path = _find(prefix, env_var)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise DataError(f"Impossible de lire {path.name} : {e}") from e
    if not isinstance(data, dict):
        raise DataError(f"{path.name} n'a pas le format attendu.")
    return data, path


_source = {"label": None}


def _both() -> tuple[dict[str, Any], dict[str, Any] | None]:
    """(budget, pea). Synchro Supabase si configurée, sinon (ou si elle échoue) les fichiers exportés."""
    if vault.configured():
        try:
            d = vault.fetch()
            _source["label"] = f"synchro Supabase (dernière écriture : {d.get('_updated_at')})"
            return d.get("budget") or {}, d.get("pea")
        except vault.VaultError as e:
            cloud_error = str(e)
            try:
                b = _load("budget", "BUDGET_FILE")
            except DataError:
                raise DataError(f"Synchro Supabase indisponible : {cloud_error}") from None
            _source["label"] = f"FICHIERS (synchro indisponible : {cloud_error})"
            try:
                return b[0], _load("pea", "PEA_FILE")[0]
            except DataError:
                return b[0], None
    b, bp = _load("budget", "BUDGET_FILE")
    _source["label"] = f"fichier {bp.name}"
    try:
        return b, _load("pea", "PEA_FILE")[0]
    except DataError:
        return b, None


def _budget() -> dict[str, Any]:
    return _both()[0]


def _pea() -> dict[str, Any]:
    p = _both()[1]
    if p is None:
        raise DataError("Données PEA introuvables (ni dans la synchro, ni dans un fichier pea-*.json).")
    return p


def _tag(fn):
    """Ajoute la provenance des données ("source") au résultat d'un outil."""
    @functools.wraps(fn)
    def wrapper(*a, **k):
        _source["label"] = None
        out = fn(*a, **k)
        if isinstance(out, dict) and "erreur" not in out and _source["label"]:
            out = {**out, "source": _source["label"]}
        return out
    return wrapper


def _r(v: float) -> float:
    return round(float(v) + 0.0, 2)


def _month(m: str | None, txs: list[dict[str, Any]]) -> str:
    months = sorted({t["date"][:7] for t in txs if t.get("date")})
    if not months:
        raise DataError("Le fichier budget ne contient aucune opération.")
    if not m:
        return months[-1]
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", m):
        raise DataError(f"Mois invalide « {m} » : utilisez le format AAAA-MM (ex. 2026-03).")
    if m not in months:
        raise DataError(f"Aucune opération en {m}. Mois disponibles : {months[0]} → {months[-1]}.")
    return m


def _kinds(b: dict[str, Any]) -> dict[str, str]:
    return {c["name"]: c.get("kind", "depense") for c in b.get("categories", []) if "name" in c}


# --------------------------------------------------------------------------- budget

def _kind(kinds: dict[str, str], cat: str, amt: float) -> str:
    if cat == UNCATEGORIZED:
        return "revenu" if amt > 0 else "depense"
    return kinds.get(cat, "depense")


def _month_totals(b: dict[str, Any], month: str) -> dict[str, Any]:
    """Même règle que BudgetCore.summarizeMonth de l'appli : le type de la catégorie décide,
    les montants se compensent dans leur catégorie (un virement sortant rangé en « Remboursement »
    réduit les revenus ; un remboursement reçu en catégorie de dépense réduit la dépense)."""
    kinds = _kinds(b)
    income = aid = expense = neutral = 0.0
    by_cat: dict[str, float] = {}
    uncategorized = 0
    for t in b.get("transactions", []):
        if t["date"][:7] != month:
            continue
        cat, amt = t.get("category", UNCATEGORIZED), float(t["amount"])
        uncategorized += cat == UNCATEGORIZED
        kind = _kind(kinds, cat, amt)
        if kind == NEUTRAL:
            neutral += amt
            continue
        by_cat[cat] = by_cat.get(cat, 0.0) + amt
        if kind in ("revenu", AID):
            income += amt
            if kind == AID:
                aid += amt
        else:
            expense -= amt
    spending = {c: -v for c, v in by_cat.items() if _kind(kinds, c, v) == "depense" and v < 0}
    return {"income": income, "aid": aid, "expense": expense, "neutral": neutral,
            "uncategorized": uncategorized, "spending": spending}


def _summary(b: dict[str, Any], month: str) -> dict[str, Any]:
    t = _month_totals(b, month)
    return {
        "mois": month,
        "revenus": _r(t["income"]),
        "dont_aide_recue": _r(t["aid"]),
        "depenses": _r(t["expense"]),
        "solde": _r(t["income"] - t["expense"]),
        "mouvements_neutres_exclus": _r(t["neutral"]),
        "operations_a_categoriser": t["uncategorized"],
    }


@mcp.tool()
@_tag
def etat_donnees() -> dict[str, Any]:
    """Indique quels fichiers d'export sont lus, leur date de modification et la période couverte.
    À appeler en premier pour savoir si les données sont à jour."""
    out: dict[str, Any] = {}
    if vault.configured():
        try:
            b, p = _both()
            dates = sorted(t["date"] for t in b.get("transactions", []) if t.get("date"))
            return {
                "source": _source["label"],
                "budget": {"operations": len(dates), "premiere": dates[0] if dates else None, "derniere": dates[-1] if dates else None},
                "pea": {"achats": len((p or {}).get("purchases", [])), "ventes": len((p or {}).get("sales", []))} if p else {"erreur": "absent"},
            }
        except DataError as e:
            out["synchro"] = {"erreur": str(e)}
    for key, prefix, env in (("budget", "budget", "BUDGET_FILE"), ("pea", "pea", "PEA_FILE")):
        try:
            data, path = _load(prefix, env)
        except DataError as e:
            out[key] = {"erreur": str(e)}
            continue
        info: dict[str, Any] = {
            "fichier": path.name,
            "modifie_le": date.fromtimestamp(path.stat().st_mtime).isoformat(),
        }
        if key == "budget":
            dates = sorted(t["date"] for t in data.get("transactions", []) if t.get("date"))
            info.update(operations=len(dates), premiere=dates[0] if dates else None, derniere=dates[-1] if dates else None)
        else:
            info.update(achats=len(data.get("purchases", [])), ventes=len(data.get("sales", [])))
        out[key] = info
    return out


@mcp.tool()
@_tag
def resume_budget(mois: str | None = None) -> dict[str, Any]:
    """Revenus, dépenses et solde d'un mois (hors virements internes et épargne).
    `mois` au format AAAA-MM ; par défaut le mois le plus récent des données."""
    try:
        b = _budget()
        return _summary(b, _month(mois, b.get("transactions", [])))
    except DataError as e:
        return {"erreur": str(e)}


@mcp.tool()
@_tag
def depenses_par_categorie(mois: str | None = None) -> dict[str, Any]:
    """Total des dépenses par catégorie pour un mois (AAAA-MM, défaut : dernier mois), triées par montant décroissant,
    avec les plafonds éventuels définis dans l'appli."""
    try:
        b = _budget()
        month = _month(mois, b.get("transactions", []))
        totals = _month_totals(b, month)["spending"]
        budgets = b.get("budgets", {})
        rows = []
        for cat, total in sorted(totals.items(), key=lambda kv: -kv[1]):
            row: dict[str, Any] = {"categorie": cat, "total": _r(total)}
            lim = budgets.get(cat)
            if lim and lim.get("period") == "mois":
                row["plafond_mensuel"] = lim["limit"]
                row["reste"] = _r(lim["limit"] - total)
            rows.append(row)
        return {"mois": month, "total_depenses": _r(sum(totals.values())), "categories": rows}
    except DataError as e:
        return {"erreur": str(e)}


@mcp.tool()
@_tag
def rechercher_operations(
    texte: str | None = None,
    date_debut: str | None = None,
    date_fin: str | None = None,
    categorie: str | None = None,
    limite: int = 50,
) -> dict[str, Any]:
    """Cherche des opérations bancaires. `texte` : morceau du libellé (insensible à la casse) ;
    `date_debut` / `date_fin` : AAAA-MM-JJ (inclus) ; `categorie` : nom exact ; `limite` : 1 à 200 (défaut 50).
    Montants négatifs = dépenses. Résultats du plus récent au plus ancien."""
    try:
        for name, v in (("date_debut", date_debut), ("date_fin", date_fin)):
            if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                raise DataError(f"{name} invalide « {v} » : utilisez AAAA-MM-JJ.")
        limite = max(1, min(int(limite), 200))
        needle = (texte or "").lower().strip()
        found = [
            t for t in _budget().get("transactions", [])
            if (not needle or needle in str(t.get("label", "")).lower())
            and (not date_debut or t["date"] >= date_debut)
            and (not date_fin or t["date"] <= date_fin)
            and (not categorie or t.get("category") == categorie)
        ]
        found.sort(key=lambda t: t["date"], reverse=True)
        return {
            "total_trouve": len(found),
            "somme": _r(sum(float(t["amount"]) for t in found)),
            "operations": [
                {"date": t["date"], "libelle": t.get("label"), "montant": _r(t["amount"]), "categorie": t.get("category")}
                for t in found[:limite]
            ],
        }
    except DataError as e:
        return {"erreur": str(e)}


@mcp.tool()
@_tag
def plafonds_budget(mois: str | None = None) -> dict[str, Any]:
    """État des plafonds de dépenses par catégorie pour un mois (plafonds mensuels uniquement)."""
    try:
        b = _budget()
        month = _month(mois, b.get("transactions", []))
        spent = {r["categorie"]: r["total"] for r in depenses_par_categorie(month)["categories"]}
        rows = [
            {"categorie": c, "plafond": v["limit"], "depense": spent.get(c, 0.0), "reste": _r(v["limit"] - spent.get(c, 0.0))}
            for c, v in b.get("budgets", {}).items() if v.get("period") == "mois"
        ]
        if not rows:
            return {"mois": month, "plafonds": [], "info": "Aucun plafond mensuel défini dans l'appli."}
        return {"mois": month, "plafonds": rows}
    except DataError as e:
        return {"erreur": str(e)}


# --------------------------------------------------------------------------- PEA

def _ticker(t: str) -> str:
    s = re.sub(r"\s+", " ", str(t or "").strip().upper())
    return {"FR001400U5Q4": "DCAM"}.get(s, re.sub(r"\.PA$", "", s))


def _pea_report(p: dict[str, Any]) -> dict[str, Any]:
    """Méthode du PRU, identique à Calc.trades / Calc.portfolio de l'appli (frais inclus)."""
    events = [("b", x) for x in p.get("purchases", [])] + [("s", x) for x in p.get("sales", [])]
    events.sort(key=lambda e: (e[1]["date"], 0 if e[0] == "b" else 1))
    book: dict[str, dict[str, float]] = {}
    realized = 0.0
    proceeds_total = 0.0
    for kind, e in events:
        t = _ticker(e["ticker"])
        fees = float(e.get("fees") or 0)
        if kind == "b":
            pos = book.setdefault(t, {"qty": 0.0, "cost": 0.0, "last": 0.0})
            pos["qty"] += e["qty"]
            pos["cost"] += e["qty"] * e["price"] + fees
            pos["last"] = e["price"]
            continue
        pos = book.get(t)
        if not pos or pos["qty"] <= 1e-9:
            continue
        qty = min(e["qty"], pos["qty"])
        cost = pos["cost"] * qty / pos["qty"]
        proceeds = qty * e["price"] - fees * qty / e["qty"]
        realized += proceeds - cost
        proceeds_total += proceeds
        pos["cost"] -= cost
        pos["qty"] -= qty
        if pos["qty"] < 1e-9:
            pos["qty"] = pos["cost"] = 0.0

    prices = p.get("prices", {})
    positions = []
    for t, pos in book.items():
        if pos["qty"] <= 1e-9:
            continue
        quote = prices.get(t) or {}
        has_quote = float(quote.get("price") or 0) > 0
        cur = float(quote["price"]) if has_quote else pos["last"]
        value = pos["qty"] * cur
        positions.append({
            "titre": t,
            "nom": (p.get("instruments", {}).get(t) or {}).get("name"),
            "quantite": round(pos["qty"], 6),
            "pru": _r(pos["cost"] / pos["qty"]),
            "cours": cur,
            "cours_date": quote.get("date") if has_quote else None,
            "cours_reel": has_quote,
            "investi": _r(pos["cost"]),
            "valeur": _r(value),
            "plus_moins_value": _r(value - pos["cost"]),
            "plus_moins_value_pct": _r(100 * (value - pos["cost"]) / pos["cost"]) if pos["cost"] else 0.0,
        })
    positions.sort(key=lambda x: -x["investi"])

    deposits = sum(d["amount"] for d in p.get("deposits", []))
    spent = sum(x["qty"] * x["price"] + float(x.get("fees") or 0) for x in p.get("purchases", []))
    moves: dict[str, float] = {}
    for m in p.get("moves", []):
        moves[m["kind"]] = moves.get(m["kind"], 0.0) + m["amount"]
    cash = None
    if p.get("deposits"):
        cash = (deposits + proceeds_total + moves.get("credit", 0) + moves.get("dividende", 0)
                - spent - moves.get("frais", 0) - moves.get("retrait", 0))
    value = sum(x["valeur"] for x in positions)
    invested = sum(x["investi"] for x in positions)
    return {
        "positions": positions,
        "valeur_titres": _r(value),
        "investi_titres": _r(invested),
        "plus_moins_value_latente": _r(value - invested),
        "plus_moins_value_realisee": _r(realized),
        "versements_total": _r(deposits),
        "plafond_150k_restant": _r(max(150000 - (deposits if p.get("deposits") else spent), 0)),
        "liquidites": _r(cash) if cash is not None else None,
        "total_pea": _r(value + (cash if cash and cash > 0 else 0)),
    }


@mcp.tool()
@_tag
def valeur_pea() -> dict[str, Any]:
    """Positions du PEA (quantité, PRU frais inclus, cours, valeur, plus/moins-value latente),
    liquidités, plus-values réalisées, versements et plafond restant. Les cours sont ceux de la dernière
    actualisation faite dans l'appli (voir `cours_date`)."""
    try:
        return _pea_report(_pea())
    except DataError as e:
        return {"erreur": str(e)}
    except (KeyError, TypeError, ValueError) as e:
        return {"erreur": f"Fichier PEA inattendu ({type(e).__name__}: {e})."}


# --------------------------------------------------------------------------- patrimoine

def _asset_value(a: dict[str, Any], today: date) -> float:
    value, rate = float(a.get("value") or 0), float(a.get("depreciation") or 0)
    if not a.get("date") or rate <= 0 or a["date"] >= today.isoformat():
        return value
    years = (today - date.fromisoformat(a["date"])).days / 365.25
    return value * (1 - min(rate, 100) / 100) ** years


@mcp.tool()
@_tag
def patrimoine_total() -> dict[str, Any]:
    """Vue globale : comptes (disponible / bloqué), PEA, biens (véhicules, immobilier dépréciés) et total.
    Si le fichier PEA est absent, le PEA est ignoré et signalé."""
    try:
        b = _budget()
        today = date.today()
        accounts = b.get("accounts", [])
        available = sum(a["balance"] for a in accounts if not a.get("blocked"))
        blocked = sum(a["balance"] for a in accounts if a.get("blocked"))
        out: dict[str, Any] = {
            "comptes": [
                {"nom": a["name"], "banque": a.get("bank") or None, "solde": _r(a["balance"]),
                 "bloque": bool(a.get("blocked")), "debloque_le": a.get("until") or None, "releve_le": a.get("date") or None}
                for a in accounts
            ],
            "comptes_disponible": _r(available),
            "comptes_bloque": _r(blocked),
        }
        pea_total = 0.0
        try:
            rep = _pea_report(_pea())
            pea_total = rep["total_pea"]
            out["pea"] = {"valeur_titres": rep["valeur_titres"], "liquidites": rep["liquidites"], "total": pea_total}
        except DataError as e:
            out["pea"] = {"erreur": str(e)}
        assets = b.get("assets", [])
        vehicles = sum(_asset_value(a, today) for a in assets if a.get("kind") == "vehicule")
        estate = sum(_asset_value(a, today) for a in assets if a.get("kind") == "immobilier")
        financial = available + blocked + pea_total
        out.update(
            patrimoine_financier=_r(financial),
            vehicules=_r(vehicles),
            immobilier=_r(estate),
            patrimoine_total=_r(financial + vehicles + estate),
            historique=b.get("history", [])[-12:],
        )
        return out
    except DataError as e:
        return {"erreur": str(e)}
    except (KeyError, TypeError, ValueError) as e:
        return {"erreur": f"Fichier inattendu ({type(e).__name__}: {e})."}


# --------------------------------------------------------------------------- écriture PEA (aperçu → confirmation)

import copy
import secrets
import time
import uuid

_pending: dict[str, dict[str, Any]] = {}
PENDING_TTL = 15 * 60
ISO = re.compile(r"\d{4}-\d{2}-\d{2}")


def _need_cloud() -> None:
    if not vault.configured():
        raise DataError("L'écriture n'est possible qu'avec la synchro Supabase (variables SUPABASE_* non configurées).")


def _resolve_ticker(pea: dict[str, Any], ticker: str | None, isin: str | None) -> str:
    if ticker and ticker.strip():
        return _ticker(ticker)
    if isin and isin.strip():
        code = isin.strip().upper()
        for t, ins in (pea.get("instruments") or {}).items():
            if str((ins or {}).get("isin", "")).upper() == code:
                return t
        alias = _ticker(code)
        if alias != code:
            return alias
        raise DataError(f"ISIN {code} inconnu de l'appli : indiquez aussi le ticker (ex. DCAM).")
    raise DataError("Indiquez le ticker (ou l'ISIN).")


def _held(pea: dict[str, Any], ticker: str) -> float:
    return next((p["quantite"] for p in _pea_report(pea)["positions"] if p["titre"] == ticker), 0.0)


def _check_date(d: str | None) -> str:
    d = d or date.today().isoformat()
    if not ISO.fullmatch(d):
        raise DataError(f"Date invalide « {d} » : utilisez AAAA-MM-JJ.")
    try:
        parsed = date.fromisoformat(d)
    except ValueError:
        raise DataError(f"Date inexistante « {d} ».") from None
    if parsed > date.today():
        raise DataError(f"La date {d} est dans le futur.")
    return d


def _num(v: Any, name: str, *, positive: bool = True) -> float:
    try:
        x = float(str(v).replace(",", ".").replace(" ", ""))
    except ValueError:
        raise DataError(f"{name} invalide : « {v} ».") from None
    if not (x > 0 if positive else x >= 0) or x != x or x in (float("inf"),):
        raise DataError(f"{name} doit être {'> 0' if positive else '>= 0'} (reçu : {v}).")
    return x


def _apply(pea: dict[str, Any], kind: str, rec: dict[str, Any]) -> None:
    key = {"achat": "purchases", "vente": "sales", "versement": "deposits"}[kind]
    pea.setdefault(key, []).append(rec)


def _duplicate(pea: dict[str, Any], kind: str, rec: dict[str, Any]) -> bool:
    key = {"achat": "purchases", "vente": "sales", "versement": "deposits"}[kind]
    fields = ("date", "amount") if kind == "versement" else ("date", "ticker", "qty", "price")
    return any(all(x.get(f) == rec[f] for f in fields) for x in pea.get(key, []))


def _preview(kind: str, rec: dict[str, Any], allow_dup: bool) -> dict[str, Any]:
    _need_cloud()
    d = vault.fetch()
    pea = d.get("pea")
    if pea is None:
        raise DataError("Aucune donnée PEA dans la synchro.")
    pea = copy.deepcopy(pea)
    warnings: list[str] = []
    if kind in ("achat", "vente"):
        known = rec["ticker"] in {p["titre"] for p in _pea_report(pea)["positions"]} or rec["ticker"] in (pea.get("instruments") or {}) or rec["ticker"] in (pea.get("prices") or {})
        if kind == "vente" and _held(pea, rec["ticker"]) + 1e-9 < rec["qty"]:
            raise DataError(f"Vente impossible : vous détenez {_held(pea, rec['ticker'])} {rec['ticker']} et la vente en porte {rec['qty']}.")
        if kind == "achat" and not known:
            warnings.append(f"« {rec['ticker']} » est un nouveau titre : tant que l'appli n'a pas de cours, il est valorisé au prix d'achat.")
    if _duplicate(pea, kind, rec):
        if not allow_dup:
            raise DataError("Une opération identique existe déjà (même date, titre, quantité et prix). Doublon ? "
                            "Si c'est bien une 2e opération identique, redemandez avec autoriser_doublon=True.")
        warnings.append("Opération identique déjà présente : ajoutée à la demande de l'utilisateur.")
    before = _pea_report(pea)
    _apply(pea, kind, rec)
    after = _pea_report(pea)
    if after["liquidites"] is not None and after["liquidites"] < 0:
        warnings.append(f"Liquidités du PEA négatives après l'opération ({after['liquidites']} €) : un versement a peut-être été oublié.")
    code = secrets.token_hex(3)
    for c in [c for c, p in _pending.items() if time.time() - p["ts"] > PENDING_TTL]:
        del _pending[c]
    _pending[code] = {"kind": kind, "rec": rec, "allow_dup": allow_dup, "ts": time.time()}
    out: dict[str, Any] = {
        "a_ajouter": {"type": kind, **rec},
        "avant": {"liquidites": before["liquidites"], "total_pea": before["total_pea"]},
        "apres": {"liquidites": after["liquidites"], "total_pea": after["total_pea"]},
        "avertissements": warnings,
        "code_confirmation": code,
        "important": "RIEN n'est encore écrit. Montrez ce récapitulatif à l'utilisateur et appelez confirmer_ajout "
                     "avec le code UNIQUEMENT après son accord explicite.",
    }
    if kind in ("achat", "vente"):
        pos = next((p for p in after["positions"] if p["titre"] == rec["ticker"]), None)
        out["position_apres"] = pos and {"quantite": pos["quantite"], "pru": pos["pru"]}
    return out


@mcp.tool()
def proposer_achat(ticker: str | None = None, quantite: float = 0, prix: float = 0, date_achat: str | None = None,
                   frais: float = 0, isin: str | None = None, autoriser_doublon: bool = False) -> dict[str, Any]:
    """PRÉPARE l'ajout d'un achat au PEA (rien n'est écrit). Renvoie un récapitulatif et un code à valider avec
    confirmer_ajout. `prix` = prix unitaire en €, `quantite` = nombre de parts, `frais` = frais de courtage en €
    (0 si inconnus), `date_achat` = AAAA-MM-JJ (défaut : aujourd'hui), `ticker` (ex. DCAM) ou `isin`.
    Depuis une photo/capture d'avis d'exécution : lisez titre, quantité, prix, frais et date, puis proposez."""
    try:
        _need_cloud()
        pea = vault.fetch().get("pea") or {}
        rec = {"id": str(uuid.uuid4()), "date": _check_date(date_achat), "ticker": _resolve_ticker(pea, ticker, isin),
               "qty": _num(quantite, "quantité"), "price": _num(prix, "prix"), "fees": _num(frais, "frais", positive=False)}
        return _preview("achat", rec, autoriser_doublon)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def proposer_vente(ticker: str | None = None, quantite: float = 0, prix: float = 0, date_vente: str | None = None,
                   frais: float = 0, isin: str | None = None, autoriser_doublon: bool = False) -> dict[str, Any]:
    """PRÉPARE l'ajout d'une vente au PEA (rien n'est écrit). Refusée si vous ne détenez pas assez de parts.
    Mêmes paramètres que proposer_achat ; la plus-value est calculée au PRU par l'appli."""
    try:
        _need_cloud()
        pea = vault.fetch().get("pea") or {}
        rec = {"id": str(uuid.uuid4()), "date": _check_date(date_vente), "ticker": _resolve_ticker(pea, ticker, isin),
               "qty": _num(quantite, "quantité"), "price": _num(prix, "prix"), "fees": _num(frais, "frais", positive=False)}
        return _preview("vente", rec, autoriser_doublon)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def proposer_versement(montant: float = 0, date_versement: str | None = None, autoriser_doublon: bool = False) -> dict[str, Any]:
    """PRÉPARE l'ajout d'un versement d'argent sur le PEA (rien n'est écrit). `montant` en €."""
    try:
        rec = {"id": str(uuid.uuid4()), "date": _check_date(date_versement), "amount": _num(montant, "montant")}
        return _preview("versement", rec, autoriser_doublon)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def confirmer_ajout(code_confirmation: str) -> dict[str, Any]:
    """ÉCRIT dans la synchro l'opération préparée par proposer_achat / proposer_vente / proposer_versement.
    À n'appeler qu'APRÈS l'accord explicite de l'utilisateur sur le récapitulatif. Le code expire après 15 minutes.
    Une sauvegarde chiffrée est faite avant l'écriture ; l'appli récupère l'ajout à sa prochaine synchro (≈ 1 min)."""
    p = _pending.get((code_confirmation or "").strip())
    if not p or time.time() - p["ts"] > PENDING_TTL:
        return {"erreur": "Code inconnu ou expiré : refaites la proposition."}
    kind, rec = p["kind"], p["rec"]

    def modify(data: dict[str, Any]) -> dict[str, Any]:
        pea = data.get("pea")
        if pea is None:
            raise vault.VaultError("Aucune donnée PEA dans le coffre.")
        if kind == "vente" and _held(pea, rec["ticker"]) + 1e-9 < rec["qty"]:
            raise vault.VaultError("Vente refusée : les parts détenues ont changé entre-temps.")
        if _duplicate(pea, kind, rec) and not p["allow_dup"]:
            raise vault.VaultError("Opération déjà présente (doublon) : rien n'a été écrit.")
        _apply(pea, kind, rec)
        return {"ecrit": {"type": kind, **rec}}

    try:
        _need_cloud()
        res = vault.update(modify)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}
    del _pending[code_confirmation.strip()]
    return {**res, "message": "Ajouté. L'appli le récupère à sa prochaine synchro (ouvrez-la ou attendez ~1 min).",
            "pea_apres": _pea_report(vault.fetch().get("pea") or {})["total_pea"]}


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
