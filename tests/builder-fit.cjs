const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../builder-core'),fit=require('../builder-fit'),catalog=require('../data/builder-catalog.json');
const needs=(overrides={})=>({fitVersion:1,usages:['game'],appNames:['PUBG'],budget:50000,resolution:'1440p',color:'any',gameQuality:'high',targetFps:60,...overrides});
test('2K office, light competitive games and PUBG produce different hardware requirements',()=>{
 const office=core.compileExperience(needs({usages:['office'],appNames:['Microsoft Excel']})),light=core.compileExperience(needs({appNames:['英雄聯盟（LOL）']})),pubg=core.compileExperience(needs());
 assert.equal(office.gpuModels,null);assert.ok(light.gpuMin<pubg.gpuMin);assert.ok(pubg.minVramGB>=12);assert.equal(pubg.resolution,'1440p');assert.match(pubg.goalLabel,/2560×1440/);
});
test('budget materially changes recommended allocation while keeping the same 2K target',()=>{
 const lower=core.plans(catalog.products,needs({budget:46000})).find(p=>p.key==='balanced'),higher=core.plans(catalog.products,needs({budget:50000})).find(p=>p.key==='balanced');
 assert.equal(lower.missing.length,0);assert.equal(higher.missing.length,0);assert.ok(lower.total<=46000);assert.ok(higher.total<=50000);assert.notDeepEqual(lower.ids,higher.ids);assert.ok(fit.gpuClass(core.resolve(higher.ids,catalog.products).gpu)>=fit.gpuClass(core.resolve(lower.ids,catalog.products).gpu));assert.equal(higher.needs.resolution,'1440p');
});
test('budget search considers DDR4 platforms instead of enforcing a universal DDR5 floor',()=>{
 const p=core.plans(catalog.products,needs({appNames:['英雄聯盟（LOL）'],budget:30000})).find(p=>p.key==='balanced'),parts=core.resolve(p.ids,catalog.products);assert.equal(p.missing.length,0);assert.ok(p.total<=30000);assert.equal(parts.ram.facts.ddr,'DDR4');assert.equal(core.validate(parts,p.needs).errors.length,0);assert.match(parts.gpu.facts.gpuModel,/RTX/);
});
test('unaffordable targets remain explicit and compromises preserve resolution and require confirmation',()=>{
 const options=core.plans(catalog.products,needs({budget:30000})),original=options.find(p=>p.key==='balanced'),trade=options.find(p=>p.key==='tradeoff');assert.ok(original.overBudget>0);assert.equal(original.fit.withinBudget,false);assert.equal(original.needs.gameQuality,'high');assert.ok(trade);assert.equal(trade.requiresConfirmation,true);assert.equal(trade.needs.resolution,'1440p');assert.equal(trade.needs.gameQuality,'medium');assert.ok(trade.total<original.total);assert.equal(trade.fit.withinBudget,trade.total<=30000);
});
test('144 FPS and extreme quality increase explicit constraints; no benchmark FPS is invented',()=>{
 const standard=core.compileExperience(needs()),fast=core.compileExperience(needs({targetFps:144})),ultra=core.compileExperience(needs({gameQuality:'ultra'}));assert.ok(fast.cpuMin>standard.cpuMin);assert.ok(fast.ramGB>=32);assert.ok(ultra.gpuMin>standard.gpuMin);assert.match(fast.goalLabel,/144 FPS.*推估/);assert.ok(fast.fitSources.every(s=>s.url.startsWith('https:')&&s.checkedAt==='2026-10-23'));
});
test('all offered builds respect prices, compatibility, appearance and preferred brands without spending the entire budget',()=>{
 for(const raw of [needs(),needs({budget:80000,color:'allwhite'}),needs({usages:['office'],appNames:['Microsoft Excel'],budget:100000}),needs({usages:['office'],appNames:['Microsoft Excel'],workloadLevel:'heavy',budget:100000})]){
  const options=core.plans(catalog.products,raw);assert.ok(options.length>=1&&options.length<=3);const signatures=new Set();for(const p of options){const parts=core.resolve(p.ids,catalog.products);assert.equal(p.total,Object.values(parts).reduce((n,x)=>n+x.price,0));assert.equal(p.overBudget,Math.max(0,p.total-raw.budget));assert.equal(core.validate(parts,p.needs).errors.length,0);for(const[k,x]of Object.entries(parts))assert.ok(core.preferred(x,k));if(raw.color==='allwhite')for(const key of ['board','ram','gpu','cooler','case','psu'])if(parts[key])assert.equal(core.colorOf(parts[key]),'white');const sig=JSON.stringify(p.ids);assert.ok(!signatures.has(sig));signatures.add(sig);if(raw.workloadLevel==='heavy'&&parts.ram)assert.ok(parts.ram.facts.capacityGB>=64);if(!p.missing.length)assert.ok(parts.psu.facts.watts>=p.needs.minPsuWatts);}
  if(raw.usages[0]==='office'&&raw.workloadLevel!=='heavy'){const p=options.find(p=>p.key==='balanced');assert.ok(p.total<50000);assert.equal(p.ids.gpu,undefined);}
 }
});
test('unknown software and advanced text stay uncovered; summaries preserve exact goals and separate add-ons',()=>{
 const p=core.plans(catalog.products,needs({appNames:['PUBG','未知模組'],advancedNotes:'光追 240 FPS'})).find(p=>p.key==='balanced');assert.ok(p.needs.unmapped.some(s=>s.includes('未知模組')));assert.ok(p.needs.unmapped.some(s=>s.includes('補充文字')));const text=core.summary({...p.needs,experienceVersion:1},core.resolve(p.ids,catalog.products),catalog);assert.match(text,/本次選配目標/);assert.match(text,/2560×1440/);assert.match(text,/周邊由客戶另外選配/);
});
test('selecting a higher power GPU also raises the PSU constraint',()=>{
 const sample=catalog.products.find(p=>p.category===12&&p.facts.gpuModel==='RTX5070'),fixture={...sample,id:'fixture-5080',name:'華碩 RTX5080 16G 測試資料',price:1000,facts:{...sample.facts,gpuModel:'RTX5080',lengthMM:200}};
 const p=core.plans([...catalog.products,fixture],needs({resolution:'4k',budget:100000})).find(p=>p.key==='balanced'),parts=core.resolve(p.ids,[...catalog.products,fixture]);assert.equal(p.missing.length,0);assert.equal(parts.gpu.id,fixture.id);assert.ok(parts.psu.facts.watts>=850);assert.ok(p.needs.minPsuWatts>=850);
});
