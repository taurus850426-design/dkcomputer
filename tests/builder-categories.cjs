const {test}=require('node:test'),assert=require('node:assert/strict'),facets=require('../builder-categories.js');
test('classification uses actual part facts and keeps unknowns explicit',()=>{assert.equal(facets.category({facts:{socket:'AM5'}},'cpu'),'AMD AM5');assert.equal(facets.category({facts:{socket:'1700',ddr:'DDR4'}},'board'),'Intel LGA 1700 · DDR4');assert.equal(facets.category({facts:{ddr:'DDR5',capacityGB:32}},'ram'),'DDR5 · 32GB');assert.equal(facets.category({facts:{gpuModel:'RTX 5070'}},'gpu'),'RTX 5070');assert.equal(facets.category({facts:{watts:850}},'psu'),'850W 級距');assert.equal(facets.category({facts:{}},'case'),'其他規格／待確認');});
test('brand aliases combine names without inserting markup or guessing unknown specs',()=>{assert.equal(facets.brand({name:'華碩 ROG RTX 5070'}),'ASUS');assert.equal(facets.brand({name:'ASUS PRIME RTX 5070'}),'ASUS');assert.equal(facets.brand({name:'Fractal Design North'}),'Fractal Design');assert.equal(facets.brand({name:'<img src=x onerror=alert(1)>'}),'其他品牌');assert.deepEqual(facets.values([{v:'DDR5'},{v:'DDR4'},{v:'DDR5'}],x=>x.v),['DDR4','DDR5']);});

test('browser pricing policy blocks an older cached conditional entry and keeps normal single-item prices',()=>{const policy=require('../catalog-price-policy.js');assert.equal(policy.accepts({name:'任搭價 Acer RX9070XT',group:'AMD'}),false);assert.equal(policy.accepts({name:'Acer RX9070XT',group:'任搭專區'}),false);assert.equal(policy.accepts({name:'藍寶石 NITRO+ RX9070XT',group:'AMD RX9070XT'}),true);});

test('bilingual brand labels preserve identity and match Chinese searches without changing product snapshots',()=>{
 const p={id:'intel1',name:'Intel Core Ultra 5 225F',price:4890},before=JSON.stringify(p);
 assert.equal(facets.brandLabel('Intel'),'Intel 英特爾');assert.equal(facets.brandLabel('ASUS'),'ASUS 華碩');assert.equal(facets.brandLabel('HYTE'),'HYTE');
 assert.equal(facets.productLabel(p),'Intel Core Ultra 5 225F（英特爾）');assert.equal(facets.matches(p,'英特爾'),true);assert.equal(facets.matches(p,'INTEL'),true);assert.equal(JSON.stringify(p),before);
 assert.equal(facets.productLabel({name:'華碩 ASUS PRIME'}),'華碩 ASUS PRIME');assert.equal(facets.productLabel({name:'HYTE X50'}),'HYTE X50');assert.equal(facets.brand({name:p.name}),'Intel');
 assert.equal(facets.brandLabel('Montech'),'Montech 君主');assert.equal(facets.brandLabel('COUGAR'),'COUGAR 美洲獅');assert.equal(facets.brandLabel('Antec'),'Antec 安鈦克');
});
