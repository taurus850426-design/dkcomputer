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
    const stock = [{id:'stock-1', name:'RTX 5060 White', qty_on_hand:2}];
    window.DKCatalogPricePolicy = require('../catalog-price-policy');
    const context = vm.createContext({window, document, DK:{getItems:()=>stock}, canPerm:()=>false,
      v2Esc:String, fetch:async()=>({ok:true,json:async()=>({
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
    assert.doesNotMatch(results.textContent,/組裝價/);
    results.querySelector('[data-catalog-index]').click();
    assert.equal(selected[0].categoryName,'顯示卡');
    assert.equal(document.getElementById('item').value,'');
    assert.equal(stock[0].qty_on_hand,2);
  } finally {
    window.close();
  }
});
