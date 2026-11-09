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
                {"id": t.get("id"), "date": t["date"], "libelle": t.get("label"), "montant": _r(t["amount"]), "categorie": t.get("category")}
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


_KEYS = {"achat": "purchases", "vente": "sales", "versement": "deposits", "mouvement": "moves"}


def _apply(pea: dict[str, Any], kind: str, rec: dict[str, Any]) -> None:
    key = _KEYS[kind]
    pea.setdefault(key, []).append(rec)


def _duplicate(pea: dict[str, Any], kind: str, rec: dict[str, Any]) -> bool:
    key = _KEYS[kind]
    fields = {"versement": ("date", "amount"), "mouvement": ("date", "amount", "kind")}.get(kind, ("date", "ticker", "qty", "price"))
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


MOVE_KINDS = {"credit": "credit", "regularisation": "credit", "régularisation": "credit", "frais": "frais",
              "retrait": "retrait", "dividende": "dividende"}


@mcp.tool()
def proposer_mouvement(type_mouvement: str, montant: float, date_mouvement: str | None = None,
                       ticker: str | None = None, autoriser_doublon: bool = False) -> dict[str, Any]:
    """PRÉPARE l'ajout d'un autre mouvement d'argent du PEA (rien n'est écrit) ; `montant` toujours positif, en €.
    `type_mouvement` : « regularisation » (régularisation de frais / crédit de la banque, ex. REGUL.FR.BOURSE, + espèces),
    « frais » (frais prélevés, − espèces), « retrait » (− espèces), « dividende » (+ espèces, `ticker` obligatoire).
    Ne compte pas dans le plafond de versements (contrairement à proposer_versement)."""
    try:
        kind = MOVE_KINDS.get(str(type_mouvement).strip().lower())
        if not kind:
            raise DataError("type_mouvement inconnu : choisissez regularisation, frais, retrait ou dividende.")
        rec = {"id": str(uuid.uuid4()), "date": _check_date(date_mouvement), "amount": _num(montant, "montant"), "kind": kind}
        if kind == "dividende":
            _need_cloud()
            if not (ticker and ticker.strip()):
                raise DataError("Un dividende demande le ticker du titre concerné.")
            rec["ticker"] = _resolve_ticker(vault.fetch().get("pea") or {}, ticker, None)
        return _preview("mouvement", rec, autoriser_doublon)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def confirmer_ajout(code_confirmation: str) -> dict[str, Any]:
    """ÉCRIT dans la synchro l'opération préparée par proposer_achat / proposer_vente / proposer_versement / proposer_mouvement.
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


# --------------------------------------------------------------------------- modification d'une ligne existante
# Même logique que les ajouts : aperçu, accord de l'utilisateur, sauvegarde chiffrée, contrôle de version.
# Aucune suppression : on ne peut que corriger les champs d'une ligne identifiée par son id.

_TYPE_OF = {v: k for k, v in _KEYS.items()}
_FIELDS = {"achat": ("date", "ticker", "qty", "price", "fees"), "vente": ("date", "ticker", "qty", "price", "fees"),
           "versement": ("date", "amount"), "mouvement": ("date", "amount", "kind", "ticker")}
_pending_mod: dict[str, dict[str, Any]] = {}


def _locate(pea: dict[str, Any], op_id: str) -> tuple[str, dict[str, Any]]:
    for key, kind in _TYPE_OF.items():
        for rec in pea.get(key) or []:
            if rec.get("id") == op_id:
                return kind, rec
    raise DataError(f"Aucune opération PEA avec l'id « {op_id} » (voir lister_operations_pea).")


def _oversold(pea: dict[str, Any]) -> set[str]:
    """Titres dont une vente dépasse les parts détenues à sa date (rejeu chronologique, comme le rapport PEA)."""
    events = [("b", x) for x in pea.get("purchases", [])] + [("s", x) for x in pea.get("sales", [])]
    events.sort(key=lambda e: (e[1]["date"], 0 if e[0] == "b" else 1))
    held: dict[str, float] = {}
    bad: set[str] = set()
    for kind, e in events:
        t = _ticker(e["ticker"])
        held[t] = held.get(t, 0.0) + (e["qty"] if kind == "b" else -e["qty"])
        if held[t] < -1e-9:
            bad.add(t)
    return bad


def _check_pea(before: dict[str, Any], pea: dict[str, Any]) -> list[str]:
    """Contrôles après modification (`before` = état d'origine) : refuse de créer une vente excessive."""
    new = _oversold(pea) - _oversold(before)
    if new:
        raise DataError(f"Modification refusée : une vente de {', '.join(sorted(new))} dépasserait les parts détenues à sa date.")
    rep = _pea_report(pea)
    if rep["liquidites"] is not None and rep["liquidites"] < 0:
        return [f"Liquidités du PEA négatives après la modification ({rep['liquidites']} €)."]
    return []


@mcp.tool()
@_tag
def lister_operations_pea() -> dict[str, Any]:
    """Liste toutes les opérations du PEA (achats, ventes, versements, mouvements) avec leur `id`,
    nécessaire pour proposer_modification."""
    pea = _pea()
    return {"operations": [{"type": _TYPE_OF[k], **r} for k in _KEYS.values() for r in pea.get(k) or []]}


@mcp.tool()
def proposer_modification(id_operation: str, date: str | None = None, quantite: float | None = None,
                          prix: float | None = None, frais: float | None = None, montant: float | None = None,
                          ticker: str | None = None, type_mouvement: str | None = None) -> dict[str, Any]:
    """PRÉPARE la correction d'une ligne existante du PEA (rien n'est écrit). `id_operation` vient de
    lister_operations_pea. Ne renseignez QUE les champs à changer : `date` (AAAA-MM-JJ), `quantite`, `prix`,
    `frais` (achat/vente), `montant` (versement/mouvement), `ticker`, `type_mouvement` (mouvement).
    Renvoie avant/après et un code à valider avec confirmer_modification. Pas de suppression."""
    try:
        _need_cloud()
        pea = copy.deepcopy(vault.fetch().get("pea") or {})
        kind, rec = _locate(pea, id_operation.strip())
        before_rec = copy.deepcopy(rec)
        origin = copy.deepcopy(pea)
        before = _pea_report(pea)
        wanted = {"date": date, "qty": quantite, "price": prix, "fees": frais, "amount": montant,
                  "ticker": ticker, "kind": type_mouvement}
        changes: dict[str, Any] = {}
        for f, v in wanted.items():
            if v is None:
                continue
            if f not in _FIELDS[kind]:
                raise DataError(f"Le champ « {f} » ne s'applique pas à une opération de type {kind}.")
            if f == "date":
                v = _check_date(v)
            elif f in ("qty", "price", "amount"):
                v = _num(v, f)
            elif f == "fees":
                v = _num(v, f, positive=False)
            elif f == "ticker":
                v = _resolve_ticker(pea, v, None)
            elif f == "kind":
                v = MOVE_KINDS.get(str(v).strip().lower())
                if not v:
                    raise DataError("type_mouvement inconnu : choisissez regularisation, frais, retrait ou dividende.")
            if rec.get(f) != v:
                changes[f] = v
        if not changes:
            raise DataError("Aucun changement : les valeurs demandées sont déjà celles de la ligne.")
        rec.update(changes)
        if kind == "mouvement" and rec["kind"] == "dividende" and not rec.get("ticker"):
            raise DataError("Un dividende demande le ticker du titre concerné.")
        warnings = _check_pea(origin, pea)
        after = _pea_report(pea)
        code = secrets.token_hex(3)
        for c in [c for c, p in _pending_mod.items() if time.time() - p["ts"] > PENDING_TTL]:
            del _pending_mod[c]
        _pending_mod[code] = {"id": id_operation.strip(), "kind": kind, "before": before_rec, "changes": changes, "ts": time.time()}
        return {
            "operation": {"type": kind, "avant": before_rec, "apres": rec},
            "avant": {"liquidites": before["liquidites"], "total_pea": before["total_pea"]},
            "apres": {"liquidites": after["liquidites"], "total_pea": after["total_pea"]},
            "avertissements": warnings,
            "code_confirmation": code,
            "important": "RIEN n'est encore écrit. Montrez ce récapitulatif à l'utilisateur et appelez "
                         "confirmer_modification avec le code UNIQUEMENT après son accord explicite.",
        }
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def confirmer_modification(code_confirmation: str) -> dict[str, Any]:
    """ÉCRIT la correction préparée par proposer_modification, après l'accord explicite de l'utilisateur.
    Refusée si la ligne a changé entre-temps. Sauvegarde chiffrée avant écriture ; code valable 15 minutes."""
    p = _pending_mod.get((code_confirmation or "").strip())
    if not p or time.time() - p["ts"] > PENDING_TTL:
        return {"erreur": "Code inconnu ou expiré : refaites la proposition."}

    def modify(data: dict[str, Any]) -> dict[str, Any]:
        pea = data.get("pea")
        if pea is None:
            raise vault.VaultError("Aucune donnée PEA dans le coffre.")
        origin = copy.deepcopy(pea)
        kind, rec = _locate(pea, p["id"])
        if rec != p["before"]:
            raise vault.VaultError("La ligne a été modifiée entre-temps : rien n'a été écrit, refaites la proposition.")
        rec.update(p["changes"])
        _check_pea(origin, pea)
        return {"modifie": {"type": kind, "avant": p["before"], "apres": rec}}

    try:
        _need_cloud()
        res = vault.update(modify)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}
    del _pending_mod[code_confirmation.strip()]
    return {**res, "message": "Modifié. L'appli le récupère à sa prochaine synchro (ouvrez-la ou attendez ~1 min).",
            "pea_apres": _pea_report(vault.fetch().get("pea") or {})["total_pea"]}


# --------------------------------------------------------------------------- import d'un CSV bancaire (budget)
# Même logique que le bouton « Importer un CSV » de l'appli (bank_csv.py est testé contre le vrai budget.js) :
# colonnes détectées, doublons écartés, catégories d'après les règles de l'utilisateur puis les règles par défaut.

import bank_csv

MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_CSV_ROWS = 5000
_pending_csv: dict[str, dict[str, Any]] = {}


def _csv_text(chemin: str | None, contenu: str | None) -> tuple[str, str]:
    if contenu and contenu.strip():
        if len(contenu.encode("utf-8")) > MAX_CSV_BYTES:
            raise DataError("Contenu CSV trop volumineux (5 Mo maximum).")
        return contenu, "(texte collé)"
    if not (chemin and chemin.strip()):
        raise DataError("Indiquez chemin_fichier (fichier .csv) ou contenu_csv (texte du CSV).")
    f = Path(chemin.strip()).expanduser()
    if f.is_symlink():
        raise DataError("Les liens symboliques ne sont pas acceptés : indiquez le fichier lui-même.")
    if not f.is_file():
        raise DataError(f"Fichier introuvable : {f}")
    if f.suffix.lower() not in (".csv", ".txt", ".tsv"):
        raise DataError("Seuls les fichiers .csv, .tsv ou .txt sont acceptés.")
    if f.stat().st_size > MAX_CSV_BYTES:
        raise DataError("Fichier trop volumineux (5 Mo maximum).")
    with f.open("rb") as fh:
        raw = fh.read(MAX_CSV_BYTES + 1)
    if len(raw) > MAX_CSV_BYTES:
        raise DataError("Fichier trop volumineux (5 Mo maximum).")
    return bank_csv.decode(raw), f.name


@mcp.tool()
def proposer_import_csv(chemin_fichier: str | None = None, contenu_csv: str | None = None,
                        colonne_date: int | None = None, colonne_libelle: int | None = None,
                        colonne_montant: int | None = None, colonne_debit: int | None = None,
                        colonne_credit: int | None = None) -> dict[str, Any]:
    """PRÉPARE l'import d'un export CSV de la banque dans le budget (rien n'est écrit). Donnez `chemin_fichier`
    (ex. ~/Downloads/export.csv) ou collez le texte dans `contenu_csv`. Les colonnes sont détectées comme dans l'appli ;
    en cas d'erreur, forcez-les avec les numéros de colonne (1 = première). Les opérations déjà présentes sont écartées
    (mêmes règles que l'appli), les nouvelles sont catégorisées avec les règles de l'utilisateur.
    Renvoie un aperçu et un code à valider avec confirmer_import_csv."""
    try:
        _need_cloud()
        text, name = _csv_text(chemin_fichier, contenu_csv)
        rows, delim = bank_csv.parse_csv(text)
        if len(rows) < 2:
            raise DataError("Le fichier semble vide.")
        det = bank_csv.detect_columns(rows)
        cols, headers = dict(det["cols"]), det["headers"]
        for key, val in (("date", colonne_date), ("label", colonne_libelle), ("amount", colonne_montant),
                         ("debit", colonne_debit), ("credit", colonne_credit)):
            if val is not None:
                if not 1 <= int(val) <= len(headers):
                    raise DataError(f"Colonne {val} inexistante (le fichier en a {len(headers)}).")
                cols[key] = int(val) - 1
        if colonne_montant is not None:
            cols["debit"] = cols["credit"] = -1
        if (colonne_debit is not None or colonne_credit is not None) and colonne_montant is None:
            cols["amount"] = -1
        if cols["date"] < 0 or (cols["amount"] < 0 and cols["debit"] < 0 and cols["credit"] < 0):
            raise DataError("Colonnes date / montant introuvables : indiquez-les (colonne_date, colonne_montant ou "
                            f"colonne_debit + colonne_credit). Colonnes du fichier : {headers}")
        txs, skipped = bank_csv.extract_transactions(rows, det["header_row"], cols)
        if not txs:
            raise DataError(f"Aucune transaction lue : vérifiez les colonnes. Détectées : {cols} ; en-têtes : {headers}")
        if len(txs) > MAX_CSV_ROWS:
            raise DataError(f"{len(txs)} lignes : importez par morceaux de {MAX_CSV_ROWS} maximum.")
        budget = vault.fetch().get("budget")
        if budget is None:
            raise DataError("Aucune donnée budget dans la synchro.")
        fresh, dups = bank_csv.dedupe(budget.get("transactions") or [], txs)
        if not fresh:
            raise DataError(f"Rien à importer : les {len(txs)} opérations lues sont déjà dans l'appli.")
        rules = budget.get("rules") or []
        by_cat: dict[str, dict[str, float]] = {}
        uncat: list[str] = []
        for t in fresh:
            t["category"] = bank_csv.categorize(t, rules)
            c = by_cat.setdefault(t["category"], {"nb": 0, "somme": 0.0})
            c["nb"] += 1
            c["somme"] = round(c["somme"] + t["amount"], 2)
            if t["category"] == bank_csv.UNCATEGORIZED:
                uncat.append(f"{t['date']} {t['amount']:+.2f} {t['label'][:60]}")
        code = secrets.token_hex(3)
        for c in [c for c, p in _pending_csv.items() if time.time() - p["ts"] > PENDING_TTL]:
            del _pending_csv[c]
        _pending_csv[code] = {"txs": [{k: t[k] for k in ("date", "label", "amount")} for t in txs], "ts": time.time()}
        return {
            "fichier": name,
            "colonnes_utilisees": {k: (headers[v] if v >= 0 else None) for k, v in cols.items()},
            "lignes_lues": len(txs), "nouvelles": len(fresh), "deja_presentes": len(dups),
            "lignes_illisibles": skipped[:20], "nb_lignes_illisibles": len(skipped),
            "periode": [min(t["date"] for t in fresh), max(t["date"] for t in fresh)],
            "entrees": round(sum(t["amount"] for t in fresh if t["amount"] > 0), 2),
            "sorties": round(-sum(t["amount"] for t in fresh if t["amount"] < 0), 2),
            "par_categorie": dict(sorted(by_cat.items(), key=lambda kv: -kv[1]["nb"])),
            "a_categoriser": {"nombre": len(uncat), "exemples": uncat[:15]},
            "extrait": [{"date": t["date"], "montant": t["amount"], "libelle": t["label"][:60], "categorie": t["category"]} for t in fresh[:8]],
            "code_confirmation": code,
            "important": "RIEN n'est encore écrit. Montrez ce récapitulatif à l'utilisateur et appelez confirmer_import_csv "
                         "avec le code UNIQUEMENT après son accord explicite.",
        }
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def confirmer_import_csv(code_confirmation: str) -> dict[str, Any]:
    """ÉCRIT dans la synchro l'import préparé par proposer_import_csv, après l'accord explicite de l'utilisateur.
    Les doublons sont revérifiés au moment d'écrire. Sauvegarde chiffrée avant écriture ; code valable 15 minutes."""
    p = _pending_csv.get((code_confirmation or "").strip())
    if not p or time.time() - p["ts"] > PENDING_TTL:
        return {"erreur": "Code inconnu ou expiré : refaites la proposition."}

    def modify(data: dict[str, Any]) -> dict[str, Any]:
        budget = data.get("budget")
        if budget is None:
            raise vault.VaultError("Aucune donnée budget dans le coffre.")
        existing = budget.get("transactions") or []
        budget["transactions"] = existing
        fresh, dups = bank_csv.dedupe(existing, p["txs"])
        if not fresh:
            raise vault.VaultError("Tout est déjà présent (importé entre-temps) : rien n'a été écrit.")
        ids = {t.get("id") for t in existing}
        rules = budget.get("rules") or []
        added = []
        for t in fresh:
            while True:
                tid = "".join(secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(8)) + \
                      "".join(secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(4))
                if tid not in ids:
                    break
            ids.add(tid)
            added.append({"id": tid, "date": t["date"], "label": t["label"], "amount": t["amount"],
                          "category": bank_csv.categorize(t, rules), "manual": False})
        existing.extend(added)
        budget["lastImport"] = date.today().isoformat()
        unc = sum(1 for a in added if a["category"] == bank_csv.UNCATEGORIZED)
        return {"importees": len(added), "deja_presentes_ignorees": len(dups), "a_categoriser": unc}

    try:
        _need_cloud()
        res = vault.update(modify)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}
    del _pending_csv[code_confirmation.strip()]
    return {**res, "message": "Importé. L'appli le récupère à sa prochaine synchro (ouvrez-la ou attendez ~1 min)."}


# --------------------------------------------------------------------------- catégories des opérations (budget)
# Même effet que le menu « Catégorie » de l'appli : l'opération est marquée « choisie à la main » (manual) et, si on le
# demande, une règle personnelle est retenue pour les prochains imports. Aucune suppression, aucun montant touché.

MAX_RECAT = 500
CAT_KINDS = ("depense", "revenu", "aide", "neutre")
_pending_cat: dict[str, dict[str, Any]] = {}


def _plain(s: str) -> str:
    return bank_csv.norm_label(s).replace(" ", "")


@mcp.tool()
def lister_categories() -> dict[str, Any]:
    """Liste les catégories du budget (nom, type, nombre d'opérations) et les règles personnelles de catégorisation."""
    try:
        _need_cloud()
        b = vault.fetch().get("budget") or {}
        count: dict[str, int] = {}
        for t in b.get("transactions") or []:
            c = t.get("category") or bank_csv.UNCATEGORIZED
            count[c] = count.get(c, 0) + 1
        cats = [{"nom": c["name"], "type": c.get("kind", "depense"), "operations": count.get(c["name"], 0)} for c in b.get("categories") or []]
        return {"categories": cats, bank_csv.UNCATEGORIZED: count.get(bank_csv.UNCATEGORIZED, 0),
                "regles_personnelles": (b.get("rules") or [])[:60], "nb_regles_personnelles": len(b.get("rules") or [])}
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def proposer_recategorisation(nouvelle_categorie: str, ids: list[str] | None = None, texte: str | None = None,
                              date_debut: str | None = None, date_fin: str | None = None,
                              categorie_actuelle: str | None = None, sens: str | None = None,
                              creer_regle: bool = False, type_nouvelle_categorie: str | None = None) -> dict[str, Any]:
    """PRÉPARE le changement de catégorie d'opérations du budget (rien n'est écrit). Sélection : soit `ids` (renvoyés par
    rechercher_operations), soit des filtres : `texte` (morceau du libellé), `date_debut` / `date_fin` (AAAA-MM-JJ),
    `categorie_actuelle`, `sens` (« entree » ou « sortie ») ; au moins un critère est obligatoire.
    `nouvelle_categorie` : une catégorie existante (voir lister_categories), « À catégoriser », ou une nouvelle (dans ce cas
    donnez `type_nouvelle_categorie` : depense, revenu, aide ou neutre). `creer_regle=True` retient aussi `texte` comme
    règle personnelle pour les prochains imports. Renvoie l'aperçu (opérations, effet sur chaque mois) et un code à valider
    avec confirmer_recategorisation."""
    try:
        _need_cloud()
        b = copy.deepcopy(vault.fetch().get("budget") or {})
        txs = b.get("transactions") or []
        cats = {c["name"]: c.get("kind", "depense") for c in b.get("categories") or [] if "name" in c}
        target = (nouvelle_categorie or "").strip()
        if not target:
            raise DataError("Indiquez la nouvelle catégorie.")
        new_kind = None
        if target != bank_csv.UNCATEGORIZED and target not in cats:
            near = [c for c in cats if _plain(c) == _plain(target)]
            if near:
                raise DataError(f"« {target} » n'existe pas, mais « {near[0]} » oui : utilisez ce nom exact.")
            if type_nouvelle_categorie not in CAT_KINDS:
                raise DataError(f"« {target} » est une nouvelle catégorie : précisez type_nouvelle_categorie "
                                f"({', '.join(CAT_KINDS)}). Catégories existantes : {', '.join(cats)}.")
            if len(target) > 60:
                raise DataError("Nom de catégorie trop long (60 caractères maximum).")
            new_kind = type_nouvelle_categorie
        for name, v in (("date_debut", date_debut), ("date_fin", date_fin)):
            if v and not ISO.fullmatch(v):
                raise DataError(f"{name} invalide « {v} » : utilisez AAAA-MM-JJ.")
        if sens not in (None, "entree", "sortie"):
            raise DataError("sens : « entree » ou « sortie ».")
        if texte and not bank_csv.norm_label(texte):
            raise DataError("`texte` ne contient aucun caractère utile : précisez un morceau de libellé.")
        if ids and (texte or date_debut or date_fin or categorie_actuelle or sens):
            raise DataError("Utilisez soit `ids`, soit des filtres, pas les deux.")
        if creer_regle and target == bank_csv.UNCATEGORIZED:
            raise DataError("Une règle vers « À catégoriser » n'a pas de sens : retirez creer_regle.")
        if creer_regle and len(bank_csv.norm_label(texte)) < 3:
            raise DataError("Pour créer une règle, donnez `texte` (au moins 3 caractères utiles).")
        if ids:
            by_id = {t.get("id"): t for t in txs}
            missing = [i for i in ids if i not in by_id]
            if missing:
                raise DataError(f"Identifiants inconnus : {missing[:5]}.")
            picked = [by_id[i] for i in dict.fromkeys(ids)]
        else:
            if not (texte or date_debut or date_fin or categorie_actuelle or sens):
                raise DataError("Précisez au moins un critère (ids, texte, dates, categorie_actuelle ou sens) : "
                                "pas de changement sur tout le budget d'un coup.")
            needle = bank_csv.norm_label(texte) if texte else ""
            picked = [t for t in txs
                      if (not needle or needle in bank_csv.norm_label(t.get("label")))
                      and (not date_debut or t["date"] >= date_debut) and (not date_fin or t["date"] <= date_fin)
                      and (not categorie_actuelle or (t.get("category") or bank_csv.UNCATEGORIZED) == categorie_actuelle)
                      and (sens is None or (float(t["amount"]) > 0) == (sens == "entree"))]
        already = [t for t in picked if (t.get("category") or bank_csv.UNCATEGORIZED) == target]
        todo = [t for t in picked if (t.get("category") or bank_csv.UNCATEGORIZED) != target]
        if not todo:
            raise DataError(f"Rien à changer : {len(picked)} opération(s) trouvée(s), déjà en « {target} »." if picked
                            else "Aucune opération ne correspond à ces critères.")
        if len(todo) > MAX_RECAT:
            raise DataError(f"{len(todo)} opérations : affinez les critères (maximum {MAX_RECAT} à la fois).")
        rule = None
        if creer_regle:
            match = bank_csv.norm_label(texte)
            signs = {float(t["amount"]) > 0 for t in todo}
            rule = {"match": match, "category": target, **({"sign": "in" if True in signs else "out"} if len(signs) == 1 else {})}
        before = {m: _summary(b, m) for m in sorted({t["date"][:7] for t in todo})[-6:]}
        old = {t["id"]: t.get("category") for t in todo}  # valeur brute, comparée telle quelle à l'écriture
        if new_kind:
            b.setdefault("categories", []).append({"name": target, "kind": new_kind})
        for t in todo:
            t["category"] = target
        after = {m: _summary(b, m) for m in before}
        code = secrets.token_hex(3)
        for c in [c for c, p in _pending_cat.items() if time.time() - p["ts"] > PENDING_TTL]:
            del _pending_cat[c]
        _pending_cat[code] = {"old": old, "cat": target, "new_kind": new_kind, "rule": rule, "ts": time.time()}
        return {
            "nouvelle_categorie": target, "nouvelle_categorie_creee": new_kind,
            "operations_a_changer": len(todo), "deja_dans_cette_categorie": len(already),
            "exemples": [{"id": t["id"], "date": t["date"], "libelle": str(t.get("label"))[:60], "montant": _r(t["amount"]),
                          "avant": old[t["id"]]} for t in sorted(todo, key=lambda x: x["date"], reverse=True)[:25]],
            "regle_retenue": rule,
            "effet_par_mois": {m: {"avant": before[m], "apres": after[m]} for m in before},
            "code_confirmation": code,
            "important": "RIEN n'est encore écrit. Montrez ce récapitulatif à l'utilisateur et appelez "
                         "confirmer_recategorisation avec le code UNIQUEMENT après son accord explicite.",
        }
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}


@mcp.tool()
def confirmer_recategorisation(code_confirmation: str) -> dict[str, Any]:
    """ÉCRIT le changement de catégorie préparé par proposer_recategorisation, après l'accord explicite de l'utilisateur.
    Refusé si une des opérations a changé de catégorie entre-temps. Sauvegarde chiffrée avant écriture ; code valable 15 min."""
    p = _pending_cat.get((code_confirmation or "").strip())
    if not p or time.time() - p["ts"] > PENDING_TTL:
        return {"erreur": "Code inconnu ou expiré : refaites la proposition."}

    def modify(data: dict[str, Any]) -> dict[str, Any]:
        b = data.get("budget")
        if b is None:
            raise vault.VaultError("Aucune donnée budget dans le coffre.")
        by_id = {t.get("id"): t for t in b.get("transactions") or []}
        for i, was in p["old"].items():
            if i not in by_id or by_id[i].get("category") != was:
                raise vault.VaultError("Une opération a été modifiée entre-temps : rien n'a été écrit, refaites la proposition.")
        known = any(c.get("name") == p["cat"] for c in b.get("categories") or [])
        if not known and not p["new_kind"] and p["cat"] != bank_csv.UNCATEGORIZED:
            raise vault.VaultError(f"La catégorie « {p['cat']} » n'existe plus : rien n'a été écrit, refaites la proposition.")
        if p["new_kind"] and not known:
            b.setdefault("categories", []).append({"name": p["cat"], "kind": p["new_kind"]})
        for i in p["old"]:
            by_id[i]["category"] = p["cat"]
            by_id[i]["manual"] = True
        if p["rule"]:
            rules = b.setdefault("rules", [])
            same = next((r for r in rules if bank_csv.norm_label(r.get("match")) == p["rule"]["match"]
                         and (r.get("sign") or "") == (p["rule"].get("sign") or "")), None)
            if same:
                same["category"] = p["cat"]
            else:
                rules.insert(0, dict(p["rule"]))
        return {"operations_changees": len(p["old"]), "categorie": p["cat"], "regle": p["rule"]}

    try:
        _need_cloud()
        res = vault.update(modify)
    except (DataError, vault.VaultError) as e:
        return {"erreur": str(e)}
    del _pending_cat[code_confirmation.strip()]
    return {**res, "message": "Modifié. L'appli le récupère à sa prochaine synchro (ouvrez-la ou attendez ~1 min)."}


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
