(function(){
'use strict';
const core=window.DKBuilder,$=id=>document.getElementById(id),KEY='dk_simple_builder_v1';
let catalog=null,selectedIds={},query='',filters={};
const facets=window.DKBuilderCategories,LIMIT=100;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'NT$ '+Number(n||0).toLocaleString('zh-TW');
function restore(){try{const d=JSON.parse(localStorage.getItem(KEY)||'{}');if(d&&typeof d==='object')selectedIds=d;}catch(_){}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(selectedIds));}catch(_){}}
function selected(){return core.resolve(selectedIds,catalog?.products||[]);}
function baseFor(slot){return (catalog?.products||[]).filter(p=>core.isPart(p,slot.key)&&window.DKCatalogPricePolicy.accepts(p));}
function optionsFor(slot){
 const f=filters[slot.key]||{},q=query.toLowerCase();
 return baseFor(slot).filter(p=>(!f.category||facets.category(p,slot.key)===f.category)&&(!f.brand||facets.brand(p)===f.brand)&&(!q||String(p.name||'').toLowerCase().includes(q))).sort((a,b)=>(a.price||0)-(b.price||0));
}
function renderSlots(){
 const current=selected();
 $('slotList').innerHTML=core.slots.map(slot=>{
  const chosen=current[slot.key],base=baseFor(slot);
  if(!filters[slot.key])filters[slot.key]={category:chosen?facets.category(chosen,slot.key):'',brand:''};
  const f=filters[slot.key],categories=facets.values(base,p=>facets.category(p,slot.key)),brands=facets.values(base.filter(p=>!f.category||facets.category(p,slot.key)===f.category),facets.brand);
  const ready=!!f.category||!!query,items=ready?optionsFor(slot):[],visible=items.slice(0,LIMIT);
  const option=(v,active)=>'<option value="'+esc(v)+'" '+(active===v?'selected':'')+'>'+esc(v)+'</option>';
  return '<article class="simple-slot"><div class="simple-slot-title"><div><strong>'+esc(slot.title)+'</strong><span>'+esc(slot.plain)+'</span></div>'+(chosen?'<button type="button" class="text-button" data-clear="'+slot.key+'">移除</button>':'')+'</div>'+
   '<div class="simple-category-grid"><label>規格分類<select data-slot-filter="'+slot.key+'" aria-label="'+esc(slot.title)+'規格分類"><option value="">先選分類，或直接搜尋型號</option>'+categories.map(v=>option(v,f.category)).join('')+'</select></label><label>品牌<select data-brand-filter="'+slot.key+'" aria-label="'+esc(slot.title)+'品牌"><option value="">全部品牌</option>'+brands.map(v=>option(v,f.brand)).join('')+'</select></label></div>'+
   '<select data-slot="'+slot.key+'" aria-label="選擇'+esc(slot.title)+'" '+(!ready?'disabled':'')+'><option value="">'+(!ready?'— 請先選規格分類 —':items.length?'— 選擇'+esc(slot.title)+' —':'— 沒有符合的商品，請調整分類或搜尋 —')+'</option>'+visible.map(p=>'<option value="'+esc(p.id)+'" '+(chosen?.id===p.id?'selected':'')+'>'+esc(p.name)+' · '+money(p.price)+'</option>').join('')+'</select>'+
   (chosen?'<p class="simple-chosen">目前已選：'+esc(chosen.name)+' · '+money(chosen.price)+(visible.some(p=>p.id===chosen.id)?'':'（目前篩選未顯示，配單仍保留）')+'</p>':'')+
   '<p class="small muted">'+(!ready?'先選規格分類，可避免大量商品擠在同一選單。':items.length.toLocaleString('zh-TW')+' 個符合商品'+(items.length>LIMIT?'；先顯示價格最低的 '+LIMIT+' 筆，請再選品牌或搜尋型號縮小範圍。':''))+'</p></article>';
 }).join('');
}
function renderSummary(){
 const p=selected();let total=0;
 $('buildItems').innerHTML=core.slots.map(slot=>{const item=p[slot.key];if(item)total+=Number(item.price||0);return '<div class="summary-line"><span>'+esc(slot.title)+'</span><strong>'+(item?esc(item.name):'尚未選擇')+'</strong>'+(item?'<em>'+money(item.price)+'</em>':'')+'</div>';}).join('');
 $('buildTotal').textContent=money(total);
 const issues=[];
 for(const slot of core.slots){const item=p[slot.key];if(!item)continue;const check=core.check(item,slot.key,p);if(check.state==='incompatible')issues.push(...check.reasons);}
 $('compatibility').innerHTML=issues.length?'<p class="error"><strong>相容性提醒：</strong>'+[...new Set(issues)].map(esc).join('；')+'</p>':'<p class="muted small">已選零件未發現目前規則可判定的明確衝突；正式組裝前仍由 DK 核對完整相容性。</p>';
}
function render(){renderSlots();renderSummary();}
function buildText(){
 const p=selected(),lines=['DK 電競電腦｜電腦配置單',''];
 let total=0;for(const slot of core.slots){const item=p[slot.key];if(!item)continue;total+=Number(item.price||0);lines.push(slot.title+'｜'+item.name+'｜'+money(item.price));}
 lines.push('','參考總價｜'+money(total),'','實際供貨與正式售價以 DK 最終確認為準。');return lines.join('\n');
}
$('slotList').addEventListener('change',e=>{const category=e.target.dataset.slotFilter,brand=e.target.dataset.brandFilter;if(category){filters[category]={category:e.target.value,brand:''};renderSlots();return;}if(brand){filters[brand].brand=e.target.value;renderSlots();return;}const s=e.target.dataset.slot;if(!s)return;if(e.target.value)selectedIds[s]=e.target.value;else delete selectedIds[s];save();render();});
$('slotList').addEventListener('click',e=>{const b=e.target.closest('[data-clear]');if(!b)return;delete selectedIds[b.dataset.clear];save();render();});
$('partSearch').addEventListener('input',e=>{query=e.target.value.trim();renderSlots();});
$('clearBuild').onclick=()=>{if(!Object.keys(selectedIds).length||confirm('確定清空目前配單？')){selectedIds={};filters={};save();render();}};
$('copyBuild').onclick=async()=>{try{await navigator.clipboard.writeText(buildText());$('actionStatus').textContent='配單已複製。';}catch(_){$('actionStatus').textContent='瀏覽器無法自動複製，請使用列印功能。';}};
$('printBuild').onclick=()=>window.print();
function buildPayload(){
 const p=selected(),items=[];let total=0;
 for(const slot of core.slots){const item=p[slot.key];if(!item)continue;const price=Number(item.price||0);total+=price;items.push({line_key:slot.key,category:slot.title,product_id:item.id,name:item.name,unit_price:price,qty:1});}
 return {schema_version:1,source:'dk-simple-builder',items,total,website:'',catalog_updated_at:catalog?.updatedAt||null,user_agent:String(navigator.userAgent||'').slice(0,300)};
}
function makeBuildNo(){
 const d=new Date(),stamp=d.toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'}).replaceAll('-','');
 const rand=crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().padStart(6,'0').slice(-6);
 return 'DK-BUILD-'+stamp+'-'+rand;
}
async function submitBuild(){
 const btn=$('saveBuild'),payload=buildPayload();
 if(!payload.items.length){$('actionStatus').textContent='請至少選擇一個零件後再儲存配單。';return;}
 if(!window.DK?.isSupabaseConfigured?.()){$('actionStatus').textContent='目前無法儲存配單，請先複製配單與 DK 聯絡。';return;}
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
 const removedCount=Object.values(selectedIds).filter(id=>!c.products.some(p=>p.id===id)).length;if(removedCount)$('actionStatus').textContent='原配單有 '+removedCount+' 項已下架或不符合一般單品價，請重新挑選；其餘選擇保留。';
 const valid=new Set(c.products.map(p=>p.id));selectedIds=Object.fromEntries(Object.entries(selectedIds).filter(([,id])=>valid.has(id)));save();
 const stale=Date.now()-Date.parse(c.updatedAt)>24*3600000;$('catalogStatus').textContent='目前商品 '+c.products.length.toLocaleString('zh-TW')+' 筆 · 更新 '+new Date(c.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+(stale?' · 價格資料已超過 24 小時，正式報價需重新確認':'')+'。';
 $('simpleLayout').hidden=false;render();
 }catch(_){$('catalogStatus').textContent='配單資料載入失敗';$('builderFailure').hidden=false;$('simpleLayout').hidden=true;}}
$('retryLoad').onclick=load;load();
})();
