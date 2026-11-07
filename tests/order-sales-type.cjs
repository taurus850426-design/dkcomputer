const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
test('every visible sales category survives reload normalization and remains selectable',()=>{
 const dom=new JSDOM(fs.readFileSync('admin.html','utf8'),{url:'https://example.com',runScripts:'outside-only'}),w=dom.window;
 try{w.eval(fs.readFileSync('inventory-ledger.js','utf8'));const select=w.document.getElementById('orderSalesType');
 for(const type of [...select.options].map(o=>o.value).filter(Boolean)){
  for(const record of [{salesType:type},{sales_type:type}]){const restored=w.DK.normalizeOrderSalesType(JSON.parse(JSON.stringify(record)));select.value=restored;assert.equal(select.value,type);assert.equal(w.DK.orderSalesTypeLabel(record),type);}
 }
 const stats=w.DK.ORDER_SALES_TYPES;assert.ok(stats.includes('零件升級'));
 }finally{w.close();}
});
test('order sections retain field identity, explicit item labels and multiline delivery notes',()=>{
 const dom=new JSDOM(fs.readFileSync('admin.html','utf8')),d=dom.window.document;
 try{assert.equal(d.querySelectorAll('#orderForm .order-editor-heading').length,5);
 for(const id of ['orderSalesType','orderCustomerSource','orderLineQty','orderLinePrice','orderSave','orderMsg','orderQuoteNote'])assert.equal(d.querySelectorAll('#'+id).length,1);
 const note=d.getElementById('orderQuoteNote');assert.equal(note.tagName,'TEXTAREA');note.value='來源配單\n空盒：保留\n運費150';assert.equal(note.value.split('\n').length,3);
 for(const id of ['orderLineQty','orderLinePrice'])assert.ok(d.querySelector('label[for="'+id+'"]'));
 }finally{dom.window.close();}
});
