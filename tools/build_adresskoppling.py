"""Bygg adresskopplingen: geokodade adresser (SWEREF 99 13 30) -> WGS84 -> DeSO 2025.

Indata
  data/kalla/adresskoppling_geokodning_malmo.tsv  Svar från Malmö stads GeocodeServer
                                                  (Malmo_adresser_platser, geocodeAddresses, outSR=3008)
  data/kalla/deso_2025_malmo.geojson               SCB DeSO 2025_v2 för Malmö (209 områden)
Utdata
  data/adresskoppling.csv                          adress;postnummer;flagga;lat;lon;deso;score

Flaggor (sätts vid hämtningen, se README):
  A  exakt träff (normaliserad adress och postnummer lika)
  B  lika efter borttagna diakritiska tecken/mellanslag, samma postnummer
  P  samma gatuadress men avvikande postnummer
  C  stavningskorrigerad gata, samma husnummer och postnummer, poäng >= 90
  R  avvisad (annat husnummer, oklar gata eller lika poäng/"tie")
  U  ingen träff
Endast A, B, P och C används i beräkningen.

Kör:  python tools/build_adresskoppling.py
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
ACCEPTED = {"A", "B", "P", "C"}


def main(root: Path = ROOT) -> dict:
    deso = json.loads((root / "data/kalla/deso_2025_malmo.geojson").read_text(encoding="utf-8"))
    polys = [shape(f["geometry"]) for f in deso["features"]]
    codes = [f["properties"]["id"] for f in deso["features"]]
    tree = STRtree(polys)
    to_wgs = Transformer.from_crs("EPSG:3008", "EPSG:4326", always_xy=True)

    rows_out = []
    stats = {"total": 0, "accepted": 0, "in_deso": 0, "outside": 0}
    with open(root / "data/kalla/adresskoppling_geokodning_malmo.tsv", encoding="utf-8") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for r in reader:
            stats["total"] += 1
            flag = r["flagga"]
            lat = lon = None
            code = ""
            if r["x_3008"] and r["y_3008"]:
                lon, lat = to_wgs.transform(float(r["x_3008"]), float(r["y_3008"]))
                if flag in ACCEPTED:
                    stats["accepted"] += 1
                    pt = Point(lon, lat)
                    hits = [i for i in tree.query(pt) if polys[i].covers(pt)]
                    if hits:
                        code = codes[min(hits)]
                        stats["in_deso"] += 1
                    else:
                        stats["outside"] += 1
            rows_out.append({
                "adress": r["adress"], "postnummer": r["postnummer"], "flagga": flag,
                "lat": f"{lat:.6f}" if lat is not None else "", "lon": f"{lon:.6f}" if lon is not None else "",
                "deso": code, "score": r["score"],
                "matchning": r["match_addr_avvikande"], "postnr_matchning": r["match_postnr_avvikande"],
            })
    out = root / "data/adresskoppling.csv"
    with open(out, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows_out[0]), delimiter=";")
        w.writeheader()
        w.writerows(rows_out)
    print(json.dumps(stats, ensure_ascii=False))
    return stats


if __name__ == "__main__":
    main()
