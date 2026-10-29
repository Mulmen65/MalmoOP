"""Uppdatera energiunderlaget direkt från Streamlit (eller kommandoraden).

Flöde
  1. Läs en ny CSV (samma kolumner som Energikarta_filer.csv) eller hämta Malmö stads aktuella
     energideklarationer (geo.malmo.se/files/energikartan/energideklarationer.json) och gör om till CSV.
  2. Geokoda adresser som saknas i adresskopplingen med Malmö stads adresstjänst (1 000 per anrop).
  3. Hämta OSM-byggnader kring nya adresser via Overpass och koppla adress -> byggnad (<= 25 m).
  4. Kör build_adresskoppling, build_energi och build_metadata i en arbetskopia.

Nätverksanrop sker bara här och bara när funktionen anropas uttryckligen.
Kommandorad:  python -m tools.uppdatera ny_fil.csv   eller   python -m tools.uppdatera --malmo
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import shutil
import tempfile
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEOCODER = "https://gis.malmo.se/arcgis/rest/services/Malmo_adresser_platser/GeocodeServer/geocodeAddresses"
ENERGIKARTA_JSON = "https://geo.malmo.se/files/energikartan/energideklarationer.json"
OVERPASS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
CSV_FIELDS = ["id", "energiklass", "primarenergital", "energiprestanda", "radonmatning", "ventilationskontroll",
              "utford", "kommun", "fastighetsbeteckning", "adress", "postnummer", "postort"]
UA = {"User-Agent": "MalmoOP/1.0 (klimatscreening per DeSO; https://github.com/Mulmen65/MalmoOP)"}


def norm(s: str) -> str:
    return " ".join(str(s or "").split()).lower()


def flat(s: str) -> str:
    t = unicodedata.normalize("NFD", norm(s))
    t = re.sub(r"[̀-̂]", "", t)
    return re.sub(r"[\s\-.]", "", unicodedata.normalize("NFC", t))


def house_no(s: str):
    m = re.search(r"(\d+)\s*([a-zåäö])?(?:\s*-\s*\d+[a-z]?)?\s*$", norm(s))
    return (m.group(1) + (m.group(2) or "")) if m else None


def flag_for(adress: str, pnr: str, hit: dict | None) -> str:
    """Samma godkännanderegler som vid den ursprungliga hämtningen."""
    if not hit or hit.get("x") is None or hit.get("status") == "U":
        return "U"
    p_ok = re.sub(r"\D", "", str(hit.get("postal") or "")) == pnr
    m = hit.get("match") or ""
    if norm(m) == norm(adress):
        return "A" if p_ok else "P"
    if flat(m) == flat(adress):
        return "B" if p_ok else "P"
    if hit.get("status") == "M" and (hit.get("score") or 0) >= 90 and house_no(m) and house_no(m) == house_no(adress) and p_ok:
        return "C"
    return "R"


def _post(url: str, data: dict, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def csv_from_energikarta_json(obj: dict) -> str:
    out = io.StringIO()
    w = csv.writer(out, delimiter=";", lineterminator="\n")
    w.writerow(CSV_FIELDS)
    for d in obj.get("energideklarationer", []):
        for f in d.get("fastigheter") or []:
            for a in f.get("adresser") or []:
                w.writerow([d.get("id"), d.get("energiklass") or "", d.get("primarenergital") or "", d.get("energiprestanda") or "",
                            d.get("radonmatning") or "", d.get("ventilationskontroll") or "", d.get("utford") or "",
                            f.get("kommun") or "", f.get("fastighetsbeteckning") or "", a.get("adress") or "",
                            a.get("postnummer") or "", a.get("postort") or ""])
    return out.getvalue()


def fetch_malmo_csv() -> str:
    req = urllib.request.Request(ENERGIKARTA_JSON, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return csv_from_energikarta_json(json.loads(r.read().decode("utf-8")))


def geocode(addresses: list[tuple[str, str]], progress=print) -> list[dict]:
    """addresses: [(adress, postnummer)] -> rader för adresskoppling_geokodning_malmo.tsv"""
    rows = []
    for start in range(0, len(addresses), 1000):
        chunk = addresses[start:start + 1000]
        recs = [{"attributes": {"OBJECTID": i + 1, "Address": a, "Postal": p, "City": "Malmö"}} for i, (a, p) in enumerate(chunk)]
        raw = _post(GEOCODER, {"addresses": json.dumps({"records": recs}), "outSR": "3008", "f": "json",
                               "matchOutOfRange": "false", "outFields": "Addr_type,Score,Status,Match_addr,Postal"})
        res = json.loads(raw)
        if "locations" not in res:
            raise ValueError("Adresstjänsten svarade utan träfflista: " + raw[:200].decode(errors="replace"))
        hits = {}
        for loc in res["locations"]:
            at = loc.get("attributes", {})
            hits[at.get("ResultID")] = {"x": (loc.get("location") or {}).get("x"), "y": (loc.get("location") or {}).get("y"),
                                        "score": loc.get("score"), "status": at.get("Status"), "match": at.get("Match_addr"), "postal": at.get("Postal")}
        for i, (a, p) in enumerate(chunk):
            h = hits.get(i + 1)
            fl = flag_for(a, p, h)
            pm = re.sub(r"\D", "", str((h or {}).get("postal") or ""))
            rows.append({"adress": a, "postnummer": p, "flagga": fl,
                         "x_3008": "" if not h or h["x"] is None else round(h["x"], 1),
                         "y_3008": "" if not h or h["y"] is None else round(h["y"], 1),
                         "score": "" if not h else h["score"], "status": "" if not h else (h["status"] or ""),
                         "match_addr_avvikande": (h or {}).get("match") or "" if (h and h.get("match") != a) else "",
                         "match_postnr_avvikande": pm if h and pm != p else ""})
        progress(f"Adresser geokodade: {min(start + 1000, len(addresses))} av {len(addresses)}")
    return rows


def buildings_for(points: list[tuple[float, float]], progress=print) -> tuple[list[dict], list[int | None], list[int | None]]:
    """Hämta OSM-byggnader kring punkterna (lon, lat). Returnerar byggnadsrader och index/avstånd per punkt."""
    from pyproj import Transformer
    from shapely.geometry import Point, Polygon
    from shapely.strtree import STRtree
    if not points:
        return [], [], []
    lons, lats = [p[0] for p in points], [p[1] for p in points]
    bbox = f"{min(lats) - 0.0005},{min(lons) - 0.0008},{max(lats) + 0.0005},{max(lons) + 0.0008}"
    q = f'[out:json][timeout:180];way["building"]({bbox});out tags geom;'
    data = None
    for url in OVERPASS:
        try:
            data = json.loads(_post(url, {"data": q}, timeout=200))
            break
        except Exception as err:  # prova nästa server
            progress(f"Overpass {url} misslyckades: {err}")
    if data is None:
        raise RuntimeError("Ingen Overpass-server kunde nås.")
    to_m = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True).transform
    polys, meta = [], []
    for e in data.get("elements", []):
        g = e.get("geometry") or []
        if len(g) < 4:
            continue
        try:
            pm = Polygon([to_m(c["lon"], c["lat"]) for c in g]).buffer(0)
        except Exception:
            continue
        if pm.is_empty:
            continue
        t = e.get("tags") or {}
        c = Polygon([(c["lon"], c["lat"]) for c in g]).buffer(0).centroid
        polys.append(pm)
        meta.append({"osm_way": e["id"], "fotavtryck_m2": round(pm.area), "building": t.get("building", ""),
                     "building_levels": t.get("building:levels", ""), "height": t.get("height", ""),
                     "roof_levels": t.get("roof:levels", ""), "levels_underground": t.get("building:levels:underground", ""),
                     "amenity_shop_office": t.get("amenity") or t.get("shop") or t.get("office") or "",
                     "lon": f"{c.x:.6f}", "lat": f"{c.y:.6f}"})
    tree = STRtree(polys)
    idx, dist = [], []
    for lon, lat in points:
        pt = Point(to_m(lon, lat))
        inside = [i for i in tree.query(pt) if polys[i].covers(pt)]
        if inside:
            idx.append(max(inside, key=lambda i: polys[i].area)); dist.append(0)
            continue
        near = tree.query(pt.buffer(25))
        best = min(near, key=lambda i: polys[i].distance(pt), default=None)
        if best is not None and polys[best].distance(pt) <= 25:
            idx.append(int(best)); dist.append(int(round(polys[best].distance(pt))))
        else:
            idx.append(None); dist.append(None)
    progress(f"OSM-byggnader: {len(polys)} i området, {sum(i is not None for i in idx)} av {len(points)} adresser kopplade")
    return meta, idx, dist


def run_update(csv_text: str, progress=print, root: Path = ROOT) -> dict:
    """Kör hela uppdateringen i en arbetskopia. Returnerar nya filers text och en logg."""
    from pyproj import Transformer
    from . import build_adresskoppling, build_energi, build_metadata
    rows = list(csv.DictReader(io.StringIO(csv_text.lstrip("﻿")), delimiter=";"))
    if not rows or any(c not in rows[0] for c in ("id", "energiprestanda", "adress", "postnummer", "utford")):
        raise ValueError("CSV-filen ska ha samma kolumner som Energikarta_filer.csv (semikolon, UTF-8).")
    work = Path(tempfile.mkdtemp(prefix="malmoop_"))
    shutil.copytree(root / "data", work / "data")
    kalla = work / "data/kalla"
    (kalla / "Energikarta_filer.csv").write_text(csv_text, encoding="utf-8")
    known = set()
    with open(kalla / "adresskoppling_geokodning_malmo.tsv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            known.add((norm(r["adress"]), re.sub(r"\D", "", r["postnummer"])))
    missing, seen = [], set()
    for r in rows:
        k = (norm(r["adress"]), re.sub(r"\D", "", r["postnummer"]))
        if k not in known and k not in seen and k[0]:
            seen.add(k); missing.append((" ".join(r["adress"].split()), k[1]))
    progress(f"{len(rows)} rader i filen, {len(missing)} nya adresser att koppla.")
    log = {"rader": len(rows), "nya_adresser": len(missing)}
    if missing:
        geo = geocode(missing, progress)
        with open(kalla / "adresskoppling_geokodning_malmo.tsv", "a", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh, delimiter="\t", lineterminator="\n")
            for g in geo:
                w.writerow([g["adress"], g["postnummer"], g["flagga"], g["x_3008"], g["y_3008"], g["score"], g["status"],
                            g["match_addr_avvikande"], g["match_postnr_avvikande"]])
        to_wgs = Transformer.from_crs("EPSG:3008", "EPSG:4326", always_xy=True)
        ok = [(g, to_wgs.transform(float(g["x_3008"]), float(g["y_3008"]))) for g in geo if g["flagga"] in "ABPC" and g["x_3008"] != ""]
        log["nya_godkanda"] = len(ok)
        if ok:
            meta, idx, dist = buildings_for([p for _, p in ok], progress)
            lines = [ln for ln in (kalla / "osm_byggnader_malmo.tsv").read_text(encoding="utf-8").splitlines() if ln and not ln.startswith("#")]
            start = len(lines) - 1
            used = sorted({i for i in idx if i is not None})
            remap = {i: start + n for n, i in enumerate(used)}
            with open(kalla / "osm_byggnader_malmo.tsv", "a", encoding="utf-8") as fh:
                for i in used:
                    m = meta[i]
                    fh.write("\t".join(str(x) for x in [remap[i], m["osm_way"], m["fotavtryck_m2"], m["building"], m["building_levels"], m["height"],
                                                        m["roof_levels"], m["levels_underground"], m["amenity_shop_office"], m["lon"], m["lat"]]) + "\n")
            with open(kalla / "adress_till_byggnad.tsv", "a", encoding="utf-8") as fh:
                for (g, _), i, d in zip(ok, idx, dist):
                    fh.write(f"{g['adress']}\t{g['postnummer']}\t{'' if i is None else remap[i]}\t{'' if d is None else d}\n")
    log["adresskoppling"] = build_adresskoppling.main(work)
    log["energi"] = build_energi.main(work)
    build_metadata.main(work)
    files = {name: (work / name).read_text(encoding="utf-8") for name in
             ("data/energi_deklarationer.json", "data/metadata.json", "data/adresskoppling.csv",
              "data/kalla/Energikarta_filer.csv", "data/kalla/adresskoppling_geokodning_malmo.tsv",
              "data/kalla/adress_till_byggnad.tsv", "data/kalla/osm_byggnader_malmo.tsv")}
    shutil.rmtree(work, ignore_errors=True)
    return {"files": files, "log": log}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--malmo":
        text = fetch_malmo_csv()
    else:
        text = Path(sys.argv[1]).read_text(encoding="utf-8-sig")
    result = run_update(text)
    for name, content in result["files"].items():
        (ROOT / name).write_text(content, encoding="utf-8")
    print(json.dumps(result["log"], ensure_ascii=False, indent=1))
