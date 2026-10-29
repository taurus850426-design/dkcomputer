const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {JSDOM}=require('jsdom');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function setup(admin=true){
 const dom=new JSDOM(read('admin.html'),{runScripts:'outside-only'}),w=dom.window,source=read('admin3.js');
 Object.assign(w,{orderLineItems:[],editingManualOrderLineIndex:-1,stage7IsAdminRole:()=>admin,fillV2CategoryOptions:()=>{},renderOrderLineTbody:()=>{},updateOrderTotalsFromLines:()=>{},v2Hide:()=>{},v2Show:()=>{},v2Esc:x=>x,orderMsg:w.document.createElement('p')});
 w.eval(source.slice(source.indexOf('    function configureManualCost('),source.indexOf('    async function saveV2Order()')));
 const field=id=>w.document.getElementById('orderManual'+id);field('Category').add(new w.Option('其他','其他'));field('Category').value='其他';field('Name').value='服務';field('Type').value='service';w.configureManualCost(null);
 return {dom,w,field};
}
test('new manual service accepts per-unit cost and zero can replace existing cost',()=>{
 const s=setup();try{s.field('Cost').value='300';s.field('Price').value='1000';s.field('Add').click();assert.equal(s.w.orderLineItems[0].cost_unit,300);assert.equal(s.w.orderLineItems[0].manual_cost_unit,300);
 s.w.editingManualOrderLineIndex=0;s.field('Name').value='服務';s.field('Category').value='其他';s.field('Cost').value='0';s.field('Add').click();assert.equal(s.w.orderLineItems.length,1);assert.equal(s.w.orderLineItems[0].cost_unit,0);
 }finally{s.dom.window.close();}
});
test('actual edit button restores cost, and authoritative procurement cost is locked',()=>{
 const s=setup();try{
  s.w.orderLineItems=[{line_key:'x',fulfillment_type:'service',category:'其他',name:'原服務',qty:1,cost_unit:450,unit_price:1000}];
  const host=s.w.document.createElement('div');host.innerHTML='<button class="order-line-edit-manual" data-i="0"></button>';s.w.orderLineTbody=host;
  const source=read('admin3.js'),start=source.indexOf('      orderLineTbody.querySelectorAll(".order-line-edit-manual")');s.w.eval(source.slice(start,source.indexOf('\n    }\n    function updateOrderTotalsFromLines',start)));
  host.firstChild.click();assert.equal(s.field('Cost').value,'450');assert.equal(s.field('Cost').disabled,false);
  s.w.configureManualCost({procurement_cost_locked:true});assert.equal(s.field('Cost').disabled,true);
 }finally{s.dom.window.close();}
});
test('serializer retains explicit admin manual cost but removes it for staff',()=>{
 const s=setup();try{const source=read('shared.js'),start=source.indexOf('function stage7OrderLinesPayload(');s.w.eval(source.slice(start,source.indexOf('async function stage7UpsertItem',start)));const line={line_key:'x',fulfillment_type:'service',qty:1,unit_price:1000,manual_cost_unit:200};assert.equal(s.w.stage7OrderLinesPayload([line],1000)[0].manual_cost_unit,200);s.w.stage7IsAdminRole=()=>false;assert.equal('manual_cost_unit' in s.w.stage7OrderLinesPayload([line],1000)[0],false);
 }finally{s.dom.window.close();}
});
