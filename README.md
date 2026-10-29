# MalmoOP 1.0 – stadens klimatavtryck per DeSO

MalmoOP är en GitHub/Streamlit-app som beräknar klimatavtrycket per DeSO i Malmö. Den har samma gränssnitt som Vägvis 2.3.1 (mörkgrön sidomeny, A/B-växel, kort, karta med havsavskiljning och områdespanel). Appen räknar på tre delar:

1. **Energi i befintliga byggnader** utgår från användarens energideklarationer (*Energikarta filer.csv*). Adresserna kopplas till DeSO med Malmö stads adresstjänst. Energin räknas om till ton CO₂e med Boverkets emissionsfaktorer för el och fjärrvärme.
2. **Mobilitet** kommer från Vägvis 2.3.1 och följer samma A/B-växel. Modell A avser trafiken på vägar i området; modell B avser hushållens bilar. A och B adderas aldrig.
3. **Exploatering 2030–2050** bygger på de 36 utbyggnadsområdena i Översiktsplan för Malmö 2023. Delen omfattar tillkommande BTA, nybyggnation (A1–A5), förändrad markanvändning (kolförråd), energi i nya byggnader och nya invånares mobilitet.

Resultaten visas i **ton CO₂e/år**, **ton eller kg CO₂e per hektar och år** (landyta utan hav) och **ton CO₂e per invånare och år**. De finns för åren 2024, 2030, 2035, 2040, 2045 och 2050 samt som summa för 2030–2050. Beräkningen körs i webbläsaren och uppdateras direkt när antagandena ändras.

## Starta i Streamlit Community Cloud

1. Öppna [share.streamlit.io](https://share.streamlit.io) och välj **Create app**.
2. Välj repositoryt **Mulmen65/MalmoOP**, grenen **main** och **Main file path: `streamlit_app.py`**. Python 3.12 rekommenderas.
3. Välj **Deploy**. Inga hemligheter, API-nycklar eller GitHub Actions behövs.

Kör lokalt:

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python -m streamlit run streamlit_app.py
```

## Det här är redan gjort i datat

| Steg | Resultat |
|---|---|
| Adresskoppling | 31 028 av 31 356 adresser (99,0 %) har kopplats via Malmö stads `Malmo_adresser_platser/GeocodeServer` och punkt-i-polygon mot SCB DeSO 2025. Hämtat 29 oktober 2026. |
| Energideklarationer | 13 721 av 13 895 beräkningsbara deklarationer (98,7 %) ligger på kartan. 1 534 exakta dubblettrader och 91 ersatta deklarationer är borttagna. |
| Atemp (saknas i CSV) | Skattas ur OpenStreetMap-byggnader: fotavtryck × våningar × 0,9 (summa ca 22 miljoner m²). |
| Energibärare (saknas i CSV) | Skattas ur kvoten primärenergital/energiprestanda; regimskifte BBR 29 den 1 september 2020. |
| Mobilitet | Vägvis 2.3.1: A från färdigt resultat; B körs med Vägvis motor (3 000 iterationer). |
| Exploatering | 36 områden i ÖP 2023 med 38 850 bostäder och 37 900 arbetsplatser, uppdelade per DeSO med marktäcke från OSM. |

**Rättelse jämfört med ChatGPT-paketet:** Malmö stads adresstjänst returnerar adresstypen `POI` för alla adresser. ChatGPT-paketet godkände bara `PointAddress` och `Subaddress`, så i praktiken hade *alla* adresser underkänts och kartan blivit grå. MalmoOP godkänner i stället träffar där adress och husnummer stämmer, med flaggor A/B/P/C (se `tools/uppdatera.py`).

## Sidor i appen

| Sida | Innehåll |
|---|---|
| 01 Översikt | Nyckeltal, klimatavtryckets delar och utveckling 2024–2050 |
| 02 Karta & DeSO | Koropletkarta (OSM-bakgrund, havsavskiljning, utbyggnadsområden), områdespanel och tabell över alla 209 DeSO |
| 03 Så räknas resultatet | Beräkningen steg för steg med siffror för vald DeSO, inklusive deklarationerna |
| 04 Antaganden & scenario | Alla antaganden med källor; ändringar sparas i webbläsaren |
| 05 Exploatering 2030–2050 | Utbyggnadsområden, BTA, åkermark, nybyggnation och mark per år |
| 06 Data & kvalitet | Urval, adressflaggor, Atemp-källor, energibärarmetod och nedladdningar |
| 07 Metod & källor | Formler, systemgränser och Harvard-referenser |
| Underlag (Streamlit) | Ladda ned adresskopplingen. Läs in en ny CSV eller hämta Malmö stads aktuella energideklarationer. Nya adresser kopplas automatiskt. |

## Beräkning i korthet

```
Energi (t)        = Σ energiprestanda × Atemp × (s·0,037 + (1−s)·0,056) / 1000 × adressandel
Mobilitet (t)     = Vägvis A eller B (2024) × flottfaktor(år) × trafikförändring(år)
Nybyggnation (t)  = BTA × klimatfaktor (kg CO₂e/m² BTA, A1–A5) / 1000, jämnt över byggåren
Mark (t)          = ha × hårdgörandel × (kolförråd före − 22 t C/ha) × 44/12, över byggåren
Nya byggnader (t) = BTA × 0,9 × 50 kWh/m² × emissionsfaktor, när de är klara
Ny mobilitet (t)  = nya hushåll × bilar/hushåll × km/bil × t CO₂e/fkm (från Vägvis B för värd-DeSO)
Per hektar        = t / landyta utan hav (ha); kg/ha = 1000 × t/ha
```

| Standardantagande | Värde | Källa |
|---|---|---|
| El / fjärrvärme | 0,037 / 0,056 kg CO₂e/kWh | Boverket (2026a), klimatdatabasen |
| Atemp/BTA | 0,9 | Antagande |
| Fokus 1 / Fokus 2 | byggs 2030–2039 / 2040–2049 | Malmö stad: Fokus 1 detaljplaneras före 2030 |
| BTA per bostad / arbetsplats | 90 m² / 25 m² (blandad stad), 100 m² (verksamhet) | Antaganden |
| Uppförande A1–A5 | 235 (flerbostadshus), 250 (kontor/skola), 190 (hall) kg/m² BTA | Boverket (2026b), förslag till gränsvärden 2030 |
| Energi nya byggnader | 50 kWh/m² Atemp, 22 % el | Median i underlaget, klass A–B, ≥ 1 000 m² BTA |
| Kolförråd åker / öppen / skog / bebyggd | 121 / 103 / 146 / 22 t C/ha | Länsstyrelsen i Uppsala län (2025), proxy |
| Hårdgörandel | 0,7 | Antagande |
| Invånare per bostad | 2,11 | SCB 2024 via Vägvis |

## Uppdatera underlaget

* **I appen:** öppna *Underlag*. Välj en ny CSV med samma kolumner, eller hämta *Malmö stads energikarta*. Klicka på **Läs in och koppla adresser**. Bara nya adresser geokodas, och OSM-byggnader hämtas för dem. Det nya underlaget används direkt i sessionen. Ladda ned ZIP-filen och ersätt filerna i GitHub, eller be Claude pusha dem.
* **Kommandorad:** `python -m tools.uppdatera ny_fil.csv` eller `python -m tools.uppdatera --malmo`. Kommandot skriver de uppdaterade filerna i `data/`.

Reproducera data från källfilerna i `data/kalla/`:

```bash
python tools/build_adresskoppling.py
python tools/build_energi.py
python tools/build_exploatering.py
node tools/build_mobilitet.js
python tools/build_metadata.py
```

## Tester

```bash
node tests/test_model.js                 # 17 beräkningstester (massbalans, räkneexempel, enheter, tidsplan …)
python -m unittest discover tests        # 10 tester av sidbygge, data och uppdateringsflöde
```

## Struktur

```
streamlit_app.py           Streamlit-sidor (appen i iframe + sidan Underlag)
app/                       shell.html, model.js (beräkning), app.js (gränssnitt), stilmallar, Leaflet
data/                      färdigt beräkningsunderlag (energi, mobilitet, exploatering, adresskoppling, metadata)
data/kalla/                källfiler: CSV, geokodning, OSM-byggnader och markanvändning, DeSO, ÖP-lager, Vägvis-data
tools/                     byggskript, uppdateringsflöde och Vägvis beräkningsmotor (MIT)
tests/                     beräknings- och apptester
```

## Tolkning och begränsningar

* MalmoOP är en **screening** för översiktlig planering och ingen officiell utsläppsstatistik. Byggnader utan energideklaration ingår inte, främst många småhus. Industriprocesser, sjöfart, flyg och konsumtion ingår inte heller.
* Atemp och energibärare är **skattningar**. De är energidelens största osäkerhet. Boverkets öppna data om energideklarationer med Atemp och energislag kan ersätta skattningen i en senare version.
* Emissionsfaktorerna är nationella medelvärden ur Boverkets klimatdatabas, inte Malmöspecifika eller marginella. Faktorerna kommer från Boverkets räkneexempel för modul A5. Att använda dem för årlig driftenergi är ett modellval.
* Framtidsåren är scenarier med uttryckliga antaganden. Flottans klimatfaktor är som standard oförändrad (1,0) och kan ändras under *Antaganden & scenario*.
* Kolförråden kommer från Uppsala län och används som proxy för Skåne. Marktäcket kommer från OpenStreetMap, och oklassad mark räknas som standard som redan bebyggd.
* Mobilitetens 95-procentsintervall kommer från Vägvis. För övriga delar redovisas inga statistiska intervall.

## Referenser (Harvard)

* Boverket (2026a) *Indata om energianvändning i klimatdeklarationen*. Senast granskad 29 maj 2026. https://www.boverket.se/sv/klimatdeklaration/gor-sa-har/underlag/indata-om-energi/ (Hämtad: 29 oktober 2026).
* Boverket (2026b) *Utkast färdplan för införande av gränsvärden för byggnaders klimatpåverkan*. Rapport 2026:29. https://www.boverket.se/globalassets/publikationer/dokument/2026/rapport-2026-29_utkast-fardplan-gransvarden-klimatpaverkan-byggnader.pdf (Hämtad: 29 oktober 2026).
* Boverket (u.å.) *Vad är primärenergital?* https://www.boverket.se/sv/PBL-kunskapsbanken/regler-om-byggande/boverkets-byggregler/energihushallning/vad-ar-primarenergital/ (Hämtad: 29 oktober 2026).
* Länsstyrelsen i Uppsala län (2025) *Kolförråd och kolsänka i skog och mark inom Uppsala län – slutrapport*. (Hämtad: 29 oktober 2026).
* Malmö stad (2023) *Översiktsplan för Malmö*. Antagen av kommunfullmäktige 28 september 2023.
* Malmö stad (2024) *OP2023_Underlag – Utbyggnadsområden*. https://gis.malmo.se/arcgis/rest/services/op/OP2023_Underlag/MapServer/129 (Hämtad: 29 oktober 2026).
* Malmö stad (u.å.) *Malmo_adresser_platser* (GeocodeServer). https://gis.malmo.se/arcgis/rest/services/Malmo_adresser_platser/GeocodeServer (Hämtad: 29 oktober 2026).
* Malmö stad (u.å.) *Malmö Energikarta*. https://stadsatlas.malmo.se/energikarta/ (Hämtad: 29 oktober 2026).
* OpenStreetMap contributors (2026) *OpenStreetMap*, Overpass-uttag 29 oktober 2026. ODbL 1.0. https://www.openstreetmap.org/copyright
* Statistiska centralbyrån (2025) *DeSO – Demografiska statistikområden*, 2025_v2. https://www.scb.se/vara-tjanster/oppna-data/oppna-geodata/demografiska-statistikomraden-deso/
* Vägvis (2026) *Vägvis 2.3.1 – trafikens klimatavtryck*. GitHub: Mulmen65/vagvisa.

## Licens

Appkoden har licensen MIT; se `LICENSE`. Där anges även villkoren för tredjepartsdelar (Vägvis, Leaflet, OpenStreetMap, SCB och Malmö stad).
