"""Tester för Streamlit-appens sidbygge och dataflödet. Kör: python -m unittest discover tests"""
from __future__ import annotations

import csv
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import streamlit_app  # noqa: E402
from tools import build_adresskoppling, build_energi, uppdatera  # noqa: E402


class TestAssemble(unittest.TestCase):
    def test_html_is_complete_and_safe(self):
        html = streamlit_app.assemble()
        self.assertNotRegex(html, r"\{\{[^}]+\}\}")
        for tag in ("d-deso", "d-energi", "d-mob", "d-expl", "d-meta", "d-land"):
            m = re.search(r'<script id="' + tag + r'" type="application/json">(.*?)</script>', html, re.S)
            self.assertIsNotNone(m, tag)
            json.loads(m.group(1))
        self.assertIn("window.MalmoOP", html)
        self.assertLess(len(html.encode()), 25 * 1024 * 1024)

    def test_overrides_replace_energy_data(self):
        energi = json.loads((ROOT / "data/energi_deklarationer.json").read_text(encoding="utf-8"))
        energi["urval"]["kartlagda"] = 4242
        html = streamlit_app.assemble({"data/energi_deklarationer.json": json.dumps(energi)})
        self.assertIn('"kartlagda":4242', html.replace(" ", ""))

    def test_rejects_paths_outside_repo(self):
        with self.assertRaises(ValueError):
            shell = streamlit_app.ROOT / streamlit_app.SHELL
            original = shell.read_text(encoding="utf-8")
            try:
                shell.write_text(original + "{{../secret.txt}}", encoding="utf-8")
                streamlit_app.assemble()
            finally:
                shell.write_text(original, encoding="utf-8")


class TestData(unittest.TestCase):
    def test_deso_and_area(self):
        fc = json.loads((ROOT / "data/kalla/deso_2025_malmo.geojson").read_text(encoding="utf-8"))
        self.assertEqual(len(fc["features"]), 209)
        self.assertTrue(all(f["properties"]["id"].startswith("1280") for f in fc["features"]))
        land = sum(float(f["properties"]["land_ha"]) for f in fc["features"])
        self.assertAlmostEqual(land, 15858, delta=5)

    def test_address_coupling_accepted_flags_only(self):
        with open(ROOT / "data/adresskoppling.csv", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter=";"))
        self.assertGreater(len(rows), 30000)
        for r in rows:
            if r["deso"]:
                self.assertIn(r["flagga"], "ABPC")
                self.assertTrue(55.4 < float(r["lat"]) < 55.7 and 12.8 < float(r["lon"]) < 13.2)
            else:
                self.assertTrue(r["flagga"] in "RU" or not r["lat"])

    def test_energy_build_is_reproducible(self):
        work = Path(tempfile.mkdtemp())
        try:
            shutil.copytree(ROOT / "data", work / "data")
            build_adresskoppling.main(work)
            build_energi.main(work)
            a = json.loads((ROOT / "data/energi_deklarationer.json").read_text(encoding="utf-8"))
            b = json.loads((work / "data/energi_deklarationer.json").read_text(encoding="utf-8"))
            self.assertEqual(a["kolumner"], b["kolumner"])
            self.assertEqual(a["bestand"], b["bestand"])
            self.assertEqual(a["kalibrering"], b["kalibrering"])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_building_stock(self):
        e = json.loads((ROOT / "data/energi_deklarationer.json").read_text(encoding="utf-8"))
        b, kl = e["bestand"], e["koder"]["kl"]
        n = len(b["deso"])
        self.assertGreater(n, 15000)
        self.assertTrue(all(len(v) == n for v in b.values()))
        self.assertTrue(all(0 <= d < 209 for d in b["deso"]))
        self.assertTrue(all(kl[k] in ("smahus", "flerbostadshus", "lokal", "industri") for k in b["kl"]))
        self.assertTrue(all(s > 0 for s in b["se"]) and all(0 <= x <= 1 for x in b["el"]))
        sm = e["urval"]["bestand"]["sammanfattning"]
        self.assertEqual(n, sm["skattad"]["byggnader"] + sm["sammanbyggd_med_deklarerad"]["byggnader"])
        self.assertEqual(sum(sm[k]["byggnader"] for k in sm), e["urval"]["bestand"]["osm_byggnader"])
        kal = e["kalibrering"]
        self.assertAlmostEqual(sum(kal["sektor_mal_mwh"].values()), kal["mal_fjarrvarme_mwh"], delta=2)


class TestUpdateFlow(unittest.TestCase):
    def test_update_reuses_existing_buildings(self):
        """En ny adress i en byggnad som redan finns i beståndet får inte lägga till byggnaden en gång till."""
        csv_text = (ROOT / "data/kalla/Energikarta_filer.csv").read_text(encoding="utf-8-sig")
        first = csv_text.splitlines()[1].split(";")
        new_row = first[:]
        new_row[0], new_row[9], new_row[10] = "99999999", "Testgatan 1", "21111"
        csv_text = csv_text.rstrip("\n") + "\n" + ";".join(new_row) + "\n"
        with open(ROOT / "data/kalla/osm_byggnader_malmo.tsv", encoding="utf-8") as fh:
            lines = [ln for ln in fh if not ln.startswith("#")]
        way = lines[1].split("\t")[1]
        fake_geo = [{"adress": "Testgatan 1", "postnummer": "21111", "flagga": "A", "x_3008": "117406", "y_3008": "6165861", "score": 100,
                     "status": "M", "match_addr_avvikande": "", "match_postnr_avvikande": ""}]
        orig = uppdatera.geocode, uppdatera.buildings_for
        uppdatera.geocode = lambda missing, progress: fake_geo
        uppdatera.buildings_for = lambda pts, progress: ([{"osm_way": int(way), "fotavtryck_m2": 100, "building": "yes", "building_levels": "",
                                                           "height": "", "roof_levels": "", "levels_underground": "", "amenity_shop_office": "",
                                                           "lon": "13.0", "lat": "55.6"}], [0], [0])
        try:
            res = uppdatera.run_update(csv_text, progress=lambda *_: None)
        finally:
            uppdatera.geocode, uppdatera.buildings_for = orig
        self.assertEqual(res["log"]["nya_adresser"], 1)
        osm = [ln for ln in res["files"]["data/kalla/osm_byggnader_malmo.tsv"].splitlines() if ln and not ln.startswith("#")]
        self.assertEqual(len(osm), len(lines), "byggnaden fanns redan och ska inte läggas till")
        a2b = res["files"]["data/kalla/adress_till_byggnad.tsv"].splitlines()[-1].split("\t")
        self.assertEqual(a2b[:3], ["Testgatan 1", "21111", lines[1].split("\t")[0]])
        e = json.loads(res["files"]["data/energi_deklarationer.json"])
        self.assertIn(99999999, e["kolumner"]["id"])

    def test_mobility_matches_vagvis_city_totals(self):
        mob = json.loads((ROOT / "data/mobilitet_vagvis.json").read_text(encoding="utf-8"))
        self.assertEqual(len(mob["A"]), 209)
        self.assertAlmostEqual(sum(v["total"] for v in mob["A"].values()), mob["stad"]["A"]["total"], delta=1)
        self.assertAlmostEqual(sum(v["total"] for v in mob["B_local"].values()), mob["stad"]["B_local"]["total"], delta=1)
        self.assertAlmostEqual(mob["stad"]["A"]["total"], 424876, delta=1)

    def test_development_areas(self):
        ex = json.loads((ROOT / "data/exploatering_op2023.json").read_text(encoding="utf-8"))
        self.assertEqual(len(ex["omraden"]), 36)
        self.assertEqual(sum(a["bostader"] for a in ex["omraden"]), 38850)
        for a in ex["omraden"]:
            self.assertIn(a["fokus"], (1, 2))
            self.assertAlmostEqual(sum(d["andel"] for d in a["delar"]), 1, delta=1e-3)
            for d in a["delar"]:
                self.assertAlmostEqual(sum(d["mark"].values()), d["ha"], delta=0.05)


class TestUpdateHelpers(unittest.TestCase):
    def test_flags(self):
        f = uppdatera.flag_for
        self.assertEqual(f("Koggens Gränd 1A", "21113", {"x": 1, "status": "M", "score": 100, "match": "Koggens gränd 1A", "postal": "211 13"}), "A")
        self.assertEqual(f("Hyllie alle 3C", "21534", {"x": 1, "status": "M", "score": 100, "match": "Hyllie allé 3C", "postal": "215 34"}), "B")
        self.assertEqual(f("Fridhällagatn 28", "21230", {"x": 1, "status": "M", "score": 98, "match": "Fridhällagatan 28", "postal": "212 30"}), "C")
        self.assertEqual(f("Norra Vallgatan 22", "21125", {"x": 1, "status": "T", "score": 88, "match": "Norra Vallgatan 2", "postal": "211 25"}), "R")
        self.assertEqual(f("Grepgatan 7F", "21634", None), "U")

    def test_energikarta_json_to_csv(self):
        obj = {"energideklarationer": [{"id": 1, "energiklass": "C", "primarenergital": "60 kWh/m² och år", "energiprestanda": "55 kWh/m² och år",
                                        "radonmatning": "Utförd", "ventilationskontroll": None, "utford": "2024-01-02",
                                        "fastigheter": [{"kommun": "Malmö", "fastighetsbeteckning": "X 1", "adresser": [
                                            {"adress": "Gatan 1", "postnummer": "21111", "postort": "Malmö"},
                                            {"adress": "Gatan 3", "postnummer": "21111", "postort": "Malmö"}]}]}]}
        rows = list(csv.DictReader(uppdatera.csv_from_energikarta_json(obj).splitlines(), delimiter=";"))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["adress"], "Gatan 3")
        self.assertEqual(rows[0]["energiprestanda"], "55 kWh/m² och år")


if __name__ == "__main__":
    unittest.main()
