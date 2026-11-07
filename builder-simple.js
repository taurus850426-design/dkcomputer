(function(){
'use strict';
const core=window.DKBuilder,$=id=>document.getElementById(id),KEY='dk_simple_builder_v1';
let catalog=null,selectedIds={},extras=[],quantities={},query='',filters={},expandedSlot=null,adding=null,orderOptions={retain_boxes:false,fulfillment_preference:'undecided'};
const deliveryOptions=window.DKBuilderOrderOptions;
const peripherals=window.DKBuilderPeripherals,slots=[...core.slots,...peripherals.slots],mobile=window.matchMedia('(max-width:900px)');
const categoryFor=(p,key)=>peripherals.slots.some(s=>s.key===key)?peripherals.category(p,key):facets.category(p,key);
const validQty=n=>Number.isInteger(Number(n))&&Number(n)>=1&&Number(n)<=99;
const facets=window.DKBuilderCategories,LIMIT=100;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'NT$ '+Number(n||0).toLocaleString('zh-TW');
function restore(){try{const d=JSON.parse(localStorage.getItem(KEY)||'{}');if(d?.version===2){selectedIds=d.ids||{};extras=Array.isArray(d.extras)?d.extras:[];quantities=d.quantities||{};orderOptions=deliveryOptions.normalize(d.order_options);}else if(d&&typeof d==='object')selectedIds=d;}catch(_){}}
function save(){try{localStorage.setItem(KEY,JSON.stringify({version:2,ids:selectedIds,extras,quantities,order_options:orderOptions}));}catch(_){}}
function selected(){const result=core.resolve(selectedIds,catalog?.products||[]);for(const slot of peripherals.slots){const p=catalog?.products.find(p=>p.id===selectedIds[slot.key]&&peripherals.isPart(p,slot.key));if(p)result[slot.key]=p;}return result;}
function lines(){const products=catalog?.products||[],p=selected();return slots.flatMap(slot=>[...(p[slot.key]?[{key:slot.key,slot,item:p[slot.key],qty:validQty(quantities[slot.key])?Number(quantities[slot.key]):1}]:[]),...extras.filter(x=>x.slot===slot.key).map(x=>({key:x.key,slot,item:products.find(p=>p.id===x.id),qty:validQty(x.qty)?Number(x.qty):1})).filter(x=>x.item)]);}
function baseFor(slot){return (catalog?.products||[]).filter(p=>(slot.optional?peripherals.isPart(p,slot.key):core.isPart(p,slot.key))&&window.DKCatalogPricePolicy.accepts(p));}
function optionsFor(slot){
 const f=filters[slot.key]||{},q=query.toLowerCase();
 return baseFor(slot).filter(p=>(!f.category||categoryFor(p,slot.key)===f.category)&&(!f.brand||facets.brand(p)===f.brand)&&(!q||facets.matches(p,q))).sort((a,b)=>(a.price||0)-(b.price||0));
}
function renderSlots(){
 const current=selected();
 $('slotList').innerHTML=slots.map(slot=>{
  const chosen=adding===slot.key?null:current[slot.key],base=baseFor(slot),rows=lines().filter(x=>x.slot.key===slot.key);
  if(!filters[slot.key])filters[slot.key]={category:chosen?categoryFor(chosen,slot.key):'',brand:''};
  const f=filters[slot.key],categories=facets.values(base,p=>categoryFor(p,slot.key)),brands=facets.values(base.filter(p=>!f.category||categoryFor(p,slot.key)===f.category),facets.brand);
  const ready=!!f.category||!!query,items=ready?optionsFor(slot):[],visible=items.slice(0,LIMIT);
  const option=(v,active,label=v)=>'<option value="'+esc(v)+'" '+(active===v?'selected':'')+'>'+esc(label)+'</option>';
  return (slot.key==='cpu'?'<h3>主機零件</h3>':slot.key==='os'?'<h3>作業系統與周邊（可留空）</h3>':'')+'<details class="simple-slot" data-part="'+slot.key+'" '+(!mobile.matches||expandedSlot===slot.key?'open':'')+'><summary class="simple-slot-title"><div><strong>'+esc(slot.title)+(rows.length?' · '+rows.reduce((n,x)=>n+x.qty,0)+' 件':'')+'</strong><span>'+esc(rows.length?rows.map(x=>facets.productLabel(x.item)+(x.qty>1?' × '+x.qty:'')).join('、'):'點開選擇')+'</span></div><span class="slot-toggle" aria-hidden="true"></span></summary><div class="simple-slot-body"><p class="small muted">'+esc(slot.plain)+'</p>'+rows.map(x=>'<div class="chosen-row"><span>'+esc(facets.productLabel(x.item))+'</span><label>數量<input type="number" min="1" max="99" step="1" data-qty="'+esc(x.key)+'" value="'+x.qty+'" aria-label="'+esc(x.item.name)+'數量"></label><button type="button" class="text-button" data-remove="'+esc(x.key)+'">移除</button></div>').join('')+(rows.length?'<button type="button" class="secondary" data-add="'+slot.key+'">再加一項'+esc(slot.title)+'</button>':'')+(adding===slot.key?'<p class="small">正在加購：選擇商品後加入，原有商品會保留。</p>':'')+
   '<div class="simple-category-grid"><label>規格分類<select data-slot-filter="'+slot.key+'" aria-label="'+esc(slot.title)+'規格分類"><option value="">先選分類，或直接搜尋型號</option>'+categories.map(v=>option(v,f.category)).join('')+'</select></label><label>品牌<select data-brand-filter="'+slot.key+'" aria-label="'+esc(slot.title)+'品牌"><option value="">全部品牌</option>'+brands.map(v=>option(v,f.brand,facets.brandLabel(v))).join('')+'</select></label></div>'+
   '<select data-slot="'+slot.key+'" aria-label="選擇'+esc(slot.title)+'" '+(!ready?'disabled':'')+'><option value="">'+(!ready?'— 請先選規格分類 —':items.length?'— 選擇'+esc(slot.title)+' —':'— 沒有符合的商品，請調整分類或搜尋 —')+'</option>'+visible.map(p=>'<option value="'+esc(p.id)+'" '+(chosen?.id===p.id?'selected':'')+'>'+esc(facets.productLabel(p))+' · '+money(p.price)+'</option>').join('')+'</select>'+
   (chosen?'<p class="simple-chosen">目前已選：'+esc(facets.productLabel(chosen))+' · '+money(chosen.price)+(visible.some(p=>p.id===chosen.id)?'':'（目前篩選未顯示，配單仍保留）')+'</p>':'')+
   '<p class="small muted">'+(!ready?'先選規格分類，可避免大量商品擠在同一選單。':items.length.toLocaleString('zh-TW')+' 個符合商品'+(items.length>LIMIT?'；先顯示價格最低的 '+LIMIT+' 筆，請再選品牌或搜尋型號縮小範圍。':''))+'</p></div></details>';
 }).join('');
}
function renderSummary(){
 const p=selected(),rows=lines();let total=0,parts=0,addons=0;
 $('buildItems').innerHTML=rows.map(x=>{const cost=Number(x.item.price||0)*x.qty;total+=cost;if(x.slot.optional)addons+=cost;else parts+=cost;return '<div class="summary-line"><span>'+esc(x.slot.title)+'</span><strong>'+esc(facets.productLabel(x.item))+' × '+x.qty+'</strong><em>'+money(cost)+'</em></div>';}).join('')||'<p class="muted">尚未選擇商品</p>';
 const boxFee=deliveryOptions.fee(orderOptions);total+=boxFee;if(boxFee)$('buildItems').insertAdjacentHTML('beforeend','<div class="summary-line"><span>運費</span><strong>空盒分箱運費 × 1</strong><em>'+money(boxFee)+'</em></div>');
 $('buildTotal').textContent=money(total);
 $('deliverySummary').textContent=deliveryOptions.describe(orderOptions);
 $('retainBoxes').value=orderOptions.retain_boxes?'yes':'no';$('fulfillmentPreference').value=orderOptions.fulfillment_preference;
 $('buildSubtotals').textContent='主機零件 '+money(parts)+' · 周邊／系統 '+money(addons)+(boxFee?' · 空盒分箱 '+money(boxFee):'');
 const quick=$('estimateQuick');if(quick)quick.textContent='查看配單 '+rows.reduce((n,x)=>n+x.qty,0)+' 件 · '+money(total);
 for(const slot of core.slots){const first=rows.find(x=>x.slot.key===slot.key);if(first)p[slot.key]=first.item;}
 const issues=[];
 for(const row of rows.filter(x=>!x.slot.optional)){const slot=row.slot,item=row.item;const check=core.check(item,slot.key,Object.assign(Object.create(p),{[slot.key]:item}));if(check.state==='incompatible')issues.push(...check.reasons);}
 if(core.slots.some(s=>rows.filter(x=>x.slot.key===s.key).reduce((n,x)=>n+x.qty,0)>1))issues.push('已選多件主機零件；是否用於同一台電腦及完整相容性，請由 DK 確認');
 $('compatibility').innerHTML=issues.length?'<p class="error"><strong>相容性提醒：</strong>'+[...new Set(issues)].map(esc).join('；')+'</p>':'<p class="muted small">已選零件未發現目前規則可判定的明確衝突；正式組裝前仍由 DK 核對完整相容性。</p>';
}
function render(){renderSlots();renderSummary();}
function buildText(){
 const text=['DK 電競電腦｜電腦配置單',''];let total=0;for(const x of lines()){const cost=Number(x.item.price||0)*x.qty;total+=cost;text.push(x.slot.title+'｜'+facets.productLabel(x.item)+'｜數量 '+x.qty+'｜'+money(cost));}
 const boxFee=deliveryOptions.fee(orderOptions);if(boxFee){text.push('空盒分箱運費｜'+money(boxFee));total+=boxFee;}text.push('',deliveryOptions.describe(orderOptions),'商品寄送運費另行確認。');
 text.push('','參考總價｜'+money(total),'','實際供貨與正式售價以 DK 最終確認為準。');return text.join('\n');
}
$('slotList').addEventListener('toggle',e=>{if(!mobile.matches||!e.target.matches('details[data-part]')||!e.target.isConnected)return;if(e.target.open){expandedSlot=e.target.dataset.part;for(const d of $('slotList').querySelectorAll('details[open]'))if(d!==e.target)d.open=false;}else if(expandedSlot===e.target.dataset.part)expandedSlot=null;},true);
$('slotList').addEventListener('change',e=>{const qty=e.target.dataset.qty;if(qty){if(!validQty(e.target.value)){render();return;}if(qty in selectedIds)quantities[qty]=Number(e.target.value);else{const x=extras.find(x=>x.key===qty);if(x)x.qty=Number(e.target.value);}save();render();return;}
 const category=e.target.dataset.slotFilter,brand=e.target.dataset.brandFilter;if(category){expandedSlot=category;filters[category]={category:e.target.value,brand:''};renderSlots();return;}if(brand){expandedSlot=brand;filters[brand].brand=e.target.value;renderSlots();return;}
 const s=e.target.dataset.slot;if(!s)return;if(e.target.value){if(adding===s){extras.push({key:'extra-'+crypto.randomUUID(),slot:s,id:e.target.value,qty:1});adding=null;}else selectedIds[s]=e.target.value;}else if(adding!==s)delete selectedIds[s];expandedSlot=mobile.matches?null:s;save();render();if(mobile.matches)$('slotList').querySelector('[data-part="'+s+'"] summary')?.focus({preventScroll:true});});
$('slotList').addEventListener('click',e=>{const add=e.target.closest('[data-add]');if(add){adding=add.dataset.add;expandedSlot=adding;renderSlots();return;}const b=e.target.closest('[data-remove]');if(!b)return;const key=b.dataset.remove;if(key in selectedIds){delete selectedIds[key];delete quantities[key];}else extras=extras.filter(x=>x.key!==key);save();render();});
mobile.addEventListener('change',()=>{expandedSlot=null;render();});
$('partSearch').addEventListener('input',e=>{query=e.target.value.trim();renderSlots();});
$('clearBuild').onclick=()=>{if(!lines().length||confirm('確定清空目前配單？')){selectedIds={};extras=[];quantities={};filters={};adding=null;expandedSlot=null;orderOptions=deliveryOptions.normalize({});save();render();}};
$('copyBuild').onclick=async()=>{try{await navigator.clipboard.writeText(buildText());$('actionStatus').textContent='配單已複製。';}catch(_){$('actionStatus').textContent='瀏覽器無法自動複製，請使用列印功能。';}};
$('printBuild').onclick=()=>window.print();
for(const id of ['retainBoxes','fulfillmentPreference'])$(id).addEventListener('change',()=>{orderOptions=deliveryOptions.normalize({retain_boxes:$('retainBoxes').value==='yes',fulfillment_preference:$('fulfillmentPreference').value});save();renderSummary();});
function buildPayload(){
 const rows=lines(),items=rows.map(x=>({line_key:x.key,category:x.slot.title,product_id:x.item.id,name:x.item.name,unit_price:Number(x.item.price||0),qty:x.qty}));
 const boxLine=deliveryOptions.serviceLine(orderOptions);if(boxLine)items.push(boxLine);
 const subtotal=optional=>rows.filter(x=>!!x.slot.optional===optional).reduce((n,x)=>n+Number(x.item.price||0)*x.qty,0);
 return {schema_version:1,source:'dk-simple-builder',items,total:subtotal(false)+subtotal(true)+deliveryOptions.fee(orderOptions),items_subtotal:subtotal(false)+subtotal(true),parts_subtotal:subtotal(false),peripherals_subtotal:rows.filter(x=>x.slot.optional&&x.slot.key!=='os').reduce((n,x)=>n+Number(x.item.price||0)*x.qty,0),software_subtotal:rows.filter(x=>x.slot.key==='os').reduce((n,x)=>n+Number(x.item.price||0)*x.qty,0),retain_boxes:orderOptions.retain_boxes,fulfillment_preference:orderOptions.fulfillment_preference,box_shipping_fee:deliveryOptions.fee(orderOptions),website:'',catalog_updated_at:catalog?.updatedAt||null,user_agent:String(navigator.userAgent||'').slice(0,300)};
}

function makeBuildNo(){
 const d=new Date(),stamp=d.toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'}).replaceAll('-','');
 const rand=crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().padStart(6,'0').slice(-6);
 return 'DK-BUILD-'+stamp+'-'+rand;
}
async function submitBuild(){
 const btn=$('saveBuild'),payload=buildPayload();
 if(!lines().length){$('actionStatus').textContent='請至少選擇一個零件後再儲存配單。';return;}
 if(!window.DK?.isSupabaseConfigured?.()){$('actionStatus').textContent='目前無法儲存配單，請先複製配單與 DK 聯絡。';return;}
 if(JSON.stringify(payload).length>45000){$('actionStatus').textContent='配單內容較多，請分成兩張配單或直接聯絡 DK。';return;}
 const buildNo=makeBuildNo();btn.disabled=true;$('actionStatus').textContent='正在儲存配單…';
 try{
  const url=window.DK.getSupabaseProjectUrl()+'/rest/v1/builder_submissions';
  const key=window.DK.getSupabaseAnonKey();
  const res=await fetch(url,{signal:AbortSignal.timeout(20000),method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({build_no:buildNo,payload,status:'new'})});
  if(!res.ok)throw new Error('HTTP '+res.status);
  try{localStorage.setItem('dk_last_builder_submission_v1',JSON.stringify({buildNo,savedAt:new Date().toISOString()}));}catch(_){}
  $('actionStatus').textContent='配單已儲存｜編號 '+buildNo+'。到店或聯絡 DK 時提供這個編號即可。';
  try{await navigator.clipboard.writeText(buildNo);}catch(_){}
 }catch(_){$('actionStatus').textContent='配單目前無法送出或確認｜編號 '+buildNo+'。請先向 DK 查詢此編號，避免重複送出；你的選擇仍保留，可先使用「複製配單」。';}
 finally{btn.disabled=false;}
}
$('saveBuild').onclick=submitBuild;
async function load(){try{
 $('builderFailure').hidden=true;const r=await fetch('./data/builder-catalog.json',{cache:'no-cache',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('catalog');let c=await r.json();if(c.schemaVersion!==1||!Array.isArray(c.products)||!c.products.length||!Number.isFinite(Date.parse(c.updatedAt)))throw Error('invalid');try{const pr=await fetch('./data/dk-market-prices.json',{cache:'no-cache',signal:AbortSignal.timeout(5000)});if(pr.ok&&window.DKMarketOverlay)c=window.DKMarketOverlay.apply(c,await pr.json());}catch(_){}c={...c,products:c.products.filter(window.DKCatalogPricePolicy.accepts)};catalog=c;restore();
 const oldCount=Object.keys(selectedIds).length+extras.length;const allowed=(key,id)=>{const slot=slots.find(s=>s.key===key),p=c.products.find(p=>p.id===id);return !!(slot&&p&&(slot.optional?peripherals.isPart(p,key):core.isPart(p,key)));};selectedIds=Object.fromEntries(Object.entries(selectedIds).filter(([key,id])=>allowed(key,id)));const seen=new Set(slots.map(s=>s.key));extras=extras.filter(x=>x&&typeof x.key==='string'&&x.key.startsWith('extra-')&&!seen.has(x.key)&&seen.add(x.key)&&allowed(x.slot,x.id));const removedCount=oldCount-Object.keys(selectedIds).length-extras.length;if(removedCount)$('actionStatus').textContent='原配單有 '+removedCount+' 項已下架或不符合一般單品價，請重新挑選；其餘選擇保留。';
 const valid=new Set(c.products.map(p=>p.id));selectedIds=Object.fromEntries(Object.entries(selectedIds).filter(([,id])=>valid.has(id)));save();
 const stale=Date.now()-Date.parse(c.updatedAt)>24*3600000;$('catalogStatus').textContent='目前商品 '+c.products.length.toLocaleString('zh-TW')+' 筆 · 更新 '+new Date(c.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+(stale?' · 價格資料已超過 24 小時，正式報價需重新確認':'')+'。';
 $('simpleLayout').hidden=false;render();
 }catch(_){$('catalogStatus').textContent='配單資料載入失敗';$('builderFailure').hidden=false;$('simpleLayout').hidden=true;}}
$('retryLoad').onclick=load;load();
})();
