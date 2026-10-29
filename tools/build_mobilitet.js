/* Bygg mobilitetsunderlaget per DeSO ur Vägvis 2.3.1.
   Modell A: färdigberäknat resultat (result.json, 3 000 iterationer, seed 19062026).
   Modell B: körs här med Vägvis egen beräkningsmotor (tools/vagvis_engine, MIT) för Malmö,
   både med kommunens körsträcka per bil (local, Vägvis standard) och med DeSO-skattning med GTFS-utbud.
   Kör: node tools/build_mobilitet.js  ->  data/mobilitet_vagvis.json */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), SRC = path.join(ROOT, 'data/kalla/vagvis_2_3_1');
const V = require('./vagvis_engine/core.js'), H = require('./vagvis_engine/households.js');
const read = f => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const om = read('omraden.json'), hp = read('household-project.json'), dist = read('distance-indicators.json'), resA = read('result.json');
const proj = V.unpackProject(hp, om); proj.distanceData = dist;
const pick = r => ({total: r.central.total, ttw: r.central.ttw, wtt: r.central.wtt, fordon: r.central.vehicle + r.central.battery + r.central.maintenance + r.central.endoflife,
  vkm: r.central.vkm, p025: r.base.p025, p975: r.base.p975, mean: r.base.mean});
(async () => {
  const out = {schema: 'malmoop-mobilitet-1', kalla: 'Vägvis 2.3.1 (Mulmen65/vagvisa), beräkningsår 2024, DeSO 2025', skapad: new Date().toISOString(),
    A: {}, B_local: {}, B_gtfs: {}, hushall: {}, stad: {}};
  for (const r of resA.results.filter(r => r.city === '1280')) {
    if (r.level === 'deso') out.A[r.id] = pick(r); else if (r.level === 'city') out.stad.A = pick(r);
  }
  out.A_metadata = {created: resA.created, iterations: resA.config.iterations, seed: resA.config.seed, calibration: resA.calibration['1280|all'], reference: resA.reference.find(x => x.city === '1280')};
  for (const [key, mode] of [['B_local', 'local'], ['B_gtfs', 'deso_gtfs']]) {
    const cfg = {...hp.config, household: {kmMode: mode}};
    const res = await H.simulate(proj, cfg, () => {});
    for (const r of res.results.filter(r => r.city === '1280')) {
      const v = {...pick(r), cars: r.central.cars, hushall: r.central.households, bef: r.central.population};
      if (r.level === 'deso') out[key][r.id] = v; else if (r.level === 'city') out.stad[key] = v;
    }
    out[key + '_config'] = {kmMode: mode, iterations: cfg.iterations, seed: cfg.seed};
  }
  for (const r of hp.d.filter(r => String(r.kk) === '1280')) out.hushall[r.kod] = {hh: r.hh, bef: r.bef, bil: r.bil, km: r.km, regso: r.rs, regsoNamn: r.regsoName};
  fs.writeFileSync(path.join(ROOT, 'data/mobilitet_vagvis.json'), JSON.stringify(out));
  console.log('A DeSO', Object.keys(out.A).length, 'B DeSO', Object.keys(out.B_local).length, 'stad A', Math.round(out.stad.A.total), 'B', Math.round(out.stad.B_local.total));
})();
