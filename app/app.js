/* MalmoOP 1.1 – gränssnitt. Samma struktur och stil som Vägvis 2.3.1. */
(function () {
'use strict';
const M = window.MalmoOP, $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const nf = (x, d = 0) => x == null || !Number.isFinite(x) ? '–' : new Intl.NumberFormat('sv-SE', {maximumFractionDigits: d, minimumFractionDigits: d}).format(x);
const sig = x => { if (x == null || !Number.isFinite(x)) return '–'; const a = Math.abs(x); return nf(x, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3); };
const json = id => JSON.parse($(id).textContent);
const D = {deso: json('d-deso'), land: json('d-land'), energi: json('d-energi'), mob: json('d-mob'), expl: json('d-expl'), meta: json('d-meta')};
const S = M.prepare(D);
const COLORS = {energi: '#1baf7a', mobilitet: '#2a78d6', bygg: '#eb6834', mark: '#6250d6', nydrift: '#eda100', nymob: '#e87ba4'};
const STORE = 'malmoop-1-antaganden';
const store = {get() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* lagring ej tillgänglig */ } }};
let P = M.params(store.get() || {});
let R = M.compute(S, P);
const st = {view: 'overview', metric: 'total', unit: 't', selected: null, osm: true, dev: true, sort: ['total', -1], filter: '', explSort: ['bygg', -1]};
const props = Object.fromEntries(D.deso.features.map(f => [f.properties.id, f.properties]));
const areaName = id => { const p = props[id]; return p ? (p.regsoName || p.name) : id; };
const yearLabel = y => y === 'ack' ? '2030–2050' : String(y);
const isAck = () => P.ar === 'ack';
const METRICS = [['total', 'Totalt klimatavtryck'], ['energi', 'Energi i befintliga byggnader'], ['mobilitet', 'Mobilitet i befintlig stad'], ['exploatering', 'Exploatering, summa'], ['bygg', 'Nybyggnation (A1–A5)'], ['mark', 'Förändrad markanvändning'], ['nydrift', 'Nya byggnaders energi'], ['nymob', 'Nya invånares mobilitet']];
const KLN = {smahus: 'Småhus', flerbostadshus: 'Flerbostadshus', lokal: 'Lokal', industri: 'Industri/lager', okand: 'Okänd'};
const GRUNDN = {typ: 'OSM-byggnadstyp', markanvandning: 'Markanvändning runt byggnaden', kvarter: 'Sammanbyggd i flerbostadskvarter', storlek: 'Storlek', liten_yta: 'Liten yta'};
const SEKN = {median_deso: 'Median, samma typ i DeSO', median_regso: 'Median, samma typ i RegSO', median_malmo: 'Median, samma typ i Malmö', median_alla: 'Median, alla deklarationer'};
const unitLabel = u => isAck()
  ? ({t: 't CO₂e 2030–2050', t_ha: 't CO₂e per ha, 2030–2050', kg_ha: 'kg CO₂e per ha, 2030–2050', t_inv: 't CO₂e per invånare, 2030–2050'}[u])
  : ({t: 't CO₂e per år', t_ha: 't CO₂e per ha och år', kg_ha: 'kg CO₂e per ha och år', t_inv: 't CO₂e per invånare och år'}[u]);
const mobLabel = () => P.perspektiv === 'A' ? 'A · Trafik inom området' : 'B · Hushållens bilar';
const changed = () => Object.keys(M.DEFAULTS).some(k => k !== 'ar' && k !== 'perspektiv' && P[k] !== M.DEFAULTS[k]);

function setP(patch) { P = M.params({...P, ...patch}); R = M.compute(S, P); store.set(P); renderChrome(); render(); uMaybeSchedule(); }
function cur() { return M.view(S, R, P.ar); }
const kt = t => nf(t / 1000, t >= 1e6 ? 0 : 1);

/* ---------- osäkerhet: Monte Carlo för energi i befintliga byggnader ---------- */
let U = null, uBusy = false, uProg = 0, uTok = 0, uRunKey = null, uTimer = null, uErr = null;
const uFresh = () => !!U && U.nyckel === M.uncertaintyKey(P);
const EI = () => uFresh() ? M.energyInterval(U, P, P.ar) : null;
function uMaybeSchedule(delay = 700) {
  const key = M.uncertaintyKey(P);
  if ((U && U.nyckel === key) || (uBusy && uRunKey === key)) return;
  clearTimeout(uTimer); uTimer = setTimeout(runUncertainty, delay);
}
async function runUncertainty() {
  clearTimeout(uTimer);
  const key = M.uncertaintyKey(P); if (U && U.nyckel === key) return;
  const tok = ++uTok; uBusy = true; uRunKey = key; uProg = 0; uErr = null; uStatusUpdate();
  try {
    const res = await M.simulateEnergy(S, P, p => { if (tok !== uTok) return false; uProg = p; uStatusUpdate(); });
    if (tok === uTok && res) U = res;
  } catch (e) { if (tok === uTok) uErr = String((e && e.message) || e); }
  finally { if (tok === uTok) { uBusy = false; uRunKey = null; uAfter(); } }
}
function uStatusHtml() {
  if (uBusy) return '<div class="u-run"><div class="progress"><div style="width:' + (100 * uProg).toFixed(1) + '%"></div></div><p class="small">Monte Carlo pågår · ' + nf(P.iterationer) + ' iterationer · ' + nf(100 * uProg) + ' %</p></div>';
  if (uErr) return notice('Osäkerhetsberäkningen misslyckades: ' + esc(uErr), 'error');
  if (uFresh()) return '<p class="small u-done">Beräknad med ' + nf(U.iterationer) + ' iterationer (seed ' + U.seed + '). Intervallen gäller de antaganden som är valda nu.</p>';
  return '<div class="u-stale">' + (U ? '<span class="small">Antagandena har ändrats sedan osäkerheten beräknades.</span>' : '<span class="small">Osäkerheten är inte beräknad ännu.</span>') + '<button class="primary small-btn" data-u-run>Beräkna osäkerhet <span>↗</span></button></div>';
}
function uStatusUpdate() { document.querySelectorAll('[data-u-status]').forEach(el => { el.innerHTML = uStatusHtml(); }); }
function uAfter() {
  if (st.view === 'map') { detail(); table(); uStatusUpdate(); }
  else if (st.view === 'parameters') uStatusUpdate();
  else render();
}
const ivTxt = (lo, hi, fmt = nf) => fmt(lo) + '–' + fmt(hi);
const pct = x => (x >= 0 ? '+' : '−') + nf(Math.abs(100 * x)) + ' %';
const ivPending = () => uBusy ? 'beräknas …' : 'ej beräknad';
/* Intervall för energi i en DeSO, i valfri enhet */
function energyIvUnit(r, unit) {
  const I = EI(); if (!I) return null;
  const c = unit === 't' ? 1 : unit === 't_ha' ? (r.land_ha > 0 ? 1 / r.land_ha : null) : unit === 'kg_ha' ? (r.land_ha > 0 ? 1000 / r.land_ha : null) : (r.bef > 0 ? 1 / r.bef : null);
  return c == null ? null : [I.lo(r.i) * c, I.hi(r.i) * c];
}
/* Kalibreringsfaktor för en post med byggnadsklass kl */
const kFor = kl => { const eb = R.energyBase; return eb.kalibrering === 'total' ? eb.kG[0] : eb.kG[S.GRP[kl] ?? 2]; };
const stockCount = new Float64Array(S.n); if (D.energi.bestand) D.energi.bestand.deso.forEach(d => { stockCount[d]++; });

/* ---------- ram: sidomeny, rubrik, år ---------- */
const HEAD = {
  overview: ['MALMOOP 1.1 · ÖVERSIKT', 'Malmö växer.<br><em>Hela klimatavtrycket.</em>', 'Årligt klimatavtryck per DeSO från energi i befintliga byggnader, mobilitet och utbyggnaden enligt ÖP 2023.'],
  map: ['DESO 2025 · 209 OMRÅDEN', 'Karta & DeSO', 'Utforska områdena. Välj nyckeltal, enhet och år; klicka på ett område för detaljer.'],
  calc: ['STEG FÖR STEG', 'Så räknas resultatet', 'Följ beräkningen för ett område, från energideklaration och trafik till nybyggnation och mark.'],
  parameters: ['ANTAGANDEN', 'Antaganden & scenario', 'Alla värden kan ändras. Beräkningen uppdateras direkt och sparas i din webbläsare.'],
  expl: ['ÖP 2023 · 36 UTBYGGNADSOMRÅDEN', 'Exploatering 2030–2050', 'Tillkommande BTA, nybyggnation, förändrad markanvändning och det som följer med nya invånare.'],
  data: ['UNDERLAG', 'Data & kvalitet', 'Urval, adresskoppling, hela byggnadsbeståndet, kontroll mot SCB, skattad Atemp och energibärare.'],
  method: ['METOD', 'Metod & källor', 'Formler, systemgränser, antaganden och referenser (Harvard).']
};
function renderChrome() {
  document.querySelectorAll('.model-switch button').forEach(b => b.classList.toggle('active', b.dataset.model === P.perspektiv));
  document.querySelectorAll('nav .nav').forEach(b => b.classList.toggle('active', b.dataset.view === st.view));
  $('active-model-label').textContent = (P.perspektiv === 'A' ? 'A · TRAFIK INOM OMRÅDET' : 'B · HUSHÅLLENS BILAR');
  $('year-switch').innerHTML = [...M.YEARS, 'ack'].map(y => '<button data-year="' + y + '" class="' + (String(P.ar) === String(y) ? 'active' : '') + '">' + (y === 'ack' ? 'Σ 2030–50' : y) + '</button>').join('');
  const ch = changed(); $('data-status').textContent = ch ? 'Egna antaganden' : 'Grundantaganden'; $('data-status').className = 'pill' + (ch ? ' amber' : '');
  const [eb, t, d] = HEAD[st.view]; $('eyebrow').textContent = eb; $('page-title').innerHTML = t; $('page-description').textContent = d;
  $('primary-action').innerHTML = st.view === 'map' ? 'Så räknas området <span>↗</span>' : 'Utforska kartan <span>↗</span>';
  $('scope-footer').textContent = 'Mobilitet: ' + mobLabel() + ' · Boverkets emissionsfaktorer för el och fjärrvärme';
}

/* ---------- gemensamma byggstenar ---------- */
function notice(html, cls = '') { return '<div class="notice ' + cls + '">' + html + '</div>'; }
function partsCard(row, title, sub) {
  const total = row.total || 0, max = Math.max(1, ...M.COMPONENTS.map(c => row[c]));
  return '<article class="card parts"><h2>' + title + '</h2><p class="card-sub">' + sub + '</p>' + M.COMPONENTS.map(c =>
    '<div class="component-row"><span class="lbl"><i class="sw" style="background:' + COLORS[c] + '"></i>' + esc(M.SHORT[c]) + '</span><div class="track"><div class="fill" style="width:' + (100 * row[c] / max).toFixed(2) + '%;background:' + COLORS[c] + '"></div></div><b class="numeric">' + nf(row[c]) + ' t</b></div>').join('') +
    '<div class="component-total"><span>Summa</span><span>' + nf(total) + ' t CO₂e' + (isAck() ? '' : ' per år') + '</span></div>' +
    (row.i == null ? '<p class="small u-line"><i class="sw" style="background:' + COLORS.energi + '"></i>Energi i befintliga byggnader, 95 %-intervall: <b>' + (EI() ? ivTxt(EI().city.p025, EI().city.p975) + ' t' : ivPending()) + '</b></p>' : '') +
    '<p class="small">Mobilitet visas enligt ' + esc(mobLabel()) + '. Nya invånares mobilitet ' + (P.perspektiv === 'A' ? 'fördelas över vägnätet i proportion till trafiken (A).' : 'räknas i den DeSO där bostäderna byggs (B).') + '</p></article>';
}
const charts = [];
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
function stackChart(id, rows, comps, opts = {}) {
  charts.push({id, rows, comps, opts});
  return '<div class="chart-wrap" id="' + id + '" role="img" aria-label="' + esc(opts.aria || 'Stapeldiagram') + '"></div>' +
    '<div class="chart-legend">' + comps.map(c => '<span><i style="background:' + COLORS[c] + '"></i>' + esc(M.SHORT[c]) + (opts.legendRow ? ' <b>' + nf(opts.legendRow[c]) + ' t</b>' : '') + '</span>').join('') + '</div>';
}
function drawCharts() { for (const c of charts) if (c.draw) c.draw(); else drawChart(c); }
/* Histogram över Monte Carlo-dragningarna för hela Malmö, med 95 %-intervall för alla källor och för aktivitetsdata */
function drawHist(id, I, det) {
  const wrap = $(id); if (!wrap || !U) return;
  const W = Math.max(280, wrap.clientWidth), H = 250, L = 10, Rm = 14, T = 12, B = 96;
  const v = Array.from(U.cityDraws, x => x * I.f / 1000).sort((a, b) => a - b), d = det / 1000;
  const vmin = Math.min(v[0], I.cityAktivitet.p025 / 1000, d), vmax = Math.max(v[v.length - 1], d);
  const stepV = niceStep((vmax - vmin) / 5), x0 = Math.floor(vmin / stepV) * stepV, x1 = Math.ceil(vmax / stepV) * stepV;
  const nb = Math.max(16, Math.min(40, Math.round((W - L - Rm) / 14))), bw = (x1 - x0) / nb, cnt = new Array(nb).fill(0);
  for (const x of v) cnt[Math.min(nb - 1, Math.max(0, Math.floor((x - x0) / bw)))]++;
  const cmax = Math.max(...cnt), X = t => L + (W - L - Rm) * (t - x0) / (x1 - x0), yb = H - B, Y = c => yb - (yb - T) * c / cmax;
  let g = '';
  for (let t = x0; t <= x1 + 1e-9; t += stepV) g += '<line class="gridline" x1="' + X(t) + '" x2="' + X(t) + '" y1="' + T + '" y2="' + yb + '"/><text class="axis-label" x="' + X(t) + '" y="' + (yb + 15) + '" text-anchor="middle">' + nf(t, stepV < 1 ? 1 : 0) + '</text>';
  cnt.forEach((c, k) => { if (c) g += '<rect x="' + (X(x0 + k * bw) + 1) + '" y="' + Y(c) + '" width="' + Math.max(1, X(x0 + bw) - X(x0) - 2) + '" height="' + (yb - Y(c)) + '" rx="1.5" fill="' + COLORS.energi + '" opacity=".85"/>'; });
  g += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + yb + '" y2="' + yb + '" stroke="#9fb3aa"/>';
  const vline = (t, dash, lbl, anchor) => '<line x1="' + X(t) + '" x2="' + X(t) + '" y1="' + (T - 4) + '" y2="' + yb + '" stroke="#103c38" stroke-width="' + (dash ? 1 : 1.6) + '"' + (dash ? ' stroke-dasharray="3 3"' : '') + '/>' + (lbl ? '<text class="axis-label" x="' + (X(t) + (anchor === 'end' ? -4 : 4)) + '" y="' + (T + 6) + '" text-anchor="' + anchor + '">' + lbl + '</text>' : '');
  g += vline(I.city.p025 / 1000, true, '2,5 %', 'end') + vline(I.city.p975 / 1000, true, '97,5 %', 'start') + vline(d, false, '', 'start');
  const strip = (y, lo, hi, col, txt) => '<text class="axis-label" x="' + L + '" y="' + (y - 7) + '">' + txt + '</text><line x1="' + X(lo / 1000) + '" x2="' + X(hi / 1000) + '" y1="' + y + '" y2="' + y + '" stroke="' + col + '" stroke-width="6" stroke-linecap="round"/><circle cx="' + X(d) + '" cy="' + y + '" r="4.5" fill="#fff" stroke="#103c38" stroke-width="1.6"/>';
  g += '<text class="axis-label" x="' + (W - Rm) + '" y="' + (yb + 15) + '" text-anchor="end" dx="0" dy="12">kt CO₂e</text>';
  g += strip(yb + 50, I.city.p025, I.city.p975, COLORS.energi, 'Alla osäkerhetskällor · ' + kt(I.city.p025) + '–' + kt(I.city.p975) + ' kt');
  g += strip(yb + 84, I.cityAktivitet.p025, I.cityAktivitet.p975, '#7fcaa9', 'Emissionsfaktorerna fasta (bara aktivitetsdata) · ' + kt(I.cityAktivitet.p025) + '–' + kt(I.cityAktivitet.p975) + ' kt');
  wrap.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg>';
}
function drawChart({id, rows, comps, opts}) {
  const wrap = $(id); if (!wrap) return;
  const W = Math.max(280, wrap.clientWidth), H = opts.h || 260, L = 44, Rm = 6, T = 22, B = 26, n = rows.length;
  const tot = rows.map(r => comps.reduce((s, c) => s + r[c], 0)), max = Math.max(1, ...tot);
  const stepV = niceStep(max / 4), top = Math.ceil(max / stepV) * stepV;
  const y = v => T + (H - T - B) * (1 - v / top), slot = (W - L - Rm) / n, bw = Math.max(6, Math.min(44, slot * 0.62)), x = i => L + slot * (i + 0.5);
  const every = Math.max(1, Math.ceil(34 / slot));
  let g = '<text class="axis-label" x="' + (L - 6) + '" y="' + (T - 10) + '" text-anchor="end">kt</text>';
  for (let v = 0; v <= top + 1e-9; v += stepV) g += '<line class="gridline" x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="axis-label" x="' + (L - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + nf(v / 1000, stepV < 1000 ? 1 : 0) + '</text>';
  rows.forEach((r, i) => {
    let acc = 0, segs = '';
    const live = comps.filter(c => r[c] > 0);
    live.forEach((c, j) => {
      const yy = y(acc + r[c]), hh = Math.max(0, y(acc) - yy - (j > 0 ? 2 : 0)), x0 = x(i) - bw / 2, x1 = x(i) + bw / 2, rr = Math.min(4, hh, bw / 2);
      segs += j === live.length - 1 && hh > 1 ? '<path d="M' + x0 + ',' + (yy + hh) + 'V' + (yy + rr) + 'Q' + x0 + ',' + yy + ' ' + (x0 + rr) + ',' + yy + 'H' + (x1 - rr) + 'Q' + x1 + ',' + yy + ' ' + x1 + ',' + (yy + rr) + 'V' + (yy + hh) + 'Z" fill="' + COLORS[c] + '"/>'
        : '<rect x="' + x0 + '" y="' + yy + '" width="' + bw + '" height="' + hh + '" fill="' + COLORS[c] + '"/>';
      acc += r[c];
    });
    const sel = opts.sel != null && String(opts.sel) === String(r.key ?? r.year);
    g += '<g class="bar' + (sel ? ' sel' : '') + '" data-i="' + i + '">' + segs + '</g><rect class="bar-hit" data-i="' + i + '" x="' + (x(i) - slot / 2) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B + 4) + '"/>';
    if (i % every === 0 || i === n - 1 || sel) g += '<text class="x-label' + (sel ? ' sel' : '') + '" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(r.label ?? r.year) + '</text>';
  });
  wrap.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg><div class="chart-tip"></div>';
  bindChart(id, rows, comps, opts.onClick);
}
window.addEventListener('resize', () => { clearTimeout(window.__mr); window.__mr = setTimeout(drawCharts, 120); });
function bindChart(id, rows, comps, onClick) {
  const wrap = $(id); if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  wrap.querySelectorAll('.bar-hit').forEach(h => {
    const r = rows[+h.dataset.i];
    h.addEventListener('mousemove', e => {
      const tot = comps.reduce((s, c) => s + r[c], 0);
      tip.innerHTML = '<b>' + esc(r.tipTitle || r.label || r.year) + '</b>' + comps.slice().reverse().map(c => '<div><span><i style="background:' + COLORS[c] + '"></i>' + esc(M.SHORT[c]) + '</span><span>' + nf(r[c]) + ' t</span></div>').join('') + '<div class="tip-total"><span>Summa</span><span>' + nf(tot) + ' t</span></div>';
      tip.style.display = 'block';
      const b = wrap.getBoundingClientRect(); let lx = e.clientX - b.left + 14; if (lx + 230 > b.width) lx = e.clientX - b.left - 240;
      tip.style.left = lx + 'px'; tip.style.top = Math.max(0, e.clientY - b.top - 40) + 'px';
      wrap.querySelectorAll('g.bar').forEach(g => g.classList.toggle('hover', g.dataset.i === h.dataset.i));
    });
    h.addEventListener('mouseleave', () => { tip.style.display = 'none'; wrap.querySelectorAll('g.bar').forEach(g => g.classList.remove('hover')); });
    if (onClick) h.addEventListener('click', () => onClick(r));
  });
}

/* ---------- 01 Översikt ---------- */
function overview() {
  const v = cur(), c = v.city, byYear = M.cityByYear(R), base = byYear.find(r => r.year === 2024);
  const sel = isAck() ? null : byYear.find(r => r.year === P.ar);
  const delta = sel ? (sel.total - base.total) / base.total : null;
  const chartRows = byYear.filter(r => M.YEARS.includes(r.year));
  const q = D.energi.urval, meta = D.meta;
  const bs = q.bestand && q.bestand.sammanfattning, eb = R.energyBase;
  let h = notice('<strong>Screening för översiktlig planering:</strong> Energi i befintliga byggnader bygger på ' + nf(q.beraknade_deklarationer) + ' energideklarationer, kopplade till DeSO via Malmö stads adresstjänst' +
    (P.bestand === 'hela' && bs ? ', och på ' + nf(stockCount.reduce((a, b) => a + b, 0)) + ' byggnader utan deklaration vars energi skattas från deklarerade byggnader av samma typ' : '') + '. Atemp och energibärare saknas i underlaget och <em>skattas</em>' +
    (eb.kalibrering !== 'ingen' ? '; ytorna kalibreras mot SCB:s fjärrvärmestatistik 2024' : '') + ' (se Data & kvalitet). Mobilitet kommer från Vägvis 2.3.1. Exploateringen följer ÖP 2023:s utbyggnadsområden med Fokus 1 byggt ' + P.f1Start + '–' + (P.f1Slut - 1) + ' och Fokus 2 ' + P.f2Start + '–' + (P.f2Slut - 1) + '.', 'info');
  h += '<section class="kpis four"><article class="card kpi-main"><div class="kpi-label">Klimatavtryck · ' + yearLabel(P.ar) + '</div><div class="kpi-value">' + kt(c.total) + ' <span class="unit">kt CO₂e' + (isAck() ? '' : ' per år') + '</span></div><div class="kpi-foot">Energi i befintliga byggnader, mobilitet (' + esc(mobLabel()) + ') och exploatering enligt ÖP 2023' + (delta != null && P.ar !== 2024 ? ' · <span class="' + (delta > 0 ? 'delta-up' : 'delta-down') + '">' + (delta > 0 ? '+' : '') + nf(delta * 100, 1) + ' % mot 2024</span>' : '') + '</div></article>' +
    '<article class="card"><div class="kpi-label">Per invånare</div><div class="kpi-value">' + nf(c.total / c.bef / (isAck() ? 21 : 1), 2) + ' <span class="unit">t CO₂e/år</span></div><div class="kpi-foot">' + nf(c.bef) + ' invånare' + (c.nyaInv > 0 ? ', varav ' + nf(c.nyaInv) + ' i nya bostäder' : '') + (isAck() ? ' (2050). Medel över 21 år.' : '') + '</div></article>' +
    '<article class="card"><div class="kpi-label">Per hektar</div><div class="kpi-value">' + nf(c.total / c.land_ha / (isAck() ? 21 : 1), 1) + ' <span class="unit">t CO₂e/ha·år</span></div><div class="kpi-foot">' + nf(c.land_ha) + ' ha land, havsytor ej medräknade</div></article>' +
    '<article class="card"><div class="kpi-label">Exploateringens del</div><div class="kpi-value">' + kt(c.exploatering) + ' <span class="unit">kt</span></div><div class="kpi-foot">' + nf(100 * c.exploatering / Math.max(1, c.total), 1) + ' % av summan · nybyggnation, mark, nya byggnaders energi och mobilitet</div></article></section>';
  h += '<section class="grid2">' + partsCard(c, 'Klimatavtryckets delar · ' + yearLabel(P.ar), isAck() ? 'Summa för åren 2030–2050, ton CO₂e.' : 'Ton CO₂e under kalenderåret. Hela Malmö, summa av 209 DeSO.') +
    '<article class="card"><h2>Utveckling 2024–2050</h2><p class="card-sub">Hela Malmö, kt CO₂e per år. Klicka på en stapel för att välja år.</p>' + stackChart('chart-years', chartRows.map(r => ({...r, key: r.year, tipTitle: 'Malmö ' + r.year})), M.COMPONENTS, {sel: P.ar, aria: 'Klimatavtryck per år och komponent', legendRow: sel || null, onClick: r => setP({ar: r.year})}) + '</article></section>';
  h += uncertaintyCard();
  h += '<article class="card"><h2>Underlag och täckning</h2><p class="card-sub">Hur stor del av underlaget som faktiskt ligger på kartan.</p><div class="coverage">' +
    '<div class="stat"><b>' + nf(q.kartlagda) + '</b><span>av ' + nf(q.beraknade_deklarationer) + ' beräkningsbara energideklarationer kartlagda (' + nf(100 * q.kartlagda / q.beraknade_deklarationer, 1) + ' %)' + (P.bestand === 'hela' && bs ? ' · ' + nf(stockCount.reduce((a, b) => a + b, 0)) + ' odeklarerade byggnader skattade' : ' · odeklarerade byggnader ingår inte') + '</span></div>' +
    '<div class="stat"><b>' + nf(meta.adresskoppling.godkanda) + '</b><span>av ' + nf(meta.adresskoppling.totalt) + ' adresser kopplade till DeSO via Malmö stads adresstjänst</span></div>' +
    '<div class="stat"><b>' + nf(D.expl.omraden.length) + '</b><span>utbyggnadsområden i ÖP 2023 · ' + nf(D.expl.omraden.reduce((s, a) => s + a.bostader, 0)) + ' bostäder, ' + nf(D.expl.omraden.reduce((s, a) => s + a.arbetsplatser, 0)) + ' arbetsplatser</span></div>' +
    '<div class="stat"><b>209</b><span>DeSO 2025 (SCB) · ' + nf(v.city.land_ha) + ' ha land</span></div></div>' +
    '<p class="summaryline">Summorna är <strong>inte</strong> en fullständig inventering av Malmös utsläpp. ' + (P.bestand === 'hela' ? 'Byggnader utan energideklaration ingår som skattningar. ' : 'Byggnader utan energideklaration (främst många småhus) ingår inte i valt läge. ') + 'Industriprocesser, sjöfart, flyg och konsumtion ingår inte. Mobilitet A och B är olika perspektiv och adderas aldrig till varandra.</p>' +
    '<div class="button-row"><button class="secondary" data-view="map">Utforska DeSO på kartan →</button><button class="secondary" data-view="parameters">Ändra antaganden →</button><button class="secondary" data-view="data">Se datakvalitet →</button></div></article>';
  return h;
}

function uncertaintyCard() {
  const I = EI(), det = cur().city.energi, eb = R.energyBase;
  const fact = (dt, dd, sm) => '<div><dt>' + dt + '</dt><dd>' + dd + '<small>' + sm + '</small></dd></div>';
  let h = '<article class="card u-card"><div class="row wrap u-head"><div><h2>Osäkerhet · energi i befintliga byggnader</h2><p class="card-sub">Monte Carlo för hela Malmö, ' + esc(yearLabel(P.ar)) + '. Atemp, energiprestanda, elandel, kalibreringsmål och emissionsfaktorer varieras samtidigt, både som gemensamma (systematiska) fel och som slumpfel per byggnad.</p></div></div>';
  h += '<div data-u-status>' + uStatusHtml() + '</div>';
  if (I) {
    const kTxt = eb.kalibrering === 'ingen' ? 'ingen kalibrering' : nf(U.k.p50, 2) + '<small>95 %: ' + nf(U.k.p025, 2) + '–' + nf(U.k.p975, 2) + ' · Atemp skalas så att fjärrvärmen möter SCB</small>';
    h += '<div class="u-grid"><dl class="u-facts">' +
      fact('Beräknat värde', kt(det) + ' kt CO₂e', isAck() ? 'summa 2030–2050' : 'per år') +
      fact('95 %-intervall', kt(I.city.p025) + '–' + kt(I.city.p975) + ' kt', 'median ' + kt(I.city.p50) + ' kt · ' + pct(I.city.p025 / det - 1) + ' / ' + pct(I.city.p975 / det - 1) + ' mot beräknat värde') +
      fact('Emissionsfaktorerna fasta', kt(I.cityAktivitet.p025) + '–' + kt(I.cityAktivitet.p975) + ' kt', 'bara aktivitetsdata: Atemp, energiprestanda, elandel och kalibrering') +
      '<div><dt>Kalibreringsfaktor (vägd)</dt><dd>' + kTxt + '</dd></div></dl>' +
      '<div class="chart-wrap" id="u-hist" role="img" aria-label="Fördelning av energins klimatavtryck i ' + nf(U.iterationer) + ' Monte Carlo-dragningar"></div></div>';
    charts.push({id: 'u-hist', draw: () => drawHist('u-hist', I, det)});
  }
  h += '<p class="small">Det breda intervallet beror främst på emissionsfaktorerna (val av nationellt medelvärde, Malmöspecifik eller marginell faktor). Med fasta faktorer återstår osäkerheten i skattad Atemp, energiprestanda och elandel. Fördelningen mellan DeSO är mer osäker än summan: se intervallen per område på kartan. Modellens struktur (t.ex. att all energi som inte är el antas vara fjärrvärme) och framtidsantagandena ingår inte i intervallet.</p><div class="button-row"><button class="secondary" data-view="parameters">Ändra osäkerhetsantaganden →</button><button class="secondary" data-view="data">Byggnadsbestånd och kontroll mot SCB →</button><button class="secondary" data-view="method">Osäkerhetskällor →</button></div></article>';
  return h;
}

/* ---------- 02 Karta ---------- */
let map = null, layers = {}, devLayer = null, tiles = null, selectedLayer = null;
const OPAQUE = .85, SEE = .55;
function rampColor(t) { return 'rgb(' + Math.round(223 - 208 * t) + ',' + Math.round(235 - 136 * t) + ',' + Math.round(207 - 119 * t) + ')'; }
function classes(vals) {
  const v = vals.filter(x => x != null && x > 0).sort((a, b) => a - b); if (!v.length) return [];
  const q = k => v[Math.min(v.length - 1, Math.floor(k * v.length))];
  const br = [v[0], q(.2), q(.4), q(.6), q(.8), v[v.length - 1]];
  return br.filter((b, i) => i === 0 || b > br[i - 1]);
}
function colorFor(x, br) { if (x == null || !(x > 0) || !br.length) return '#e3e8e4'; let k = 0; while (k < br.length - 2 && x > br[k + 1]) k++; const n = Math.max(1, br.length - 1); return rampColor((k + .5) / n); }
function mapView() {
  const v = cur();
  const opts = METRICS.map(([k, l]) => '<option value="' + k + '"' + (st.metric === k ? ' selected' : '') + '>' + l + '</option>').join('');
  const units = ['t', 't_ha', 'kg_ha', 't_inv'].map(u => '<option value="' + u + '"' + (st.unit === u ? ' selected' : '') + '>' + unitLabel(u) + '</option>').join('');
  let h = '<article class="card"><div class="map-toolbar2"><label class="inline">Nyckeltal <select id="metric">' + opts + '</select></label><label class="inline">Enhet <select id="unit">' + units + '</select></label><span class="pill">' + esc(mobLabel()) + ' · ' + yearLabel(P.ar) + '</span></div>' +
    '<div class="map-checks"><label><input type="checkbox" id="map-osm"' + (st.osm ? ' checked' : '') + '> OpenStreetMap</label><label><input type="checkbox" id="map-dev"' + (st.dev ? ' checked' : '') + '> Utbyggnadsområden ÖP 2023</label><button class="map-fit secondary small-btn" id="map-fit">Hela kommunen</button></div>' +
    '<div class="map-layout"><div><div class="map-surface" id="map-surface"></div><p class="small" id="map-status"></p></div><aside class="area-detail" id="area-detail"></aside></div></article>';
  h += '<article class="card"><div class="row wrap"><div><h2>Alla DeSO</h2><p class="card-sub">' + esc(unitLabel(st.unit)) + ' · ' + yearLabel(P.ar) + '. Klicka på en rad för att visa området; klicka på en kolumnrubrik för att sortera.</p></div><input class="input" id="table-filter" placeholder="Sök DeSO-kod eller område" value="' + esc(st.filter) + '" style="max-width:320px"></div><div class="table-wrap area-table" id="deso-table"></div></article>';
  return h;
}
function metricVals(v) { return v.rows.map(r => M.metric(r, st.metric, st.unit)); }
function drawMap() {
  const v = cur(), vals = metricVals(v), br = classes(vals), byId = Object.fromEntries(v.rows.map((r, i) => [r.id, vals[i]]));
  if (map) { map.remove(); map = null; } layers = {};
  const L = window.L, land = D.land;
  map = L.map('map-surface', {scrollWheelZoom: false, zoomSnap: .25, attributionControl: false});
  const LandSVG = L.SVG.extend({
    _initContainer() { L.SVG.prototype._initContainer.call(this); const ns = 'http://www.w3.org/2000/svg', defs = document.createElementNS(ns, 'defs'); this._landClip = document.createElementNS(ns, 'clipPath'); this._clipID = 'malmoop-land-' + L.Util.stamp(this); this._landClip.setAttribute('id', this._clipID); this._landClip.setAttribute('clipPathUnits', 'userSpaceOnUse'); defs.appendChild(this._landClip); this._container.appendChild(defs); this._rootGroup.setAttribute('clip-path', 'url(#' + this._clipID + ')'); },
    _update() { L.SVG.prototype._update.call(this); if (!this._map || !this._landClip) return; const p = x => { const a = this._map.latLngToLayerPoint([x[1], x[0]]); return [a.x, a.y]; }; this._landClip.innerHTML = land.features.map(f => '<path clip-rule="evenodd" fill-rule="evenodd" d="' + polyPath(f.geometry, p) + '"/>').join(''); }
  });
  const renderer = new LandSVG({padding: .5});
  const layer = L.geoJSON(D.deso, {renderer, style: f => ({color: '#ffffff', weight: .7, opacity: .95, fillColor: colorFor(byId[f.properties.id], br), fillOpacity: st.osm ? SEE : OPAQUE}),
    onEachFeature(f, l) {
      const id = f.properties.id; layers[id] = l;
      l.bindTooltip(() => { const iv = st.metric === 'energi' ? energyIvUnit(v.rows[S.index[id]], st.unit) : null;
        return '<b>' + esc(id) + '</b> · ' + esc(areaName(id)) + '<br>' + sig(byId[id]) + ' ' + esc(unitLabel(st.unit)) + (iv ? '<br><small>95 %: ' + ivTxt(iv[0], iv[1], sig) + '</small>' : ''); }, {sticky: true, className: 'map-tip'});
      l.on('click', () => selectArea(id, false));
      l.on('mouseover', () => { if (id !== st.selected) l.setStyle({weight: 2.2, color: '#0b463a'}); });
      l.on('mouseout', () => { if (id !== st.selected) l.setStyle({weight: .7, color: '#ffffff'}); });
    }}).addTo(map);
  devLayer = L.geoJSON({type: 'FeatureCollection', features: D.expl.omraden.map(a => ({type: 'Feature', properties: a, geometry: a.geometry}))}, {
    style: f => ({color: '#a76019', weight: 2.2, opacity: .95, fill: true, fillOpacity: 0, dashArray: f.properties.fokus === 2 ? '6 5' : null}),
    onEachFeature(f, l) { const a = f.properties, [s, e] = a.fokus === 1 ? [P.f1Start, P.f1Slut] : [P.f2Start, P.f2Slut];
      l.bindTooltip('<b>' + esc(a.namn) + '</b><br>' + esc(a.kategori) + ' · Fokus ' + a.fokus + ' · byggs ' + s + '–' + (e - 1) + '<br>' + nf(a.bostader) + ' bostäder · ' + nf(a.arbetsplatser) + ' arbetsplatser · ' + nf(a.ha, 1) + ' ha', {sticky: true, className: 'map-tip dev-tip'}); }
  });
  if (st.dev) devLayer.addTo(map);
  const lc = L.control({position: 'bottomright'});
  lc.onAdd = () => { const d = L.DomUtil.create('div', 'map-legend'); d.innerHTML = legendHtml(br); L.DomEvent.disableClickPropagation(d); return d; }; lc.addTo(map);
  const bounds = L.geoJSON(land).getBounds(); map.fitBounds(bounds, {padding: [12, 12]});
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'});
  const local = location.protocol === 'file:';
  function refreshOsm() {
    if (local) { $('map-osm').checked = false; $('map-osm').disabled = true; layer.setStyle({fillOpacity: OPAQUE}); $('map-status').textContent = 'Offlinekarta. Bakgrundskartan visas när appen körs via Streamlit. Beräkningen fungerar ändå.'; return; }
    if (st.osm) { tiles.addTo(map); tiles.bringToBack(); layer.setStyle({fillOpacity: SEE}); $('map-surface').classList.add('osm-on'); $('map-status').textContent = 'OpenStreetMap · bakgrundskartan kräver internet. Havsytor är bortklippta i visningen; beräkningen använder SCB:s DeSO-gränser.'; }
    else { map.removeLayer(tiles); layer.setStyle({fillOpacity: OPAQUE}); $('map-surface').classList.remove('osm-on'); $('map-status').textContent = 'Bakgrund avstängd · områdeskartan fungerar utan internet.'; }
  }
  let fails = 0; tiles.on('tileerror', () => { if (++fails > 2) $('map-status').textContent = 'Bakgrundskartan kunde inte hämtas. Områdeskartan och beräkningen fungerar ändå.'; });
  $('map-osm').onchange = e => { st.osm = e.target.checked; refreshOsm(); }; refreshOsm();
  $('map-dev').onchange = e => { st.dev = e.target.checked; if (st.dev) devLayer.addTo(map); else map.removeLayer(devLayer); };
  $('map-fit').onclick = () => map.fitBounds(bounds, {padding: [12, 12]});
  L.control.attribution({position: 'bottomleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'}).addTo(map).addAttribution('Områden: SCB DeSO 2025 · Utbyggnadsområden: Malmö stad ÖP 2023');
  setTimeout(() => map && map.invalidateSize(), 60);
  if (st.selected) highlight(st.selected);
}
function polyPath(g, project) { return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => p.map(r => r.map((x, i) => (i ? 'L' : 'M') + project(x).join(',')).join('') + 'Z').join('')).join(''); }
function legendHtml(br) {
  const n = br.length - 1, f = x => sig(x);
  let h = '<b>' + esc(METRICS.find(m => m[0] === st.metric)[1]) + '</b><small style="margin:0 0 5px">' + esc(unitLabel(st.unit)) + '</small>';
  for (let k = 0; k < n; k++) h += '<span><i style="background:' + rampColor((k + .5) / n) + '"></i>' + f(br[k]) + '–' + f(br[k + 1]) + '</span>';
  h += '<span><i class="nodata" style="background:#e3e8e4"></i>Noll eller saknas</span>';
  if (st.dev) h += '<span><i class="dev1"></i>Fokus 1</span><span><i class="dev2"></i>Fokus 2</span>';
  return h;
}
function highlight(id) {
  for (const [k, l] of Object.entries(layers)) l.setStyle({weight: k === id ? 3 : .7, color: k === id ? '#0b2e28' : '#ffffff'});
  if (layers[id]) layers[id].bringToFront();
}
function selectArea(id, zoom) {
  st.selected = id; highlight(id); detail(); table();
  if (zoom && map && layers[id]) map.fitBounds(layers[id].getBounds(), {padding: [60, 60], maxZoom: 14});
}
function detail() {
  const el = $('area-detail'); if (!el) return;
  const v = cur(), id = st.selected;
  if (!id) {
    const c = v.city;
    el.innerHTML = '<div class="ad-head"><span class="ad-kicker">Hela kommunen · 209 DeSO</span><h3>Malmö</h3></div><div class="ad-hero"><b>' + nf(c.total) + '</b><span>' + (isAck() ? 't CO₂e 2030–2050' : 't CO₂e per år') + ' · ' + yearLabel(P.ar) + '</span><small>Mobilitet enligt ' + esc(mobLabel()) + '</small></div>' +
      '<dl class="ad-facts"><div><dt>Invånare</dt><dd>' + nf(c.bef) + '</dd></div><div><dt>Yta utan hav</dt><dd>' + nf(c.land_ha) + ' ha</dd></div><div><dt>Per hektar</dt><dd>' + nf(c.total / c.land_ha, 1) + ' t</dd></div><div><dt>Per invånare</dt><dd>' + nf(c.total / c.bef, 2) + ' t</dd></div>' +
      '<div class="ad-wide"><dt>Energi befintliga byggnader</dt><dd>' + nf(c.energi) + ' t<small class="ad-intervall">95 %: ' + (EI() ? ivTxt(EI().city.p025, EI().city.p975) + ' t' : ivPending()) + '</small></dd></div></dl>' +
      partsMini(c) + '<p class="small ad-note">Klicka på ett område på kartan eller i tabellen.</p>';
    return;
  }
  const rows = v.rows, r = rows.find(x => x.id === id), val = M.metric(r, st.metric, st.unit);
  const sorted = rows.map(x => M.metric(x, st.metric, st.unit)).filter(x => x != null).sort((a, b) => b - a), rank = sorted.indexOf(val) + 1;
  const p = props[id], mA = D.mob.A[id], mB = D.mob[R.bKey][id], eb = R.energyBase, i = S.index[id];
  const mob = P.perspektiv === 'A' ? mA : mB, I = EI(), ivM = st.metric === 'energi' ? energyIvUnit(r, st.unit) : null;
  el.innerHTML = '<div class="ad-head"><span class="ad-kicker">DeSO ' + esc(id) + ' · RegSO ' + esc(p.regso) + '</span><h3>' + esc(areaName(id)) + '</h3></div>' +
    '<div class="ad-hero"><b>' + sig(val) + '</b><span>' + esc(unitLabel(st.unit)) + '</span><small>' + esc(METRICS.find(m => m[0] === st.metric)[1]) + ' · ' + yearLabel(P.ar) + (st.metric === 'energi' ? ' · 95 %: ' + (ivM ? ivTxt(ivM[0], ivM[1], sig) : ivPending()) : '') + '</small></div>' +
    '<div class="ad-rank">Plats ' + rank + ' av ' + sorted.length + '<small>1 = högst värde i Malmö</small><i><em style="left:' + (100 * (1 - (rank - 1) / Math.max(1, sorted.length - 1))).toFixed(1) + '%"></em></i></div>' +
    '<dl class="ad-facts"><div><dt>Totalt</dt><dd>' + nf(r.total) + ' t<small>' + (isAck() ? '2030–2050' : 'per år') + '</small></dd></div><div><dt>Yta utan hav</dt><dd>' + nf(r.land_ha, 1) + ' ha</dd></div>' +
    '<div><dt>Invånare</dt><dd>' + nf(r.bef) + (r.nyaInv > 0 ? '<small>varav ' + nf(r.nyaInv) + ' nya</small>' : '<small>2024</small>') + '</dd></div><div><dt>Energi befintliga</dt><dd>' + nf(r.energi) + ' t<small class="ad-intervall">95 %: ' + (I ? ivTxt(I.lo(i), I.hi(i)) + ' t' : ivPending()) + '</small></dd></div>' +
    '<div><dt>Byggnader med energi</dt><dd>' + nf(eb.count[i], 1) + ' dekl.<small>' + (P.bestand === 'hela' ? '+ ' + nf(stockCount[i]) + ' skattade byggnader' : 'odeklarerade ingår inte') + '</small></dd></div><div><dt>Atemp</dt><dd>' + nf(eb.atemp[i] / 1000, 1) + '<small>tusen m² (skattad' + (eb.kalibrering !== 'ingen' ? ', kalibrerad' : '') + ')</small></dd></div>' +
    '<div><dt>Mobilitet 2024</dt><dd>' + nf(mob ? mob.total : null) + ' t<small class="ad-intervall">95 %: ' + (mob ? nf(mob.p025) + '–' + nf(mob.p975) : '–') + ' t</small></dd></div><div><dt>Per invånare</dt><dd>' + (r.bef > 0 ? nf(r.total / r.bef, 2) + ' t' : '–') + '</dd></div></dl>' +
    partsMini(r) + '<button class="secondary ad-button" data-view="calc">Så räknas området →</button>';
}
function partsMini(r) {
  const tot = Math.max(1e-9, r.total);
  return '<div class="ad-parts"><h4>Klimatavtryckets delar</h4>' + M.COMPONENTS.filter(c => r[c] > 0 || c === 'energi' || c === 'mobilitet').map(c => '<div class="ad-part"><span>' + esc(M.SHORT[c]) + '</span><b>' + nf(100 * r[c] / tot) + ' %</b><i><em style="width:' + (100 * r[c] / tot).toFixed(1) + '%;background:' + COLORS[c] + '"></em></i></div>').join('') + '</div>';
}
function table() {
  const el = $('deso-table'); if (!el) return;
  const v = cur(), f = st.filter.trim().toLowerCase();
  const I = EI(), cols = [['id', 'DeSO'], ['total', 'Totalt'], ['energi', 'Energi befintliga'], ['eHi', 'Energi 95 %'], ['mobilitet', 'Mobilitet'], ['exploatering', 'Exploatering'], ['bef', 'Invånare'], ['per', unitLabel(st.unit)]];
  let rows = v.rows.map(r => ({...r, per: M.metric(r, st.metric, st.unit), eLo: I ? I.lo(r.i) : null, eHi: I ? I.hi(r.i) : null}));
  if (f) rows = rows.filter(r => r.id.toLowerCase().includes(f) || areaName(r.id).toLowerCase().includes(f));
  const [k, dir] = st.sort;
  rows.sort((a, b) => k === 'id' ? dir * a.id.localeCompare(b.id) : dir * ((a[k] ?? -1) - (b[k] ?? -1)));
  el.innerHTML = '<table class="tbl-sort"><thead><tr><th class="rank">#</th>' + cols.map(([c, l]) => '<th data-sort="' + c + '" class="' + (c !== 'id' ? 'numeric ' : '') + (k === c ? 'sorted' + (dir > 0 ? ' asc' : '') : '') + '">' + esc(l) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r, n) => '<tr data-id="' + r.id + '" class="' + (r.id === st.selected ? 'sel' : '') + '"><td class="rank">' + (n + 1) + '</td><td><button class="link-btn" data-id="' + r.id + '">' + esc(r.id) + '</button><small>' + esc(areaName(r.id)) + '</small></td><td class="numeric">' + nf(r.total) + '</td><td class="numeric">' + nf(r.energi) + '</td><td class="numeric iv">' + (I ? ivTxt(r.eLo, r.eHi) : '<span class="small">' + ivPending() + '</span>') + '</td><td class="numeric">' + nf(r.mobilitet) + '</td><td class="numeric">' + nf(r.exploatering) + '</td><td class="numeric">' + nf(r.bef) + '</td><td class="numeric">' + sig(r.per) + '</td></tr>').join('') + '</tbody></table>';
  el.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => { const c = th.dataset.sort; st.sort = [c, st.sort[0] === c ? -st.sort[1] : (c === 'id' ? 1 : -1)]; table(); });
  el.querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => { selectArea(tr.dataset.id, true); $('map-surface').scrollIntoView({behavior: 'smooth', block: 'center'}); });
}

/* ---------- 03 Så räknas resultatet ---------- */
function calcView() {
  const v = cur(), rows = v.rows;
  const id = st.selected || rows.slice().sort((a, b) => b.total - a.total)[0].id;
  const r = rows.find(x => x.id === id), i = S.index[id], E = D.energi.kolumner, eb = R.energyBase;
  const opts = rows.slice().sort((a, b) => a.id.localeCompare(b.id)).map(x => '<option value="' + x.id + '"' + (x.id === id ? ' selected' : '') + '>' + esc(x.id + ' · ' + areaName(x.id)) + '</option>').join('');
  // deklarationer i området
  const decl = [];
  for (let k = 0; k < E.id.length; k++) for (const [d, w] of E.alloc[k]) if (d === i) {
    const kk = kFor(E.kl ? E.kl[k] : 4), a = (P.atempLage === 'fast' ? P.atempFast : (E.bta[k] > 0 ? E.bta[k] * P.atempFaktor : S.btaMedian * P.atempFaktor)) * kk, s = P.elLage === 'fast' ? P.elFast : E.el[k];
    decl.push({id: E.id[k], fast: E.fast[k], klass: E.klass[k], typ: KLN[S.KL[E.kl ? E.kl[k] : 4]], se: E.se[k], a, s, w, t: E.se[k] * a * (s * P.efEl + (1 - s) * P.efFv) / 1000 * w, btak: D.energi.koder.btak[E.btak[k]], elk: D.energi.koder.elk[E.elk[k]]});
  }
  decl.sort((a, b) => b.t - a.t);
  // skattade byggnader utan deklaration i området
  const B = D.energi.bestand, stock = [];
  if (P.bestand === 'hela' && B) for (let j = 0; j < B.deso.length; j++) if (B.deso[j] === i) {
    const kl = B.kl[j], kk = kFor(kl), a = (P.atempLage === 'fast' ? P.atempFast : B.bta[j] * P.atempFaktor) * (kl === S.IND ? P.industriAndel : 1) * kk, s = P.elLage === 'fast' ? P.elFast : B.el[j];
    stock.push({typ: KLN[S.KL[kl]], bta: B.bta[j], a, se: B.se[j], s, t: a * B.se[j] * (s * P.efEl + (1 - s) * P.efFv) / 1000, btak: D.energi.koder.btak[B.btak[j]], sek: D.energi.koder.sek[B.sek[j]], grund: D.energi.koder.grund[B.grund[j]]});
  }
  stock.sort((a, b) => b.t - a.t);
  const I = EI(), tDecl = decl.reduce((x, d) => x + d.t, 0), tStock = stock.reduce((x, d) => x + d.t, 0);
  const mA = D.mob.A[id], mB = D.mob[R.bKey][id], hh = D.mob.hushall[id] || {};
  const yi = isAck() ? null : R.years.indexOf(P.ar), f = isAck() ? null : (P.ar - 2024) / 26;
  const pieces = [];
  for (const a of D.expl.omraden) for (const d of a.delar) if (d.deso === id) pieces.push({a, d});
  let h = '<article class="card"><div class="row wrap calc-top"><div><h2>' + esc(areaName(id)) + ' · ' + esc(id) + '</h2><p class="card-sub">' + esc(yearLabel(P.ar)) + ' · mobilitet enligt ' + esc(mobLabel()) + '</p></div><label class="calc-pick field">Välj DeSO<select id="calc-pick">' + opts + '</select></label></div>' +
    '<div class="calc-tiles"><div><b>' + nf(r.total) + '</b><span>t CO₂e ' + (isAck() ? '2030–2050' : 'per år') + '</span></div><div><b>' + nf(r.land_ha, 1) + '</b><span>hektar land</span></div><div><b>' + sig(r.total / Math.max(1e-9, r.land_ha)) + '</b><span>t CO₂e per ha' + (isAck() ? '' : ' och år') + '</span></div><div><b>' + nf(r.bef) + '</b><span>invånare' + (r.nyaInv ? ' (' + nf(r.nyaInv) + ' nya)' : '') + '</span></div></div>';
  const kLine = eb.kalibrering === 'ingen' ? 'Ingen kalibrering: k = 1.' : eb.kalibrering === 'total' ? 'k = ' + nf(eb.kG[0], 3) + ' för alla byggnader, så att modellens fjärrvärme blir SCB:s 1 868 GWh (2024).'
    : 'k = ' + nf(eb.kG[1], 3) + ' för flerbostadshus och ' + nf(eb.kG[2], 3) + ' för lokaler och industri, så att fjärrvärmen per sektor möter SCB 2024. Småhus kalibreras inte (k = 1); deras yta stämmer med SCB:s bostadsarea.';
  h += '<div class="calc-step"><div class="calc-n">1</div><div class="calc-body"><h3>Energi i befintliga byggnader</h3><div class="formula calc-formula">t CO₂e = Σ<sub>byggnader</sub> k × energiprestanda × Atemp × (elandel × ' + nf(P.efEl, 3) + ' + (1 − elandel) × ' + nf(P.efFv, 3) + ') / 1 000 × adressandel</div>' +
    '<p>Energiprestanda (kWh/m² Atemp och år) kommer från deklarationen. Atemp ' + (P.atempLage === 'osm' ? 'skattas ur OpenStreetMap-byggnadens fotavtryck × antal våningar × ' + nf(P.atempFaktor, 2) : 'sätts till ' + nf(P.atempFast) + ' m² per deklaration') + '. Elandelen ' + (P.elLage === 'kvot' ? 'skattas ur kvoten primärenergital/energiprestanda' : 'sätts till ' + nf(100 * P.elFast) + ' %') + '; resten antas vara fjärrvärme. ' +
    (P.bestand === 'hela' ? 'Byggnader utan deklaration får energiprestanda och elandel från deklarerade byggnader av samma typ i samma DeSO (annars RegSO eller hela Malmö); industri- och lagerbyggnader räknas med ' + nf(100 * P.industriAndel) + ' % uppvärmd yta. ' : 'Bara deklarerade byggnader ingår i valt läge. ') + kLine + '</p>' +
    '<div class="calc-result"><div><span class="lbl">Deklarationer (vägt)</span><b>' + nf(eb.count[i], 1) + '</b><small>' + nf(tDecl) + ' t</small></div><div><span class="lbl">Skattade byggnader</span><b>' + nf(stock.length) + '</b><small>' + nf(tStock) + ' t</small></div><div><span class="lbl">Atemp</span><b>' + nf(eb.atemp[i]) + ' m²</b></div><div><span class="lbl">Levererad energi</span><b>' + nf(eb.kwh[i] / 1e6, 2) + ' GWh</b></div><div><span class="lbl">2024</span><b>' + nf(eb.t[i]) + ' t</b></div><div><span class="lbl">' + yearLabel(P.ar) + '</span><b>' + nf(r.energi) + ' t</b><small class="ad-intervall">95 %: ' + (I ? ivTxt(I.lo(i), I.hi(i)) + ' t' : ivPending()) + '</small></div></div>' +
    (I ? '<p class="small">Osäkerhet i området: ' + pct(I.lo(i) / Math.max(1e-9, r.energi) - 1) + ' / ' + pct(I.hi(i) / Math.max(1e-9, r.energi) - 1) + ' mot beräknat värde. Med fasta emissionsfaktorer: ' + ivTxt(I.loA(i), I.hiA(i)) + ' t.</p>' : '') +
    (decl.length ? '<details class="calc-details"><summary>Deklarationer i området (' + decl.length + ')</summary><div class="table-wrap calc-full"><table><thead><tr><th>ID</th><th>Fastighet</th><th>Klass</th><th>Typ</th><th class="numeric">kWh/m²</th><th class="numeric">Atemp m²</th><th>Atemp-källa</th><th class="numeric">Elandel</th><th>Elandel-källa</th><th class="numeric">Andel</th><th class="numeric">t CO₂e 2024</th></tr></thead><tbody>' +
      decl.slice(0, 200).map(x => '<tr><td>' + x.id + '</td><td>' + esc(x.fast) + '</td><td>' + esc(x.klass) + '</td><td>' + esc(x.typ) + '</td><td class="numeric">' + nf(x.se) + '</td><td class="numeric">' + nf(x.a) + '</td><td>' + esc(x.btak.replace(/_/g, ' ')) + '</td><td class="numeric">' + nf(100 * x.s) + ' %</td><td>' + esc(x.elk.replace(/_/g, ' ')) + '</td><td class="numeric">' + nf(100 * x.w) + ' %</td><td class="numeric">' + nf(x.t, 1) + '</td></tr>').join('') + '</tbody></table></div></details>' : '<p class="small">Inga energideklarationer är kopplade till området.</p>') +
    (stock.length ? '<details class="calc-details"><summary>Skattade byggnader utan deklaration (' + stock.length + ')</summary><div class="table-wrap calc-full"><table><thead><tr><th>Typ</th><th>Typ bestämd av</th><th class="numeric">BTA m²</th><th>Våningskälla</th><th class="numeric">Atemp m²</th><th class="numeric">kWh/m²</th><th>Energiprestanda från</th><th class="numeric">Elandel</th><th class="numeric">t CO₂e 2024</th></tr></thead><tbody>' +
      stock.slice(0, 200).map(x => '<tr><td>' + esc(x.typ) + '</td><td>' + esc(GRUNDN[x.grund] || x.grund) + '</td><td class="numeric">' + nf(x.bta) + '</td><td>' + esc(x.btak.replace(/_/g, ' ')) + '</td><td class="numeric">' + nf(x.a) + '</td><td class="numeric">' + nf(x.se) + '</td><td>' + esc(SEKN[x.sek] || x.sek) + '</td><td class="numeric">' + nf(100 * x.s) + ' %</td><td class="numeric">' + nf(x.t, 1) + '</td></tr>').join('') + '</tbody></table>' + (stock.length > 200 ? '<p class="small">Visar de 200 största av ' + nf(stock.length) + '.</p>' : '') + '</div></details>' : '') + '</div></div>';
  h += '<div class="calc-step"><div class="calc-n">2</div><div class="calc-body"><h3>Mobilitet i befintlig stad</h3><div class="formula calc-formula">' + (P.perspektiv === 'A' ? 'A: trafik på vägar i området (vägar × trafikmängd), livscykel' : 'B: hushållens bilar × körsträcka × livscykelfaktor') + ' × flottfaktor × trafikförändring</div>' +
    '<p>Värdet 2024 kommer från Vägvis 2.3.1 med 3 000 iterationer. A är kalibrerad mot Malmös direkta vägtrafikutsläpp 2024. B ' + (R.bKey === 'B_gtfs' ? 'använder DeSO-skattad körsträcka med GTFS-utbud' : 'använder kommunens körsträcka per bil') + '. A och B adderas aldrig.</p>' +
    '<div class="calc-result"><div><span class="lbl">A 2024</span><b>' + nf(mA && mA.total) + ' t</b><small class="ad-intervall">95 %: ' + (mA ? nf(mA.p025) + '–' + nf(mA.p975) : '–') + '</small></div><div><span class="lbl">B 2024</span><b>' + nf(mB && mB.total) + ' t</b><small class="ad-intervall">95 %: ' + (mB ? nf(mB.p025) + '–' + nf(mB.p975) : '–') + '</small></div><div><span class="lbl">Bilar / hushåll</span><b>' + (hh.hh ? nf(hh.bil / hh.hh, 2) : '–') + '</b></div><div><span class="lbl">Flottfaktor ' + yearLabel(P.ar) + '</span><b>' + (isAck() ? 'per år' : nf(M.fleet(P, P.ar), 2)) + '</b></div><div><span class="lbl">' + yearLabel(P.ar) + '</span><b>' + nf(r.mobilitet) + ' t</b></div></div></div></div>';
  h += '<div class="calc-step"><div class="calc-n">3</div><div class="calc-body"><h3>Exploatering enligt ÖP 2023</h3>' +
    '<div class="formula calc-formula">Nybyggnation = BTA × klimatfaktor (kg CO₂e/m² BTA) / 1 000, fördelat jämnt över byggåren<br>Mark = ha × hårdgörandel × (kolförråd före − ' + nf(P.kolBebyggd) + ' t C/ha) × 44/12, under byggåren<br>Nya byggnaders energi = BTA × ' + nf(P.atempNy, 2) + ' × ' + nf(P.energiNy) + ' kWh/m² × emissionsfaktor · när de är klara</div>' +
    (pieces.length ? '<div class="table-wrap calc-full"><table><thead><tr><th>Utbyggnadsområde</th><th>Fokus</th><th class="numeric">Andel i DeSO</th><th class="numeric">Bostäder</th><th class="numeric">Arbetsplatser</th><th class="numeric">Åker ha</th><th class="numeric">Öppen ha</th><th class="numeric">Bebyggd ha</th><th class="numeric">Okänd ha</th></tr></thead><tbody>' +
      pieces.map(({a, d}) => '<tr><td>' + esc(a.namn) + '</td><td><span class="chip f' + a.fokus + '">Fokus ' + a.fokus + '</span></td><td class="numeric">' + nf(100 * d.andel) + ' %</td><td class="numeric">' + nf(a.bostader * d.andel) + '</td><td class="numeric">' + nf(a.arbetsplatser * d.andel) + '</td><td class="numeric">' + nf(d.mark.aker, 1) + '</td><td class="numeric">' + nf(d.mark.oppen, 1) + '</td><td class="numeric">' + nf(d.mark.bebyggd, 1) + '</td><td class="numeric">' + nf(d.mark.okand, 1) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="small">Inget av ÖP 2023:s utbyggnadsområden ligger i denna DeSO. Exploateringsposterna kan ändå vara större än noll i modell A, där nya invånares trafik fördelas över hela vägnätet.</p>') +
    '<div class="calc-result"><div><span class="lbl">Nybyggnation</span><b>' + nf(r.bygg) + ' t</b></div><div><span class="lbl">Mark</span><b>' + nf(r.mark) + ' t</b></div><div><span class="lbl">Nya byggnaders energi</span><b>' + nf(r.nydrift) + ' t</b></div><div><span class="lbl">Ny mobilitet</span><b>' + nf(r.nymob) + ' t</b></div></div></div></div>';
  h += '<div class="calc-step"><div class="calc-n">4</div><div class="calc-body"><h3>Summa och nyckeltal</h3><div class="formula calc-formula">Totalt = energi + mobilitet + nybyggnation + mark + nya byggnaders energi + ny mobilitet = ' + nf(r.total) + ' t</div>' +
    '<p>Per hektar delas med områdets landyta utan hav (' + nf(r.land_ha, 1) + ' ha). Per invånare delas med folkmängden 2024 plus nya invånare som flyttat in till och med valt år.</p></div></div></article>';
  return h;
}

/* ---------- 04 Antaganden ---------- */
const FIELDS = [
  ['Perspektiv och underlag', 'Välj hur mobiliteten ska räknas. A och B är olika perspektiv och adderas aldrig.', [
    ['perspektiv', 'Mobilitet', 'select', [['A', 'A · Trafik inom området (Vägvis)'], ['B', 'B · Hushållens bilar (Vägvis)']], 'Vägvis 2.3.1. A: alla fordon på vägar i området inkl. genomfart. B: bilar registrerade på hushåll i området.'],
    ['bLage', 'Körsträcka i modell B', 'select', [['local', 'Kommunens körsträcka per bil (Vägvis standard)'], ['gtfs', 'DeSO-skattning med GTFS-utbud 2024']], 'Påverkar fördelningen mellan DeSO i B; Malmös summa är densamma.']]],
  ['Energi i befintliga byggnader', 'Energideklarationerna saknar uppvärmd area och energibärare. Båda skattas och kan ersättas här.', [
    ['efEl', 'El, kg CO₂e/kWh', 'number', 0.001, 'Boverkets klimatdatabas, svensk elmix (Boverket, 2026a).'],
    ['efFv', 'Fjärrvärme, kg CO₂e/kWh', 'number', 0.001, 'Boverkets klimatdatabas, svenskt medelvärde (Boverket, 2026a). Ej Malmöspecifik.'],
    ['atempLage', 'Atemp per deklaration', 'select', [['osm', 'Skattad ur OSM-byggnader (fotavtryck × våningar)'], ['fast', 'Samma yta för alla deklarationer']], 'OSM: OpenStreetMap-bidragsgivare. Se Data & kvalitet för våningskällor.'],
    ['atempFaktor', 'Atemp / BTA', 'number', 0.01, 'Andel av bruttoarean som är uppvärmd area. Antagande.'],
    ['atempFast', 'Fast Atemp, m² per deklaration', 'number', 50, 'Används bara i läget "samma yta".'],
    ['elLage', 'Elandel av levererad energi', 'select', [['kvot', 'Skattad ur primärenergital / energiprestanda'], ['fast', 'Samma andel för alla']], 'Kvotmetod: se Metod & källor.'],
    ['elFast', 'Fast elandel (0–1)', 'number', 0.01, 'Används bara i läget "samma andel". Resten fjärrvärme.'],
    ['effektivisering2050', 'Energieffektivisering till 2050, %', 'number', 1, 'Lägre levererad energi i befintligt bestånd, linjärt från 2024. Känslighetsberäkning.'],
    ['efForandring2050', 'Förändrade emissionsfaktorer till 2050, %', 'number', 1, 'Gäller el och fjärrvärme i både befintliga och nya byggnader. Negativt = lägre utsläpp.']]],
  ['Byggnadsbestånd, kalibrering och osäkerhet', 'Hela beståndet: byggnader utan energideklaration skattas från deklarerade byggnader av samma typ. Ytorna kan kalibreras mot SCB:s fjärrvärmestatistik. Osäkerheten beräknas med Monte Carlo.', [
    ['bestand', 'Byggnader som ingår', 'select', [['hela', 'Hela beståndet (deklarerade + skattade)'], ['deklarerade', 'Bara byggnader med energideklaration']], 'Skattade byggnader: alla OSM-byggnader i Malmö som är uppvärmda men saknar deklaration (se Data & kvalitet).'],
    ['kalibrering', 'Kalibrering mot SCB 2024', 'select', [['sektor', 'Per sektor (flerbostadshus, lokaler/industri)'], ['total', 'En faktor för all fjärrvärme'], ['ingen', 'Ingen kalibrering']], 'SCB (2026), kommunal energistatistik: fjärrvärme 2024 per sektor. Gäller bara hela beståndet.'],
    ['industriAndel', 'Uppvärmd andel i odeklarerade industri- och lagerbyggnader', 'number', 0.05, 'Antagande. Många lager och hallar är kalla eller tempererade.'],
    ['cvEfEl', 'Osäkerhet i elens emissionsfaktor (CV)', 'number', 0.01, '0,25 = ±25 % (1 sd). Speglar val av faktor: nordisk mix, marginalel, ursprungsgarantier. 0 = fast faktor.'],
    ['cvEfFv', 'Osäkerhet i fjärrvärmens emissionsfaktor (CV)', 'number', 0.01, 'Svenskt medelvärde mot Malmöspecifik faktor och allokeringsmetod. 0 = fast faktor.'],
    ['cvKalibrering', 'Osäkerhet i kalibreringsmålet (CV)', 'number', 0.01, 'Normalårskorrigering, sektorsgränser och sekretessbelagda värden i SCB:s statistik.'],
    ['iterationer', 'Iterationer', 'number', 100, '1 000 ger stabila 95 %-intervall (ca 4 s). Max 5 000.'],
    ['seed', 'Slumptalsfrö (seed)', 'number', 1, 'Samma seed och samma antaganden ger samma resultat.']], () => '<div class="u-param"><h3>Status</h3><div data-u-status>' + uStatusHtml() + '</div></div>'],
  ['Mobilitet', 'Utgångsläget 2024 kommer från Vägvis. Framtiden styrs av två enkla faktorer.', [
    ['trafikForandring2050', 'Förändrat trafikarbete till 2050, %', 'number', 1, 'Befintlig stad, linjärt från 2024. Nya invånares trafik läggs till separat.'],
    ['flotta2030', 'Flottans klimatfaktor 2030', 'number', 0.01, 'Livscykelutsläpp per fordonskilometer relativt 2024 (1 = oförändrad flotta).'],
    ['flotta2040', 'Flottans klimatfaktor 2040', 'number', 0.01, 'Interpoleras linjärt mellan åren.'],
    ['flotta2050', 'Flottans klimatfaktor 2050', 'number', 0.01, 'Sätt t.ex. 0,3 för en kraftigt elektrifierad flotta.'],
    ['bilFaktor', 'Bilar per nytt hushåll (relativt värd-DeSO)', 'number', 0.05, '1 = som befintliga hushåll i samma DeSO 2024 (SCB via Vägvis).'],
    ['andelKmInomMalmo', 'Andel av nya bilars körning på Malmös vägar (A)', 'number', 0.05, 'Används bara i perspektiv A. Antagande.'],
    ['personerPerBostad', 'Invånare per ny bostad', 'number', 0.01, 'Malmö 2024: 365 644 invånare / 172 941 hushåll.']]],
  ['Exploatering – tidsplan och volymer', 'ÖP 2023: Fokus 1 detaljplaneras före 2030, Fokus 2 därefter. Byggåren fördelas jämnt.', [
    ['exploatering', 'Räkna med exploatering', 'select', [['true', 'Ja'], ['false', 'Nej, bara befintlig stad']], ''],
    ['f1Start', 'Fokus 1 · första byggår', 'number', 1, 'Standard 2030.'], ['f1Slut', 'Fokus 1 · klart år', 'number', 1, 'Standard 2040 (byggs 2030–2039).'],
    ['f2Start', 'Fokus 2 · första byggår', 'number', 1, 'Standard 2040.'], ['f2Slut', 'Fokus 2 · klart år', 'number', 1, 'Standard 2050 (byggs 2040–2049).'],
    ['btaBostad', 'BTA per bostad, m²', 'number', 1, 'Antagande, inkl. väggar, trapphus och biutrymmen.'],
    ['btaArbBlandad', 'BTA per arbetsplats i blandad stad, m²', 'number', 1, 'Kontor och service. Antagande.'],
    ['btaArbVerks', 'BTA per arbetsplats i verksamhetsområde, m²', 'number', 1, 'Logistik och industri. Antagande.'],
    ['btaSkolplats', 'BTA per förskole-/skolplats, m²', 'number', 1, 'Antagande.']]],
  ['Exploatering – klimatfaktorer', 'Uppförande (A1–A5) och drift av de nya byggnaderna.', [
    ['klimatBygg', 'Klimatpåverkan vid uppförande', 'select', [['gransvarde2030', 'Boverkets föreslagna gränsvärden 2030'], ['referens', 'Dagens referensvärden (median)'], ['bana', 'Indikativ bana: gränsvärde 2030 → −90 % 2040']], 'Boverket (2026b), utkast till färdplan: flerbostadshus 358 → 235, kontor/skola 383 → 250, hallbyggnader 291 → 190 kg CO₂e/m² BTA.'],
    ['atempNy', 'Atemp / BTA i nya byggnader', 'number', 0.01, 'Antagande.'],
    ['energiNy', 'Energi i nya byggnader, kWh/m² Atemp och år', 'number', 1, 'Median för klass A–B, ≥ 1 000 m² BTA, i Malmö-underlaget.'],
    ['elandelNy', 'Elandel i nya byggnader (0–1)', 'number', 0.01, 'Median i samma urval.']]],
  ['Markanvändning', 'Kolförråd före och efter exploatering. Andelen som inte hårdgörs behåller sitt förråd.', [
    ['hardgorandel', 'Andel som bebyggs eller hårdgörs (0–1)', 'number', 0.05, 'Antagande. Resten antas bli park eller gröna ytor.'],
    ['markOkand', 'Mark utan OSM-klass antas vara', 'select', [['bebyggd', 'Redan bebyggd/hårdgjord'], ['oppen', 'Öppen mark med vegetation'], ['aker', 'Åkermark']], 'Försiktigt standardval: ingen kolförlust för oklassad mark.'],
    ['kolAker', 'Åkermark, t C/ha', 'number', 1, 'Minerogen åkermark (Länsstyrelsen i Uppsala län, 2025, tabell 2). Proxy för Skåne.'],
    ['kolOppen', 'Öppen mark med vegetation, t C/ha', 'number', 1, 'Biomassa + förna + markkol (samma källa, tabell 6).'],
    ['kolSkog', 'Skog på fastmark, t C/ha', 'number', 1, 'Samma källa, tabell 6.'],
    ['kolBebyggd', 'Anlagd och bebyggd mark, t C/ha', 'number', 1, 'Kolförrådet efter exploatering (samma källa, tabell 6).']]]
];
function paramsView() {
  return FIELDS.map(([title, sub, fields, extra]) => '<article class="card field-group"><h2>' + esc(title) + '</h2><p class="card-sub">' + esc(sub) + '</p><div class="controls">' + fields.map(([k, label, type, a, src]) => {
    const val = P[k], ch = String(val) !== String(M.DEFAULTS[k]);
    const input = type === 'select' ? '<select data-p="' + k + '">' + a.map(([v, l]) => '<option value="' + v + '"' + (String(val) === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>'
      : '<input class="input" type="number" data-p="' + k + '" step="' + a + '" value="' + val + '">';
    return '<div class="field"><label>' + esc(label) + (ch ? '<span class="changed-dot" title="Ändrat från standard (' + esc(M.DEFAULTS[k]) + ')"></span>' : '') + '</label>' + input + '<span class="src">' + esc(src) + (ch ? ' Standard: ' + esc(M.DEFAULTS[k]) + '.' : '') + '</span></div>';
  }).join('') + '</div>' + (extra ? extra() : '') + '</article>').join('') + '<article class="card"><div class="button-row"><button class="primary" id="reset-params">Återställ alla standardvärden</button><button class="secondary" data-view="overview">Se resultatet →</button></div><p class="small">Antagandena sparas i den här webbläsaren. Exportera JSON för att dela dem.</p></article>';
}

/* ---------- 05 Exploatering ---------- */
function explView() {
  const ar = R.areas, A = D.expl.omraden, byYear = M.cityByYear(R).filter(r => r.year >= 2030 && r.year <= 2050);
  const comps = ['bygg', 'mark', 'nydrift', 'nymob'];
  const bta = ar.reduce((s, a) => s + a.btaSum, 0), aker = A.reduce((s, a) => s + a.delar.reduce((x, d) => x + d.mark.aker, 0), 0);
  const sum = c => byYear.reduce((s, r) => s + r[c], 0);
  let h = '<section class="kpis four"><article class="card kpi-main"><div class="kpi-label">Exploatering 2030–2050 · summa</div><div class="kpi-value">' + kt(comps.reduce((s, c) => s + sum(c), 0)) + ' <span class="unit">kt CO₂e</span></div><div class="kpi-foot">Nybyggnation ' + kt(sum('bygg')) + ' kt · mark ' + kt(sum('mark')) + ' kt · drift ' + kt(sum('nydrift')) + ' kt · mobilitet ' + kt(sum('nymob')) + ' kt</div></article>' +
    '<article class="card"><div class="kpi-label">Tillkommande BTA</div><div class="kpi-value">' + nf(bta / 1e6, 2) + ' <span class="unit">milj. m²</span></div><div class="kpi-foot">' + nf(A.reduce((s, a) => s + a.bostader, 0)) + ' bostäder · ' + nf(A.reduce((s, a) => s + a.arbetsplatser, 0)) + ' arbetsplatser</div></article>' +
    '<article class="card"><div class="kpi-label">Åkermark som tas i anspråk</div><div class="kpi-value">' + nf(aker * P.hardgorandel, 0) + ' <span class="unit">ha hårdgörs</span></div><div class="kpi-foot">' + nf(aker, 0) + ' ha åkermark inom områdena enligt OSM</div></article>' +
    '<article class="card"><div class="kpi-label">Per ny bostad</div><div class="kpi-value">' + nf(sum('bygg') / Math.max(1, A.reduce((s, a) => s + a.bostader, 0)), 1) + ' <span class="unit">t CO₂e</span></div><div class="kpi-foot">Nybyggnation inkl. lokaler och skolor, fördelat per bostad</div></article></section>';
  h += '<article class="card"><h2>Exploateringens klimatpåverkan per år</h2><p class="card-sub">Hela Malmö, kt CO₂e per år, enligt valda antaganden. Mobilitet enligt ' + esc(mobLabel()) + '.</p>' + stackChart('chart-expl', byYear.map(r => ({...r, key: r.year, tipTitle: 'Exploatering ' + r.year})), comps, {sel: P.ar, aria: 'Exploateringens klimatpåverkan per år', h: 300, onClick: r => { if (M.YEARS.includes(r.year)) setP({ar: r.year}); }}) + '</article>';
  const rows = ar.map((x, k) => ({...x, a: A[k], aker: A[k].delar.reduce((s, d) => s + d.mark.aker, 0)}));
  const [sk, sd] = st.explSort; rows.sort((a, b) => sk === 'namn' ? sd * a.namn.localeCompare(b.namn) : sd * ((a[sk] ?? 0) - (b[sk] ?? 0)));
  const cols = [['namn', 'Område'], ['fokus', 'Fokus · byggår'], ['bost', 'Bostäder'], ['arb', 'Arbetsplatser'], ['btaSum', 'BTA m²'], ['ha', 'Yta ha'], ['aker', 'varav åker ha'], ['bygg', 'Nybyggnation t'], ['mark', 'Mark t'], ['nydrift2050', 'Drift 2050 t/år'], ['nymob2050', 'Mobilitet 2050 t/år (B)']];
  rows.forEach(r => { r.bost = r.a.bostader; r.arb = r.a.arbetsplatser; r.ha = r.a.ha; r.fokus = r.a.fokus; });
  h += '<article class="card"><h2>Utbyggnadsområden i ÖP 2023</h2><p class="card-sub">Områden med minst 200 bostäder eller 500 arbetsplatser där detaljplaneringen inte har börjat. Nybyggnation och mark avser summan 2030–2050. Mobilitet 2050 visas med hushållslogik (B) för området.</p><div class="table-wrap area-table"><table class="tbl-sort" id="expl-table"><thead><tr>' + cols.map(([c, l]) => '<th data-sort="' + c + '" class="' + (c !== 'namn' && c !== 'fokus' ? 'numeric ' : '') + (sk === c ? 'sorted' + (sd > 0 ? ' asc' : '') : '') + '">' + l + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr><td><button class="link-btn" data-area="' + r.id + '">' + esc(r.namn) + '</button><small>' + esc(r.a.kategori) + (r.a.storstadspaket ? ' · Storstadspaketet linje ' + esc(r.a.storstadspaket) : '') + '</small></td><td><span class="chip f' + r.a.fokus + '">Fokus ' + r.a.fokus + '</span><small>' + r.s + '–' + (r.e - 1) + '</small></td><td class="numeric">' + nf(r.bost) + '</td><td class="numeric">' + nf(r.arb) + '</td><td class="numeric">' + nf(r.btaSum) + '</td><td class="numeric">' + nf(r.ha, 1) + '</td><td class="numeric">' + nf(r.aker, 1) + '</td><td class="numeric">' + nf(r.bygg) + '</td><td class="numeric">' + nf(r.mark) + '</td><td class="numeric">' + nf(r.nydrift2050) + '</td><td class="numeric">' + nf(r.nymob2050) + '</td></tr>').join('') + '</tbody></table></div>' +
    '<p class="small">Källa: Malmö stad, Översiktsplan för Malmö 2023, underlag "Utbyggnadsområden". Marktäcke: OpenStreetMap. BTA = bostäder × ' + P.btaBostad + ' m² + arbetsplatser × ' + P.btaArbBlandad + '/' + P.btaArbVerks + ' m² + skolplatser × ' + P.btaSkolplats + ' m².</p></article>';
  return h;
}

/* ---------- 06 Data & kvalitet ---------- */
function dataView() {
  const q = D.energi.urval, m = D.meta, E = D.energi.kolumner;
  const btaStats = {}; const elStats = {};
  E.btak.forEach((k, i) => { if (!E.alloc[i].length) return; const n = D.energi.koder.btak[k]; btaStats[n] = btaStats[n] || {n: 0, bta: 0}; btaStats[n].n++; btaStats[n].bta += E.bta[i]; });
  E.elk.forEach((k, i) => { if (!E.alloc[i].length) return; const n = D.energi.koder.elk[k]; elStats[n] = (elStats[n] || 0) + 1; });
  const btaTot = Object.values(btaStats).reduce((s, x) => s + x.bta, 0);
  const btaNames = {osm_levels: 'OSM building:levels (uppmätt/kartlagt)', osm_height: 'OSM-höjd / 3 m', median_deso: 'Median för taggade byggnader i samma DeSO', median_regso: 'Median i samma RegSO', median_malmo: 'Median i hela Malmö (' + q.vaningar_imputering.median_malmo + ' plan)', smahus_standard: 'Småhustyp, 1,5 plan', liten_byggnad: 'Liten byggnad, 1 plan', stor_byggnadsyta: 'Fotavtryck ≥ 3 000 m², 2 plan (hall)', saknas: 'Ingen byggnad hittad – medianyta används'};
  const elNames = {kvot_ep_se: 'Kvot primärenergital / energiprestanda', median_deso: 'Median i samma DeSO (primärenergital saknas)', median_malmo: 'Median i Malmö'};
  const flags = m.adresskoppling.flaggor;
  const flagNames = {A: 'Exakt träff', B: 'Träff efter normalisering av stavning/mellanslag', P: 'Samma gatuadress, avvikande postnummer', C: 'Stavningskorrigerad gata, samma husnummer', R: 'Avvisad (annat husnummer eller osäker)', U: 'Ingen träff'};
  let h = '<section class="grid2 grid-even"><article class="card"><h2>Energideklarationer: urval</h2><p class="card-sub">Användarens CSV, ' + nf(q.rader) + ' adressrader. SHA-256 ' + esc(q.csv_sha256.slice(0, 16)) + '…</p><table class="quality-table"><tbody>' +
    '<tr><td>Adressrader i filen</td><td class="numeric">' + nf(q.rader) + '</td></tr><tr><td>Exakta dubblettrader borttagna</td><td class="numeric">' + nf(q.exakta_dubblettrader) + '</td></tr><tr><td>Unika deklarations-ID</td><td class="numeric">' + nf(q.deklarationer) + '</td></tr><tr><td>Ersatta av senare deklaration för samma adress</td><td class="numeric">' + nf(q.ersatta_av_senare_deklaration) + '</td></tr><tr><td>Beräkningsbara deklarationer</td><td class="numeric">' + nf(q.beraknade_deklarationer) + '</td></tr><tr><td>Kartlagda till DeSO</td><td class="numeric">' + nf(q.kartlagda) + '</td></tr><tr><td>Ej kartlagda (ingen godkänd adress)</td><td class="numeric">' + nf(q.ej_kartlagda) + '</td></tr></tbody></table>' +
    '<p class="small">Regel: en adress styrs av den senaste deklarationen. Deklarationer med samma senaste datum behålls alla (troligen olika byggnader). Adresserna i en deklaration väger lika; okopplade adresser får ingen vikt.</p></article>' +
    '<article class="card"><h2>Adresskoppling</h2><p class="card-sub">Malmö stads adresstjänst (Malmo_adresser_platser, GeocodeServer), hämtad ' + esc(m.adresskoppling.hamtad) + '. Punkt-i-polygon mot SCB DeSO 2025.</p><table class="quality-table"><tbody>' +
    Object.entries(flagNames).map(([k, l]) => '<tr><td>' + k + ' · ' + l + (('ABPC').includes(k) ? '' : ' <span class="status st-avvik">används ej</span>') + '</td><td class="numeric">' + nf(flags[k] || 0) + '</td></tr>').join('') + '<tr><td><b>Godkända och kopplade till DeSO</b></td><td class="numeric"><b>' + nf(m.adresskoppling.godkanda) + '</b></td></tr></tbody></table><p class="small">Hela tabellen finns i GitHub som <code>data/adresskoppling.csv</code> och kan laddas ned på sidan "Underlag" i Streamlit.</p></article></section>';
  h += stockView();
  h += '<section class="grid2 grid-even"><article class="card"><h2>Skattad Atemp</h2><p class="card-sub">Atemp = Σ OSM-fotavtryck × våningar × andel × ' + nf(P.atempFaktor, 2) + '. Andel = deklarationens adresser i byggnaden / alla deklarationsadresser i byggnaden.</p><table class="quality-table"><thead><tr><th>Våningskälla (störst del av BTA)</th><th class="numeric">Deklarationer</th><th class="numeric">Andel av BTA</th></tr></thead><tbody>' +
    Object.entries(btaStats).sort((a, b) => b[1].bta - a[1].bta).map(([k, x]) => '<tr><td>' + esc(btaNames[k] || k) + '</td><td class="numeric">' + nf(x.n) + '</td><td class="numeric">' + nf(100 * x.bta / btaTot, 1) + ' %</td></tr>').join('') + '</tbody></table>' +
    '<p class="small">Summa skattad Atemp: <b>' + nf(btaTot * P.atempFaktor / 1e6, 1) + ' milj. m²</b>. Skattningen är det största osäkerhetsmomentet för energidelen. Bättre underlag: Boverkets öppna data om energideklarationer (Atemp per deklaration) kan läsas in i en kommande version.</p></article>' +
    '<article class="card"><h2>Energibärare</h2><p class="card-sub">Kvoten r = primärenergital / energiprestanda ökar med andelen el. Ankarvärden per regelregim (BBR före/efter 1 sep 2020).</p><table class="quality-table"><tbody>' +
    Object.entries(elStats).map(([k, n]) => '<tr><td>' + esc(elNames[k] || k) + '</td><td class="numeric">' + nf(n) + '</td></tr>').join('') + '</tbody></table>' +
    '<table class="quality-table"><thead><tr><th>Regim</th><th class="numeric">r, 10:e percentil</th><th class="numeric">r, 90:e percentil</th><th class="numeric">n</th></tr></thead><tbody>' +
    Object.entries(q.energibarare_ankare).map(([k, a]) => '<tr><td>' + (k === 'bbr29' ? 'Från 1 sep 2020 (el 1,8 / fjärrvärme 0,7)' : 'Före 1 sep 2020 (el 1,6 / fjärrvärme 1,0)') + '</td><td class="numeric">' + nf(a.r_lo, 3) + '</td><td class="numeric">' + nf(a.r_hi, 3) + '</td><td class="numeric">' + nf(a.n) + '</td></tr>').join('') + '</tbody></table>' +
    '<p class="small">Elandel = ' + nf(q.f0_fastighetsel, 2) + ' + (1 − ' + nf(q.f0_fastighetsel, 2) + ') × (r − r₁₀)/(r₉₀ − r₁₀), begränsad till 0–1. ' + nf(q.f0_fastighetsel, 2) + ' motsvarar fastighetsel i en fjärrvärmevärmd byggnad (antagande). Median i Malmö: ' + nf(100 * q.elandel_median_malmo) + ' %.</p></article></section>';
  h += '<article class="card"><h2>Ladda ned</h2><div class="button-row"><button class="secondary" id="dl-deso">DeSO-resultat · CSV</button><button class="secondary" id="dl-decl">Deklarationer med beräkning · CSV</button><button class="secondary" id="dl-years">Malmö per år · CSV</button><button class="secondary" id="dl-json">Antaganden och resultat · JSON</button></div><p class="small">Allt räknas i webbläsaren med de antaganden som är valda just nu.</p></article>';
  return h;
}

function stockView() {
  const q = D.energi.urval, bs = q.bestand, kal = D.energi.kalibrering, eb = R.energyBase;
  if (!bs) return '';
  const sm = bs.sammanfattning, pk = bs.per_klass, hela = P.bestand === 'hela', mn = x => nf(x / 1e6, 2);
  const cat = [['deklarerad', 'Har energideklaration', 'Ja, via deklarationen'], ['sammanbyggd_med_deklarerad', 'Sammanbyggd med deklarerad byggnad (gårdshus, flyglar, delar utan egen adress)', hela ? 'Ja, skattad' : 'Nej i valt läge'],
    ['skattad', 'Uppvärmd byggnad utan deklaration', hela ? 'Ja, skattad' : 'Nej i valt läge'], ['ouppvarmd', 'Ouppvärmd (garage, förråd, carport, växthus, kolonistugor och små byggnader)', 'Nej'], ['utanfor_deso', 'Utanför Malmös DeSO (grannkommuner i uttaget)', 'Nej']];
  let h = '<section class="grid2 grid-even"><article class="card"><h2>Hela byggnadsbeståndet</h2><p class="card-sub">Alla ' + nf(bs.osm_byggnader) + ' byggnader i OpenStreetMap-uttaget klassas som småhus, flerbostadshus, lokal, industri/lager eller ouppvärmd. Byggnader utan deklaration får energiprestanda och elandel från deklarerade byggnader av samma typ i samma DeSO (minst 5), annars RegSO eller hela Malmö.</p>' +
    '<table class="quality-table"><thead><tr><th>Byggnader</th><th class="numeric">Antal</th><th class="numeric">BTA milj. m²</th><th>I beräkningen</th></tr></thead><tbody>' +
    cat.map(([k, l, inc]) => '<tr><td>' + l + '</td><td class="numeric">' + nf(sm[k].byggnader) + '</td><td class="numeric">' + mn(sm[k].bta) + '</td><td>' + (inc.startsWith('Ja') ? '<span class="status st-ok">' + inc + '</span>' : '<span class="status st-avvik">' + inc + '</span>') + '</td></tr>').join('') + '</tbody></table>' +
    '<table class="quality-table"><thead><tr><th>Typ</th><th class="numeric">Deklarerade</th><th class="numeric">BTA</th><th class="numeric">Skattade</th><th class="numeric">BTA</th><th class="numeric">Skattad andel av BTA</th></tr></thead><tbody>' +
    Object.entries(pk).map(([k, x]) => '<tr><td>' + esc(KLN[k]) + '</td><td class="numeric">' + nf(x.deklarerade) + '</td><td class="numeric">' + mn(x.deklarerade_bta) + '</td><td class="numeric">' + nf(x.skattade) + '</td><td class="numeric">' + mn(x.skattade_bta) + '</td><td class="numeric">' + nf(100 * x.skattade_bta / Math.max(1, x.skattade_bta + x.deklarerade_bta)) + ' %</td></tr>').join('') + '</tbody></table>' +
    '<p class="small">Typen bestäms av OSM-taggen building (t.ex. house, apartments, retail, industrial), annars av markanvändningen runt byggnaden och storleken. Otaggade byggnader som är sammanbyggda i en DeSO där taggade hus har minst tre våningar räknas som flerbostadshus (kvartersstad). Odeklarerade industri- och lagerbyggnader räknas med ' + nf(100 * P.industriAndel) + ' % uppvärmd yta. BTA = fotavtryck × våningar.</p></article>';
  // kontroll mot SCB (okalibrerat, valda antaganden)
  const it = M.energyItems(S, P), G = [0, 0, 0].map(() => ({dh: 0, el: 0, at: 0})), A = {};
  for (let i = 0; i < it.m; i++) { const e = it.se[i] * it.a[i], g = G[it.grp[i]]; g.dh += e * (1 - it.el[i]); g.el += e * it.el[i]; g.at += it.a[i]; const kl = S.KL[it.kl[i]]; A[kl] = (A[kl] || 0) + it.a[i]; }
  const sek = kal && kal.sektor_mal_mwh, gw = x => nf(x / 1e6), rat = (a, b) => b > 0 ? nf(a / b, 2) : '–';
  const scbG = sek ? [sek.smahus * 1000, sek.flerbostadshus * 1000, sek.lokal_industri * 1000] : [null, null, null];
  const kUsed = g => eb.kalibrering === 'total' ? eb.kG[0] : eb.kalibrering === 'sektor' ? eb.kG[g] : 1;
  const dhTot = G.reduce((x, g) => x + g.dh, 0);
  h += '<article class="card"><h2>Kontroll och kalibrering mot SCB</h2><p class="card-sub">Modellens fjärrvärme före kalibrering jämförs med SCB:s kommunala energistatistik för Malmö 2024. Allt som inte är el antas i modellen vara fjärrvärme.</p>';
  if (kal) {
    h += '<table class="quality-table"><thead><tr><th>Fjärrvärme 2024, GWh</th><th class="numeric">SCB</th><th class="numeric">Modell</th><th class="numeric">Modell / SCB</th><th class="numeric">k som används</th></tr></thead><tbody>' +
      M.GROUP_NAMES.map((n, g) => '<tr><td>' + n + (g === 0 && sek ? '<span class="kk-sub">SCB-värdet 2024 är sekretessbelagt och skattat som rest</span>' : g === 2 ? '<span class="kk-sub">Offentlig verksamhet + övriga tjänster + industri</span>' : '') + '</td><td class="numeric">' + (scbG[g] ? gw(scbG[g]) : '–') + '</td><td class="numeric">' + gw(G[g].dh) + '</td><td class="numeric">' + (scbG[g] ? rat(G[g].dh, scbG[g]) : '–') + '</td><td class="numeric">' + nf(kUsed(g), 3) + '</td></tr>').join('') +
      '<tr><td><b>Summa</b></td><td class="numeric"><b>' + gw(kal.mal_fjarrvarme_mwh * 1000) + '</b></td><td class="numeric"><b>' + gw(dhTot) + '</b></td><td class="numeric"><b>' + rat(dhTot, kal.mal_fjarrvarme_mwh * 1000) + '</b></td><td class="numeric"><b>' + nf(eb.k, 3) + '</b></td></tr></tbody></table>';
    const bo = kal.bostader_2024 || {}, sh = bo['SMÅHUS'], fb = bo['FLERBOST'], nSm = pk.smahus.deklarerade + pk.smahus.skattade;
    h += '<table class="quality-table"><thead><tr><th>Bostäder, kontroll av ytan</th><th class="numeric">SCB 2024</th><th class="numeric">Modell</th><th class="numeric">Kvot</th></tr></thead><tbody>' +
      (sh ? '<tr><td>Småhus: antal (SCB: lägenheter i småhus)</td><td class="numeric">' + nf(sh.lagenheter) + '</td><td class="numeric">' + nf(nSm) + '</td><td class="numeric">' + rat(nSm, sh.lagenheter) + '</td></tr>' +
        '<tr><td>Småhus: Atemp mot bostadsarea (BOA), milj. m²</td><td class="numeric">' + nf(sh.boa_m2 / 1e6, 2) + '</td><td class="numeric">' + nf((A.smahus || 0) * kUsed(0) / 1e6, 2) + '</td><td class="numeric">' + rat((A.smahus || 0) * kUsed(0), sh.boa_m2) + '</td></tr>' : '') +
      (fb ? '<tr><td>Flerbostadshus: Atemp mot bostadsarea (BOA), milj. m²</td><td class="numeric">' + nf(fb.boa_m2 / 1e6, 2) + '</td><td class="numeric">' + nf((A.flerbostadshus || 0) * kUsed(1) / 1e6, 2) + '</td><td class="numeric">' + rat((A.flerbostadshus || 0) * kUsed(1), fb.boa_m2) + '</td></tr>' : '') + '</tbody></table>' +
      '<p class="small">Atemp är normalt större än bostadsarean: den omfattar väggar, trapphus, uppvärmda källare och lokaler i bottenvåningen, så en kvot på ungefär 1,2–1,4 är rimlig. Flerbostadshusens fjärrvärme ligger nära SCB, medan småhus, lokaler och industri ligger över. För småhus stämmer antalet och ytan; överskottet tolkas som andra energibärare (gas, biobränsle, värmepump), och småhus kalibreras därför inte. För lokaler och industri är ytan osäkrast (våningar, uppvärmd andel av hallar) och skalas ned. Källa: ' + esc(kal.kalla) + '; ' + esc(kal.bostader_kalla) + '. ' + esc(kal.sektor_metod || '') + '</p>';
  } else h += '<p class="small">SCB-underlaget saknas i datafilen. Ingen kalibrering görs.</p>';
  h += '</article></section>';
  return h;
}

/* ---------- 07 Metod ---------- */
function methodView() {
  const m = D.meta;
  return '<article class="card method-text"><h2>Syfte och systemgräns</h2><p>MalmoOP är en screeningmodell för översiktsplanering. Den räknar ett årligt klimatavtryck per DeSO (SCB 2025, 209 områden) för tre delar: energi i befintliga byggnader, mobilitet och utbyggnaden enligt Översiktsplan för Malmö 2023. Resultatet visas i ton CO₂e per år, per hektar landyta (havsytor exkluderade via OpenStreetMap-landpolygoner) och per invånare. Beräkningsåret för utgångsläget är 2024. Framtidsåren 2030–2050 är scenarier, inte prognoser.</p>' +
    '<h2>1. Energi i befintliga byggnader</h2><div class="formula">t CO₂e = Σ<sub>byggnader</sub> k<sub>sektor</sub> × EP<sub>spec</sub> × Atemp × (s × EF<sub>el</sub> + (1 − s) × EF<sub>fv</sub>) / 1 000 × w<sub>DeSO</sub></div>' +
    '<ul><li><b>Energiprestanda</b> (kWh/m² Atemp och år) är deklarationens specifika energianvändning. Primärenergitalet används aldrig som köpt energi; det används bara i kvoten för energibärare.</li><li><b>Atemp</b> saknas i CSV-filen. Den skattas som OSM-byggnadens fotavtryck × antal våningar × Atemp/BTA (0,9). Våningar: <code>building:levels</code>; annars höjd/3 m; annars median för taggade flerbostads- och lokalbyggnader i samma DeSO, RegSO eller hela Malmö. Småhustyper 1,5 plan. Fotavtryck ≥ 3 000 m² utan våningsuppgift 2 plan. Odeklarerade industri- och lagerbyggnader 1,5 plan. Om flera deklarationer delar byggnad delas ytan efter antal adresser.</li>' +
    '<li><b>Hela beståndet:</b> alla byggnader i OpenStreetMap klassas efter byggnadstyp, markanvändning och storlek. Ouppvärmda byggnader (garage, förråd, växthus m.m.) tas bort. Uppvärmda byggnader utan deklaration får medianen av energiprestanda och elandel för deklarerade byggnader av samma typ i samma DeSO (minst 5), annars RegSO (minst 5) eller Malmö. Byggnader som är sammanbyggda med en deklarerad byggnad men saknar egen träff skattas på samma sätt; deras yta ingår inte i deklarationens skattade Atemp. Odeklarerade industri- och lagerbyggnader räknas med ' + nf(P.industriAndel * 100) + ' % uppvärmd yta.</li>' +
    '<li><b>Kalibrering mot SCB:</b> modellens fjärrvärme jämförs med SCB:s kommunala energistatistik 2024. Standard är kalibrering per sektor: Atemp i flerbostadshus respektive lokaler och industri skalas med en faktor k så att fjärrvärmen möter SCB:s värde för sektorn. Småhus kalibreras inte, eftersom deras antal och yta stämmer med SCB:s bostadsstatistik och överskottet troligen är andra energibärare. Alternativ: en faktor för all fjärrvärme, eller ingen kalibrering.</li>' +
    '<li><b>Elandel s</b> skattas ur r = primärenergital/energiprestanda. El har högre primärenergifaktor än fjärrvärme (1,8 mot 0,7 efter 1 sep 2020; 1,6 mot 1,0 före). Regimskiftet syns tydligt i data. Saknas primärenergital används medianen i DeSO eller Malmö.</li><li><b>Emissionsfaktorer:</b> el 0,037 och fjärrvärme 0,056 kg CO₂e/kWh enligt Boverkets klimatdatabas, återgivna i Boverkets räkneexempel för modul A5. Användningen för årlig driftenergi är ett modellval. Faktorerna är nationella medelvärden och inte Malmöspecifika eller marginella.</li><li><b>Urval:</b> exakta dubbletter tas bort; en adress styrs av den senaste deklarationen; adresser väger lika; okopplade adresser får ingen vikt. ' + nf(D.energi.urval.ej_kartlagda) + ' deklarationer kunde inte kartläggas och ingår inte i DeSO-summorna (men i kalibreringen).</li></ul>' +
    '<h2>2. Mobilitet (Vägvis 2.3.1)</h2><p>Utgångsläget 2024 per DeSO hämtas från Vägvis 2.3.1: <b>A</b> = territoriell trafik på vägar i området (vägar × trafikmängd, livscykel, kalibrerad mot Malmös direkta vägtrafikutsläpp 2024), <b>B</b> = hushållens registrerade bilar × körsträcka × livscykelfaktor. B räknas om här med Vägvis egen beräkningsmotor (3 000 iterationer, seed 19062026). A och B är olika perspektiv och adderas aldrig. Framåt skalas utgångsläget med flottans klimatfaktor och förändrat trafikarbete. Nya hushåll får bilinnehav och körsträcka som värd-DeSO 2024. I A läggs deras trafik på Malmös vägnät i proportion till dagens trafik.</p>' +
    '<h2>3. Exploatering 2030–2050 (ÖP 2023)</h2><ul><li><b>Volymer:</b> bostäder, arbetsplatser och skolplatser per utbyggnadsområde från Malmö stads ÖP-underlag. BTA = bostäder × 90 m² + arbetsplatser × 25 m² (blandad stad) eller 100 m² (verksamhetsområde) + skolplatser × 10 m². Alla värden kan ändras.</li><li><b>Tid:</b> Fokus 1 byggs 2030–2039 och Fokus 2 2040–2049, jämnt fördelat. Enligt Malmö stad detaljplaneras Fokus 1 före 2030 och Fokus 2 därefter.</li><li><b>Nybyggnation (A1–A5):</b> BTA × klimatfaktor. Standard är Boverkets föreslagna gränsvärden för 2030: flerbostadshus 235, kontor/skolor 250, hallbyggnader 190 kg CO₂e/m² BTA. Alternativ: dagens referensvärden (358/383/291) eller en indikativ bana till −90 % år 2040 mot en 75-percentil som här approximeras som referensvärdet × 1,15.</li><li><b>Förändrad markanvändning:</b> utbyggnadsytan delas per DeSO och klassas med OpenStreetMap (åker, öppen mark, skog, vatten, bebyggd, okänd). Förlust = ha × hårdgörandel (0,7) × (kolförråd före − 22 t C/ha) × 44/12. Kolförråden är hämtade från Länsstyrelsen i Uppsala län (2025) och används som proxy. Utsläppet fördelas över byggåren.</li><li><b>Nya byggnaders energi:</b> BTA × 0,9 × 50 kWh/m² och år × emissionsfaktor (22 % el), från det år byggnaderna är klara.</li><li><b>Fördelning:</b> ett område som ligger i flera DeSO fördelas efter yta.</li></ul>' +
    '<h2>Osäkerhet och tolkning</h2><p>Energin i befintliga byggnader har en Monte Carlo-beräkning (standard 1 000 iterationer, seed 19062026). Varje iteration drar gemensamma fel, som påverkar alla byggnader lika, och slumpfel per byggnad. Gemensamma fel ger brett intervall för summan; slumpfel jämnas ut i summan men inte i ett litet område. Kalibreringen dras om i varje iteration, så ett för högt dragen Atemp vägs delvis upp av en lägre faktor k.</p>' +
    '<table class="quality-table"><thead><tr><th>Källa</th><th>Gemensamt fel</th><th>Slumpfel per byggnad</th></tr></thead><tbody>' +
    '<tr><td>Emissionsfaktor el / fjärrvärme</td><td>CV ' + nf(P.cvEfEl, 2) + ' / ' + nf(P.cvEfFv, 2) + ' (lognormal)</td><td>–</td></tr>' +
    '<tr><td>Atemp/BTA</td><td>CV ' + nf(M.UNC.atempFaktorCv, 2) + '</td><td>–</td></tr>' +
    '<tr><td>Våningar (per våningskälla)</td><td>CV 0,03 (building:levels) – 0,20 (industri, schablon)</td><td>CV 0,10 (building:levels) – 0,60 (saknad byggnad)</td></tr>' +
    '<tr><td>Energiprestanda, deklarerad / skattad</td><td>CV ' + nf(M.UNC.seDeklSys, 2) + ' / ' + nf(M.UNC.seKlassSys, 2) + ' per byggnadstyp</td><td>CV ' + nf(M.UNC.seDekl, 2) + ' / ' + nf(M.UNC.seSkattad, 2) + '</td></tr>' +
    '<tr><td>Elandel</td><td>±' + nf(M.UNC.elSys * 100) + ' procentenheter</td><td>±' + nf(M.UNC.elKvot * 100) + ' (kvotmetod) / ±' + nf(M.UNC.elMedian * 100) + ' (median) procentenheter</td></tr>' +
    '<tr><td>Uppvärmd andel i industri och lager</td><td>likformig ±' + nf(M.UNC.industriSpann * 100) + ' procentenheter</td><td>–</td></tr>' +
    '<tr><td>Kalibreringsmål (SCB)</td><td>CV ' + nf(P.cvKalibrering, 2) + ' per sektor</td><td>–</td></tr></tbody></table>' +
    '<p>Intervallen för framtida år skalas med årets effektivisering och förändrade emissionsfaktorer; felen antas bestå över åren. Mobilitetens 95-procentsintervall kommer från Vägvis. För exploateringen redovisas inga statistiska intervall; använd Antaganden & scenario för känslighetsanalys. Modellstrukturen ingår inte i intervallen, till exempel att all energi som inte är el antas vara fjärrvärme. Resultaten är jämförbara mellan DeSO under samma antaganden, men de är inte en officiell utsläppsstatistik.</p>' +
    '<h2>Referenser</h2><ol class="refs">' + m.referenser.map(r => '<li>' + r + '</li>').join('') + '</ol>' +
    '<h2>Licenser</h2><p class="small">Appkod: MIT. Gränssnittets stil och mobilitetsmotorn kommer från Vägvis 2.3.1 (MIT). Leaflet 1.9.4: BSD-2-Clause. OpenStreetMap-data: © OpenStreetMap contributors, ODbL 1.0. SCB:s geodata och Malmö stads öppna kartunderlag används enligt respektive villkor.</p></article>';
}

/* ---------- export ---------- */
function download(name, text, mime) { const b = new Blob([text], {type: mime}), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const csvCell = x => typeof x === 'number' ? String(Math.round(x * 1000) / 1000).replace('.', ',') : '"' + String(x ?? '').replace(/"/g, '""') + '"';
function csvDeso() {
  const v = cur(), I = EI(), head = ['deso', 'omrade', 'ar', 'perspektiv_mobilitet', ...M.COMPONENTS, 'total', 'land_ha', 'invanare', 't_per_ha', 'kg_per_ha', 't_per_invanare', 'energi_p025', 'energi_p975', 'energi_p025_fasta_ef', 'energi_p975_fasta_ef'];
  return '﻿' + head.join(';') + '\n' + v.rows.map(r => [r.id, areaName(r.id), yearLabel(P.ar), P.perspektiv, ...M.COMPONENTS.map(c => r[c]), r.total, r.land_ha, r.bef, M.metric(r, 'total', 't_ha'), M.metric(r, 'total', 'kg_ha'), M.metric(r, 'total', 't_inv'),
    I ? I.lo(r.i) : '', I ? I.hi(r.i) : '', I ? I.loA(r.i) : '', I ? I.hiA(r.i) : ''].map(csvCell).join(';')).join('\n');
}
function csvYears() { return '﻿' + ['ar', ...M.COMPONENTS, 'total', 'invanare'].join(';') + '\n' + M.cityByYear(R).map(r => [r.year, ...M.COMPONENTS.map(c => r[c]), r.total, r.bef].map(csvCell).join(';')).join('\n'); }
function csvDecl() {
  const E = D.energi.kolumner, ids = D.energi.deso;
  let out = '﻿' + ['id', 'fastighet', 'klass', 'byggnadstyp', 'energiprestanda_kwh_m2', 'primarenergital', 'ar', 'bta_m2', 'atemp_m2_kalibrerad', 'atemp_kalla', 'kalibreringsfaktor', 'elandel', 'elandel_kalla', 'deso_fordelning', 't_co2e_2024'].join(';') + '\n';
  for (let i = 0; i < E.id.length; i++) {
    const kl = E.kl ? E.kl[i] : 4, kk = kFor(kl), a = (P.atempLage === 'fast' ? P.atempFast : (E.bta[i] > 0 ? E.bta[i] * P.atempFaktor : S.btaMedian * P.atempFaktor)) * kk, s = P.elLage === 'fast' ? P.elFast : E.el[i];
    out += [E.id[i], E.fast[i], E.klass[i], S.KL[kl], E.se[i], E.ep[i] ?? '', E.ar[i], E.bta[i], a, D.energi.koder.btak[E.btak[i]], kk, s, D.energi.koder.elk[E.elk[i]], E.alloc[i].map(([d, w]) => ids[d] + ':' + (Math.round(w * 1000) / 1000)).join(' '), E.se[i] * a * (s * P.efEl + (1 - s) * P.efFv) / 1000].map(csvCell).join(';') + '\n';
  }
  return out;
}
function jsonAll() {
  const I = EI(), eb = R.energyBase;
  const osak = I ? {metod: 'Monte Carlo, energi i befintliga byggnader', iterationer: U.iterationer, seed: U.seed, ar: P.ar, arsfaktor: I.f,
    malmo_t: I.city, malmo_fasta_emissionsfaktorer_t: I.cityAktivitet, kalibreringsfaktor: U.k,
    deso_t: Object.fromEntries(S.ids.map((id, i) => [id, {p025: I.lo(i), p50: I.mid(i), p975: I.hi(i), p025_fasta_ef: I.loA(i), p975_fasta_ef: I.hiA(i)}]))} : null;
  return JSON.stringify({app: 'MalmoOP', version: M.VERSION, created: new Date().toISOString(), antaganden: P, malmo_per_ar: M.cityByYear(R), deso_valt_ar: cur().rows,
    energi_kalibrering: {lage: eb.kalibrering, grupper: eb.grupper, fjarrvarme_modell_kwh: eb.dhModell, fjarrvarme_kalibrerad_kwh: eb.dhKalibrerad}, osakerhet_energi: osak,
    utbyggnadsomraden: R.areas, kallor: D.meta.referenser}, null, 1);
}
function bindExports() {
  const map_ = {'download-csv': () => download('malmoop_deso_' + yearLabel(P.ar) + '_' + P.perspektiv + '.csv', csvDeso(), 'text/csv'), 'download-years': () => download('malmoop_malmo_per_ar_' + P.perspektiv + '.csv', csvYears(), 'text/csv'), 'download-decl': () => download('malmoop_energideklarationer.csv', csvDecl(), 'text/csv'), 'download-json': () => download('malmoop_resultat.json', jsonAll(), 'application/json'),
    'dl-deso': () => download('malmoop_deso_' + yearLabel(P.ar) + '_' + P.perspektiv + '.csv', csvDeso(), 'text/csv'), 'dl-decl': () => download('malmoop_energideklarationer.csv', csvDecl(), 'text/csv'), 'dl-years': () => download('malmoop_malmo_per_ar_' + P.perspektiv + '.csv', csvYears(), 'text/csv'), 'dl-json': () => download('malmoop_resultat.json', jsonAll(), 'application/json')};
  for (const [id, fn] of Object.entries(map_)) { const el = $(id); if (el) el.onclick = fn; }
}

/* ---------- rendering ---------- */
function render() {
  const view = $('view');
  if (map && st.view !== 'map') { map.remove(); map = null; }
  charts.length = 0;
  const html = {overview, map: mapView, calc: calcView, parameters: paramsView, expl: explView, data: dataView, method: methodView}[st.view]();
  view.innerHTML = html;
  drawCharts();
  if (st.view === 'expl') {
    document.querySelectorAll('#expl-table th[data-sort]').forEach(th => th.onclick = () => { const c = th.dataset.sort; st.explSort = [c, st.explSort[0] === c ? -st.explSort[1] : (c === 'namn' ? 1 : -1)]; render(); });
    document.querySelectorAll('[data-area]').forEach(b => b.onclick = () => { const a = D.expl.omraden.find(x => String(x.id) === b.dataset.area); const big = a.delar.slice().sort((x, y) => y.ha - x.ha)[0]; st.selected = big.deso; st.dev = true; go('map'); setTimeout(() => { if (map) map.fitBounds(window.L.geoJSON(a.geometry).getBounds(), {padding: [60, 60], maxZoom: 15}); }, 120); }); }
  if (st.view === 'map') { drawMap(); detail(); table();
    $('metric').onchange = e => { st.metric = e.target.value; render(); };
    $('unit').onchange = e => { st.unit = e.target.value; render(); };
    $('table-filter').oninput = e => { st.filter = e.target.value; table(); }; }
  if (st.view === 'calc') $('calc-pick').onchange = e => { st.selected = e.target.value; render(); };
  if (st.view === 'parameters') {
    view.querySelectorAll('[data-p]').forEach(el => el.onchange = () => { const k = el.dataset.p; let v = el.value; if (k === 'exploatering') v = v === 'true'; setP({[k]: v}); });
    $('reset-params').onclick = resetP;
  }
  bindExports();
}
function go(v) { st.view = v; renderChrome(); render(); window.scrollTo({top: 0}); }

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]'); if (nav) { e.preventDefault(); go(nav.dataset.view); return; }
  const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const y = e.target.closest('[data-year]'); if (y) { setP({ar: y.dataset.year === 'ack' ? 'ack' : Number(y.dataset.year)}); return; }
  const m = e.target.closest('.model-switch button'); if (m) { setP({perspektiv: m.dataset.model}); return; }
  const lb = e.target.closest('.link-btn[data-id]'); if (lb) { e.stopPropagation(); selectArea(lb.dataset.id, true); return; }
  if (e.target.closest('[data-u-run]')) { e.preventDefault(); runUncertainty(); }
});
$('primary-action').onclick = () => go(st.view === 'map' ? 'calc' : 'map');
$('export').onclick = () => $('export-dialog').showModal();
$('close-export').onclick = () => $('export-dialog').close();
$('print').onclick = () => { $('export-dialog').close(); window.print(); };
function resetP() { P = M.params({ar: P.ar, perspektiv: P.perspektiv}); R = M.compute(S, P); store.set(P); renderChrome(); render(); uMaybeSchedule(); }
$('reset-side').onclick = resetP;
renderChrome(); render(); uMaybeSchedule(250);
window.MalmoOPApp = {get params() { return P; }, get result() { return R; }, get uncertainty() { return U; }, get busy() { return uBusy; }, S, D, go, setP, runUncertainty};
})();
