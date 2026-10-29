/* Beräkningstester för MalmoOP. Kör: node tests/test_model.js */
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'app/model.js'));
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const D = {deso: read('data/kalla/deso_2025_malmo.geojson'), energi: read('data/energi_deklarationer.json'), mob: read('data/mobilitet_vagvis.json'), expl: read('data/exploatering_op2023.json')};
const S = M.prepare(D);
const sum = a => Array.from(a).reduce((x, y) => x + y, 0);
const near = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), msg + ' ' + a + ' ≠ ' + b);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓ ' + name); }

test('209 DeSO och samma ordning i energi och geometri', () => { assert.strictEqual(S.n, 209); assert.deepStrictEqual(D.energi.deso, S.ids); });

test('DeSO-summor = Malmö-summor för varje år och komponent', () => {
  const R = M.compute(S, {});
  for (const ar of [...M.YEARS, 'ack']) {
    const v = M.view(S, R, ar);
    for (const c of [...M.COMPONENTS, 'total']) near(v.rows.reduce((s, r) => s + r[c], 0), v.city[c], 1e-9, ar + ' ' + c);
    near(v.city.total, M.COMPONENTS.reduce((s, c) => s + v.city[c], 0), 1e-9, 'total ' + ar);
  }
});

test('Energins massbalans: kartlagt + ej kartlagt = alla deklarationer (bara deklarerade, okalibrerat)', () => {
  const P = M.params({bestand: 'deklarerade'}), eb = M.energyBase(S, P), E = D.energi.kolumner;
  let all = 0;
  for (let i = 0; i < E.id.length; i++) {
    const a = E.bta[i] > 0 ? E.bta[i] * P.atempFaktor : S.btaMedian * P.atempFaktor;
    all += E.se[i] * a * (E.el[i] * P.efEl + (1 - E.el[i]) * P.efFv) / 1000;
  }
  near(sum(eb.t) + eb.unmappedT, all, 1e-9, 'massbalans');
  assert.strictEqual(eb.unmapped, D.energi.urval.ej_kartlagda);
  assert.strictEqual(eb.k, 1); assert.strictEqual(eb.kalibrering, 'ingen');
});

test('Hela beståndet: massbalans med kalibreringsfaktor per post', () => {
  const P = M.params({}), eb = M.energyBase(S, P), it = M.energyItems(S, P);
  assert.strictEqual(it.m, D.energi.kolumner.id.length + D.energi.bestand.bta.length);
  let all = 0;
  for (let i = 0; i < it.m; i++) all += eb.kG[it.grp[i]] * it.se[i] * it.a[i] * (it.el[i] * P.efEl + (1 - it.el[i]) * P.efFv) / 1000;
  near(sum(eb.t) + eb.unmappedT, all, 1e-9, 'massbalans hela');
  near(sum(eb.skattadT), D.energi.bestand.bta.reduce((s, b, j) => { const kl = D.energi.bestand.kl[j], a = b * P.atempFaktor * (kl === S.IND ? P.industriAndel : 1), el = D.energi.bestand.el[j];
    return s + eb.kG[S.GRP[kl]] * D.energi.bestand.se[j] * a * (el * P.efEl + (1 - el) * P.efFv) / 1000; }, 0), 1e-9, 'skattade byggnader');
  assert.ok(sum(eb.t) > sum(M.energyBase(S, M.params({bestand: 'deklarerade', kalibrering: 'ingen'})).t), 'hela beståndet ger mer än bara deklarerade');
});

test('Kalibrering: fjärrvärmen möter SCB per sektor eller totalt', () => {
  const kal = D.energi.kalibrering, sek = M.energyBase(S, M.params({kalibrering: 'sektor'}));
  assert.strictEqual(sek.kalibrering, 'sektor'); assert.strictEqual(sek.kG[0], 1, 'småhus kalibreras inte');
  near(sek.grupper[1].modell * sek.kG[1], kal.sektor_mal_mwh.flerbostadshus * 1000, 1e-9, 'flerbostadshus');
  near(sek.grupper[2].modell * sek.kG[2], kal.sektor_mal_mwh.lokal_industri * 1000, 1e-9, 'lokaler och industri');
  near(sek.dhKalibrerad, sek.grupper[0].modell + (kal.sektor_mal_mwh.flerbostadshus + kal.sektor_mal_mwh.lokal_industri) * 1000, 1e-9, 'summa sektor');
  const tot = M.energyBase(S, M.params({kalibrering: 'total'}));
  near(tot.dhKalibrerad, kal.mal_fjarrvarme_mwh * 1000, 1e-9, 'total');
  near(tot.k, kal.mal_fjarrvarme_mwh * 1000 / tot.dhModell, 1e-12, 'k total');
  const ingen = M.energyBase(S, M.params({kalibrering: 'ingen'}));
  near(ingen.dhKalibrerad, ingen.dhModell, 1e-12); near(ingen.dhModell, tot.dhModell, 1e-12, 'samma okalibrerade modell');
  near(kal.sektor_mal_mwh.smahus + kal.sektor_mal_mwh.flerbostadshus + kal.sektor_mal_mwh.lokal_industri, kal.mal_fjarrvarme_mwh, 1e-5, 'sektorer = total');
  assert.strictEqual(M.params({kalibrering: 'scb'}).kalibrering, 'total', 'äldre värde scb tolkas som total');
});

test('Räkneexempel energi: 100 kWh/m², 1 000 m², 10 % el = 5,41 t', () => {
  const t = 100 * 1000 * (0.1 * 0.037 + 0.9 * 0.056) / 1000;
  near(t, 5.41, 1e-12);
  const P = M.params({atempLage: 'fast', atempFast: 1000, elLage: 'fast', elFast: 0.1, bestand: 'deklarerade'}), eb = M.energyBase(S, P), E = D.energi.kolumner;
  let mapped = 0; for (let i = 0; i < E.id.length; i++) if (E.alloc[i].length) mapped += E.se[i] * 1000 * (0.1 * 0.037 + 0.9 * 0.056) / 1000;
  near(sum(eb.t), mapped, 1e-9, 'fast läge');
});

test('Mobilitet 2024 = Vägvis Malmö-summor (A och B)', () => {
  near(M.view(S, M.compute(S, {perspektiv: 'A'}), 2024).city.mobilitet, D.mob.stad.A.total, 1e-6, 'A');
  near(M.view(S, M.compute(S, {perspektiv: 'B'}), 2024).city.mobilitet, D.mob.stad.B_local.total, 1e-6, 'B');
  near(M.view(S, M.compute(S, {perspektiv: 'B', bLage: 'gtfs'}), 2024).city.mobilitet, D.mob.stad.B_gtfs.total, 1e-6, 'B gtfs');
});

test('Utan exploatering är exploateringsposterna noll', () => {
  const v = M.view(S, M.compute(S, {exploatering: false}), 'ack');
  for (const c of ['bygg', 'mark', 'nydrift', 'nymob']) assert.strictEqual(v.city[c], 0, c);
});

test('Nybyggnation 2030–2050 = Σ BTA × gränsvärde / 1 000', () => {
  const P = M.params({}), v = M.view(S, M.compute(S, P), 'ack');
  let exp = 0;
  for (const a of D.expl.omraden) {
    const lok = a.kategori === 'Verksamhetsområde' ? ['hall', P.btaArbVerks] : ['lokal', P.btaArbBlandad];
    exp += (a.bostader * P.btaBostad * M.BYGG.gransvarde2030.bostad + a.arbetsplatser * lok[1] * M.BYGG.gransvarde2030[lok[0]] + (a.forskola + a.grundskola + a.gymnasie) * P.btaSkolplats * M.BYGG.gransvarde2030.skola) / 1000;
  }
  near(v.city.bygg, exp, 1e-9, 'bygg');
});

test('Markförlust = Σ ha × hårdgörandel × (C före − C efter) × 44/12', () => {
  const P = M.params({}), v = M.view(S, M.compute(S, P), 'ack'), C = {aker: P.kolAker, oppen: P.kolOppen, skog: P.kolSkog, vatten: 0, bebyggd: P.kolBebyggd, okand: P.kolBebyggd};
  let exp = 0;
  for (const a of D.expl.omraden) for (const d of a.delar) for (const [k, ha] of Object.entries(d.mark)) exp += ha * P.hardgorandel * Math.max(0, C[k] - P.kolBebyggd) * 44 / 12;
  near(v.city.mark, exp, 1e-9, 'mark');
});

test('Tidsplan: ingen nybyggnation 2024 eller 2050; Fokus 1 klar 2040', () => {
  const R = M.compute(S, {});
  assert.strictEqual(M.view(S, R, 2024).city.bygg, 0);
  assert.strictEqual(M.view(S, R, 2050).city.bygg, 0);
  const f1 = D.expl.omraden.filter(a => a.fokus === 1).reduce((s, a) => s + a.bostader, 0);
  near(M.view(S, R, 2040).city.nyaInv, f1 * M.DEFAULTS.personerPerBostad, 1e-9, 'nya invånare 2040');
});

test('Nya invånare 2050 = alla bostäder × invånare per bostad', () => {
  const v = M.view(S, M.compute(S, {}), 2050), b = D.expl.omraden.reduce((s, a) => s + a.bostader, 0);
  near(v.city.nyaInv, b * M.DEFAULTS.personerPerBostad, 1e-9);
  near(v.city.bef, sum(S.hh.map(h => h.bef)) + b * M.DEFAULTS.personerPerBostad, 1e-9);
});

test('Ny mobilitet: B i värd-DeSO, A fördelad efter trafik; flottfaktor skalar', () => {
  const vB = M.view(S, M.compute(S, {perspektiv: 'B'}), 2050), vA = M.view(S, M.compute(S, {perspektiv: 'A'}), 2050);
  const host = new Set(D.expl.omraden.flatMap(a => a.delar.map(d => d.deso)));
  assert.ok(vB.rows.every(r => host.has(r.id) || r.nymob === 0), 'B utanför värd-DeSO');
  assert.ok(vA.rows.filter(r => r.mobilitet > 0).every(r => r.nymob > 0), 'A fördelas till alla med trafik');
  const half = M.view(S, M.compute(S, {perspektiv: 'B', flotta2050: 0.5}), 2050);
  near(half.city.nymob, vB.city.nymob * 0.5, 1e-9, 'flotta');
  near(half.city.mobilitet, vB.city.mobilitet * 0.5, 1e-9, 'flotta befintlig');
});

test('Enheter: kg/ha = 1 000 × t/ha; per invånare', () => {
  const v = M.view(S, M.compute(S, {}), 2030), r = v.rows.find(x => x.land_ha > 0 && x.bef > 0);
  near(M.metric(r, 'total', 'kg_ha'), 1000 * M.metric(r, 'total', 't_ha'), 1e-12);
  near(M.metric(r, 'total', 't_inv'), r.total / r.bef, 1e-12);
});

test('Effektivisering och emissionsfaktorer verkar linjärt till 2050', () => {
  const base = M.view(S, M.compute(S, {}), 2050).city.energi;
  near(M.view(S, M.compute(S, {effektivisering2050: 30}), 2050).city.energi, base * 0.7, 1e-9, 'eff');
  near(M.view(S, M.compute(S, {efForandring2050: -50}), 2050).city.energi, base * 0.5, 1e-9, 'ef');
  near(M.view(S, M.compute(S, {effektivisering2050: 30}), 2024).city.energi, base, 1e-9, '2024 oförändrat');
});

test('Ogiltiga antaganden avvisas eller begränsas', () => {
  const P = M.params({efEl: -5, atempFaktor: 'abc', perspektiv: 'C', ar: 2033, f1Start: 2035, f1Slut: 2030, okänd: 1});
  assert.strictEqual(P.efEl, 0); assert.strictEqual(P.atempFaktor, M.DEFAULTS.atempFaktor); assert.strictEqual(P.perspektiv, 'A');
  assert.strictEqual(P.ar, M.DEFAULTS.ar); assert.ok(P.f1Slut > P.f1Start); assert.ok(!('okänd' in P));
});

test('Indikativ bana: gränsvärde 2030, −90 % mot 75-percentilproxy 2040', () => {
  const P = M.params({klimatBygg: 'bana'});
  near(M.byggFaktor(P, 'bostad', 2030), 235, 1e-12);
  near(M.byggFaktor(P, 'bostad', 2040), 0.1 * 358 * M.P75_PROXY, 1e-12);
  near(M.byggFaktor(P, 'bostad', 2035), (235 + 0.1 * 358 * M.P75_PROXY) / 2, 1e-12);
});

test('Varje utbyggnadsområde fördelas fullt ut på DeSO', () => {
  for (const a of D.expl.omraden) near(a.delar.reduce((s, d) => s + d.andel, 0), 1, 1e-4, a.namn);
});

test('Deklarationernas DeSO-vikter summerar till 1', () => {
  const E = D.energi.kolumner;
  for (let i = 0; i < E.id.length; i++) if (E.alloc[i].length) near(E.alloc[i].reduce((s, [, w]) => s + w, 0), 1, 1e-3, 'id ' + E.id[i]);
});

(async () => {
  const P = {iterationer: 200, seed: 42};
  const a = await M.simulateEnergy(S, P), b = await M.simulateEnergy(S, P), c = await M.simulateEnergy(S, {...P, seed: 43});
  test('Monte Carlo: samma seed ger samma resultat, annat seed ett annat', () => {
    assert.deepStrictEqual(Array.from(a.deso.p50), Array.from(b.deso.p50));
    assert.strictEqual(a.city.p975, b.city.p975);
    assert.notStrictEqual(a.city.p50, c.city.p50);
    assert.strictEqual(a.nyckel, M.uncertaintyKey(M.params(P)));
  });
  test('Monte Carlo: p2,5 ≤ p50 ≤ p97,5 och beräknat värde inom intervallet', () => {
    for (let d = 0; d < S.n; d++) assert.ok(a.deso.p025[d] <= a.deso.p50[d] + 1e-9 && a.deso.p50[d] <= a.deso.p975[d] + 1e-9, 'DeSO ' + d);
    const det = sum(M.energyBase(S, M.params(P)).t);
    assert.ok(a.city.p025 < det && det < a.city.p975, 'Malmö ' + det);
    assert.ok(a.cityAktivitet.p975 - a.cityAktivitet.p025 < a.city.p975 - a.city.p025, 'fasta faktorer ger smalare intervall');
  });
  const z = await M.simulateEnergy(S, {iterationer: 100, atempLage: 'fast', elLage: 'fast', cvEfEl: 0, cvEfFv: 0, bestand: 'deklarerade', seed: 7});
  test('Monte Carlo: fasta emissionsfaktorer ger samma intervall för total och aktivitetsdata', () => {
    near(z.city.p025, z.cityAktivitet.p025, 1e-9); near(z.city.p975, z.cityAktivitet.p975, 1e-9);
  });
  test('Intervall för framtida år skalas med effektivisering och emissionsfaktorer', () => {
    const Q = M.params({effektivisering2050: 30, efForandring2050: -20});
    const I24 = M.energyInterval(a, Q, 2024), I50 = M.energyInterval(a, Q, 2050), Iack = M.energyInterval(a, Q, 'ack');
    near(I24.city.p975, a.city.p975, 1e-12); near(I50.f, 0.7 * 0.8, 1e-12); near(I50.hi(5), a.deso.p975[5] * 0.7 * 0.8, 1e-12);
    const R = M.compute(S, Q); near(M.view(S, R, 'ack').city.energi, sum(R.energyBase.t) * Iack.f, 1e-9, 'ack-faktor');
  });
  const stop = await M.simulateEnergy(S, {iterationer: 500}, p => p < 0.2);
  test('Avbruten Monte Carlo returnerar null', () => assert.strictEqual(stop, null));
  console.log('\n' + passed + ' beräkningstester godkända.');
})().catch(e => { console.error(e); process.exit(1); });
