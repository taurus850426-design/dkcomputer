import {test} from 'node:test';import assert from 'node:assert/strict';import {parseCatalog,exclusionReason,factsFor} from '../scripts/coolpc-catalog.mjs';
function html(extra=''){return Array.from({length:30},(_,j)=>`<select name=n${j+1}><option>共有商品 40 樣<optgroup label='一般商品'><option disabled>分類標題</option>${Array.from({length:40},(_,i)=>`<option value=${i}>商品${j}-${i}, $${1000+i}</option>`).join('')}${j===3?extra:''}</select>`).join('');}
test('optional closing option tags do not swallow group labels and price is last comma-dollar amount',()=>{const c=parseCatalog(html('<option>測試原價$9999, $1,234 ◆ ★</option>'));assert.equal(c.products.length,1201);assert.ok(c.products.every(p=>p.group==='一般商品'));assert.equal(c.products.find(x=>x.name==='測試原價$9999').price,1234);});
test('exclusive product, group and follow-up annotation are excluded; conditional price differs from normal-price discount',()=>{
 const c=parseCatalog(html(`<option>原價屋獨家型號, $999</option><option>一般型號, $1000</option><option disabled>↪ 原價屋獨家販售</option><option>搭板專案, $1000</option><option>正常價, $2000 ◆ ↓任搭290↓</option><optgroup label='獨家專區'><option>隱藏商品, $1000</option>`));
 assert.equal(c.excluded.exclusive,3);assert.equal(c.excluded.conditional,1);assert.ok(c.products.some(x=>x.name==='正常價'));assert.ok(!c.products.some(x=>['一般型號','隱藏商品'].includes(x.name)));
});
test('manual blocklist survives source option reordering and price changes',()=>{const a=parseCatalog(html('<option value=20>同型號, $1000</option>'));const id=a.products.find(x=>x.name==='同型號').id;const b=parseCatalog(html('<option value=99>同型號, $1100</option>'),{blockedIds:[id]});assert.equal(b.excluded.blocked,1);assert.ok(!b.products.some(x=>x.id===id));});
test('broken source or missing categories fail closed',()=>{assert.throws(()=>parseCatalog('<html>Maintenance</html>'));assert.throws(()=>parseCatalog(html().replace('name=n30','name=missing')));});
test('explicit source dimensions and restrictive bundles are extracted conservatively',()=>{
 assert.equal(factsFor(12,'RTX5060 /25.5cm/雙風扇','').lengthMM,255);assert.equal(factsFor(14,'顯卡長42.5(41)/CPU高15.6(5.2)/M-ATX','').maxGpuMM,undefined);assert.equal(factsFor(14,'卡40/U高17/ATX','').maxCoolerMM,170);
 assert.equal(factsFor(14,'M-ATX/內附400W電源','').restricted,true);assert.equal(factsFor(15,'750W/SFX-L','').compact,true);assert.equal(exclusionReason('原價屋限定'),'exclusive');
});
test('reviewed cooler brackets are overlaid by exact ID without changing the source price',()=>{
 const a=parseCatalog(html('<option>已核對散熱器, $1000</option>')),p=a.products.find(x=>x.name==='已核對散熱器'),b=parseCatalog(html('<option>已核對散熱器, $1000</option>'),{specOverrides:{[p.id]:{supportedSockets:['AM5'],heightMM:157,price:1}}});const updated=b.products.find(x=>x.id===p.id);assert.deepEqual(updated.facts.supportedSockets,['AM5']);assert.equal(updated.price,1000);
});
test('dual-module memory count and rated transfer speed come from explicit source text',()=>{
 const f=factsFor(6,'32G(雙通16G*2)D5-5600 白','桌上型記憶體 DDR5 雙通道');assert.equal(f.modules,2);assert.equal(f.speedMT,5600);assert.equal(f.capacityGB,32);assert.equal(factsFor(6,'單條16GB DDR5-6000','桌上型').modules,1);
});
