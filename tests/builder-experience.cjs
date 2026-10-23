const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../builder-core.js'),policy=core.policy,catalog=require('../data/builder-catalog.json');
const request=extra=>({experienceVersion:1,usages:['game'],appNames:['特戰英豪（VALORANT）'],appKinds:{'特戰英豪（VALORANT）':'game'},experience:'balanced',resolution:'1440p',simultaneous:'unknown',budget:50000,color:'allwhite',...extra});
const compile=extra=>core.compileExperience(request(extra),[]);
test('common real customer cases produce complete, compatible plans instead of stopping for manual configuration',()=>{
 const cases=[['Grand Theft Auto V Enhanced'],['Grand Theft Auto V Legacy'],['Grand Theft Auto V Enhanced','英雄聯盟（LOL）'],['Grand Theft Auto V Enhanced','Microsoft Excel'],['Counter-Strike 2','Apex Legends','PUBG'],['Minecraft']];
 for(const appNames of cases){const n=compile({appNames,color:'any'}),p=core.plan(catalog.products,n),v=core.validate(core.resolve(p.ids,catalog.products),n);assert.deepEqual(p.missing,[],appNames.join(','));assert.deepEqual(v.errors,[]);assert.equal(n.requiresReview,false);assert.equal(n.partial,false);assert.ok(p.total>0);assert.ok(!p.warnings.some(x=>/請 DK|人工/.test(x)));}
});
test('unknown applications are locally uncovered; known goals and an automatic starting plan survive',()=>{
 const n=compile({appNames:['Grand Theft Auto V Enhanced','不明遊戲'],color:'any'}),p=core.plan(catalog.products,n);assert.equal(n.partial,true);assert.equal(n.coverage[0].state,'estimate');assert.equal(n.coverage[1].state,'uncovered');assert.deepEqual(p.missing,[]);assert.ok(n.unmapped.some(x=>x.includes('不明遊戲')));assert.ok(n.hasGameRule);
});
test('multiple uses combine per-component requirements and installed storage, without averaging game scores',()=>{
 const a=compile({appNames:['英雄聯盟（LOL）'],color:'any'}),b=compile({appNames:['Grand Theft Auto V Enhanced'],color:'any'}),mix=compile({appNames:['英雄聯盟（LOL）','Grand Theft Auto V Enhanced'],color:'any',workloadLevel:'video4k',simultaneous:'yes'});
 assert.ok(mix.cpuTier>=Math.max(a.cpuTier,b.cpuTier));assert.ok(mix.gpuTier>=Math.max(a.gpuTier,b.gpuTier));assert.ok(mix.ramGB>=32);assert.ok(mix.ssdGB>=2000);assert.deepEqual(core.plan(catalog.products,mix).missing,[]);
});
test('office workloads auto-configure, heavy reports reserve memory and do not require a gaming GPU',()=>{
 const n=compile({usages:['office'],appNames:['Microsoft Excel'],workloadLevel:'heavy',color:'any'});assert.equal(n.ramGB,64);assert.equal(n.gpuModels,null);assert.equal(n.partial,false);const p=core.plan(catalog.products,n);assert.deepEqual(p.missing,[]);assert.equal(p.ids.gpu,undefined);
});
test('unknown monitor is an explicit provisional 1080p assumption; 4K is a policy estimate without invented FPS',()=>{
 const n=compile({resolution:'unknown',color:'any'});assert.ok(n.questions.some(x=>/1080P/.test(x)));assert.equal(n.partial,true);assert.deepEqual(core.plan(catalog.products,n).missing,[]);
 const four=compile({resolution:'4k',color:'any'});assert.equal(four.partial,false);assert.ok(four.gpuTier>n.gpuTier);assert.ok(four.ruleNotes.some(x=>/不是.*幀數/.test(x)));assert.deepEqual(core.plan(catalog.products,four).missing,[]);assert.ok(!four.targets.some(t=>/144|240/.test(t)));
});
test('unparsed advanced/mod workload remains uncovered while structured simultaneous requirements are incorporated',()=>{
 const n=compile({advancedNotes:'必須 240 FPS、光追',simultaneous:'yes',workload:'特殊模組'});assert.ok(n.unmapped.some(x=>/補充文字/.test(x)));assert.ok(n.ramGB>=32);assert.equal(n.requiresReview,false);assert.ok(Object.keys(core.plan(catalog.products,n).ids).length>0);const text=core.summary(n,{},catalog);assert.match(text,/240 FPS/);assert.match(text,/特殊模組/);assert.match(text,/不承諾每款遊戲/);
});
test('insufficient budget preserves white appearance and original targets; never pretends the sum fits',()=>{
 const n=compile({appNames:['Grand Theft Auto V Enhanced'],budget:10000}),p=core.plan(catalog.products,n),selected=core.resolve(p.ids,catalog.products);assert.ok(p.overBudget>0);assert.deepEqual(p.missing,[]);for(const slot of ['board','ram','gpu','cooler','case','psu'])assert.equal(core.colorOf(selected[slot]),'white');
});
test('external hardware facts use explicit mapping; unrecognized and missing hardware never acquire made-up tiers',()=>{
 const base={name:'New Game',kind:'game',sourceUrl:'https://store.steampowered.com/app/123/',cpu:'Ryzen 5 3600',gpu:'RTX 3060',ramGB:16,storageGB:120};assert.ok(policy.fromRequirements(base));for(const extra of [{cpu:'Future CPU 999'},{gpu:'unknown GPU'},{ramGB:NaN},{storageGB:9000}])assert.equal(policy.fromRequirements({...base,...extra}),null);
 const profile=policy.fromRequirements(base),n=compile({appNames:['New Game'],researchProfiles:[profile]});assert.equal(n.partial,false);assert.equal(n.coverage[0].state,'estimate');
});
