const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../builder-core.js'),catalog=require('../data/builder-catalog.json');
const input=raw=>({advisorVersion:1,fitVersion:1,usages:['game'],appNames:['PUBG'],budget:50000,resolution:'1440p',workloadLevel:'normal',...raw});
const recommended=raw=>{const options=core.plans(catalog.products,input(raw));return options.find(p=>p.key==='balanced')||options[0];};
test('storage, Wi-Fi, quiet operation and case style are effective constraints, not decorative questions',()=>{
 const o=recommended({storageGB:4000,network:'wifi',noise:'quiet',lookStyle:'showcase',budget:100000}),p=core.resolve(o.ids,catalog.products);
 assert.equal(o.missing.length,0);assert.ok(p.ssd.facts.capacityGB>=4000);assert.match(p.board.name,/wi[ -]?fi/i);assert.ok(p.cooler);assert.equal(core.advisor.caseProfile(p.case).style,'showcase');assert.equal(o.thermal.included,3);assert.equal(core.validate(p,o.needs).total,o.total);
});
test('working memory changes with workload; content priorities do not reuse the gaming cache score',()=>{
 const light=recommended({usages:['office'],appNames:['Microsoft Excel'],budget:158000}),heavy=recommended({usages:['office'],appNames:['Microsoft Excel'],workloadLevel:'heavy',budget:158000}),creative=recommended({usages:['create'],appNames:['Adobe Premiere Pro'],primaryUse:'create',workloadLevel:'video4k',budget:158000});
 assert.ok(core.resolve(light.ids,catalog.products).ram.facts.capacityGB<64);assert.ok(core.resolve(heavy.ids,catalog.products).ram.facts.capacityGB>=64);assert.ok(core.resolve(creative.ids,catalog.products).ram.facts.capacityGB>=64);assert.doesNotMatch(core.resolve(creative.ids,catalog.products).cpu.name,/X3D/);assert.ok(creative.needs.requirementTrace.length>=7);
});
test('value mode, appearance and performance preserve requested minimums and expose the resulting differences',()=>{
 const value=recommended({budgetMode:'value',budget:100000}),balanced=recommended({budgetMode:'balanced',budget:100000}),look=recommended({allocation:'appearance',budget:100000});
 assert.ok(value.total<=balanced.total);assert.equal(value.needs.resolution,balanced.needs.resolution);assert.equal(value.needs.targetFps,balanced.needs.targetFps);assert.equal(core.advisor.caseProfile(core.resolve(look.ids,catalog.products).case).style,'showcase');
});
test('small budgets retain full needs and require acceptance of any lower quality or FPS target',()=>{
 const raw=input({budget:50000,targetFps:144,gameQuality:'high'}),options=core.plans(catalog.products,raw),full=options.find(o=>o.key==='balanced');assert.equal(full.needs.targetFps,144);assert.ok(full.overBudget>0);
 const trade=options.find(o=>o.key==='tradeoff');assert.ok(trade);assert.equal(trade.requiresConfirmation,true);assert.equal(trade.needs.resolution,'1440p');assert.equal(raw.targetFps,144);
});
test('fan cost uses current catalogue prices; unknown fan counts and controller costs stay unpriced',()=>{
 const caseItem=catalog.products.find(p=>/^華碩 A21 黑 /.test(p.name)),n=core.compileExperience(input({usages:['office'],appNames:[]}));
 const p=core.resolve({case:caseItem.id},catalog.products),q=core.validate(p,n);assert.equal(q.thermal.items[0].quantity,3);const current=catalog.products.find(p=>p.id===q.thermal.items[0].id);assert.equal(q.total,caseItem.price+current.price*3);assert.ok(q.unpricedCount>0);assert.match(q.pending.join(' '),/集線器/);
 const unknown={...caseItem,name:'風扇支援 120mm × 6，附贈內容未明'};assert.equal(core.advisor.thermal({case:unknown},n,catalog.products).unpriced,true);assert.equal(core.advisor.caseProfile({...caseItem,name:'Montech XR Wood 黑'}),undefined);
});
test('verified included fans are never double charged and summaries retain decisions and limitations',()=>{
 const o=recommended({lookStyle:'rgb'}),p=core.resolve(o.ids,catalog.products),q=core.validate(p,o.needs);assert.equal(q.thermal.included,4);assert.equal(q.thermal.total,0);assert.equal(q.total,Object.values(p).reduce((sum,item)=>sum+item.price,0));const text=core.summary(o.needs,p,catalog);assert.match(text,/原廠附 4 顆風扇/);assert.match(text,/需求與配置的關係/);assert.doesNotMatch(text,/原價屋|coolpc/i);
});
test('unavailable high-end tiers remain missing rather than becoming an apparently complete low-end PC',()=>{
 const o=recommended({budget:158000,resolution:'4k',gameQuality:'ultra',targetFps:144});assert.ok(o.missing.includes('顯示卡'));assert.equal(o.fit.withinBudget,false);
});
