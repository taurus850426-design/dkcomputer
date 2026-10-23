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
