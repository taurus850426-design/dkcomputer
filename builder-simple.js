(function(){
'use strict';
const core=window.DKBuilder,$=id=>document.getElementById(id),KEY='dk_simple_builder_v1';
let catalog=null,selectedIds={},query='';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'NT$ '+Number(n||0).toLocaleString('zh-TW');
function restore(){try{const d=JSON.parse(localStorage.getItem(KEY)||'{}');if(d&&typeof d==='object')selectedIds=d;}catch(_){}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(selectedIds));}catch(_){}}
function selected(){return core.resolve(selectedIds,catalog?.products||[]);}
function optionsFor(slot){
 const q=query.toLowerCase();
 return (catalog?.products||[]).filter(p=>core.isPart(p,slot.key)&&(!q||String(p.name||'').toLowerCase().includes(q))).sort((a,b)=>(a.price||0)-(b.price||0));
}
function renderSlots(){
 const current=selected();
 $('slotList').innerHTML=core.slots.map(slot=>{
  const items=optionsFor(slot),chosen=current[slot.key];
  return '<article class="simple-slot"><div class="simple-slot-title"><div><strong>'+esc(slot.title)+'</strong><span>'+esc(slot.plain)+'</span></div>'+(chosen?'<button type="button" class="text-button" data-clear="'+slot.key+'">移除</button>':'')+'</div><select data-slot="'+slot.key+'" aria-label="選擇'+esc(slot.title)+'"><option value="">— 選擇'+esc(slot.title)+' —</option>'+items.map(p=>'<option value="'+esc(p.id)+'" '+(chosen?.id===p.id?'selected':'')+'>'+esc(p.name)+' · '+money(p.price)+'</option>').join('')+'</select><p class="small muted">'+items.length.toLocaleString('zh-TW')+' 個可選商品</p></article>';
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
$('slotList').addEventListener('change',e=>{const s=e.target.dataset.slot;if(!s)return;if(e.target.value)selectedIds[s]=e.target.value;else delete selectedIds[s];save();render();});
$('slotList').addEventListener('click',e=>{const b=e.target.closest('[data-clear]');if(!b)return;delete selectedIds[b.dataset.clear];save();render();});
$('partSearch').addEventListener('input',e=>{query=e.target.value.trim();renderSlots();});
$('clearBuild').onclick=()=>{if(!Object.keys(selectedIds).length||confirm('確定清空目前配單？')){selectedIds={};save();render();}};
$('copyBuild').onclick=async()=>{try{await navigator.clipboard.writeText(buildText());$('actionStatus').textContent='配單已複製。';}catch(_){$('actionStatus').textContent='瀏覽器無法自動複製，請使用列印功能。';}};
$('printBuild').onclick=()=>window.print();
async function load(){try{
 $('builderFailure').hidden=true;const r=await fetch('./data/builder-catalog.json',{cache:'no-cache',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('catalog');let c=await r.json();if(c.schemaVersion!==1||!Array.isArray(c.products)||!c.products.length)throw Error('invalid');try{const pr=await fetch('./data/dk-market-prices.json',{cache:'no-cache',signal:AbortSignal.timeout(5000)});if(pr.ok&&window.DKMarketOverlay)c=window.DKMarketOverlay.apply(c,await pr.json());}catch(_){}catalog=c;restore();
 const valid=new Set(c.products.map(p=>p.id));selectedIds=Object.fromEntries(Object.entries(selectedIds).filter(([,id])=>valid.has(id)));save();
 const stale=Date.now()-Date.parse(c.updatedAt)>48*3600000;$('catalogStatus').textContent='目前商品 '+c.products.length.toLocaleString('zh-TW')+' 筆 · 更新 '+new Date(c.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+(stale?' · 價格資料已超過 48 小時，正式報價需重新確認':'')+'。';
 $('simpleLayout').hidden=false;render();
 }catch(_){$('catalogStatus').textContent='配單資料載入失敗';$('builderFailure').hidden=false;$('simpleLayout').hidden=true;}}
$('retryLoad').onclick=load;load();
})();