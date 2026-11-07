const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
test('current builder: desktop/mobile, search, total, restoration, failed/successful submission and print', {timeout:60000}, async()=>{
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;const p=path.resolve(root,'.'+pathname);if(!p.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(p));}catch(_){res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.DK_TEST_CHROME,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];let reject=true;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const req=route.request();if(req.method()==='POST'){
    writes.push({url:req.url(),payload:req.postDataJSON()});
    assert.ok(req.url().endsWith('/rest/v1/builder_submissions'));
    return route.fulfill({status:reject?503:201,body:''});
   }
   return req.url().startsWith(origin)?route.continue():route.abort();
  });
  await page.goto(origin+'/builder.html');await page.locator('#simpleLayout').waitFor();
  await page.locator('#saveBuild').click();assert.match(await page.locator('#actionStatus').innerText(),/至少選擇/);assert.equal(writes.length,0);
  await page.locator('[data-slot-filter="cpu"]').selectOption({label:'AMD AM5'});const cpu=page.locator('[data-slot="cpu"]');const value=await cpu.locator('option').nth(1).getAttribute('value');await cpu.selectOption(value);
  let total=await page.locator('#buildTotal').innerText();assert.notEqual(total,'NT$ 0');
  await page.locator('[data-slot-filter="cpu"]').selectOption({label:'Intel LGA 1700'});assert.equal(await page.locator('#buildTotal').innerText(),total);assert.match(await page.locator('.simple-slot').first().innerText(),/配單仍保留/);
  await page.locator('[data-slot-filter="cpu"]').selectOption({label:'AMD AM5'});assert.equal(await cpu.inputValue(),value);
  await page.locator('[data-slot-filter="case"]').selectOption({label:'ATX 機殼'});assert.ok(await page.locator('[data-slot="case"] option').count()<=101);
  await page.locator('[data-brand-filter="case"]').selectOption({label:'ASUS 華碩'});assert.match(await page.locator('[data-slot="case"]').innerText(),/華碩|ASUS/);

  await page.locator('#partSearch').fill('華碩');assert.match(await page.locator('[data-slot="case"]').innerText(),/ASUS|華碩/);await page.locator('#partSearch').fill('');
  await page.locator('#partSearch').fill('7500F');assert.match(await cpu.innerText(),/7500F/);await page.locator('#partSearch').fill('');
  await page.reload();await page.locator('#simpleLayout').waitFor();assert.equal(await cpu.inputValue(),value);assert.equal(await page.locator('#buildTotal').innerText(),total);
  // Unsaved local drafts retain product IDs, but reprice from the next verified snapshot.
  const latest=JSON.parse(fs.readFileSync(path.join(root,'data/builder-catalog.json'),'utf8'));const chosen=latest.products.find(p=>p.id===value);chosen.price+=100;latest.updatedAt=new Date().toISOString();
  await page.route('**/data/builder-catalog.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(latest)}));await page.reload();await page.locator('#simpleLayout').waitFor();assert.equal(await cpu.inputValue(),value);total='NT$ '+chosen.price.toLocaleString('zh-TW');assert.equal(await page.locator('#buildTotal').innerText(),total);

  for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.locator('#saveBuild').click();await page.waitForFunction(()=>document.getElementById('actionStatus').textContent.includes('無法送出'));
  assert.equal(await cpu.inputValue(),value);assert.equal(writes.length,1);reject=false;
  await page.locator('#saveBuild').click();await page.waitForFunction(()=>document.getElementById('actionStatus').textContent.includes('配單已儲存'));
  assert.equal(writes.length,2);assert.equal(writes[1].payload.payload.items[0].product_id,value);assert.match(writes[1].payload.build_no,/^DK-BUILD-\d{8}-[A-Z0-9]{6}$/);
  const prices=writes[1].payload.payload.items.reduce((n,x)=>n+x.qty*x.unit_price,0);assert.equal(prices,writes[1].payload.payload.total);
  // Real mobile controls: accordion, extra brands, quantities, peripherals and fixed shortcuts.
  await page.locator('[data-part="cpu"] summary').click();await page.waitForFunction(()=>document.querySelector('[data-part="cpu"]').open);
  await page.locator('[data-add="cpu"]').click();await page.locator('[data-slot-filter="cpu"]').selectOption({label:'Intel LGA 1700'});
  const extraCpu=await cpu.locator('option').nth(2).getAttribute('value');await cpu.selectOption(extraCpu);
  await page.waitForFunction(()=>!document.querySelector('[data-part="cpu"]').open);
  await page.locator('[data-part="cpu"] summary').click();await page.locator('[data-qty="cpu"]').fill('2');await page.locator('[data-qty="cpu"]').press('Tab');
  for(const key of ['monitor','keyboard','mouse']){
   await page.locator('[data-part="'+key+'"] summary').click();await page.waitForFunction(k=>document.querySelector('[data-part="'+k+'"]').open,key);
   const filter=page.locator('[data-slot-filter="'+key+'"]');await filter.selectOption(await filter.locator('option').nth(1).getAttribute('value'));
   assert.equal(await page.locator('[data-part="'+key+'"]').getAttribute('open'),'');
   const select=page.locator('[data-slot="'+key+'"]');await select.selectOption(await select.locator('option').nth(1).getAttribute('value'));
   await page.waitForFunction(k=>!document.querySelector('[data-part="'+k+'"]').open,key);
  }
  assert.match(await page.locator('#estimateQuick').innerText(),/6 件/);await page.locator('#estimateQuick').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const beforeNav=await page.locator('.dk-mobile-nav').boundingBox();await page.evaluate(()=>scrollTo(0,0));const afterNav=await page.locator('.dk-mobile-nav').boundingBox();assert.equal(beforeNav.y,afterNav.y);
  await page.locator('#saveBuild').click();await page.waitForFunction(()=>document.getElementById('actionStatus').textContent.includes('配單已儲存'));
  const multi=writes.at(-1).payload.payload;assert.equal(multi.items.length,5);assert.equal(multi.items[0].qty,2);assert.equal(multi.total,multi.items.reduce((n,x)=>n+x.qty*x.unit_price,0));assert.equal(multi.parts_subtotal+multi.peripherals_subtotal,multi.total);
  await page.reload();await page.locator('#simpleLayout').waitFor();assert.equal(await page.locator('.summary-line').count(),5);assert.equal(await page.locator('[data-qty="cpu"]').inputValue(),'2');assert.equal(await page.locator('details[open]').count(),0);
  await page.locator('[data-part="os"] summary').click();const osFilter=page.locator('[data-slot-filter="os"]');await osFilter.selectOption(await osFilter.locator('option').nth(1).getAttribute('value'));const osSelect=page.locator('[data-slot="os"]');await osSelect.selectOption(await osSelect.locator('option').nth(1).getAttribute('value'));
  const beforeBoxes=await page.locator('#buildTotal').innerText();await page.locator('#retainBoxes').selectOption('yes');await page.locator('#fulfillmentPreference').selectOption('delivery');assert.notEqual(await page.locator('#buildTotal').innerText(),beforeBoxes);assert.match(await page.locator('#deliverySummary').innerText(),/空盒：保留/);await page.locator('#saveBuild').click();await page.waitForFunction(()=>document.getElementById('actionStatus').textContent.includes('配單已儲存'));const boxes=writes.at(-1).payload.payload;assert.equal(boxes.box_shipping_fee,150);assert.ok(boxes.software_subtotal>0);assert.equal(boxes.items.filter(x=>x.line_key==='box_shipping').length,1);assert.equal(boxes.total,boxes.items.reduce((n,x)=>n+x.qty*x.unit_price,0));await page.reload();await page.locator('#simpleLayout').waitFor();assert.equal(await page.locator('#retainBoxes').inputValue(),'yes');assert.equal(await page.locator('#fulfillmentPreference').inputValue(),'delivery');
  await page.locator('#estimateQuick').click();await page.emulateMedia({media:'print'});assert.equal(await page.locator('.dk-mobile-nav').isVisible(),false);assert.match(await page.locator('#buildItems').innerText(),/× 2/);assert.equal(await page.locator('.simple-summary').evaluate(el=>getComputedStyle(el).maxHeight),'none');assert.equal(await page.locator('.simple-summary').evaluate(el=>getComputedStyle(el).overflow),'visible');await page.emulateMedia({media:'screen'});
  await page.evaluate(()=>window.print=()=>{window.__printed=true;});await page.locator('#printBuild').click();assert.equal(await page.evaluate(()=>window.__printed),true);
  page.once('dialog',d=>d.accept());await page.locator('#clearBuild').click();assert.equal(await page.locator('#buildTotal').innerText(),'NT$ 0');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
