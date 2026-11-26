const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

function setup({orderId=null,lines=[],purchases=[],savedOrder=null}={}) {
  const dom=new JSDOM(read('admin.html'),{url:'https://fixture.invalid',runScripts:'outside-only'});
  const {window}=dom;
  const el=id=>window.document.getElementById(id);
  el('orderForm').hidden=false;
  for(const file of ['admin-order-payment.js','purchase-receive-batch.js','admin-order-editor.js']) window.eval(read(file));
  let dirty=false;
  const opened=[],notices=[];
  const options={
    orderId:()=>orderId, lines:()=>lines, purchases:()=>purchases,
    dirty:()=>dirty, savedOrder:()=>savedOrder, canOpenPurchase:()=>true,
    openPurchase:id=>opened.push(id), notice:message=>notices.push(message),
  };
  return {dom,window,el,opened,notices,options,open:()=>window.DKOrderEditor.open(options),setDirty:()=>{dirty=true;}};
}

test('new orders collapse optional fields, and shortcuts reveal the original controls without changing values',()=>{
  const s=setup();
  try {
    s.el('orderDeliveryNote').value='門市取貨';
    s.el('orderDepositAmount').value='1000';
    s.open();
    assert.equal(s.el('orderEditorTitle').textContent,'新增訂單');
    assert.equal(s.el('orderEditorCustomerHint').hidden,false);
    for(const id of ['orderEditorContact','orderEditorCosts','orderEditorStatus','orderEditorPayment','orderEditorDelivery','orderEditorScan']){
      assert.equal(s.el(id).open,false,id);
    }
    s.el('orderEditorShortcuts').querySelector('[data-order-editor-target="orderReceivedAmount"]').click();
    assert.equal(s.el('orderEditorPayment').open,true);
    assert.equal(s.window.document.activeElement.id,'orderReceivedAmount');
    assert.equal(s.el('orderDepositAmount').value,'1000');
    assert.equal(s.el('orderDeliveryNote').value,'門市取貨');
    assert.equal(s.el('orderStatus').value,'negotiating');
  }finally{s.dom.window.close();}
});

test('order amount labels follow the calculation and the total remains visible when adjustments are collapsed',async()=>{
  const s=setup();
  try {
    const d=s.window.document;
    const adjustments=s.el('orderEditorAdjustments');
    const total=s.el('orderEditorTotal');
    const panel=total.closest('.order-editor-panel');
    assert.equal(panel.querySelector('h4').textContent,'訂單金額');
    for(const [id,label] of Object.entries({orderTotalSale:'商品小計',orderShipping:'運費收入',orderDiscount:'折扣金額'})){
      assert.equal(d.querySelectorAll('#'+id).length,1);
      assert.equal(d.querySelector('label[for="'+id+'"]').textContent,label);
    }
    assert.equal(total.previousElementSibling.textContent,'應收總額');
    assert.ok(adjustments.compareDocumentPosition(total)&s.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(total.closest('details'),null);
    assert.ok(total.compareDocumentPosition(s.el('orderEditorCosts'))&s.window.Node.DOCUMENT_POSITION_FOLLOWING);
    s.el('orderTotalSale').value='96415';
    s.el('orderShipping').value='4345';
    s.el('orderReceivedAmount').value='10000';
    s.open();
    assert.equal(adjustments.open,false);
    assert.equal(total.textContent,'NT$ 100,760');
    adjustments.open=true;
    s.el('orderDiscount').value='760';
    s.el('orderDiscount').dispatchEvent(new s.window.Event('input',{bubbles:true}));
    await Promise.resolve();
    assert.equal(total.textContent,'NT$ 100,000');
    assert.equal(s.el('orderEditorDue').textContent,total.textContent);
    assert.equal(s.el('orderEditorBalance').textContent,'NT$ 90,000');
    adjustments.open=false;
    assert.equal(total.textContent,'NT$ 100,000');
  }finally{s.dom.window.close();}
});

test('an old order shows a named missing line despite a received purchase and opens only an active linked purchase',()=>{
  const s=setup({
    orderId:'order-1',
    lines:[{line_key:'cpu',name:'285K',qty:1,fulfillment_type:'procurement'}],
    purchases:[
      {id:'po1',orderNo:'PO-1',sourceSalesOrderId:'order-1',status:'received',items:[]},
      {id:'deleted',sourceSalesOrderId:'order-1',status:'draft',deletedAt:'2026-11-20',items:[]},
      {id:'other',sourceSalesOrderId:'order-2',status:'draft',items:[]}
    ]
  });
  try {
    for(const [id,value] of Object.entries({orderStatus:'confirmed',orderCustomer:'客戶 A',orderNo:'ORD-1',
      orderTotalSale:'45000',orderShipping:'150',orderDiscount:'650',orderReceivedAmount:'10000'})) s.el(id).value=value;
    s.open();
    assert.equal(s.el('orderEditorTitle').textContent,'客戶 A｜ORD-1');
    assert.equal(s.el('orderEditorBalance').textContent,'NT$ 34,500');
    assert.match(s.el('orderEditorNextText').textContent,/285K × 1/);
    s.el('orderEditorNextButton').click();
    assert.equal(s.el('orderEditorProcurement').open,true);
    assert.equal(s.el('orderEditorPurchaseLinks').children.length,1);
    s.el('orderEditorPurchaseLinks').firstElementChild.click();
    assert.deepEqual(s.opened,['po1']);
  }finally{s.dom.window.close();}
});

test('customer confirmation uses saved totals and excludes cost, vendor and private fields',()=>{
  const s=setup({orderId:'order-1',savedOrder:{
    order_no:'ORD-1',customer_name:'王先生',total_sale:10000,shipping_income:150,discount:150,received_amount:3000,
    payment_reference:'PRIVATE-TRANSFER',delivery_note:'PRIVATE-NOTE',
    items:[{name:'SSD',spec:'SSD',qty:2,cost_unit:2100,preferred_vendor:'PRIVATE-VENDOR'}]
  }});
  try {
    s.open();
    s.el('orderEditorCustomerMessage').click();
    assert.equal(s.el('orderEditorMessagePanel').hidden,false);
    const message=s.el('orderEditorMessageText').value;
    assert.match(message,/SSD × 2/);
    assert.match(message,/尾款 NT\$ 7,000/);
    assert.doesNotMatch(message,/PRIVATE|2,100/);
    s.setDirty();
    s.el('orderEditorCustomerMessage').click();
    assert.match(s.notices[0],/請先儲存/);
  }finally{s.dom.window.close();}
});

test('order actions and responsive form remain usable on desktop and mobile',async()=>{
  const {chromium}=require('playwright');
  const packaged=process.env.DK_TEST_CHROME?null:require('@sparticuz/chromium');
  const browser=await chromium.launch({
    executablePath:process.env.DK_TEST_CHROME || await packaged.executablePath(),
    args:packaged?.args || ['--no-sandbox','--disable-dev-shm-usage'],headless:true
  });
  try {
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    for(const width of [1440,390]){
      await page.goto('about:blank');
      await page.setViewportSize({width,height:844});
      await page.setContent(read('admin.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
      for(const file of ['styles.css','admin-wide.css','admin-theme.css','admin-order-editor.css']){
        await page.addStyleTag({content:read(file)});
      }
      for(const file of ['admin-order-payment.js','admin-order-editor.js']){
        await page.addScriptTag({content:read(file)});
      }
      await page.evaluate(()=>{
        for(const id of ['panel','tab-inv','v2-orders','orderForm']) document.getElementById(id).hidden=false;
        document.body.classList.add('order-workspace-open');
        window.DKOrderEditor.open({orderId:()=>null,lines:()=>[],purchases:()=>[],canOpenPurchase:()=>false});
        document.getElementById('orderForm').scrollIntoView();
      });
      assert.equal(await page.locator('#orderCustomer').isVisible(),true);
      assert.equal(await page.locator('#orderEditorTotal').isVisible(),true);
      await page.locator('#orderTotalSale').fill('96415');
      await page.locator('#orderEditorAdjustments > summary').click();
      await page.locator('#orderShipping').fill('4345');
      await page.locator('#orderDiscount').fill('760');
      assert.equal(await page.locator('#orderEditorTotal').textContent(),'NT$ 100,000');
      assert.equal(await page.locator('#orderEditorTotal').evaluate(el=>{
        const total=el.getBoundingClientRect();
        const adjustments=document.getElementById('orderEditorAdjustments').getBoundingClientRect();
        return total.top>=adjustments.bottom;
      }),true);
      await page.locator('#orderEditorAdjustments > summary').click();
      assert.equal(await page.locator('#orderEditorTotal').isVisible(),true);
      assert.equal(await page.locator('#orderReceivedAmount').isVisible(),false);
      await page.getByRole('button',{name:'登記收款',exact:true}).click();
      await page.locator('#orderReceivedAmount').fill('100');
      assert.match(await page.locator('#orderEditorReceived').textContent(),/100/);
      assert.equal(await page.locator('#orderSave').isVisible(),true);
      assert.equal(await page.locator('#orderForm').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      assert.deepEqual(errors,[]);
    }
  }finally{await browser.close();}
});
