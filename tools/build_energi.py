"""Bygg energiunderlaget för befintliga byggnader per deklaration.

Indata (data/kalla/)
  Energikarta_filer.csv            Energideklarationer i Malmö (användarens CSV, 31 121 adressrader)
  adresskoppling (data/)           data/adresskoppling.csv från build_adresskoppling.py
  adress_till_byggnad.tsv          Geokodad adress -> närmaste/omslutande OSM-byggnad (<= 25 m)
  osm_byggnader_malmo.tsv          OSM-byggnader: fotavtryck, våningar, höjd, typ
  deso_2025_malmo.geojson          DeSO 2025 för imputering per område

Utdata
  data/energi_deklarationer.json   Kompakt tabell per beräkningsbar deklaration + urvalslogg

Urvalsregler (dokumenteras också i appen)
  1. Exakta dubblettrader tas bort.
  2. En adress styrs av den senaste deklarationen (utförd-datum) som omfattar adressen.
     Deklarationer med samma senaste datum behålls alla (troligen olika byggnader på samma adress).
     En deklaration som inte styr någon adress räknas som ersatt och utesluts.
  3. Deklarationens adresser vägs lika. Adresser utan godkänd adresskoppling får ingen vikt;
     övriga adresser delar på deklarationen. Deklarationer utan någon kopplad adress är ej kartlagda.

Atemp-skattning (ingen Atemp finns i CSV-filen)
  Atemp ≈ Σ byggnader (fotavtryck × våningar × andel) × Atemp/BTA-faktor (sätts i appen, standard 0,9)
  andel = deklarationens adresser i byggnaden / alla behållna deklarationsadresser i byggnaden.
  Våningar: OSM building:levels; annars height/3 m; annars median för taggade flerbostads-/
  lokalbyggnader i samma DeSO (n>=5), samma RegSO (n>=5) eller hela Malmö; småhustyper 1,5.
  Fotavtryck >= 3 000 m² utan building:levels antas vara hallbyggnad med 2 plan.

Energibärare (ingen fördelning finns i CSV-filen)
  Kvoten r = primärenergital / energiprestanda beror på andelen el eftersom el har högre
  primärenergifaktor än fjärrvärme. Regimskifte 1 sep 2020 (BBR 29). Ankarvärden per regim
  = 10:e resp. 90:e percentilen av r. s = f0 + (1−f0)·clamp((r−r_lo)/(r_hi−r_lo)), f0 = 0,12.
  Saknas primärenergital används medianen i samma DeSO (n>=5) eller hela Malmö.

Kör:  python tools/build_energi.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
K = ROOT / "data" / "kalla"
REGIME_DATE = "2020-09-01"
F0_ELSHARE = 0.12
HOUSE_TYPES = {"house", "detached", "semidetached_house", "terrace", "bungalow", "farm", "cabin"}
SMALL_TYPES = {"garage", "garages", "shed", "carport", "roof", "hut", "greenhouse", "allotment_house"}


def norm_addr(a: str) -> str:
    return " ".join(str(a).split()).lower()


def norm_pnr(p: str) -> str:
    return re.sub(r"\D", "", str(p))


def kwh(text: str):
    m = re.match(r"\s*([\d\s ]+(?:[.,]\d+)?)", text or "")
    if not m:
        return None
    try:
        return float(m.group(1).replace(" ", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def pct(values, p):
    v = sorted(values)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def main(root: Path = ROOT) -> dict:
    K = root / "data" / "kalla"
    raw = (K / "Energikarta_filer.csv").read_bytes()
    text = raw.decode("utf-8-sig")
    rows = list(csv.DictReader(text.splitlines(), delimiter=";"))
    log = {"csv_sha256": hashlib.sha256(raw).hexdigest(), "rader": len(rows)}

    # 1. exakta dubbletter
    seen, uniq = set(), []
    for r in rows:
        t = tuple(r.values())
        if t not in seen:
            seen.add(t)
            uniq.append(r)
    log["exakta_dubblettrader"] = len(rows) - len(uniq)

    decl = {}
    for r in uniq:
        d = decl.setdefault(r["id"], {
            "id": r["id"], "klass": r["energiklass"].strip(), "ep": kwh(r["primarenergital"]),
            "se": kwh(r["energiprestanda"]), "datum": r["utford"].strip(),
            "fastighet": r["fastighetsbeteckning"].strip(), "adresser": []})
        key = (norm_addr(r["adress"]), norm_pnr(r["postnummer"]))
        if key not in d["adresser"]:
            d["adresser"].append(key)
    log["deklarationer"] = len(decl)

    # 2. styrande deklaration per adress
    governing = defaultdict(str)
    for d in decl.values():
        for a in d["adresser"]:
            governing[a] = max(governing[a], d["datum"])
    superseded = []
    for d in decl.values():
        d["kvar"] = [a for a in d["adresser"] if d["datum"] == governing[a]]
        if not d["kvar"]:
            superseded.append(d["id"])
    log["ersatta_av_senare_deklaration"] = len(superseded)

    # adresskoppling
    coupling = {}
    with open(root / "data/adresskoppling.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            if r["deso"]:
                coupling[(norm_addr(r["adress"]), norm_pnr(r["postnummer"]))] = r
    bmap = {}
    with open(K / "adress_till_byggnad.tsv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            if r["byggnad_idx"]:
                bmap[(norm_addr(r["adress"]), norm_pnr(r["postnummer"]))] = (int(r["byggnad_idx"]), int(r["avstand_m"]))

    deso_fc = json.loads((K / "deso_2025_malmo.geojson").read_text(encoding="utf-8"))
    deso_ids = [f["properties"]["id"] for f in deso_fc["features"]]
    regso_of = {f["properties"]["id"]: f["properties"]["regso"] for f in deso_fc["features"]}
    polys = [shape(f["geometry"]) for f in deso_fc["features"]]
    tree = STRtree(polys)

    # OSM-byggnader
    buildings = {}
    with open(K / "osm_byggnader_malmo.tsv", encoding="utf-8") as fh:
        lines = [ln for ln in fh if not ln.startswith("#")]
    for r in csv.DictReader(lines, delimiter="\t"):
        lv = None
        src = None
        try:
            if r["building_levels"]:
                lv = float(r["building_levels"].replace(",", ".").split(";")[0])
                src = "osm_levels"
        except ValueError:
            lv = None
        if lv is None and r["height"]:
            try:
                h = float(re.sub(r"[^\d.]", "", r["height"].replace(",", ".")))
                if h > 0:
                    lv, src = max(1.0, round(h / 3.0)), "osm_height"
            except ValueError:
                pass
        if lv is not None and not (0.5 <= lv <= 40):
            lv, src = None, None
        pt = Point(float(r["lon"]), float(r["lat"]))
        hits = [i for i in tree.query(pt) if polys[i].covers(pt)]
        buildings[int(r["idx"])] = {"osm": r["osm_way"], "area": float(r["fotavtryck_m2"]), "typ": r["building"],
                                    "lv": lv, "lvsrc": src, "deso": deso_ids[min(hits)] if hits else None}

    # mycket stora fotavtryck utan våningsuppgift är oftast hallar, köpcentrum eller industri:
    # höjdtaggen eller områdesmedianen överskattar då antalet våningsplan kraftigt.
    LARGE_FOOTPRINT = 3000.0
    for b in buildings.values():
        if b["lvsrc"] == "osm_height" and b["area"] >= LARGE_FOOTPRINT:
            b["lv"], b["lvsrc"] = 2.0, "stor_byggnadsyta"

    # imputering av våningar
    def tagged_ok(b):
        return b["lv"] is not None and b["typ"] not in HOUSE_TYPES | SMALL_TYPES
    by_deso, by_regso, city = defaultdict(list), defaultdict(list), []
    for b in buildings.values():
        if tagged_ok(b):
            city.append(b["lv"])
            if b["deso"]:
                by_deso[b["deso"]].append(b["lv"])
                by_regso[regso_of[b["deso"]]].append(b["lv"])
    city_med = statistics.median(city)
    for b in buildings.values():
        if b["lv"] is not None:
            continue
        if b["typ"] in HOUSE_TYPES:
            b["lv"], b["lvsrc"] = 1.5, "smahus_standard"
        elif b["typ"] in SMALL_TYPES or b["area"] < 40:
            b["lv"], b["lvsrc"] = 1.0, "liten_byggnad"
        elif b["area"] >= LARGE_FOOTPRINT:
            b["lv"], b["lvsrc"] = 2.0, "stor_byggnadsyta"
        elif b["deso"] and len(by_deso[b["deso"]]) >= 5:
            b["lv"], b["lvsrc"] = statistics.median(by_deso[b["deso"]]), "median_deso"
        elif b["deso"] and len(by_regso[regso_of[b["deso"]]]) >= 5:
            b["lv"], b["lvsrc"] = statistics.median(by_regso[regso_of[b["deso"]]]), "median_regso"
        else:
            b["lv"], b["lvsrc"] = city_med, "median_malmo"
    log["vaningar_imputering"] = {"taggade_referensbyggnader": len(city), "median_malmo": city_med}

    # adressandelar per byggnad
    kept = [d for d in decl.values() if d["kvar"]]
    addr_in_b = Counter()
    for d in kept:
        for a in d["kvar"]:
            if a in coupling and a in bmap:
                addr_in_b[bmap[a][0]] += 1

    # 3. fördelning, Atemp
    out_rows = []
    lv_src_count = Counter()
    for d in kept:
        matched = [a for a in d["kvar"] if a in coupling]
        alloc = Counter(coupling[a]["deso"] for a in matched)
        n = sum(alloc.values())
        bta = 0.0
        srcs = Counter()
        per_b = Counter(bmap[a][0] for a in matched if a in bmap)
        for bi, cnt in per_b.items():
            b = buildings[bi]
            share = cnt / addr_in_b[bi]
            bta += b["area"] * b["lv"] * share
            srcs[b["lvsrc"]] += b["area"] * b["lv"] * share
        lv_src_count.update(srcs.keys())
        main_src = srcs.most_common(1)[0][0] if srcs else "saknas"
        regime = "bbr29" if d["datum"] >= REGIME_DATE else "bbr25"
        out_rows.append({
            "id": d["id"], "klass": d["klass"], "ep": d["ep"], "se": d["se"], "datum": d["datum"], "regim": regime,
            "fastighet": d["fastighet"], "n_adr": len(d["kvar"]), "n_kopplade": n,
            "alloc": {k: v / n for k, v in alloc.items()} if n else {},
            "bta": round(bta, 1), "bta_kalla": main_src, "n_byggnader": len(per_b),
        })

    # energibärare: ankarvärden per regim
    anchors = {}
    for regime in ("bbr25", "bbr29"):
        rr = [r["ep"] / r["se"] for r in out_rows if r["regim"] == regime and r["ep"] and r["se"]]
        anchors[regime] = {"r_lo": round(pct(rr, 0.10), 3), "r_hi": round(pct(rr, 0.90), 3), "n": len(rr)}
    for r in out_rows:
        s = None
        if r["ep"] and r["se"]:
            a = anchors[r["regim"]]
            t = (r["ep"] / r["se"] - a["r_lo"]) / (a["r_hi"] - a["r_lo"])
            s = F0_ELSHARE + (1 - F0_ELSHARE) * min(1.0, max(0.0, t))
        r["el"] = s
        r["el_kalla"] = "kvot_ep_se" if s is not None else None
    deso_el = defaultdict(list)
    for r in out_rows:
        if r["el"] is not None and r["alloc"]:
            deso_el[max(r["alloc"], key=r["alloc"].get)].append(r["el"])
    city_el = statistics.median([r["el"] for r in out_rows if r["el"] is not None])
    for r in out_rows:
        if r["el"] is None:
            dd = max(r["alloc"], key=r["alloc"].get) if r["alloc"] else None
            if dd and len(deso_el[dd]) >= 5:
                r["el"], r["el_kalla"] = statistics.median(deso_el[dd]), "median_deso"
            else:
                r["el"], r["el_kalla"] = city_el, "median_malmo"

    log.update({
        "beraknade_deklarationer": len(out_rows),
        "kartlagda": sum(1 for r in out_rows if r["alloc"]),
        "ej_kartlagda": sum(1 for r in out_rows if not r["alloc"]),
        "saknar_energiprestanda": sum(1 for r in out_rows if r["se"] is None),
        "saknar_byggnad_for_atemp": sum(1 for r in out_rows if r["alloc"] and r["bta"] <= 0),
        "energibarare_ankare": anchors, "elandel_median_malmo": round(city_el, 3), "f0_fastighetsel": F0_ELSHARE,
        "bta_kalla_antal": dict(Counter(r["bta_kalla"] for r in out_rows)),
        "regimdatum": REGIME_DATE,
    })

    # kompakt kolumnformat för appen
    deso_index = {c: i for i, c in enumerate(deso_ids)}
    cols = {"id": [], "klass": [], "se": [], "ep": [], "ar": [], "regim": [], "el": [], "elk": [],
            "bta": [], "btak": [], "fast": [], "alloc": []}
    elk_codes = {"kvot_ep_se": 0, "median_deso": 1, "median_malmo": 2}
    btak_codes = {"osm_levels": 0, "osm_height": 1, "median_deso": 2, "median_regso": 3, "median_malmo": 4,
                  "smahus_standard": 5, "liten_byggnad": 6, "saknas": 7, "stor_byggnadsyta": 8}
    for r in out_rows:
        cols["id"].append(int(r["id"]))
        cols["klass"].append(r["klass"])
        cols["se"].append(r["se"])
        cols["ep"].append(r["ep"])
        cols["ar"].append(int(r["datum"][:4]))
        cols["regim"].append(1 if r["regim"] == "bbr29" else 0)
        cols["el"].append(round(r["el"], 3))
        cols["elk"].append(elk_codes[r["el_kalla"]])
        cols["bta"].append(round(r["bta"]))
        cols["btak"].append(btak_codes[r["bta_kalla"]])
        cols["fast"].append(r["fastighet"])
        cols["alloc"].append([[deso_index[k], round(v, 4)] for k, v in sorted(r["alloc"].items())])
    payload = {"schema": "malmoop-energi-1", "deso": deso_ids, "kolumner": cols,
               "koder": {"elk": list(elk_codes), "btak": list(btak_codes)}, "urval": log,
               "uteslutna_ersatta": superseded}
    (root / "data/energi_deklarationer.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(log, ensure_ascii=False, indent=1))
    return log


if __name__ == "__main__":
    main()
