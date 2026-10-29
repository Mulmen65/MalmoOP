/* Vägvis scenario engine. Relative changes are explicit scenario inputs.
   Vehicle-kilometre changes describe the complete activity change and are never
   multiplied by the car-ownership change a second time. No empirical local
   effect is inferred from the name of a measure. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VagvisScenarios = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2.3.0';
  const KEYS = ['cars', 'vkm', 'energy'];
  const ZERO = Object.freeze({ cars: 0, vkm: 0, energy: 0 });
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(label + ' måste vara ett ändligt tal mellan ' + min + ' och ' + max + '.');
    }
    return value;
  };
  const freeze = object => {
    Object.freeze(object);
    for (const value of Object.values(object)) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) freeze(value);
    }
    return object;
  };

  // The catalogue defines selectable interventions, not measured local effects.
  const actions = freeze([
    { id: 'parkeringspris', name: 'Parkering prissätts separat och marknadsmässigt', kind: 'level', role: 'parkering', description: 'Ange antagen förändring av bilinnehav och bilkörning vid vald prissättning.' },
    { id: 'parkeringsutbud', name: 'Färre parkeringsplatser i befintliga områden', kind: 'level', role: 'parkering', description: 'Ange antagen effekt av förändrat parkeringsutbud. Ett platsantal är inte automatiskt ett bilinnehav.' },
    { id: 'mobilitetshus', name: 'Samlad parkering i mobilitetshus', kind: 'level', role: 'parkering', description: 'Ange målgrupp och antagen effekt. Åtgärden har ingen automatisk procenteffekt.' },
    { id: 'gatuutrymme', name: 'Omfördelat gatuutrymme eller lågtrafikområde', kind: 'level', role: 'trafikmiljo', description: 'Ange antagen förändring av körningen. Omdirigerad trafik och trafik som försvinner behöver skiljas åt.' },
    { id: 'trangselskatt', name: 'Trängselskatt', kind: 'level', role: 'ekonomisk_styrning', description: 'Ange relevant geografisk omfattning och antagen förändring av hushållens bilkörning.' },
    { id: 'kollektivtrafik', name: 'Spårväg BRT eller stomlinje med hög turtäthet', kind: 'level', role: 'alternativ', description: 'Ange antagen övergång från bil. Ökat kollektivresande är inte automatiskt lika med minskad bilkörning.' },
    { id: 'elcykel', name: 'Elcykel till hushållen', kind: 'participation', role: 'alternativ', description: 'Deltagandet anges som andel av målgruppen. Effektantagandet gäller en deltagande enhet.' },
    { id: 'cykelnat', name: 'Sammanhängande cykelnät', kind: 'level', role: 'alternativ', description: 'Ange antagen minskning av bilkörning för den målgrupp som faktiskt berörs.' },
    { id: 'bilpool', name: 'Bilpool i fastigheten', kind: 'participation', role: 'delning', description: 'Ange deltagande och effekt på bilinnehav respektive all bilkörning. Ett litteraturexempel finns som ett separat scenarioförval.', presetIds: ['carsharing_pbl2015'] },
    { id: 'grontransportplan', name: 'Grön transportplan på arbetsplatsen', kind: 'participation', role: 'arbetsresor', description: 'Andel berörda hushåll och påverkan på deras hela årliga bilkörning behöver anges.' },
    { id: 'distansarbete', name: 'Distansarbete', kind: 'participation', role: 'arbetsresor', description: 'Ange nettoförändring av hela bilkörningen, inklusive andra resor och eventuell längre pendling.' },
    { id: 'radgivning', name: 'Mobilitetsrådgivning', kind: 'participation', role: 'information', description: 'Ange deltagande och ett eget dokumenterat antagande om ändrat resande.' },
    { id: 'hastighet70', name: 'Sänkt hastighet på större väg', kind: 'level', role: 'energi', description: 'Ange antagen förändring av energiåtgång per fordonskilometer för berörd körning.' },
    { id: 'sparsamkorning', name: 'Sparsam körning', kind: 'participation', role: 'energi', description: 'Ange deltagande och antagen förändring av energiåtgång per kilometer.' }
  ].map(action => Object.assign(action, {
    defaultEffects: clone(ZERO),
    defaultCoverage: 1,
    defaultIntensity: 1,
    status: 'user_scenario_required',
    assumptionId: 'SCENARIO_' + action.id.toUpperCase(),
    sourceIds: []
  })));

  const source = freeze({
    id: 'PBL_2015_CARSHARING',
    author: 'Nijland, H., van Meerkerk, J. och Hoen, A.',
    year: 2015,
    title: 'Impact of car sharing on mobility and CO2 emissions',
    publisher: 'PBL Netherlands Environmental Assessment Agency',
    report: '1842',
    url: 'https://www.pbl.nl/en/publications/impact-of-car-sharing-on-mobility-and-co2-emissions',
    accessed: '2026-10-23',
    population: 'Bilpoolsanvändare i Nederländerna i den studerade gruppen.',
    observation: 'Sammanfattningen redovisar över 30 procent lägre bilinnehav och cirka 15–20 procent färre bilkilometer efter inträde i bilpool.',
    use: 'Grund för ett valbart illustrativt överföringsscenario; ingen lokal kausal effekt skattas av Vägvis.'
  });
  const presets = freeze([
    {
      id: 'carsharing_pbl2015',
      actionId: 'bilpool',
      name: 'Bilpool litteraturexempel från Nederländerna',
      effects: { cars: -0.30, vkm: -0.175, energy: 0 },
      status: 'transferred_scenario_assumption',
      assumptionId: 'SCENARIO_PBL_TRANSFER',
      sourceIds: [source.id],
      explanation: '−30 procent för bilar är en vald avrundad nivå nära den redovisade förändringen över 30 procent. −17,5 procent för bilkilometer är mittpunkten i det redovisade intervallet 15–20 procent. Värdena är ett överfört räkneexempel för deltagande hushåll, inte en uppmätt effekt för svenska områden. Inga utsläppstal från studien används som faktor.'
    }
  ]);

  const byId = new Map(actions.map(action => [action.id, action]));
  const presetById = new Map(presets.map(preset => [preset.id, preset]));

  function initialState() {
    return Object.fromEntries(actions.map(action => [action.id, {
      enabled: false,
      coverage: action.defaultCoverage,
      intensity: action.defaultIntensity,
      effects: clone(action.defaultEffects),
      note: ''
    }]));
  }

  function resolveAction(id, item) {
    const action = byId.get(id);
    if (!action) throw new Error('Okänd åtgärd: ' + id);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Ogiltigt åtgärdsval för ' + action.name + '.');
    if (item.enabled != null && typeof item.enabled !== 'boolean') throw new Error('enabled ska vara true eller false för ' + action.name + '.');
    const preset = item.preset ? presetById.get(item.preset) : null;
    if (item.preset && (!preset || preset.actionId !== id)) throw new Error('Scenarioförvalet passar inte åtgärden ' + action.name + '.');
    const input = item.effects || (preset ? preset.effects : action.defaultEffects);
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Effekter saknas för ' + action.name + '.');
    for (const key of Object.keys(input)) if (!KEYS.includes(key)) throw new Error('Okänd effektdimension: ' + key);
    const values = Object.fromEntries(KEYS.map(key => [key, finite(input[key] == null ? 0 : input[key], action.name + ' ' + key, -1, 5)]));
    return {
      id,
      name: action.name,
      enabled: item.enabled === true,
      coverage: finite(item.coverage == null ? 1 : item.coverage, action.name + ' deltagande', 0, 1),
      intensity: finite(item.intensity == null ? 1 : item.intensity, action.name + ' genomförande', 0, 1),
      effects: values,
      note: typeof item.note === 'string' ? item.note : '',
      presetId: preset ? preset.id : null,
      assumptionId: preset ? preset.assumptionId : action.assumptionId,
      status: item.effects ? 'user_scenario_assumption' : preset ? preset.status : action.status,
      sourceIds: preset ? preset.sourceIds.slice() : []
    };
  }

  /* Each relative change is weighted by participation and implementation:
       w_j = coverage_j * intensity_j * effectScale
       F_x = product_j (1 + w_j * e_jx)
     F_vkm is the TOTAL change in vehicle-kilometres. F_cars is reported
     separately; K_after = K_before * F_vkm/F_cars where defined. */
  function effects(state = {}, options = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Åtgärdstillståndet ska vara ett objekt.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Scenarioinställningarna ska vara ett objekt.');
    if (options.combination != null && options.combination !== 'multiply') throw new Error('Endast uttryckligen multiplikativ kombination stöds.');
    const effectScale = finite(options.effectScale == null ? 1 : options.effectScale, 'Gemensam effektandel', 0, 1);
    const factors = { cars: 1, vkm: 1, energy: 1 };
    const contributions = [];
    const warnings = [];
    // Canonical catalogue order makes receipts reproducible and independent of
    // property insertion order in imported project files.
    for (const id of Object.keys(state)) if (!byId.has(id)) throw new Error('Okänd åtgärd: ' + id);
    for (const action of actions) {
      if (!Object.prototype.hasOwnProperty.call(state, action.id)) continue;
      const resolved = resolveAction(action.id, state[action.id]);
      if (!resolved.enabled) continue;
      const weight = resolved.coverage * resolved.intensity * effectScale;
      const part = Object.fromEntries(KEYS.map(key => [key, 1 + weight * resolved.effects[key]]));
      for (const key of KEYS) factors[key] *= part[key];
      if (weight > 0 && KEYS.every(key => resolved.effects[key] === 0)) {
        warnings.push('Åtgärden ' + action.name + ' saknar ett kvantifierat effektantagande. Noll är en neutral inmatning, inte belägg för utebliven effekt.');
      }
      contributions.push(Object.assign(resolved, { weight, factors: part }));
    }
    if (contributions.filter(x => x.weight > 0).length > 1) {
      warnings.push('Kombinationen multiplicerar återstående andelar. Samma beteendeförändring kan ingå i flera antaganden; kontrollera överlapp och använd vid behov en lägre gemensam effektandel.');
    }
    return {
      version: VERSION,
      method: 'weighted_remaining_fractions',
      combination: 'multiply',
      effectScale,
      fCars: factors.cars,
      fVkm: factors.vkm,
      fEnergy: factors.energy,
      fKmPerCar: factors.cars > 0 ? factors.vkm / factors.cars : factors.vkm === 0 ? 0 : null,
      contributions,
      warnings,
      assumptionId: 'SCENARIO_MULTIPLICATIVE_COMBINATION',
      combinationStatus: 'model_assumption'
    };
  }

  function apply(baseline, state = {}, options = {}) {
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('Basfallet ska vara ett objekt.');
    const cars = finite(baseline.cars, 'Bilar i basfallet', 0, 1e12);
    const vkm = finite(baseline.vkm, 'Fordonskilometer i basfallet', 0, 1e15);
    if (cars === 0 && vkm > 0) throw new Error('Positiv körning kräver ett positivt modellerat bilantal.');
    const result = effects(state, options);
    const afterCars = cars * result.fCars;
    const afterVkm = vkm * result.fVkm;
    if (afterCars === 0 && afterVkm > 0) throw new Error('Scenariot ger inga modellerade bilar men positiv körning. Justera antagandena om bilar och fordonskilometer.');
    const before = { cars, vkm, kmPerCar: cars > 0 ? vkm / cars : 0 };
    const after = {
      cars: afterCars,
      vkm: afterVkm,
      kmPerCar: afterCars > 0 ? afterVkm / afterCars : 0,
      energyPerKmFactor: result.fEnergy
    };
    if (baseline.households != null) {
      before.households = finite(baseline.households, 'Hushåll i basfallet', 0, 1e12);
      after.households = before.households;
      before.carsPerHousehold = before.households > 0 ? cars / before.households : 0;
      after.carsPerHousehold = after.households > 0 ? afterCars / after.households : 0;
    }
    return {
      before,
      after,
      difference: { cars: afterCars - cars, vkm: afterVkm - vkm },
      effects: result
    };
  }

  return freeze({ VERSION, actions, presets, sources: [source], initialState, effects, apply });
});
