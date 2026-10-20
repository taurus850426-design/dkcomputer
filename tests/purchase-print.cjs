const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {JSDOM}=require('jsdom');
const chromium=require('@sparticuz/chromium').default;
const {chromium:playwright}=require('playwright');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
for(const longText of [false,true])test('purchase print preserves physical font sizes: '+(longText?'long specifications and notes':'normal six-item order'),async()=>{
 const dom=new JSDOM(read('admin.html'),{runScripts:'outside-only'});
 dom.window.DK={loadPurchaseOrdersRaw:()=>[]};
 dom.window.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,'window.printTest={build:buildPrintHtml};})();'));
 const rows=Array.from({length:6},(_,i)=>({id:'line'+i,quantity:1,selectedSpec:'Intel Core Ultra 5 225F '+(longText&&i===5?'LONGSPEC'.repeat(35):''),selectedVendor:['Vendor A','Vendor B','Vendor C'][i%3],selectedUnitPrice:4450,itemNote:'ORD-20261016-003 | Customer: Test '+(longText&&i===5?'LongNote'.repeat(45):'')}));
 const printHtml=dom.window.printTest.build({orderNo:'PO-TEST',createdAt:'2026-10-16',status:'ordered',items:rows,note:'TEST TOTAL'},'');
 dom.window.close();
 const browser=await playwright.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1755,height:1161}});
  await page.setContent(read('admin.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
  for(const file of ['styles.css','admin-wide.css','admin-theme.css'])await page.addStyleTag({content:read(file)});
  await page.evaluate(html=>{document.body.classList.add('po-printing');document.getElementById('panel').hidden=false;document.getElementById('tab-purchase').hidden=false;document.getElementById('poPrintArea').innerHTML=html;},printHtml);
  await page.emulateMedia({media:'print'});
  const target=fs.mkdtempSync(path.join(os.tmpdir(),'dk-purchase-print-'));
  const pdf=path.join(target,'purchase.pdf');await page.pdf({path:pdf,preferCSSPageSize:true});
  const xml=execFileSync('pdftohtml',['-xml','-stdout','-i',pdf],{encoding:'utf8'});
  // pdftohtml reports pixels at 108dpi: 12pt text must remain about 18px.
  const sizes=[...xml.matchAll(/<fontspec[^>]*size="([\d.]+)"/g)].map(x=>Number(x[1]));
  console.log('PDF font sizes (108dpi):',sizes,'PDF:',pdf);
  assert.ok(sizes.some(n=>n>=17&&n<=19),'12pt body text was scaled down in the actual PDF');
  assert.ok(sizes.some(n=>n>=26&&n<=28),'18pt heading was scaled down in the actual PDF');
  const specs=await page.locator('#poPrintArea table').evaluateAll(tables=>tables.map(t=>({layout:getComputedStyle(t).tableLayout,overflow:t.scrollWidth>t.clientWidth+1})));
  assert.ok(specs.every(t=>t.layout==='fixed'&&!t.overflow),'long text must wrap inside the printable table');
 }finally{await browser.close();}
});
