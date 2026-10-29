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
# Klassning av alla OSM-byggnader (hela beståndet). Ordningen avgör: typ -> storlek -> markanvändning.
UNHEATED_T = {"garage", "garages", "shed", "carport", "roof", "greenhouse", "hut", "ruins", "transformer_tower", "water_tower",
              "silo", "storage_tank", "tank", "container", "bunker", "construction", "collapsed", "allotment_house", "cabin",
              "toilets", "bridge", "tent", "boathouse", "barn", "cowshed", "stable", "sty", "farm_auxiliary", "digester",
              "gasometer", "chimney", "tower", "grandstand", "parking", "wall", "shelter", "conservatory", "kiosk", "service",
              "pavilion", "gazebo", "canopy", "bicycle_parking", "outbuilding", "annexe", "no", "static_caravan", "houseboat", "ship"}
SMAHUS_T = {"house", "detached", "semidetached_house", "terrace", "bungalow", "farm", "semi"}
FLERBO_T = {"apartments", "residential", "dormitory"}
LOKAL_T = {"commercial", "retail", "office", "school", "kindergarten", "university", "college", "hospital", "public", "civic",
           "government", "church", "chapel", "mosque", "synagogue", "temple", "cathedral", "religious", "sports_hall",
           "sports_centre", "hotel", "train_station", "transportation", "fire_station", "townhall", "museum", "theatre",
           "cinema", "library", "supermarket", "clinic", "healthcare", "community_centre", "prison", "police", "stadium",
           "conference_centre", "childcare", "dentist", "nursing_home"}
INDUSTRI_T = {"industrial", "warehouse", "manufacture", "factory", "hangar", "depot", "storage", "workshop", "riding_hall"}
LU_LOKAL = {"retail", "commercial", "school", "kindergarten", "university", "college", "hospital", "clinic",
            "place_of_worship", "religious", "education", "prison"}
LU_INDUSTRI = {"industrial", "port", "railway", "depot", "military"}
KLASSER = ["smahus", "flerbostadshus", "lokal", "industri"]


def heat_class(t: str, lu: str, area: float, amen: str) -> tuple[str, str]:
    """Returnerar (klass, grund). Klass: smahus|flerbostadshus|lokal|industri|ouppvarmd."""
    if t in UNHEATED_T:
        return "ouppvarmd", "typ"
    if area < 30:
        return "ouppvarmd", "liten_yta"
    if t in SMAHUS_T:
        return "smahus", "typ"
    if t in FLERBO_T:
        return "flerbostadshus", "typ"
    if t in LOKAL_T or amen:
        return "lokal", "typ"
    if t in INDUSTRI_T:
        return "industri", "typ"
    if lu == "residential":
        return ("ouppvarmd" if area < 40 else "smahus" if area < 250 else "flerbostadshus"), "markanvandning"
    if lu in ("allotments", "construction", "brownfield", "garages"):
        return "ouppvarmd", "markanvandning"
    if lu == "farmyard":
        return ("smahus" if 40 <= area < 300 else "ouppvarmd"), "markanvandning"
    if lu in LU_INDUSTRI:
        return ("industri" if area >= 40 else "ouppvarmd"), "markanvandning"
    if lu in LU_LOKAL:
        return ("lokal" if area >= 40 else "ouppvarmd"), "markanvandning"
    if lu == "cemetery":
        return ("lokal" if area >= 100 else "ouppvarmd"), "markanvandning"
    # ingen typ eller markanvändning: främst hamn- och verksamhetsområden
    if area < 40:
        return "ouppvarmd", "storlek"
    return ("smahus" if area < 150 else "industri"), "storlek"
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
        area = float(r["fotavtryck_m2"])
        kl, grund = heat_class(r["building"], r.get("landuse", ""), area, r["amenity_shop_office"])
        buildings[int(r["idx"])] = {"osm": r["osm_way"], "area": area, "typ": r["building"],
                                    "lv": lv, "lvsrc": src, "deso": deso_ids[min(hits)] if hits else None,
                                    "kl": kl, "klgrund": grund}

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

    # Grannar (<= 2 m) – kvartersbebyggelse känns igen på sammanbyggda byggnadskroppar
    neighbours = defaultdict(set)
    gfile = K / "osm_byggnader_grannar.tsv"
    if gfile.exists():
        with open(gfile, encoding="utf-8") as fh:
            for r in csv.DictReader((ln for ln in fh if not ln.startswith("#")), delimiter="\t"):
                neighbours[r["osm_a"]].add(r["osm_b"])
                neighbours[r["osm_b"]].add(r["osm_a"])
    # Otaggade mindre byggnader i bostadsområde: sammanbyggda i en DeSO med flervåningshus = kvarter, inte villa
    for b in buildings.values():
        if b["kl"] == "smahus" and b["klgrund"] == "markanvandning" and b["typ"] not in SMAHUS_T and neighbours.get(b["osm"]):
            dm = statistics.median(by_deso[b["deso"]]) if b["deso"] and len(by_deso[b["deso"]]) >= 5 else None
            if dm is not None and dm >= 3:
                b["kl"], b["klgrund"] = "flerbostadshus", "kvarter"

    for b in buildings.values():
        if b["lv"] is not None:
            continue
        if b["typ"] in HOUSE_TYPES or (b["kl"] == "smahus" and b["typ"] not in FLERBO_T):
            b["lv"], b["lvsrc"] = 1.5, "smahus_standard"
        elif b["kl"] == "industri":
            b["lv"], b["lvsrc"] = (2.0, "stor_byggnadsyta") if b["area"] >= LARGE_FOOTPRINT else (1.5, "industri_standard")
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
    declared_b = set()
    lv_src_count = Counter()
    for d in kept:
        matched = [a for a in d["kvar"] if a in coupling]
        alloc = Counter(coupling[a]["deso"] for a in matched)
        n = sum(alloc.values())
        bta = 0.0
        srcs = Counter()
        per_b = Counter(bmap[a][0] for a in matched if a in bmap)
        kls = Counter()
        for bi, cnt in per_b.items():
            b = buildings[bi]
            share = cnt / addr_in_b[bi]
            bta += b["area"] * b["lv"] * share
            srcs[b["lvsrc"]] += b["area"] * b["lv"] * share
            kls[b["kl"] if b["kl"] in KLASSER else "flerbostadshus" if b["area"] >= 250 else "smahus"] += b["area"] * b["lv"] * share
            declared_b.add(bi)
        lv_src_count.update(srcs.keys())
        main_src = srcs.most_common(1)[0][0] if srcs else "saknas"
        regime = "bbr29" if d["datum"] >= REGIME_DATE else "bbr25"
        out_rows.append({
            "id": d["id"], "klass": d["klass"], "ep": d["ep"], "se": d["se"], "datum": d["datum"], "regim": regime,
            "fastighet": d["fastighet"], "n_adr": len(d["kvar"]), "n_kopplade": n,
            "alloc": {k: v / n for k, v in alloc.items()} if n else {},
            "bta": round(bta, 1), "bta_kalla": main_src, "n_byggnader": len(per_b),
            "kl": kls.most_common(1)[0][0] if kls else "okand",
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

    # 4. Hela beståndet: odeklarerade uppvärmda byggnader får energiprestanda och elandel
    #    från deklarerade byggnader av samma klass i samma DeSO (n>=5), RegSO (n>=5) eller Malmö.
    #    Byggnadskroppar som är sammanbyggda (<= 2 m, högst två steg) med en deklarerad
    #    flerbostads-, lokal- eller industribyggnad (gårdshus, flyglar, byggnadsdelar utan egen adress)
    #    redovisas separat. Deras yta finns inte i deklarationens skattade Atemp, så de skattas som
    #    övriga odeklarerade byggnader och räknas inte två gånger.
    osm_to_idx = {b["osm"]: i for i, b in buildings.items()}
    declared_osm = {buildings[i]["osm"] for i in declared_b}
    covered = set()
    frontier = set(declared_osm)
    for _ in range(2):
        nxt = set()
        for o in frontier:
            for nb in neighbours.get(o, ()):
                bi = osm_to_idx.get(nb)
                if bi is None or nb in declared_osm or nb in covered:
                    continue
                if buildings[bi]["kl"] in ("flerbostadshus", "lokal", "industri"):
                    covered.add(nb)
                    nxt.add(nb)
        frontier = nxt
    stat_se = {k: defaultdict(list) for k in ("deso", "regso")}
    stat_el = {k: defaultdict(list) for k in ("deso", "regso")}
    city_se, city_el_k = defaultdict(list), defaultdict(list)
    for r in out_rows:
        if not r["alloc"] or r["se"] is None:
            continue
        kl = r["kl"] if r["kl"] in KLASSER else "flerbostadshus"
        dd = max(r["alloc"], key=r["alloc"].get)
        for key, area_code in (("deso", dd), ("regso", regso_of[dd])):
            stat_se[key][(kl, area_code)].append(r["se"])
            stat_el[key][(kl, area_code)].append(r["el"])
        city_se[kl].append(r["se"])
        city_el_k[kl].append(r["el"])
    all_se = [r["se"] for r in out_rows if r["se"] is not None]
    all_el = [r["el"] for r in out_rows]

    def impute(kl, deso_code):
        for lvl, key, code in ((0, "deso", deso_code), (1, "regso", regso_of[deso_code])):
            v = stat_se[key].get((kl, code), [])
            if len(v) >= 5:
                return statistics.median(v), statistics.median(stat_el[key][(kl, code)]), lvl
        if len(city_se[kl]) >= 20:
            return statistics.median(city_se[kl]), statistics.median(city_el_k[kl]), 2
        return statistics.median(all_se), statistics.median(all_el), 3

    stock_rows = []
    summary = {k: {"byggnader": 0, "bta": 0.0} for k in
               ("deklarerad", "sammanbyggd_med_deklarerad", "skattad", "ouppvarmd", "utanfor_deso")}
    klass_summary = {k: {"deklarerade": 0, "deklarerade_bta": 0.0, "skattade": 0, "skattade_bta": 0.0} for k in KLASSER}
    for bi, b in buildings.items():
        bta_b = b["area"] * b["lv"]
        if bi in declared_b:
            summary["deklarerad"]["byggnader"] += 1; summary["deklarerad"]["bta"] += bta_b
            if b["kl"] in KLASSER:
                klass_summary[b["kl"]]["deklarerade"] += 1; klass_summary[b["kl"]]["deklarerade_bta"] += bta_b
            continue
        if b["kl"] not in KLASSER:
            summary["ouppvarmd"]["byggnader"] += 1; summary["ouppvarmd"]["bta"] += bta_b
            continue
        if not b["deso"]:
            summary["utanfor_deso"]["byggnader"] += 1; summary["utanfor_deso"]["bta"] += bta_b
            continue
        se, el, lvl = impute(b["kl"], b["deso"])
        grupp = "sammanbyggd_med_deklarerad" if b["osm"] in covered else "skattad"
        summary[grupp]["byggnader"] += 1; summary[grupp]["bta"] += bta_b
        klass_summary[b["kl"]]["skattade"] += 1; klass_summary[b["kl"]]["skattade_bta"] += bta_b
        stock_rows.append((b["deso"], b["kl"], bta_b, b["lvsrc"], se, el, lvl, b["klgrund"]))
    for v in summary.values():
        v["bta"] = round(v["bta"])
    for v in klass_summary.values():
        v["deklarerade_bta"] = round(v["deklarerade_bta"]); v["skattade_bta"] = round(v["skattade_bta"])
    log["bestand"] = {"sammanfattning": summary, "per_klass": klass_summary,
                      "klassgrund": dict(Counter(b["klgrund"] for b in buildings.values())),
                      "osm_byggnader": len(buildings)}

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
                  "smahus_standard": 5, "liten_byggnad": 6, "saknas": 7, "stor_byggnadsyta": 8, "industri_standard": 9}
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
    kl_codes = {k: i for i, k in enumerate(KLASSER + ["okand"])}
    cols["kl"] = [kl_codes.get(r["kl"], kl_codes["okand"]) for r in out_rows]
    btak_codes.setdefault("industri_standard", 9)
    grund_codes = {"typ": 0, "markanvandning": 1, "kvarter": 2, "storlek": 3, "liten_yta": 4}
    stock = {"deso": [], "kl": [], "bta": [], "btak": [], "se": [], "el": [], "sek": [], "grund": []}
    for dd, kl, bta_b, lvsrc, se, el, lvl, grund in stock_rows:
        stock["deso"].append(deso_index[dd]); stock["kl"].append(kl_codes[kl]); stock["bta"].append(round(bta_b))
        stock["btak"].append(btak_codes[lvsrc]); stock["se"].append(round(se, 1)); stock["el"].append(round(el, 3))
        stock["sek"].append(lvl); stock["grund"].append(grund_codes.get(grund, 3))
    # Kalibrerings- och kontrolldata från SCB (kommunal energistatistik och bostadsbestånd)
    kal = None
    scb_file = K / "scb_energi_bostader.json"
    if scb_file.exists():
        scb = json.loads(scb_file.read_text(encoding="utf-8"))
        kre = {tuple(d["key"][1:]): d["values"][0] for d in scb["slutanvandning_malmo"]["data"]}
        num = lambda v: None if v in ("..", ".", "-", None) else float(v)
        sektorer = {"98": "småhus", "97": "flerbostadshus", "931": "offentlig verksamhet", "951": "övriga tjänster", "921": "industri, byggverksamhet"}
        fjv = {namn: {ar: num(kre.get((k, "14", ar))) for ar in ("2020", "2021", "2022", "2023", "2024")} for k, namn in sektorer.items()}
        el = {namn: {ar: num(kre.get((k, "16", ar))) for ar in ("2020", "2021", "2022", "2023", "2024")} for k, namn in sektorer.items()}
        total_fjv = {ar: num(kre.get(("999", "14", ar))) for ar in ("2020", "2021", "2022", "2023", "2024")}
        mid = {"30mindre": 25, "31": 35.5, "41": 45.5, "51": 55.5, "61": 65.5, "71": 75.5, "81": 85.5, "91": 95.5, "101": 105.5,
               "111": 115.5, "121": 125.5, "131": 135.5, "141": 145.5, "151": 155.5, "161": 165.5, "171": 175.5, "181": 185.5,
               "191": 195.5, "200plus": 230}
        boa = defaultdict(lambda: [0, 0.0])
        for d in scb["lagenheter_bostadsarea_malmo_2024"]["data"]:
            hus, klass_ = d["key"][1], d["key"][2]
            n = num(d["values"][0]) or 0
            if klass_ in mid:
                boa[hus][0] += n
                boa[hus][1] += n * mid[klass_]
        # Sektorsmål 2024: sekretessbelagda sektorer (null) får resten mot totalen, fördelad som senaste år där alla värden finns
        ar_mal = "2024"
        sek24 = {s: v[ar_mal] for s, v in fjv.items()}
        saknas = [s for s, v in sek24.items() if v is None]
        if saknas and total_fjv[ar_mal] is not None:
            rest = total_fjv[ar_mal] - sum(v for v in sek24.values() if v is not None)
            ref_ar = next((a for a in ("2023", "2022", "2021", "2020") if all(fjv[s][a] is not None for s in saknas)), None)
            vikt = {s: (fjv[s][ref_ar] if ref_ar else 1.0) for s in saknas}
            for s in saknas:
                sek24[s] = rest * vikt[s] / sum(vikt.values())
        else:
            ref_ar = None
        sektor_mal = {"smahus": round(sek24["småhus"]), "flerbostadshus": round(sek24["flerbostadshus"]),
                      "lokal_industri": round(sek24["offentlig verksamhet"] + sek24["övriga tjänster"] + sek24["industri, byggverksamhet"])}
        kal = {"mal_fjarrvarme_mwh": total_fjv["2024"], "ar": 2024,
               "kalla": "SCB (2026) Kommunal och regional energistatistik, tabell SlutAnvSektor, Malmö (1280), fjärrvärme totalt 2024",
               "sektor_mal_mwh": sektor_mal,
               "sektor_metod": ("Fjärrvärme 2024 per sektor. Lokaler och industri = offentlig verksamhet + övriga tjänster + industri/byggverksamhet. "
                                + (" och ".join(x.replace(", ", "/") for x in saknas).capitalize() + " är sekretessbelagda 2024 och får resten mot totalen, fördelad som " + ref_ar + "." if saknas and ref_ar else "")),
               "fjarrvarme_mwh_per_sektor": fjv, "el_mwh_per_sektor": el, "fjarrvarme_totalt_mwh": total_fjv,
               "bostader_2024": {h: {"lagenheter": int(v[0]), "boa_m2": round(v[1])} for h, v in boa.items()},
               "bostader_kalla": "SCB (2026) BO0104T5, antal lägenheter efter hustyp och bostadsarea, Malmö 2024 (klassmittpunkter; >200 m² = 230 m²)"}
    payload = {"schema": "malmoop-energi-2", "deso": deso_ids, "kolumner": cols, "bestand": stock, "kalibrering": kal,
               "koder": {"elk": list(elk_codes), "btak": list(btak_codes), "kl": list(kl_codes),
                         "sek": ["median_deso", "median_regso", "median_malmo", "median_alla"], "grund": list(grund_codes)},
               "urval": log, "uteslutna_ersatta": superseded}
    (root / "data/energi_deklarationer.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(log, ensure_ascii=False, indent=1))
    return log


if __name__ == "__main__":
    main()
