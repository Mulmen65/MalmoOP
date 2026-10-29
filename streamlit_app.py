"""MalmoOP 1.1 – klimatavtryck per DeSO i Malmö (energi, mobilitet och exploatering enligt ÖP 2023).

Start lokalt:  python -m streamlit run streamlit_app.py
Allt underlag ligger i mapparna app/ och data/. Beräkningen körs i webbläsaren.
Sidan "Underlag" kan hämta nya energideklarationer och koppla nya adresser (kräver internet).
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHELL = "app/shell.html"
MARKER = re.compile(r"\{\{([^}]+)\}\}")
OVERRIDABLE = ("data/energi_deklarationer.json", "data/metadata.json")


def _embed(name: str, text: str) -> str:
    text = text.strip()
    if name.endswith((".json", ".geojson")):
        json.loads(text)  # validera
        return text.replace("<", "\\u003c")
    if name.endswith(".js"):
        return re.sub(r"</script", r"<\\/script", text, flags=re.IGNORECASE)
    if name.endswith(".css"):
        return re.sub(r"</style", r"<\\/style", text, flags=re.IGNORECASE)
    return text


def _signature() -> tuple:
    files = [ROOT / SHELL, *sorted((ROOT / "app").glob("*")), *sorted((ROOT / "data").glob("*.json")),
             ROOT / "data/kalla/deso_2025_malmo.geojson", ROOT / "data/kalla/land_malmo_osm.json"]
    return tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in files if p.is_file())


@lru_cache(maxsize=4)
def _assemble_cached(signature: tuple, overrides_key: str) -> str:
    del signature
    overrides = json.loads(overrides_key) if overrides_key else {}
    return assemble(overrides)


def assemble(overrides: dict | None = None) -> str:
    """Bygg en fristående HTML-sida med all kod och allt underlag inbäddat."""
    overrides = overrides or {}
    shell = (ROOT / SHELL).read_text(encoding="utf-8")
    meta = json.loads(overrides.get("data/metadata.json") or (ROOT / "data/metadata.json").read_text(encoding="utf-8"))

    def sub(match: re.Match) -> str:
        name = match[1]
        if name == "byggdatum":
            return meta.get("byggdatum", "")
        if ".." in name.split("/") or not (name.startswith("app/") or name.startswith("data/")):
            raise ValueError("Otillåten sökväg i mallen: " + name)
        text = overrides[name] if name in overrides else (ROOT / name).read_text(encoding="utf-8")
        return _embed(name, text)

    html = MARKER.sub(sub, shell)
    if MARKER.search(html):
        raise ValueError("Mallen innehåller platshållare som inte kunde fyllas.")
    return html


def page_html(st=None) -> str:
    overrides = {}
    if st is not None and st.session_state.get("malmoop_overrides"):
        overrides = {k: v for k, v in st.session_state["malmoop_overrides"].items() if k in OVERRIDABLE}
    key = json.dumps(overrides, sort_keys=True) if overrides else ""
    return _assemble_cached(_signature(), key)


def data_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def underlag_page(st, back) -> None:
    with st.container(border=True):
        st.title("Underlag")
        st.write("Ladda ned modellens underlag eller uppdatera energideklarationerna. Nya adresser kopplas automatiskt till DeSO med Malmö stads adresstjänst.")
        st.page_link(back, label="Tillbaka till MalmoOP", icon="⬅️")
        meta = json.loads((ROOT / "data/metadata.json").read_text(encoding="utf-8"))
        energi = json.loads((ROOT / "data/energi_deklarationer.json").read_text(encoding="utf-8"))
        q = energi["urval"]
        c1, c2, c3 = st.columns(3)
        sv = lambda n: f"{n:,}".replace(",", "\u00a0")
        c1.metric("Energideklarationer kartlagda", sv(q["kartlagda"]))
        c1.caption(f"av {sv(q['beraknade_deklarationer'])} beräkningsbara deklarationer")
        c2.metric("Adresser kopplade till DeSO", sv(meta["adresskoppling"]["godkanda"]))
        c2.caption(f"av {sv(meta['adresskoppling']['totalt'])} adresser · Malmö stads adresstjänst")
        c3.metric("Utbyggnadsområden ÖP 2023", "36")
        c3.caption("38\u00a0850 bostäder · 37\u00a0900 arbetsplatser")

        st.subheader("Ladda ned")
        names = ["data/adresskoppling.csv", "data/energi_deklarationer.json", "data/mobilitet_vagvis.json", "data/exploatering_op2023.json", "data/metadata.json"]
        st.download_button("Adresskoppling (adress → koordinat → DeSO) · CSV", (ROOT / names[0]).read_bytes(), "adresskoppling.csv", "text/csv")
        st.download_button("Allt beräkningsunderlag · ZIP", data_zip({n: (ROOT / n).read_text(encoding="utf-8") for n in names}), "malmoop_underlag.zip", "application/zip")

        st.subheader("Uppdatera energideklarationer")
        st.write("Välj en ny CSV med samma kolumner som *Energikarta filer.csv*, eller hämta Malmö stads aktuella energideklarationer. Bara adresser som saknas geokodas; OSM-byggnader hämtas för dem. Resultatet används direkt i din session.")
        source = st.radio("Källa", ["Egen CSV-fil", "Malmö stads energikarta (geo.malmo.se)"], horizontal=True)
        upload = st.file_uploader("CSV (semikolon, UTF-8)", type=["csv"]) if source == "Egen CSV-fil" else None
        if st.button("Läs in och koppla adresser", type="primary"):
            try:
                from tools import uppdatera
                with st.status("Uppdaterar underlaget…", expanded=True) as status:
                    if source == "Egen CSV-fil":
                        if upload is None:
                            raise ValueError("Välj en CSV-fil först.")
                        text = upload.getvalue().decode("utf-8-sig")
                    else:
                        status.write("Hämtar energideklarationer från Malmö stad…")
                        text = uppdatera.fetch_malmo_csv()
                    result = uppdatera.run_update(text, progress=status.write)
                    st.session_state["malmoop_overrides"] = result["files"]
                    st.session_state["malmoop_update_log"] = result["log"]
                    status.update(label="Klart – det nya underlaget används nu i appen", state="complete")
            except Exception as err:  # visas för användaren
                st.error(f"Uppdateringen kunde inte genomföras: {err}")
        if st.session_state.get("malmoop_overrides"):
            log = st.session_state.get("malmoop_update_log", {})
            st.success(f"Nytt underlag aktivt i sessionen: {log.get('energi', {}).get('kartlagda', '–')} kartlagda deklarationer.")
            st.page_link(back, label="Visa resultatet i MalmoOP", icon="🗺️")
            st.write("För att spara för alla användare: ladda ned filerna och ersätt dem i GitHub (samma sökvägar), eller be Claude pusha dem.")
            st.download_button("Uppdaterade datafiler · ZIP", data_zip(st.session_state["malmoop_overrides"]), "malmoop_uppdaterat_underlag.zip", "application/zip")
            with st.expander("Logg"):
                st.json(log, expanded=False)
            if st.button("Återgå till underlaget i GitHub"):
                st.session_state.pop("malmoop_overrides", None)
                st.session_state.pop("malmoop_update_log", None)
                st.rerun()


def main() -> None:
    import streamlit as st
    import streamlit.components.v1 as components

    st.set_page_config(page_title="MalmoOP 1.1", page_icon="🏙️", layout="wide", initial_sidebar_state="collapsed")
    st.markdown("""<style>
[data-testid="stHeader"], [data-testid="stSidebar"], footer {display:none;}
.block-container {padding:0 !important;max-width:100% !important;}
[data-testid="stMainBlockContainer"] {padding:0 !important;}
iframe {border:0;}
</style>""", unsafe_allow_html=True)

    def show() -> None:
        try:
            html = page_html(st)
        except (OSError, ValueError, KeyError) as error:
            st.error("MalmoOP kunde inte läsa sitt underlag. Kontrollera att mapparna app/ och data/ finns bredvid streamlit_app.py.")
            st.caption(str(error))
            return
        st.page_link(pages[1], label="Underlag: ladda ned eller uppdatera energideklarationer och adresskoppling", icon="📥")
        components.html(html, height=1080, scrolling=True)

    pages = [
        st.Page(show, title="MalmoOP", url_path="malmoop", default=True),
        st.Page(lambda: underlag_page(st, pages[0]), title="Underlag", url_path="underlag"),
    ]
    st.navigation(pages, position="hidden").run()


if __name__ == "__main__":
    main()
