const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../builder-core.js'),games=require('../data/builder-games.json').games,apps=require('../builder-apps.js'),catalog=require('../data/builder-catalog.json');
const request=extra=>({experienceVersion:1,usages:['game'],appNames:['特戰英豪（VALORANT）'],appKinds:{'特戰英豪（VALORANT）':'game'},experience:'balanced',resolution:'1440p',simultaneous:'unknown',budget:50000,color:'allwhite',...extra});
test('one global resolution chooses only an explicit sourced target and can produce a whole PC',()=>{
 const n=core.compileExperience(request(),games,apps),p=core.plan(catalog.products,n);assert.equal(n.gameTargets.valorant,'1440p-high-144');assert.equal(n.requiresReview,false);assert.equal(Object.keys(p.ids).length,8);assert.equal(p.total,49538);
});
test('unknown resolution and unsupported 4K never inherit 1080p or unqualified official FPS',()=>{
 for(const resolution of ['unknown','4k']){const n=core.compileExperience(request({resolution}),games,apps);assert.equal(n.gameTargets.valorant,undefined);assert.equal(n.requiresReview,true);assert.deepEqual(core.plan(catalog.products,n).ids,{});}
});
test('resolving a missing monitor clears a previous pending state instead of permanently blocking the draft',()=>{
 const a=core.compileExperience(request({resolution:'unknown'}),games,apps),b=core.compileExperience({...a,resolution:'1440p'},games,apps);assert.equal(a.requiresReview,true);assert.equal(b.requiresReview,false);assert.equal(Object.keys(core.plan(catalog.products,b).ids).length,8);
});
test('a discoverable name is not a verified performance rule; software is never treated as an unknown game',()=>{
 const names=['特戰英豪（VALORANT）','Microsoft Excel'],n=core.compileExperience(request({appNames:names}),games,apps);assert.equal(n.hasGameRule,true);assert.ok(n.unmapped.some(x=>x.includes('Microsoft Excel：軟體')));assert.ok(!n.unmapped.some(x=>x.includes('Microsoft Excel：尚無效能')));assert.deepEqual(core.plan(catalog.products,n).ids,{});
 const only=core.compileExperience(request({usages:['office'],appNames:['Microsoft Word']}),games,apps);assert.equal(only.requiresReview,true);assert.deepEqual(core.plan(catalog.products,only).ids,{});
});
test('multiple games combine supported model sets and per-component capacity needs without ranking entire games',()=>{
 const a={id:'a',name:'A',targets:[{id:'t',resolution:'1440p',selectionRules:[{resolutions:['1440p'],cpuModels:['7500F','7700'],gpuModels:['RTX5050','RTX5060'],ramGB:16,ssdGB:1000,sourceUrls:[]}]}]},b={id:'b',name:'B',targets:[{id:'t',resolution:'1440p',selectionRules:[{resolutions:['1440p'],cpuModels:['7700'],gpuModels:['RTX5060'],ramGB:32,ssdGB:2000,sourceUrls:[]}]}]};
 const n=core.compileExperience(request({appNames:['A','B'],appKinds:{A:'game',B:'game'}}),[a,b],[]);assert.deepEqual(n.cpuModels,['7700']);assert.deepEqual(n.gpuModels,['RTX5060']);assert.equal(n.ramGB,32);assert.equal(n.ssdGB,2000);
});
test('advanced performance requests and simultaneous workloads need review; monitor Hz is never an FPS guarantee',()=>{
 for(const extra of [{advancedNotes:'希望 240 FPS、光追'},{simultaneous:'yes'}]){const n=core.compileExperience(request(extra),games,apps);assert.equal(n.requiresReview,true);assert.deepEqual(core.plan(catalog.products,n).ids,{});}
 const n=core.compileExperience(request({refreshRate:'240',monitorModel:'我的螢幕',workload:'4K 剪輯',legacyTargets:'舊版個別目標'}),games,apps),text=core.summary(n,{},catalog);assert.match(text,/240Hz/);assert.match(text,/我的螢幕/);assert.match(text,/4K 剪輯/);assert.match(text,/舊版個別目標/);assert.match(text,/不承諾每款遊戲/);
});
