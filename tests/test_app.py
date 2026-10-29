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
        finally:
            shutil.rmtree(work, ignore_errors=True)

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
