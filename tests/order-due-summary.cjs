const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
test('order overview shows actual due separately from receipts and retains price breakdown',()=>{
 const source=fs.readFileSync('admin3.js','utf8'),a=source.indexOf('    function orderDueSummaryCell('),b=source.indexOf('    function renderV2Orders()',a),d=new JSDOM('',{runScripts:'outside-only'}),w=d.window;
 try{w.eval(fs.readFileSync('admin-order-payment.js','utf8'));w.eval('const v2FmtNum=n=>Number(n||0).toLocaleString("zh-TW");'+source.slice(a,b));
 for(const o of [{total_sale:20000,shipping_income:150,discount:1000,received_amount:5000},{total_sale:20000,shipping_income:0,discount:0},{total_sale:0,shipping_income:0,discount:0},{total_sale:0,shipping_income:0,discount:10}]){
  const original=JSON.stringify(o),host=w.document.createElement('div');host.innerHTML=w.orderDueSummaryCell(o);
  assert.equal(host.querySelector('strong').textContent,w.DKOrderPayment.summary(o).due.toLocaleString('zh-TW'));assert.match(host.querySelector('small').textContent,/售價.*運費.*折扣/);assert.equal(JSON.stringify(o),original);
 }
 const cell=w.orderDueSummaryCell({total_sale:20000,shipping_income:150,discount:1000,received_amount:5000});assert.match(cell,/19,150/);assert.doesNotMatch(cell,/14,150/);
 }finally{w.close();}
});
