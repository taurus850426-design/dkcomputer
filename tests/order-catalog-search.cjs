const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');

test('catalog selection stays separate from the inventory ID and filters conditional pricing', async () => {
  const dom = new JSDOM('<input id="search"><select id="item"></select><div id="results" hidden></div>');
  const {window} = dom;
  try {
    const {document} = window;
    const selected = [];
    const stock = [{id:'stock-1', name:'RTX 5060 White', qty_on_hand:2, category:"顯示卡", price_list:8990}, {id:'stock-2',name:'RTX 5060 Used',qty_on_hand:1,cost_unit:5000}];
    window.DKCatalogPricePolicy = require('../catalog-price-policy');
    const context = vm.createContext({window, document, DK:{getItems:()=>stock}, canPerm:()=>false,
      v2Esc:String, v2FmtNum:value=>Number(value).toLocaleString("zh-TW"), fetch:async()=>({ok:true,json:async()=>({
        schemaVersion:1, categories:[{id:12,name:'顯示卡'}], products:[
          {id:'catalog-1',name:'RTX 5060 Black',category:12,price:9990},
          {id:'catalog-2',name:'RTX 5060 組裝價',category:12,price:8000}
        ]
      })})});
    const source = fs.readFileSync(require.resolve('../admin3.js'),'utf8');
    vm.runInContext(source.slice(source.indexOf('    function makeSearchableItemSelect('), source.indexOf('    function profitNumberClass(')), context);
    context.makeSearchableItemSelect('item','search','results',{sellableOnly:true,showQty:true,orderCatalog:product=>{selected.push(product);return true;}});
    const input = document.getElementById('search');
    input.focus();
    input.value = '5060';
    input.dispatchEvent(new window.Event('input'));
    await new Promise(resolve=>setImmediate(resolve));
    const results = document.getElementById('results');
    assert.match(results.textContent,/White/);
    assert.match(results.textContent,/需採購/);
    assert.doesNotMatch(results.textContent,/組裝價|5,000/);
    assert.match(results.querySelector('[data-id="stock-1"]').textContent,/建議售價 NT\$8,990/);
    assert.match(results.querySelector('[data-id="stock-2"]').textContent,/建議售價未設定/);
    assert.match(results.querySelector('[data-catalog-index]').textContent,/建議售價 NT\$9,990/);
    assert.deepEqual([...results.querySelectorAll('.order-search-category')].map(el=>el.textContent), ['顯示卡','未分類','顯示卡']);
    results.querySelector('[data-catalog-index]').click();
    assert.equal(selected[0].categoryName,'顯示卡');
    assert.equal(document.getElementById('item').value,'');
    assert.equal(stock[0].qty_on_hand,2);
  } finally {
    window.close();
  }
});

test('selecting stock fills the editable unit price used by order and quote lines', () => {
  const dom = new JSDOM(`
    <input id="orderLineItemSearch"><select id="orderLineItem"></select>
    <div id="orderLineItemDropdown" hidden></div>
    <input id="orderLineQty" value="1"><input id="orderLinePrice" type="number">
    <button id="orderLineAdd" type="button"></button>
  `);
  const {window} = dom;
  try {
    const {document} = window;
    const stock = [
      {id:'cooler', name:'Cooler Master CORE NEX 360', category:'水冷', qty_on_hand:2, cost_unit:1700, price_list:'2290'},
      {id:'unpriced', name:'Other cooler', category:'水冷', qty_on_hand:1, cost_unit:1000}
    ];
    const orderLineItems = [];
    const context = vm.createContext({
      document, window, orderLineItems, orderLineItemSelect:document.getElementById('orderLineItem'),
      DK:{getItems:()=>stock, findItemById:id=>stock.find(item=>item.id===id)},
      canPerm:()=>true, v2Esc:String, v2FmtNum:String, orderMsg:null, todayStr:()=>'2026-11-24',
      renderOrderLineTbody(){}, updateOrderTotalsFromLines(){}, v2Hide(){},
      v2Show:(_,message)=>assert.fail(message)
    });
    const source = fs.readFileSync(require.resolve('../admin3.js'),'utf8');
    const run = (start,end) => vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),context);
    run('    function makeSearchableItemSelect(', '    function profitNumberClass(');
    run('    makeSearchableItemSelect("orderLineItem",', '    makeSearchableItemSelect("ledgerItemId",');
    run('    document.getElementById("orderLineAdd")?.addEventListener', '    function configureManualCost(');
    run('    function collectQuoteDataFromForm(', '    function quoteFilename(');
    const price = document.getElementById('orderLinePrice');
    const add = document.getElementById('orderLineAdd');
    const search = document.getElementById('orderLineItemSearch');
    const pick = id => {
      search.value = '';
      search.dispatchEvent(new window.Event('input'));
      document.querySelector(`[data-id="${id}"]`).dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));
    };
    pick('cooler');
    assert.equal(price.value,'2290');
    add.click();
    assert.deepEqual(
      [orderLineItems[0].unit_price, orderLineItems[0].quote_unit_price, orderLineItems[0].cost_unit],
      [2290,2290,1700]
    );
    const quote = context.collectQuoteDataFromForm();
    assert.equal(quote.items[0].unit_price,2290);
    assert.equal(quote.grand,2290);
    price.value = '0';
    add.click();
    assert.deepEqual([orderLineItems[1].unit_price,orderLineItems[1].quote_unit_price],[0,0]);
    pick('cooler');
    pick('unpriced');
    assert.equal(price.value,'');
    assert.deepEqual(stock.map(item=>item.qty_on_hand),[2,1]);
  } finally {
    window.close();
  }
});
