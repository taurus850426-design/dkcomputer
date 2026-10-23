const {test}=require('node:test'),assert=require('node:assert/strict'),r=require('../builder-core.js'),catalog=require('../data/builder-catalog.json');
const part=(category,facts,price=100,id='p'+category)=>({category,facts,price,id,name:id});
const cpu=part(4,{socket:'AM5',cores:6,integrated:false,stockCooler:true}),board=part(5,{socket:'AM5',ddr:'DDR5',form:'MATX'}),ram=part(6,{desktop:true,ddr:'DDR5',capacityGB:32}),gpu=part(12,{gpuModel:'RTX 5060',lengthMM:250}),box=part(14,{form:'MATX',maxGpuMM:300,maxCoolerMM:165});
test('socket, DDR generation and physical fit conflicts are rejected',()=>{
 assert.equal(r.check({...board,facts:{...board.facts,socket:'1700'}},'board',{cpu}).state,'incompatible');
 assert.equal(r.check({...ram,facts:{...ram.facts,ddr:'DDR4'}},'ram',{board}).state,'incompatible');
 assert.equal(r.check({...board,facts:{...board.facts,form:'ATX'}},'board',{cpu,case:box}).state,'incompatible');
 assert.equal(r.check({...gpu,facts:{...gpu.facts,lengthMM:300}},'gpu',{case:box}).state,'incompatible');
 assert.equal(r.check(board,'board',{cpu,ram,case:box}).state,'basic');
});
test('missing fit data, cooler brackets and E-ATX width stay pending',()=>{
 assert.equal(r.check({...gpu,facts:{gpuModel:'RTX 5060'}},'gpu',{case:box}).state,'pending');
 assert.equal(r.check(part(10,{air:true,heightMM:150}),'cooler',{cpu,case:box}).state,'pending');
 assert.equal(r.check({...board,facts:{...board.facts,form:'EATX'}},'board',{case:{...box,facts:{form:'EATX'}}}).state,'pending');
});
test('accessories, bundled/restricted cases, laptop RAM and compact PSUs are not auto-selected',()=>{
 assert.equal(r.isPart(part(12,{}),'gpu'),false);assert.equal(r.isPart(part(6,{desktop:false,ddr:'DDR5',capacityGB:32}),'ram'),false);
 assert.equal(r.isPart(part(14,{form:'ATX',restricted:true}),'case'),false);assert.equal(r.isPart(part(15,{watts:850,compact:true}),'psu'),false);
});
test('stale IDs cannot reintroduce source-excluded items or wrong-category parts',()=>{
 assert.deepEqual(r.resolve({cpu:'removed',ram:cpu.id},[cpu]),{});
});
test('totals and budget warnings use current catalog prices, never saved draft prices',()=>{
 const p=r.resolve({cpu:cpu.id,board:board.id},[{...cpu,price:2000},{...board,price:3000}]);const q=r.validate(p,{budget:4000});assert.equal(q.total,5000);assert.equal(q.overBudget,1000);assert.ok(q.pending.length);
});
test('stock CPU cooler and integrated graphics may be omitted for office use but not gaming claims',()=>{
 const p={cpu:{...cpu,facts:{...cpu.facts,integrated:true}},board,ram};const q=r.validate(p,{budget:10000,usages:['office']});assert.ok(!q.pending.includes('尚未選擇顯示卡'));assert.ok(!q.pending.includes('尚未選擇散熱器'));assert.ok(r.validate(p,{usages:['game']}).pending.some(x=>/顯示效能/.test(x)));
});
test('real source snapshots have positive prices, stable unique IDs and thirty categories',()=>{
 assert.equal(catalog.categories.length,30);assert.ok(catalog.products.length>1000);assert.equal(new Set(catalog.products.map(x=>x.id)).size,catalog.products.length);assert.ok(catalog.products.every(p=>Number.isSafeInteger(p.price)&&p.price>0));assert.ok(!catalog.products.some(p=>/共有商品/.test(p.name)));
});
test('budget drafts never label themselves as verified game builds and never contain hard conflicts',()=>{
 for(const budget of [15000,30000,50000,100000]){const needs={budget,usages:['game'],color:'any',ramGB:16},selected=r.resolve(r.suggest(catalog.products,needs),catalog.products),q=r.validate(selected,needs);assert.equal(q.errors.length,0);assert.ok(q.pending.some(x=>/實測/.test(x)));assert.match(r.summary(needs,selected,catalog),/未確認.*正式報價/);}
});
const games=require('../data/builder-games.json').games;
function valorant(extra={}){return r.compileNeeds({usages:['game'],appNames:['特戰英豪（VALORANT）'],gameTargets:{valorant:'1080p-high-144'},resolution:'1080p',color:'any',budget:50000,...extra},games);}
test('game reference rules constrain CPU/GPU models and choose complete dual-module builds',()=>{
 const needs=valorant(),plan=r.plan(catalog.products,needs),p=r.resolve(plan.ids,catalog.products);
 assert.equal(needs.hasGameRule,true);assert.deepEqual(plan.missing,[]);assert.ok(needs.cpuModels.some(model=>p.cpu.name.includes(model)));assert.ok(needs.gpuModels.includes(p.gpu.facts.gpuModel.replace(/\s/g,'')));assert.ok(p.ram.facts.modules>=2);assert.ok(p.ram.facts.speedMT>=5200);assert.ok(p.ssd.facts.capacityGB>=1000);assert.equal(r.validate(p,needs).errors.length,0);
});
test('all-white refers to visible parts and PSU; platinum efficiency is not a white paint colour',()=>{
 assert.equal(r.colorOf({name:'850W 黑色 白金'}),'black');assert.equal(r.colorOf({name:'850W 白金'}),'unknown');assert.equal(r.colorOf({name:'RTX 5060 White Edition'}),'white');
 const needs=valorant({color:'allwhite'}),plan=r.plan(catalog.products,needs),p=r.resolve(plan.ids,catalog.products);assert.deepEqual(plan.missing,[]);assert.ok(p.cooler);for(const key of ['board','ram','gpu','cooler','case','psu'])assert.equal(r.colorOf(p[key]),'white');assert.ok(plan.total<=50000);
});
test('insufficient budget changes the warning, never the game model set or white appearance',()=>{
 const high=r.plan(catalog.products,valorant({color:'allwhite',budget:50000})),low=r.plan(catalog.products,valorant({color:'allwhite',budget:10000}));assert.deepEqual(low.ids,high.ids);assert.ok(low.overBudget>0);assert.ok(low.warnings.some(x=>/超出預算/.test(x)));
});
test('unknown game, unknown target and resolution conflict do not silently create a game build',()=>{
 for(const needs of [valorant({appNames:['Unknown Game']}),valorant({gameTargets:{valorant:'custom'}}),valorant({resolution:'4k'}),valorant({appNames:['特戰英豪（VALORANT）','Unknown Game']})]){const p=r.plan(catalog.products,needs);assert.deepEqual(p.ids,{});assert.ok(p.warnings.length);}
});
test('multiple game references intersect models instead of silently using the easiest game',()=>{
 const a={name:'A',id:'a',targets:[{id:'t',resolution:'1080p',selectionRules:[{resolutions:['1080p'],cpuModels:['7500F'],gpuModels:['RTX5050'],sourceUrls:[]}]}]},b={name:'B',id:'b',targets:[{id:'t',resolution:'1080p',selectionRules:[{resolutions:['1080p'],cpuModels:['7700'],gpuModels:['RTX5060'],sourceUrls:[]}]}]};const needs=r.compileNeeds({usages:['game'],appNames:['A','B'],gameTargets:{a:'t',b:'t'},resolution:'1080p'},[a,b]);assert.deepEqual(needs.cpuModels,[]);assert.deepEqual(needs.gpuModels,[]);assert.deepEqual(r.plan(catalog.products,needs).ids,{});
});
test('no white GPU or confirmed cooler means an explicit missing slot, not a substituted black part',()=>{
 const needs=valorant({color:'allwhite'}),products=catalog.products.filter(p=>!(p.category===12&&r.colorOf(p)==='white'));const plan=r.plan(products,needs);assert.ok(plan.missing.includes('顯示卡'));assert.equal(plan.ids.gpu,undefined);assert.ok(plan.warnings.some(x=>/不是完整主機價格/.test(x)));
});
test('custom requests and owned parts never inherit prices or claims of compatibility',()=>{
 const others={cpu:{name:'Customer CPU',mode:'request',url:'https://example.com/cpu',price:1,facts:{socket:'AM5'}},gpu:{name:'My GPU',mode:'owned',price:1}};
 const p=r.resolve({cpu:cpu.id},[cpu],others),q=r.validate(p,{budget:10000});assert.equal(p.cpu.price,null);assert.deepEqual(p.cpu.facts,{});assert.equal(q.total,0);assert.equal(q.unpricedCount,1);assert.equal(q.ownedCount,1);assert.equal(q.errors.length,0);assert.equal(r.check(p.cpu,'cpu',{}).state,'pending');
});
test('unknown custom sockets make related selections pending rather than compatible or falsely incompatible',()=>{
 const p=r.resolve({},[],{cpu:{name:'Unknown CPU',mode:'owned'}});assert.equal(r.check(board,'board',p).state,'pending');assert.match(r.check(board,'board',p).reasons.join(' '),/自填處理器/);
 const mix={...p,board:{...board,facts:{...board.facts,ddr:'DDR4'}}};assert.equal(r.check(ram,'ram',mix).state,'incompatible');
});
test('custom summary includes links and quote/ownership status, real line breaks and no embedded photo payload',()=>{
 const photo={dataUrl:'data:image/jpeg;base64,YWJj',name:'part.jpg'},p=r.resolve({},[],{cpu:{name:'My CPU',mode:'owned',photo},gpu:{name:'Other GPU',mode:'request',url:'https://example.com/gpu'}}),text=r.summary({budget:10000},p,catalog);
 assert.match(text,/https:\/\/example.com\/gpu/);assert.match(text,/待報價/);assert.match(text,/自備零件/);assert.match(text,/另傳官方 LINE/);assert.ok(text.split('\n').length>10);assert.ok(!text.includes('data:image'));assert.ok(!text.includes('\\n'));
});
test('custom inputs reject active URLs, credentials, unknown slots, overlong photos and injected specifications',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,hi','https://user:password@example.com'])assert.equal(r.safeProductUrl(url),'');
 const parts=r.normalizeOthers({cpu:{name:'X',url:'javascript:alert(1)',photo:{dataUrl:'data:image/svg+xml;base64,YWJj'},mode:'admin'},otherSlot:{name:'bad'}});assert.deepEqual(Object.keys(parts),['cpu']);assert.equal(parts.cpu.url,'');assert.equal(parts.cpu.photo,null);assert.equal(parts.cpu.mode,'request');assert.equal(r.cleanOtherDraft({photo:{dataUrl:'data:image/jpeg;base64,'+'a'.repeat(300000)}}).photo,null);
});
test('mixed catalogue, requested and owned parts total only confirmed catalogue prices',()=>{
 const known=part(12,{gpuModel:'RTX 5060',lengthMM:250},12345,'known-gpu'),p=r.resolve({gpu:known.id},[known],{cpu:{name:'Own CPU',mode:'owned'},case:{name:'Requested case',mode:'request'}}),q=r.validate(p,{budget:50000});assert.equal(q.total,12345);assert.equal(q.unpricedCount,1);assert.equal(q.ownedCount,1);assert.equal(q.errors.length,0);assert.ok(q.pending.some(x=>/機殼/.test(x)));
});
