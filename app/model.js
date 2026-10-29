/* MalmoOP beräkningsmotor – klimatavtryck per DeSO, Malmö 2024–2050.
   Ren JavaScript utan beroenden. Körs i webbläsaren (window.MalmoOP) och i Node (tester).
   Enheter: ton CO2e per år om inget annat anges. Alla antaganden finns i DEFAULTS med källa. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MalmoOP = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.2.0';
  const BASE_YEAR = 2024, END_YEAR = 2050;
  const YEARS = [2024, 2030, 2035, 2040, 2045, 2050];
  const ACK = [2030, 2050];
  const COMPONENTS = ['energi', 'mobilitet', 'bygg', 'mark', 'nydrift', 'nymob'];
  const LABELS = {
    energi: 'Energi i befintliga byggnader', mobilitet: 'Mobilitet i befintlig stad',
    bygg: 'Nybyggnation (A1–A5)', mark: 'Förändrad markanvändning',
    nydrift: 'Nya byggnaders energi', nymob: 'Nya invånares mobilitet'
  };
  const SHORT = {energi: 'Energi befintliga', mobilitet: 'Mobilitet', bygg: 'Nybyggnation', mark: 'Markanvändning', nydrift: 'Nya byggnaders energi', nymob: 'Ny mobilitet'};
  const C_TO_CO2 = 44 / 12;

  /* Klimatpåverkan vid uppförande, modul A1–A5, kg CO2e per m² BTA.
     Boverket (2026) Rapport 2026:29, utkast: tabell 2 (referensvärden) och tabell 5 (gränsvärden 2030). */
  const BYGG = {
    referens: {bostad: 358, lokal: 383, hall: 291, skola: 382},
    gransvarde2030: {bostad: 235, lokal: 250, hall: 190, skola: 250}
  };
  const P75_PROXY = 1.15; // 75-percentilen saknas i rapporten; approximeras som referensvärdet × 1,15 (MalmoOP-antagande)

  const DEFAULTS = {
    perspektiv: 'A',            // A: trafik inom området, B: hushållens bilar (Vägvis 2.3.1)
    bLage: 'local',             // Vägvis modell B: 'local' (standard) eller 'gtfs' (DeSO-skattning med GTFS)
    ar: 2050,
    // Energi i befintliga byggnader
    efEl: 0.037,                // kg CO2e/kWh, svensk elmix, Boverkets klimatdatabas (räkneexempel)
    efFv: 0.056,                // kg CO2e/kWh, fjärrvärme svenskt medelvärde, Boverkets klimatdatabas
    atempLage: 'osm',           // 'osm' = skattad ur OSM-fotavtryck × våningar, 'fast' = samma yta per deklaration
    atempFaktor: 0.9,           // Atemp/BTA (antagande)
    atempFast: 1000,            // m² per deklaration i läget 'fast' (ChatGPT-paketets illustrativa värde)
    elLage: 'kvot',             // 'kvot' = elandel ur primärenergital/energiprestanda, 'fast' = samma andel
    elFast: 0.10,
    bestand: 'hela',            // 'hela' = deklarerade + skattade odeklarerade byggnader, 'deklarerade' = bara energideklarationer
    kalibrering: 'sektor',      // Atemp skalas mot SCB:s fjärrvärme 2024: 'sektor' = flerbostadshus resp. lokaler/industri var för sig
                                // (småhus kontrolleras mot SCB:s bostadsarea och kalibreras inte), 'total' = en faktor för alla, 'ingen'
    industriAndel: 0.5,         // uppvärmd andel av BTA i odeklarerade industri-/lagerbyggnader (antagande)
    // Osäkerhet (Monte Carlo). Emissionsfaktorerna är Boverkets värden och varieras inte.
    cvKalibrering: 0.08,        // osäkerhet i kalibreringsmålet (normalår, sektorsgränser, saknade sektorsvärden)
    iterationer: 1000, seed: 19062026,
    effektivisering2050: 0,     // % lägre levererad energi i befintligt bestånd 2050 (linjärt från 2024)
    efForandring2050: 0,        // % förändring av el- och fjärrvärmefaktorer till 2050 (linjärt)
    // Mobilitet
    trafikForandring2050: 0,    // % förändrat trafikarbete i befintlig stad till 2050 (linjärt)
    flotta2030: 1, flotta2040: 1, flotta2050: 1, // fordonsflottans klimatfaktor relativt 2024
    // Exploatering 2030–2050 (ÖP 2023)
    exploatering: true,
    f1Start: 2030, f1Slut: 2040, f2Start: 2040, f2Slut: 2050,
    btaBostad: 90,              // m² BTA per bostad (antagande)
    btaArbBlandad: 25,          // m² BTA per arbetsplats i blandad stad (kontor; antagande)
    btaArbVerks: 100,           // m² BTA per arbetsplats i verksamhetsområde (hall/logistik; antagande)
    btaSkolplats: 10,           // m² BTA per förskole-, grundskole- eller gymnasieplats (antagande)
    klimatBygg: 'gransvarde2030', // 'referens' | 'gransvarde2030' | 'bana'
    atempNy: 0.9,
    energiNy: 50,               // kWh/m² Atemp och år: median, klass A–B, ≥1 000 m² BTA, Malmö-underlaget
    elandelNy: 0.22,            // median elandel, samma urval
    personerPerBostad: 2.11,    // Malmö 2024: 365 644 invånare / 172 941 hushåll (SCB via Vägvis)
    bilFaktor: 1,               // bilar per nytt hushåll relativt värd-DeSO 2024
    andelKmInomMalmo: 0.5,      // andel av nya bilars körsträcka på Malmös vägar (modell A; antagande)
    hardgorandel: 0.7,          // andel av utbyggnadsytan som bebyggs/hårdgörs (antagande)
    markOkand: 'bebyggd',       // mark utan OSM-klass antas vara: 'bebyggd' | 'oppen' | 'aker'
    kolAker: 121, kolOppen: 103, kolSkog: 146, kolBebyggd: 22 // t C/ha, Länsstyrelsen i Uppsala län (2025)
  };

  const LIMITS = {
    efEl: [0, 2], efFv: [0, 2], atempFaktor: [0.3, 1.2], atempFast: [10, 1e6], elFast: [0, 1],
    industriAndel: [0, 1], cvKalibrering: [0, 1], iterationer: [100, 5000], seed: [1, 2147483646],
    effektivisering2050: [-100, 100], efForandring2050: [-100, 200], trafikForandring2050: [-100, 200],
    flotta2030: [0, 3], flotta2040: [0, 3], flotta2050: [0, 3],
    f1Start: [2025, 2050], f1Slut: [2026, 2060], f2Start: [2025, 2060], f2Slut: [2026, 2070],
    btaBostad: [10, 1000], btaArbBlandad: [1, 2000], btaArbVerks: [1, 5000], btaSkolplats: [0, 200],
    atempNy: [0.3, 1.2], energiNy: [0, 500], elandelNy: [0, 1], personerPerBostad: [0, 10], bilFaktor: [0, 5],
    andelKmInomMalmo: [0, 1], hardgorandel: [0, 1], kolAker: [0, 1000], kolOppen: [0, 1000], kolSkog: [0, 1000], kolBebyggd: [0, 1000]
  };
  const ENUMS = {perspektiv: ['A', 'B'], bLage: ['local', 'gtfs'], atempLage: ['osm', 'fast'], elLage: ['kvot', 'fast'],
    bestand: ['hela', 'deklarerade'], kalibrering: ['sektor', 'total', 'ingen'],
    klimatBygg: ['referens', 'gransvarde2030', 'bana'], markOkand: ['bebyggd', 'oppen', 'aker']};

  function params(p = {}) {
    const out = {...DEFAULTS};
    for (const [k, v] of Object.entries(p || {})) {
      if (!(k in DEFAULTS)) continue;
      if (k in ENUMS) { const w = k === 'kalibrering' && v === 'scb' ? 'total' : v; if (ENUMS[k].includes(w)) out[k] = w; continue; }
      if (k === 'exploatering') { out[k] = !!v; continue; }
      if (k === 'ar') { const y = v === 'ack' ? 'ack' : Number(v); if (y === 'ack' || YEARS.includes(y)) out[k] = y; continue; }
      const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) continue;
      const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
      out[k] = Math.min(hi, Math.max(lo, n));
    }
    out.iterationer = Math.round(out.iterationer); out.seed = Math.round(out.seed);
    if (out.f1Slut <= out.f1Start) out.f1Slut = out.f1Start + 1;
    if (out.f2Slut <= out.f2Start) out.f2Slut = out.f2Start + 1;
    return out;
  }

  const clamp01 = x => Math.max(0, Math.min(1, x));
  const ramp = y => clamp01((y - BASE_YEAR) / (END_YEAR - BASE_YEAR));
  function fleet(P, y) {
    const pts = [[BASE_YEAR, 1], [2030, P.flotta2030], [2040, P.flotta2040], [2050, P.flotta2050]];
    if (y <= pts[0][0]) return 1;
    for (let i = 1; i < pts.length; i++) {
      const [x0, v0] = pts[i - 1], [x1, v1] = pts[i];
      if (y <= x1) return v0 + (v1 - v0) * (y - x0) / (x1 - x0);
    }
    return pts[pts.length - 1][1];
  }
  function byggFaktor(P, typ, y) {
    if (P.klimatBygg === 'referens') return BYGG.referens[typ];
    if (P.klimatBygg === 'gransvarde2030') return BYGG.gransvarde2030[typ];
    const start = BYGG.gransvarde2030[typ], m2040 = 0.1 * BYGG.referens[typ] * P75_PROXY;
    if (y <= 2030) return start;
    if (y >= 2040) return m2040;
    return start + (m2040 - start) * (y - 2030) / 10;
  }

  /* Förbered underlaget en gång: index, medianer och kontroller. */
  function prepare(D) {
    const fc = D.deso, ids = fc.features.map(f => f.properties.id), index = Object.fromEntries(ids.map((id, i) => [id, i]));
    const n = ids.length, E = D.energi.kolumner, nd = E.id.length;
    if (D.energi.deso.length !== n || D.energi.deso.some((id, i) => id !== ids[i])) throw new Error('Energiunderlaget och DeSO-geometrin har olika områdesordning.');
    const landHa = fc.features.map(f => Number(f.properties.land_ha) || 0);
    const hh = ids.map(id => D.mob.hushall[id] || {hh: 0, bef: 0, bil: 0, km: null});
    const city = D.mob.stad;
    const cityCph = city.B_local.cars / city.B_local.hushall;
    const cityKm = city.B_local.vkm / city.B_local.cars;
    const cityEpv = city.B_local.total / city.B_local.vkm;
    // fallback för deklarationer utan byggnad: median Atemp-underlag (BTA) bland flerbostads-/lokaldeklarationer
    const btaOk = []; for (let i = 0; i < nd; i++) if (E.bta[i] > 0 && E.btak[i] !== 5 && E.btak[i] !== 6) btaOk.push(E.bta[i]);
    btaOk.sort((a, b) => a - b);
    const btaMedian = btaOk.length ? btaOk[Math.floor(btaOk.length / 2)] : 1000;
    const areas = D.expl.omraden.map(a => {
      const delar = a.delar.filter(d => d.deso in index), tot = delar.reduce((s, d) => s + d.andel, 0) || 1;
      return {...a, delar: delar.map(d => ({...d, andel: d.andel / tot, i: index[d.deso]}))}; // andelar normeras så att de summerar exakt till 1
    });
    // Hela beståndet: skattade odeklarerade byggnader (en DeSO per byggnad)
    const B = D.energi.bestand || {deso: [], kl: [], bta: [], btak: [], se: [], el: [], sek: []};
    const KL = (D.energi.koder && D.energi.koder.kl) || ['smahus', 'flerbostadshus', 'lokal', 'industri', 'okand'];
    const IND = KL.indexOf('industri');
    const GRP = Int8Array.from(KL, k => k === 'smahus' ? 0 : k === 'flerbostadshus' ? 1 : 2); // kalibreringsgrupp per byggnadsklass
    return {ids, index, n, landHa, hh, cityCph, cityKm, cityEpv, btaMedian, areas, D, B, KL, IND, GRP, kal: D.energi.kalibrering || null};
  }

  /* Osäkerhetsmodell för energidelen. Slumpfel per byggnad/deklaration och gemensamma (systematiska) fel. */
  const SIG_LV = [0.10, 0.20, 0.30, 0.35, 0.40, 0.25, 0.30, 0.60, 0.35, 0.35];   // per våningskälla (btak), slumpfel
  const SYS_LV = [0.03, 0.05, 0.12, 0.12, 0.12, 0.10, 0.10, 0.15, 0.15, 0.20];   // per våningskälla, gemensamt fel
  const UNC = {seDekl: 0.10, seDeklSys: 0.05, seSkattad: 0.30, seKlassSys: 0.15, elKvot: 0.06, elMedian: 0.15, elSys: 0.04,
    atempFaktorCv: 0.06, fastAtempCv: 0.5, fastAtempSys: 0.3, industriSpann: 0.25};

  /* Gemensam lista över beräkningsposter: deklarationer (+ skattade byggnader i läget 'hela'). */
  function energyItems(S, P) {
    const E = S.D.energi.kolumner, nd = E.id.length, B = S.B, ns = P.bestand === 'hela' ? B.bta.length : 0, m = nd + ns;
    const it = {m, nd, a: new Float64Array(m), se: new Float64Array(m), el: new Float64Array(m), btak: new Uint8Array(m),
      kl: new Int8Array(m), grp: new Int8Array(m), stock: new Uint8Array(m), sigMag: new Float64Array(m), sigEl: new Float64Array(m), deso: new Int32Array(m), missing: 0};
    const okand = Math.max(0, S.KL.indexOf('okand'));
    for (let i = 0; i < nd; i++) {
      let a, sl;
      if (P.atempLage === 'fast') { a = P.atempFast; sl = UNC.fastAtempCv; }
      else if (E.bta[i] > 0) { a = E.bta[i] * P.atempFaktor; sl = SIG_LV[E.btak[i]] ?? 0.4; }
      else { a = S.btaMedian * P.atempFaktor; sl = SIG_LV[7]; it.missing++; }
      it.a[i] = a; it.se[i] = E.se[i]; it.el[i] = P.elLage === 'fast' ? P.elFast : E.el[i]; it.btak[i] = E.btak[i];
      it.kl[i] = E.kl ? E.kl[i] : okand; it.grp[i] = S.GRP[it.kl[i]] ?? 2; it.deso[i] = -1;
      it.sigMag[i] = Math.sqrt(Math.log(1 + sl * sl) + Math.log(1 + UNC.seDekl * UNC.seDekl));
      it.sigEl[i] = P.elLage === 'fast' ? 0.1 : (E.elk[i] === 0 ? UNC.elKvot : UNC.elMedian);
    }
    for (let j = 0; j < ns; j++) {
      const i = nd + j, ind = B.kl[j] === S.IND;
      const sl = P.atempLage === 'fast' ? UNC.fastAtempCv : (SIG_LV[B.btak[j]] ?? 0.4);
      it.a[i] = (P.atempLage === 'fast' ? P.atempFast : B.bta[j] * P.atempFaktor) * (ind ? P.industriAndel : 1);
      it.se[i] = B.se[j]; it.el[i] = P.elLage === 'fast' ? P.elFast : B.el[j]; it.btak[i] = B.btak[j]; it.kl[i] = B.kl[j]; it.grp[i] = S.GRP[B.kl[j]] ?? 2;
      it.stock[i] = 1; it.deso[i] = B.deso[j];
      it.sigMag[i] = Math.sqrt(Math.log(1 + sl * sl) + Math.log(1 + UNC.seSkattad * UNC.seSkattad));
      it.sigEl[i] = UNC.elMedian;
    }
    return it;
  }
  /* Kalibreringsmål (kWh fjärrvärme) per grupp: 0 småhus, 1 flerbostadshus, 2 lokaler, industri och okänd typ.
     'total' lägger alla byggnader i en grupp. Grupper med mål null kalibreras inte. */
  const GROUP_NAMES = ['Småhus', 'Flerbostadshus', 'Lokaler, industri och okänd typ'];
  function calibration(S, P) {
    const kal = S.kal;
    if (P.bestand !== 'hela' || P.kalibrering === 'ingen' || !kal || !kal.mal_fjarrvarme_mwh) return null;
    if (P.kalibrering === 'total') return {lage: 'total', single: true, mal: [kal.mal_fjarrvarme_mwh * 1000, null, null], namn: ['Alla byggnader']};
    const sm = kal.sektor_mal_mwh; if (!sm) return null;
    return {lage: 'sektor', single: false, mal: [null, sm.flerbostadshus * 1000, sm.lokal_industri * 1000], scb: [sm.smahus * 1000, sm.flerbostadshus * 1000, sm.lokal_industri * 1000], namn: GROUP_NAMES};
  }

  function energyBase(S, P) {
    const it = energyItems(S, P), E = S.D.energi.kolumner, n = S.n;
    const t = new Float64Array(n), kwh = new Float64Array(n), atemp = new Float64Array(n), count = new Float64Array(n), skattadT = new Float64Array(n);
    const cal = calibration(S, P), G = 3, dhG = new Float64Array(G), elG = new Float64Array(G), atG = new Float64Array(G);
    const gOf = i => cal && cal.single ? 0 : it.grp[i];
    const tItem = new Float64Array(it.m), eItem = new Float64Array(it.m);
    for (let i = 0; i < it.m; i++) {
      const e = it.se[i] * it.a[i], s = it.el[i], g = gOf(i);
      eItem[i] = e; tItem[i] = e * (s * P.efEl + (1 - s) * P.efFv) / 1000; dhG[g] += e * (1 - s); elG[g] += e * s; atG[g] += it.a[i];
    }
    const kG = [1, 1, 1];
    if (cal) for (let g = 0; g < G; g++) if (cal.mal[g] && dhG[g] > 0) kG[g] = cal.mal[g] / dhG[g];
    const dh = dhG[0] + dhG[1] + dhG[2];
    let unmapped = 0, unmappedT = 0, dhCal = 0;
    const perKlass = {}; const addK = (key, a, e, ton, dhi) => { const o = perKlass[key] = perKlass[key] || {n: 0, atemp: 0, kwh: 0, t: 0, dh: 0}; o.n++; o.atemp += a; o.kwh += e; o.t += ton; o.dh += dhi; };
    for (let i = 0; i < it.m; i++) {
      const k = kG[gOf(i)], ton = tItem[i] * k, e = eItem[i] * k, a = it.a[i] * k; dhCal += e * (1 - it.el[i]);
      addK((it.stock[i] ? 'skattad_' : 'deklarerad_') + (S.KL[it.kl[i]] || 'okand'), a, e, ton, e * (1 - it.el[i]));
      if (it.stock[i]) { const d = it.deso[i]; t[d] += ton; kwh[d] += e; atemp[d] += a; skattadT[d] += ton; continue; }
      const al = E.alloc[i];
      if (!al.length) { unmapped++; unmappedT += ton; continue; }
      for (const [d, w] of al) { t[d] += ton * w; kwh[d] += e * w; atemp[d] += a * w; count[d] += w; }
    }
    const grupper = cal ? (cal.single ? [{namn: cal.namn[0], mal: cal.mal[0], modell: dh, el: elG[0], atemp: atG[0], k: kG[0]}]
      : [0, 1, 2].map(g => ({namn: cal.namn[g], mal: cal.mal[g], scb: cal.scb[g], modell: dhG[g], el: elG[g], atemp: atG[g], k: kG[g]}))) : null;
    return {t, kwh, atemp, count, skattadT, unmapped, unmappedT, missingBta: it.missing, k: cal && dh > 0 ? dhCal / dh : 1, kG, kalibrering: cal ? cal.lage : 'ingen', grupper,
      dhModell: dh, dhKalibrerad: dhCal, dhMal: cal ? (cal.single ? cal.mal[0] : (S.kal.mal_fjarrvarme_mwh * 1000)) : null, dhGrupp: Array.from(dhG), perKlass, poster: it.m};
  }

  /* Monte Carlo för energi i befintliga byggnader (år 2024). Emissionsfaktorerna hålls fasta (Boverket).
     Returnerar percentiler per DeSO och för Malmö. */
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0; while (u === 0) u = r(); const v = r(), m = Math.sqrt(-2 * Math.log(u)); return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)]; }
  const lnMean1 = (cv, z) => { const s = Math.sqrt(Math.log(1 + cv * cv)); return Math.exp(s * z - s * s / 2); };
  function quant(sorted, p) { const k = (sorted.length - 1) * p, lo = Math.floor(k), hi = Math.min(sorted.length - 1, lo + 1); return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo); }
  async function simulateEnergy(S, pIn, onProgress = () => {}) {
    const P = params(pIn), it = energyItems(S, P), E = S.D.energi.kolumner, n = S.n, N = P.iterationer, r = rng(P.seed);
    const cal = calibration(S, P), G = 3, draws = new Float64Array(N * n);
    const tmp = new Float64Array(G * n), dhG = new Float64Array(G), kfG = new Float64Array(G);
    const gOf = new Int8Array(it.m); for (let i = 0; i < it.m; i++) gOf[i] = cal && cal.single ? 0 : it.grp[i];
    const city = new Float64Array(N), kk = new Float64Array(N);
    const nLv = SIG_LV.length, nK = S.KL.length, TWO_PI = 2 * Math.PI;
    const z = () => gauss(r)[0];
    for (let k = 0; k < N; k++) {
      const mAt = P.atempLage === 'fast' ? lnMean1(UNC.fastAtempSys, z()) : lnMean1(UNC.atempFaktorCv, z());
      const lvB = new Float64Array(nLv); for (let q = 0; q < nLv; q++) lvB[q] = P.atempLage === 'fast' ? 1 : lnMean1(SYS_LV[q], z());
      const seD = lnMean1(UNC.seDeklSys, z()), seK = new Float64Array(nK); for (let q = 0; q < nK; q++) seK[q] = lnMean1(UNC.seKlassSys, z());
      const elShift = UNC.elSys * z(), eps = [1 + P.cvKalibrering * z(), 1 + P.cvKalibrering * z(), 1 + P.cvKalibrering * z()];
      const indLo = Math.max(0, P.industriAndel - UNC.industriSpann), indHi = Math.min(1, P.industriAndel + UNC.industriSpann);
      const indF = P.industriAndel > 0 ? (indLo + (indHi - indLo) * r()) / P.industriAndel : 1;
      const efE = P.efEl, efF = P.efFv; // Boverkets emissionsfaktorer, fasta
      const row = draws.subarray(k * n, (k + 1) * n);
      tmp.fill(0); dhG.fill(0);
      for (let i = 0; i < it.m; i++) {
        let u = r(); while (u === 0) u = r();
        const rad = Math.sqrt(-2 * Math.log(u)), ang = TWO_PI * r(), z1 = rad * Math.cos(ang), z2 = rad * Math.sin(ang);
        const sm = it.sigMag[i], mag = Math.exp(sm * z1 - sm * sm / 2);
        let a = it.a[i] * lvB[it.btak[i]] * mAt; if (it.stock[i] === 1 && it.kl[i] === S.IND) a *= indF;
        const e = a * it.se[i] * (it.stock[i] === 1 ? (seK[it.kl[i]] || 1) : seD) * mag;
        let s = it.el[i] + elShift + it.sigEl[i] * z2; s = s < 0 ? 0 : s > 1 ? 1 : s;
        const ton = e * (s * efE + (1 - s) * efF) / 1000, g = gOf[i], o = g * n; dhG[g] += e * (1 - s);
        if (it.stock[i] === 1) { tmp[o + it.deso[i]] += ton; continue; }
        const al = E.alloc[i];
        for (let q = 0; q < al.length; q++) tmp[o + al[q][0]] += ton * al[q][1];
      }
      let dhSum = 0, dhCal = 0;
      for (let g = 0; g < G; g++) { kfG[g] = cal && cal.mal[g] && dhG[g] > 0 ? cal.mal[g] * eps[g] / dhG[g] : 1; dhSum += dhG[g]; dhCal += dhG[g] * kfG[g]; }
      let tot = 0;
      for (let d = 0; d < n; d++) { let v = 0; for (let g = 0; g < G; g++) v += kfG[g] * tmp[g * n + d]; row[d] = v; tot += v; }
      city[k] = tot; kk[k] = dhSum > 0 ? dhCal / dhSum : 1;
      if (k % 25 === 24) { if (onProgress((k + 1) / N) === false) return null; await new Promise(res => setTimeout(res, 0)); } // false = avbryt
    }
    onProgress(1);
    const stat = arr => { const s = Float64Array.from(arr).sort(); let m = 0; for (const x of s) m += x; return {p025: quant(s, 0.025), p50: quant(s, 0.5), p975: quant(s, 0.975), mean: m / s.length}; };
    const perDeso = src => { const o = {p025: new Float64Array(n), p50: new Float64Array(n), p975: new Float64Array(n), mean: new Float64Array(n)}, col = new Float64Array(N);
      for (let d = 0; d < n; d++) { for (let k = 0; k < N; k++) col[k] = src[k * n + d]; const st = stat(col); o.p025[d] = st.p025; o.p50[d] = st.p50; o.p975[d] = st.p975; o.mean[d] = st.mean; } return o; };
    return {iterationer: N, seed: P.seed, deso: perDeso(draws), city: stat(city), k: stat(kk), cityDraws: Float64Array.from(city),
      nyckel: uncertaintyKey(P), skapad: new Date().toISOString()};
  }
  /* Antaganden som påverkar energins osäkerhetsberäkning (ändras de krävs ny körning). */
  function uncertaintyKey(P) {
    return JSON.stringify(['bestand', 'kalibrering', 'industriAndel', 'efEl', 'efFv', 'atempLage', 'atempFaktor', 'atempFast', 'elLage', 'elFast', 'cvKalibrering', 'iterationer', 'seed'].map(k => P[k]));
  }

  /* Energins årsfaktor relativt 2024 (effektivisering × förändrade emissionsfaktorer); 'ack' = summa 2030–2050. */
  function energyYearFactor(P, ar) {
    const f = y => { const r = ramp(y); return (1 - P.effektivisering2050 / 100 * r) * (1 + P.efForandring2050 / 100 * r); };
    if (ar === 'ack') { let s = 0; for (let y = ACK[0]; y <= ACK[1]; y++) s += f(y); return s; }
    return f(Number(ar));
  }
  /* 95-procentsintervall för energi i befintliga byggnader för valt år. Årsfaktorn är deterministisk och lika för alla
     poster, så percentilerna skalas exakt. Felen antas bestå över åren (samma dragning alla år). */
  function energyInterval(U, P, ar) {
    if (!U) return null;
    const f = energyYearFactor(P, ar), sc = o => ({p025: o.p025 * f, p50: o.p50 * f, p975: o.p975 * f, mean: o.mean * f});
    const d = U.deso;
    return {f, city: sc(U.city), lo: i => d.p025[i] * f, mid: i => d.p50[i] * f, hi: i => d.p975[i] * f};
  }

  /* Huvudberäkning. Returnerar årsvärden per DeSO och komponent för 2024–2050. */
  function compute(S, pIn) {
    const P = params(pIn), n = S.n, mob = S.D.mob;
    const bKey = P.bLage === 'gtfs' ? 'B_gtfs' : 'B_local';
    const years = []; for (let y = BASE_YEAR; y <= END_YEAR; y++) years.push(y);
    const eb = energyBase(S, P);
    const A0 = S.ids.map(id => mob.A[id] ? mob.A[id].total : 0), B0 = S.ids.map(id => mob[bKey][id] ? mob[bKey][id].total : 0);
    const cityAvkm = mob.stad.A.vkm;
    const perDeso = {cph: new Float64Array(n), km: new Float64Array(n), epv: new Float64Array(n)};
    for (let i = 0; i < n; i++) {
      const h = S.hh[i], b = mob[bKey][S.ids[i]];
      perDeso.cph[i] = h.hh > 0 && h.bil > 0 ? h.bil / h.hh : S.cityCph;
      perDeso.km[i] = b && b.cars > 0 && b.vkm > 0 ? b.vkm / b.cars : S.cityKm;
      perDeso.epv[i] = b && b.vkm > 0 ? b.total / b.vkm : S.cityEpv;
    }
    const kol = {aker: P.kolAker, oppen: P.kolOppen, skog: P.kolSkog, vatten: 0, bebyggd: P.kolBebyggd};
    // förbered områden
    const areas = S.areas.map(a => {
      const [s, e] = a.fokus === 1 ? [P.f1Start, P.f1Slut] : [P.f2Start, P.f2Slut];
      const lokTyp = a.kategori === 'Verksamhetsområde' ? 'hall' : 'lokal';
      const bta = {bostad: a.bostader * P.btaBostad,
        [lokTyp]: a.arbetsplatser * (lokTyp === 'hall' ? P.btaArbVerks : P.btaArbBlandad),
        skola: (a.forskola + a.grundskola + a.gymnasie) * P.btaSkolplats};
      const btaSum = Object.values(bta).reduce((x, y) => x + y, 0);
      const delar = a.delar.map(d => {
        const m = {...d.mark}; const ok = m.okand || 0; delete m.okand; m[P.markOkand] = (m[P.markOkand] || 0) + ok;
        let luc = 0; for (const [k, ha] of Object.entries(m)) luc += ha * P.hardgorandel * Math.max(0, (kol[k] || 0) - kol.bebyggd) * C_TO_CO2;
        return {i: d.i, w: d.andel, ha: d.ha, luc, mark: m};
      });
      return {a, s, e, bta, btaSum, delar, luc: delar.reduce((x, d) => x + d.luc, 0)};
    });
    const comp = {}; for (const c of COMPONENTS) comp[c] = years.map(() => new Float64Array(n));
    const pop = years.map(() => new Float64Array(n)), newPop = years.map(() => new Float64Array(n));
    const areaRes = areas.map(x => ({id: x.a.id, namn: x.a.namn, bygg: 0, mark: 0, nydrift2050: 0, nymob2050: 0, btaSum: x.btaSum, s: x.s, e: x.e}));
    years.forEach((y, yi) => {
      const f = ramp(y), fl = fleet(P, y), tr = 1 + P.trafikForandring2050 / 100 * f;
      const efScale = 1 + P.efForandring2050 / 100 * f, effScale = 1 - P.effektivisering2050 / 100 * f;
      const efMixNy = (P.elandelNy * P.efEl + (1 - P.elandelNy) * P.efFv) * efScale;
      let newVkmCity = 0;
      const nymobB = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        comp.energi[yi][i] = eb.t[i] * effScale * efScale;
        comp.mobilitet[yi][i] = (P.perspektiv === 'A' ? A0[i] : B0[i]) * fl * tr;
        pop[yi][i] = S.hh[i].bef;
      }
      if (P.exploatering) areas.forEach((x, k) => {
        const dur = x.e - x.s, build = (y >= x.s && y < x.e) ? 1 / dur : 0, done = clamp01((y - x.s) / dur);
        for (const d of x.delar) {
          let bygg = 0; for (const [typ, m2] of Object.entries(x.bta)) bygg += m2 * byggFaktor(P, typ, y) / 1000;
          comp.bygg[yi][d.i] += d.w * build * bygg;
          comp.mark[yi][d.i] += build * d.luc;
          const drift = d.w * done * x.btaSum * P.atempNy * P.energiNy * efMixNy / 1000;
          comp.nydrift[yi][d.i] += drift;
          const hhNew = x.a.bostader * d.w * done, vkm = hhNew * perDeso.cph[d.i] * P.bilFaktor * perDeso.km[d.i];
          nymobB[d.i] += vkm * perDeso.epv[d.i] * fl;
          newVkmCity += vkm;
          newPop[yi][d.i] += hhNew * P.personerPerBostad;
          pop[yi][d.i] += hhNew * P.personerPerBostad;
          if (y >= 2030 && y <= 2050) { areaRes[k].bygg += d.w * build * bygg; areaRes[k].mark += build * d.luc; }
          if (y === 2050) { areaRes[k].nydrift2050 += drift; areaRes[k].nymob2050 += vkm * perDeso.epv[d.i] * fl; }
        }
      });
      if (P.perspektiv === 'B') comp.nymob[yi].set(nymobB);
      else if (newVkmCity > 0) { const g = P.andelKmInomMalmo * newVkmCity / cityAvkm; for (let i = 0; i < n; i++) comp.nymob[yi][i] = A0[i] * fl * tr * g; }
    });
    return {P, years, comp, pop, newPop, areas: areaRes, energyBase: eb, perDeso, bKey};
  }

  /* Hämta värden för valt år ('ack' = summa 2030–2050) som objekt per DeSO. */
  function view(S, R, ar) {
    const n = S.n, sel = ar === 'ack' ? R.years.map((y, i) => [y, i]).filter(([y]) => y >= ACK[0] && y <= ACK[1]).map(x => x[1]) : [R.years.indexOf(Number(ar))];
    if (sel.some(i => i < 0)) throw new Error('Okänt år: ' + ar);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = {id: S.ids[i], i, land_ha: S.landHa[i]};
      let tot = 0;
      for (const c of COMPONENTS) { let v = 0; for (const yi of sel) v += R.comp[c][yi][i]; r[c] = v; tot += v; }
      r.total = tot; r.exploatering = r.bygg + r.mark + r.nydrift + r.nymob;
      const yi = sel[sel.length - 1]; r.bef = R.pop[yi][i]; r.nyaInv = R.newPop[yi][i];
      rows.push(r);
    }
    const city = {land_ha: rows.reduce((s, r) => s + r.land_ha, 0), bef: rows.reduce((s, r) => s + r.bef, 0), nyaInv: rows.reduce((s, r) => s + r.nyaInv, 0)};
    for (const c of [...COMPONENTS, 'total', 'exploatering']) city[c] = rows.reduce((s, r) => s + r[c], 0);
    return {rows, city, years: sel.length};
  }

  function cityByYear(R) {
    return R.years.map((y, yi) => { const o = {year: y}; for (const c of COMPONENTS) o[c] = R.comp[c][yi].reduce((a, b) => a + b, 0); o.total = COMPONENTS.reduce((s, c) => s + o[c], 0); o.bef = R.pop[yi].reduce((a, b) => a + b, 0); return o; });
  }

  function metric(row, key, unit) {
    const v = key === 'total' ? row.total : row[key];
    if (v == null) return null;
    if (unit === 't') return v;
    if (unit === 't_ha') return row.land_ha > 0 ? v / row.land_ha : null;
    if (unit === 'kg_ha') return row.land_ha > 0 ? v * 1000 / row.land_ha : null;
    if (unit === 't_inv') return row.bef > 0 ? v / row.bef : null;
    throw new Error('Okänd enhet');
  }

  return {VERSION, BASE_YEAR, END_YEAR, YEARS, ACK, COMPONENTS, LABELS, SHORT, DEFAULTS, LIMITS, ENUMS, BYGG, P75_PROXY, SIG_LV, SYS_LV, UNC,
    params, prepare, compute, view, cityByYear, metric, fleet, byggFaktor, energyBase, energyItems, simulateEnergy, uncertaintyKey, ramp,
    calibration, GROUP_NAMES, energyYearFactor, energyInterval};
});
