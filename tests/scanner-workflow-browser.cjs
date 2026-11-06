const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
test('scanner browser: desktop/mobile layout, Enter safety, local printable barcode and DK identifiers', {timeout:30000}, async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.DK_TEST_CHROME,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const panel=read('admin.html').match(/<section id="dkScanPanel"[\s\S]*?<\/section>/)[0];
  await page.setContent('<style>'+read('styles.css')+'body{padding:16px}#dkScanPanel{max-width:900px;min-width:0}input,select{max-width:100%;box-sizing:border-box}</style>'+panel+'<textarea id="poReceiveSerials"></textarea><button id="dkScanGenerateSerial">DK</button><button id="dkScanPrintSerials">print</button>');
  await page.addScriptTag({content:read('assets/vendor/JsBarcode.code128.min.js')});
  await page.evaluate(()=>{window.calls=[];window.dkScanOperation=async(...a)=>{calls.push(a);return {ok:true,data:{enabled:true,lines:[{name:'CPU',qty:1,serials:['SN-001']}],tested:false}}};});
  await page.addScriptTag({content:read('scanner-workflow.js')});
  await page.evaluate(()=>DKScanner.open({id:'o',order_no:'DK-20261107-001',status:'confirmed'},[{line_key:'cpu',item_id:'i',name:'CPU',qty:1}]));
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.locator('#dkScanCode').fill('SN-001');await page.locator('#dkScanCode').press('Enter');assert.equal(await page.evaluate(()=>calls.length),1);
  await page.locator('#dkScanBind').click();assert.equal(await page.evaluate(()=>calls[1][0]),'bind');
  await page.locator('#dkScanGenerateSerial').click();const serial=await page.locator('#poReceiveSerials').inputValue();assert.match(serial,/^DK-[A-F0-9]{20}$/);assert.equal(await page.evaluate(()=>calls.length),2);
  await page.evaluate(()=>{window.printed=[];const old=document.body.append.bind(document.body);document.body.append=(frame)=>{old(frame);if(frame.tagName==='IFRAME'){frame.contentWindow.print=()=>printed.push(frame.contentDocument.body.innerHTML);frame.contentWindow.focus=()=>{};}};});
  await page.locator('#dkScanPrintOrder').click();assert.match(await page.evaluate(()=>printed[0]),/DK-20261107-001/);assert.match(await page.evaluate(()=>printed[0]),/<svg/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
