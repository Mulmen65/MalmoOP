"""Bygg exploateringsunderlaget 2030–2050 ur Översiktsplan för Malmö (ÖP 2023).

Indata (data/kalla/)
  op2023_utbyggnadsomraden_raw.json   Malmö stad, ÖP2023 Underlag, lager 129 "Utbyggnadsområden"
                                      (gis.malmo.se/arcgis/rest/services/op/OP2023_Underlag/MapServer/129)
  osm_markanvandning_utbyggnad.json   OSM-polygoner (landuse/natural/leisure m.fl.) kring områdena
  deso_2025_malmo.geojson             SCB DeSO 2025

Utdata
  data/exploatering_op2023.json       Områden med kapacitet, fokus, geometri och delar per DeSO
                                      inklusive nuvarande marktäcke (ha) per del.

Malmö stads definition (kartans popup): "Kartan visar utbyggnadsområden med minst 200 bostäder
eller 500 arbetsplatser där detaljplaneringen inte har dragit igång. Fokus 1 innebär att området
kommer att börja detaljplaneras innan år 2030 och fokus 2 är efter det."

Marktäcke: OSM-polygoner målas från minsta till största yta (den mest specifika vinner).
Ytor utan OSM-polygon redovisas som "okand".
"""
from __future__ import annotations

import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parents[1]
K = ROOT / "data" / "kalla"

AKER = {"farmland", "farmyard", "orchard", "plant_nursery", "greenhouse_horticulture", "vineyard"}
OPPEN = {"grass", "meadow", "village_green", "recreation_ground", "allotments", "cemetery", "greenfield",
         "flowerbed", "park", "garden", "pitch", "common", "dog_park", "golf_course", "scrub", "heath",
         "grassland", "shrubbery", "wetland", "nature_reserve", "playground", "fitness_station"}
SKOG = {"forest", "wood"}
VATTEN = {"water", "basin", "reservoir", "swimming_pool", "bay"}
BEBYGGD = {"residential", "industrial", "commercial", "retail", "railway", "construction", "brownfield",
           "garages", "parking", "port", "harbour", "quarry", "landfill", "military", "education",
           "religious", "depot", "aerodrome", "apron", "runway", "taxiway", "pedestrian", "stadium",
           "sports_centre", "track", "school", "hospital", "university", "bleachers", "water_park",
           "marina", "slipway", "outdoor_seating", "storage", "fuel"}
LINES = {"tree_row", "coastline", "cliff", "tree"}


def klass(tags: dict) -> str | None:
    for key in ("landuse", "natural", "leisure", "amenity", "aeroway", "highway"):
        v = tags.get(key)
        if not v or v in LINES:
            continue
        if v in SKOG:
            return "skog"
        if v in AKER:
            return "aker"
        if v in VATTEN:
            return "vatten"
        if v in OPPEN:
            return "oppen"
        if v in BEBYGGD:
            return "bebyggd"
    return None


def poly_of(feature):
    g = feature["g"]
    try:
        if feature["id"].startswith("w"):
            ring = g[0]
            if len(ring) < 4 or ring[0] != ring[-1]:
                return None
            p = Polygon(ring)
        else:
            outers = [Polygon(m["c"]) for m in g if m.get("role") in ("outer", "") and len(m["c"]) >= 4 and m["c"][0] == m["c"][-1]]
            inners = [Polygon(m["c"]) for m in g if m.get("role") == "inner" and len(m["c"]) >= 4 and m["c"][0] == m["c"][-1]]
            if not outers:
                return None
            p = unary_union([o.buffer(0) for o in outers])
            if inners:
                p = p.difference(unary_union([i.buffer(0) for i in inners]))
        p = p.buffer(0)
        return p if not p.is_empty else None
    except Exception:
        return None


def main() -> None:
    to_m = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True).transform
    raw = json.loads((K / "op2023_utbyggnadsomraden_raw.json").read_text(encoding="utf-8"))["a"]["features"]
    deso = json.loads((K / "deso_2025_malmo.geojson").read_text(encoding="utf-8"))["features"]
    deso_m = [(f["properties"]["id"], transform(to_m, shape(f["geometry"])).buffer(0)) for f in deso]
    lu = json.loads((K / "osm_markanvandning_utbyggnad.json").read_text(encoding="utf-8"))["features"]
    lu_polys = []
    for f in lu:
        k = klass(f["t"])
        if not k:
            continue
        p = poly_of(f)
        if p is None:
            continue
        pm = transform(to_m, p).buffer(0)
        if pm.area > 0:
            lu_polys.append((pm.area, k, pm))
    lu_polys.sort(key=lambda x: x[0])

    areas = []
    for n, f in enumerate(raw):
        pr = f["properties"]
        geom = shape(f["geometry"]).buffer(0)
        gm = transform(to_m, geom).buffer(0)
        delar = []
        for code, dm in deso_m:
            if not gm.intersects(dm):
                continue
            piece = gm.intersection(dm)
            if piece.area < 1:
                continue
            remaining = piece
            mark = {"aker": 0.0, "oppen": 0.0, "skog": 0.0, "vatten": 0.0, "bebyggd": 0.0}
            for _, k, pm in lu_polys:
                if remaining.is_empty:
                    break
                if not pm.intersects(remaining):
                    continue
                inter = pm.intersection(remaining)
                if inter.area > 0:
                    mark[k] += inter.area / 1e4
                    remaining = remaining.difference(pm)
            mark["okand"] = max(0.0, remaining.area / 1e4)
            delar.append({"deso": code, "ha": round(piece.area / 1e4, 3),
                          "mark": {k: round(v, 3) for k, v in mark.items()}})
        tot = sum(d["ha"] for d in delar)
        for d in delar:
            d["andel"] = round(d["ha"] / tot, 5)
        simp = geom.simplify(0.00003, preserve_topology=True)
        areas.append({
            "id": n + 1, "pkid": pr.get("pkid"), "namn": pr["namn"], "kategori": pr["Utbyggn_kategori"],
            "fokus": int(pr["Fokus"]), "bostader": pr["Bostader"] or 0, "arbetsplatser": pr["Arbetsplatser"] or 0,
            "forskola": pr["Forskola"] or 0, "grundskola": pr["Grundskola"] or 0, "gymnasie": pr["Gymnasie"] or 0,
            "storstadspaket": (pr.get("Storstadspaket_linje") or "").strip(), "ha": round(tot, 2),
            "delar": delar, "geometry": json.loads(json.dumps(mapping(simp), default=float)),
        })
        print(f"{pr['namn'][:28]:28} F{pr['Fokus']} {tot:6.1f} ha  DeSO {len(delar)}  "
              + " ".join(f"{k}={sum(d['mark'][k] for d in delar):.1f}" for k in ("aker", "oppen", "skog", "vatten", "bebyggd", "okand")))
    for a in areas:
        a["geometry"]["coordinates"] = json.loads(json.dumps(a["geometry"]["coordinates"]),
                                                  parse_float=lambda x: round(float(x), 6))
    out = {
        "schema": "malmoop-exploatering-1",
        "kalla": "Malmö stad, Översiktsplan för Malmö 2023, underlag Utbyggnadsområden (OP2023_Underlag, lager 129), hämtat 2026-10-29",
        "definition": "Utbyggnadsområden med minst 200 bostäder eller 500 arbetsplatser där detaljplaneringen inte har dragit igång. Fokus 1: detaljplanering börjar före 2030. Fokus 2: därefter.",
        "markkalla": "OpenStreetMap-bidragsgivare (ODbL), Overpass osm_base 2026-10-29T15:01:51Z",
        "omraden": areas,
    }
    (ROOT / "data/exploatering_op2023.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("bostäder", sum(a["bostader"] for a in areas), "arbetsplatser", sum(a["arbetsplatser"] for a in areas),
          "ha", round(sum(a["ha"] for a in areas), 1))


if __name__ == "__main__":
    main()
