(function(){
 'use strict';
 const core=window.DKBuilder,$=id=>document.getElementById(id),KEY='dk_builder_draft_v1';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usageLabels={office:'文書、上網、看影片',game:'玩遊戲',create:'剪片、修圖、設計',stream:'直播與錄影',unsure:'不確定，想請你推薦'};
 let catalog,games=[],step=0,view='wizard',needs={usages:[],appNames:[],targets:[],gameTargets:{},budget:30000,color:'any',resolution:'unknown',monitor:'existing',ramGB:16},ids={},limit=24,partLimit=4,partSearch='',changed=false,dirty=false;
 const selected=()=>core.resolve(ids,catalog?.products||[]);
 function safeRead(){try{return JSON.parse(localStorage.getItem(KEY)||'null');}catch(_){return null;}}
 function restore(){const d=safeRead();if(d?.version!==1)return;const n=d.needs||{};
  needs.usages=Array.isArray(n.usages)?n.usages.filter(x=>Object.hasOwn(usageLabels,x)):[];
  needs.appNames=Array.isArray(n.appNames)?n.appNames.filter(x=>typeof x==='string').slice(0,20).map(x=>x.slice(0,100)):[];
  needs.budget=Number(n.budget)>0?Math.min(1000000,Number(n.budget)):30000;
  for(const [key,allowed]of Object.entries({color:['any','white','black','allwhite'],resolution:['unknown','1080p','1440p','4k'],monitor:['existing','buy','unknown']}))if(allowed.includes(n[key]))needs[key]=n[key];
  needs.gameTargets={};for(const g of games){const target=n.gameTargets?.[g.id];if(g.targets.some(t=>t.id===target)||target==='custom')needs.gameTargets[g.id]=target;}
  const resolved=core.resolve(d.ids,catalog.products);ids=Object.fromEntries(Object.entries(resolved).map(([k,p])=>[k,p.id]));
  changed=Object.keys(d.ids||{}).some(k=>ids[k]!==d.ids[k])||d.updatedAt!==catalog.updatedAt;
  step=Number.isInteger(d.step)?Math.max(0,Math.min(12,d.step)):0;
  updateTargets();
 }
 function save(){dirty=true;try{localStorage.setItem(KEY,JSON.stringify({version:1,needs,ids,step,updatedAt:catalog.updatedAt}));dirty=false;$('saveStatus').textContent='草稿已保存在這台裝置；價格會依目前資料重新計算。';}catch(_){$('saveStatus').textContent='此瀏覽器無法保存草稿，離開前請複製需求。';}}
 function updateTargets(){needs.targets=[];
  if(needs.usages.includes('game'))for(const g of games.filter(g=>needs.appNames.includes(g.name))){const t=g.targets.find(t=>t.id===needs.gameTargets[g.id]);needs.targets.push(g.name+'：'+(t?.label||'自訂目標，待確認'));}
  needs=core.compileNeeds(needs,games);
 }
 function refreshSummary(){const p=selected(),q=core.validate(p,needs);
  $('buildItems').innerHTML=core.slots.map((s,i)=>'<div class="summary-line"><span>'+s.title+'</span><button type="button" data-step="'+(4+i)+'">'+esc(p[s.key]?.name||'尚未選擇')+'</button>'+(p[s.key]?esc(core.money(p[s.key].price)):'')+'</div>').join('');
  $('buildTotal').textContent=core.money(q.total);$('mobileTotal').textContent=core.money(q.total);$('budgetStatus').textContent=q.overBudget?'目前小計超出預算 '+core.money(q.overBudget):'主機預算 '+core.money(needs.budget)+'；未選項目仍需預留費用。';$('budgetStatus').className=q.overBudget?'error':'muted small';
 }
 function choice(name,value,text,checked,type='checkbox'){return '<label class="choice"><input type="'+type+'" name="'+name+'" value="'+esc(value)+'" '+(checked?'checked':'')+'>'+esc(text)+'</label>';}
 function sourceLink(url,text){try{const u=new URL(url);if(u.protocol==='https:')return '<a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+'</a>';}catch(_){}return '';}
 function render(focus=true){
  partSearch='';partLimit=4;$('stepMessage').textContent='';$('previous').disabled=step===0;$('next').hidden=step===12;$('next').textContent=step===2?'整理需求 →':step===3?'開始逐項挑選 →':'下一步 →';$('stepLabel').textContent='步驟 '+(step+1)+' / 13';$('builderProgress').value=step+1;
  let title='',lead='',html='';
  if(step===0){title='你想拿電腦做什麼？';lead='可以複選，我們會一起考慮。';html='<div class="choices">'+Object.entries(usageLabels).map(([v,t])=>choice('usage',v,t,needs.usages.includes(v))).join('')+'</div>';}
  if(step===1){title='常用什麼遊戲或軟體？';lead='選擇遊戲後，查看官方需求與已建檔的實測參考目標；找不到的名稱直接填寫。';
   if(needs.usages.includes('game'))html+='<div class="choices">'+games.map(g=>choice('game',g.id,g.name,needs.appNames.includes(g.name))).join('')+'</div><div id="gameRequirements"></div>';
   html+='<label>其他遊戲／常用軟體<textarea id="appNames" maxlength="1000" rows="3" placeholder="例如：Minecraft、Excel、剪映；不同名稱請換行">'+esc(needs.appNames.filter(n=>!games.some(g=>g.name===n)).join('\n'))+'</textarea></label><p class="muted small">可填寫版本、模組、剪輯解析度等細節。未建檔的需求由 DK 進一步確認。</p>';
  }
  if(step===2){title='你的預算與使用環境';lead='預算先以主機本體計算；螢幕、正版系統及周邊另行確認。';html='<div class="fields"><label>主機預算（元）<input id="budget" type="number" min="5000" max="1000000" step="1" required value="'+needs.budget+'"></label><label>螢幕安排<select id="monitor"><option value="existing">已有螢幕</option><option value="buy">需要一起購買（另計）</option><option value="unknown">還不確定</option></select></label><label>螢幕解析度<select id="resolution"><option value="unknown">不知道，請協助推薦</option><option value="1080p">1080P</option><option value="1440p">2K／1440P</option><option value="4k">4K</option></select></label><label>外觀偏好<select id="color"><option value="any">不限</option><option value="black">黑色機殼</option><option value="white">白色機殼，內部不限色</option><option value="allwhite">全白搭配（主板、記憶體、顯卡、散熱、機殼與電源）</option></select></label></div>';}
  if(step===3){title='先確認你想要的體驗';lead='需求完整後，再逐項挑選零件。';html='<div class="requirements"><p><strong>用途：</strong>'+esc(needs.usages.map(v=>usageLabels[v]).join('、'))+'</p><p><strong>遊戲／軟體：</strong>'+esc(needs.appNames.join('、')||'待補充')+'</p><p><strong>遊玩目標：</strong>'+esc(needs.targets.join('；')||'待確認')+'</p><p><strong>主機預算：</strong>'+core.money(needs.budget)+'</p><p><strong>記憶體規劃：</strong>先以 '+needs.ramGB+'GB 作為容量篩選目標，依工作量調整。</p></div><div class="notice">有建檔的目標會依測試參考型號、容量與外觀條件搭配，再檢查整體費用。不會為了壓低價格，自動降低目標或改用其他顏色。尚未完成 DK 整機實測與供貨確認。</div><button id="suggestBuild" type="button">依需求產生配置草稿</button>';if(needs.unmapped?.length)html+='<p class="notice">'+needs.unmapped.map(esc).join('<br>')+'</p>';if(needs.ruleSources?.length)html+='<p class="muted small">選配依據：'+needs.ruleSources.map(url=>sourceLink(url,'查看原始測試')).join('、')+'</p>';if(changed)html+='<p class="notice">商品或價格資料已更新；已下架或不再開放的項目已移出草稿，請重新核對。</p>';}
  if(step>=4&&step<=11){const s=core.slots[step-4];title='選擇'+s.title;lead=s.plain;html='<label>搜尋'+s.title+'<input id="partSearch" type="search" maxlength="100" placeholder="品牌、型號或顏色"></label><p class="muted small">預設顯示能通過已知規格初步篩選的項目；這不是完整相容性認證。</p><label><input id="showPending" type="checkbox"> 同時查看規格待補的品項（僅供參考，不能自動選入）</label><p id="partCount" role="status"></p><div id="partProducts" class="cards"></div><button id="partsMore" type="button" class="secondary">顯示更多</button><button id="clearPart" type="button" class="text-button">先不選，交給 DK 確認</button>';}
  if(step===12){title='這是你的配單需求';lead='核對後複製內容，再到官方 LINE 貼上傳送，由 DK 確認配備、供貨與正式報價。';const p=selected(),q=core.validate(p,needs);html='<span class="draft-tag">配單草稿 · 尚未完成店家確認</span>'+(q.errors.length?'<div class="notice error">'+q.errors.map(esc).join('<br>')+'</div>':'')+'<div class="notice">'+q.pending.map(esc).join('<br>')+'</div><label>完整需求<textarea id="summaryText" readonly rows="14">'+esc(core.summary(needs,p,catalog))+'</textarea></label><div class="actions"><button id="copyBuild" type="button">複製配單需求</button><a class="secondary" id="builderLine" href="https://lin.ee/vOtt85O" target="_blank" rel="noopener noreferrer">開啟官方 LINE</a></div><p class="muted small">此頁不會自動傳送訊息；請在 LINE 貼上後自行傳送。</p>';}
  $('stepTitle').textContent=title;$('stepLead').textContent=lead;$('stepBody').innerHTML=html;
  if(step===1)renderGames();
  if(step===2)for(const k of ['monitor','resolution','color'])$(k).value=needs[k];
  if(step>=4&&step<=11)renderParts();
  if(step===12){const url=window.DK?.getConfig?.()?.line?.url;try{const u=new URL(url);if(u.protocol==='https:'&&['lin.ee','line.me'].includes(u.hostname))$('builderLine').href=u.href;}catch(_){}}
  refreshSummary();save();if(focus)$('stepTitle').focus({preventScroll:true});
 }
 function renderGames(){const host=$('gameRequirements');if(!host)return;
  host.innerHTML=games.filter(g=>needs.appNames.includes(g.name)).map(g=>{const t=g.targets.find(t=>t.id===needs.gameTargets[g.id]);return '<div class="requirements"><h3>'+esc(g.name)+'</h3><label>想要的遊玩目標<select data-game-target="'+g.id+'"><option value="custom">我有其他需求／還不確定</option>'+g.targets.map(t=>'<option value="'+t.id+'">'+esc(t.label)+'</option>').join('')+'</select></label>'+(t?'<p>參考 CPU：'+esc(t.cpu)+'<br>參考顯示卡：'+esc(t.gpu)+'<br>參考記憶體容量：'+t.ramGB+'GB</p><p class="muted">'+esc(t.note)+'</p>':'<p class="muted">請在下方補充希望的畫質、流暢度；未驗證前不會承諾效能。</p>')+sourceLink(t?.sourceUrl||g.sourceUrl,t?.sourceLabel||'查看官方需求依據')+'</div>';}).join('');
  for(const g of games){const s=host.querySelector('[data-game-target="'+g.id+'"]');if(s)s.value=needs.gameTargets[g.id]||'custom';}
 }
 function optionContext(key,p){const context={...p};if(key==='cpu'){delete context.board;delete context.cooler;}if(key==='board'){delete context.ram;delete context.case;}return context;}
 function renderParts(){const slot=core.slots[step-4];if(!slot)return;const p=selected(),pending=$('showPending').checked;
  const rows=catalog.products.filter(x=>x.category===slot.category&&(!partSearch||(x.name+' '+x.group).toLowerCase().includes(partSearch.toLowerCase()))).map(item=>{const result=core.check(item,slot.key,optionContext(slot.key,p)),reasons=core.requirementReasons(item,slot.key,needs);return {item,result:reasons.length&&result.state==='basic'?{state:'pending',reasons}:result};}).filter(x=>x.result.state==='basic'||(pending&&x.result.state==='pending')).sort((a,b)=>Number(b.item.id===ids[slot.key])-Number(a.item.id===ids[slot.key])||Math.abs(a.item.price-(p[slot.key]?.price||0))-Math.abs(b.item.price-(p[slot.key]?.price||0))||a.item.price-b.item.price);
  $('partCount').textContent=rows.length?'找到 '+rows.length+' 個選項':'目前沒有能確認適用的項目，可以先跳過交給 DK 確認。';
  $('partProducts').innerHTML=rows.slice(0,partLimit).map(({item,result})=>{const old=p[slot.key]?.price||0,diff=item.price-old;return '<article class="product '+(ids[slot.key]===item.id?'selected':'')+'"><span class="tag">'+(result.state==='basic'?'通過已知規格初步篩選':'規格待補')+'</span><h3>'+esc(item.name)+'</h3><strong>'+core.money(item.price)+'</strong><p>'+esc(item.group)+'</p><p>'+(old?'換選價差：'+(diff>0?'+':'')+core.money(diff):'選入後參考小計：'+core.money(core.validate(p,needs).total+item.price))+'</p>'+(result.reasons.length?'<p>'+result.reasons.map(esc).join('；')+'</p>':'')+'<button type="button" data-part="'+esc(item.id)+'" '+(result.state!=='basic'?'disabled':'')+'>'+(ids[slot.key]===item.id?'已選擇':'選擇這個')+'</button></article>';}).join('');$('partsMore').hidden=rows.length<=partLimit;
 }
 function renderCatalog(){const category=Number($('catalogCategory').value),query=$('catalogSearch').value.trim().toLowerCase();const rows=catalog.products.filter(x=>(!category||x.category===category)&&(!query||(x.name+' '+x.group).toLowerCase().includes(query)));
  $('catalogCount').textContent='共 '+rows.length+' 筆；顯示前 '+Math.min(rows.length,limit)+' 筆';$('catalogProducts').innerHTML=rows.slice(0,limit).map(p=>'<article class="product"><h3>'+esc(p.name)+'</h3><strong>'+core.money(p.price)+'</strong><p>'+esc(p.group)+'</p><p>供貨與相容性待確認</p></article>').join('')||'<p>找不到符合的商品。</p>';$('catalogMore').hidden=rows.length<=limit;
 }
 function go(n){step=n;render();$('wizardView').scrollIntoView?.({behavior:'smooth',block:'start'});}
 function capture(){if(step===1){const known=games.filter(g=>$('stepBody').querySelector('input[name="game"][value="'+g.id+'"]:checked')).map(g=>g.name);needs.appNames=[...new Set([...known,...($('appNames')?.value||'').split(/[\n、,，]/).map(x=>x.trim()).filter(Boolean)])].slice(0,20);}
  if(step===2){needs.budget=Number($('budget').value);for(const k of ['monitor','resolution','color'])needs[k]=$(k).value;}updateTargets();save();refreshSummary();
 }
 $('builderForm').addEventListener('submit',e=>{e.preventDefault();capture();if(step===0&&!needs.usages.length){$('stepMessage').textContent='請先選擇至少一個用途。';return;}if(step===1&&!needs.appNames.length&&needs.usages.some(x=>['game','create','stream'].includes(x))){$('stepMessage').textContent='請選擇或填寫遊戲／軟體名稱。';return;}go(Math.min(12,step+1));});
 $('previous').onclick=()=>{capture();go(Math.max(0,step-1));};
 $('builderForm').addEventListener('change',e=>{const t=e.target;if(t.name==='usage'){needs.usages=[...document.querySelectorAll('[name="usage"]:checked')].map(x=>x.value);updateTargets();save();}
  if(t.name==='game'){capture();renderGames();}
  if(t.dataset.gameTarget){needs.gameTargets[t.dataset.gameTarget]=t.value;updateTargets();renderGames();save();}
  if(t.id==='showPending')renderParts();if(['monitor','resolution','color','budget'].includes(t.id))capture();
 });
 $('builderForm').addEventListener('input',e=>{if(e.target.id==='partSearch'){partSearch=e.target.value.trim();partLimit=4;renderParts();}else if(e.target.id==='appNames')capture();});
 $('builderForm').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  if(b.id==='suggestBuild'){const plan=core.plan(catalog.products,needs);if(!Object.keys(plan.ids).length){$('stepMessage').textContent=plan.warnings.join('\n');return;}if(Object.keys(ids).length&&!window.confirm('產生新草稿會取代目前已選零件，是否繼續？'))return;ids=plan.ids;save();refreshSummary();$('stepMessage').textContent='已產生需求配置草稿，參考小計 '+core.money(plan.total)+'。\n'+plan.warnings.join('\n')+'\n尚待完整相容性、整機效能與供貨核對。';}
  if(b.id==='partsMore'){partLimit+=8;renderParts();}if(b.id==='clearPart'){delete ids[core.slots[step-4].key];save();refreshSummary();renderParts();}
  if(b.dataset.part){const slot=core.slots[step-4],item=catalog.products.find(x=>x.id===b.dataset.part),p=selected();if(!item||core.check(item,slot.key,optionContext(slot.key,p)).state!=='basic'||core.requirementReasons(item,slot.key,needs).length)return;const proposed={...p,[slot.key]:item},bad=core.slots.filter(s=>proposed[s.key]&&s.key!==slot.key&&core.check(proposed[s.key],s.key,proposed).state==='incompatible');if(bad.length&&!window.confirm('這次更換會使'+bad.map(s=>s.title).join('、')+'不相容，將移除這些選項並保留其餘零件。是否繼續？'))return;ids[slot.key]=item.id;for(const s of bad)delete ids[s.key];save();refreshSummary();renderParts();$('stepMessage').textContent='已選擇，可按下一步繼續。';}
  if(b.id==='copyBuild'){const text=$('summaryText').value;try{await navigator.clipboard.writeText(text);$('stepMessage').textContent='已複製。請開啟官方 LINE，貼上後自行傳送。';}catch(_){$('summaryText').focus();$('summaryText').select();$('stepMessage').textContent='無法自動複製，已選取內容，請手動複製。';}}
 });
 $('restart').onclick=()=>{if(!window.confirm('清除這台裝置保存的配單並重新開始？'))return;ids={};needs={usages:[],appNames:[],targets:[],gameTargets:{},budget:30000,color:'any',resolution:'unknown',monitor:'existing',ramGB:16};changed=false;go(0);};
 $('buildItems').onclick=e=>{const b=e.target.closest('[data-step]');if(b){view='wizard';switchView();go(Number(b.dataset.step));}};
 $('mobileSummary').onclick=()=>$('toSummary').click();
 $('toSummary').onclick=()=>{capture();view='wizard';switchView();go(12);};
 function switchView(){$('wizardView').hidden=view!=='wizard';$('catalogView').hidden=view!=='catalog';$('wizardTab').classList.toggle('active',view==='wizard');$('catalogTab').classList.toggle('active',view==='catalog');if(view==='catalog')renderCatalog();}
 $('wizardTab').onclick=()=>{view='wizard';switchView();};$('catalogTab').onclick=()=>{if(!catalog)return;capture();view='catalog';switchView();};
 for(const id of ['catalogCategory','catalogSearch'])$(id).addEventListener(id==='catalogSearch'?'input':'change',()=>{limit=24;renderCatalog();});$('catalogMore').onclick=()=>{limit+=24;renderCatalog();};
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 async function load(){try{
  $('builderFailure').hidden=true;const [c,g]=await Promise.all(['./data/builder-catalog.json','./data/builder-games.json'].map(async path=>{const r=await fetch(path,{cache:'no-cache',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();return r.json();}));
  if(c.schemaVersion!==1||!Array.isArray(c.products)||!c.products.length||!Array.isArray(g.games))throw Error('invalid catalog');catalog=c;games=g.games;restore();
  const stale=Date.now()-Date.parse(c.updatedAt)>48*3600000;$('catalogStatus').textContent='參考原價屋公開標價 · '+c.products.length.toLocaleString('zh-TW')+' 筆商品 · 更新 '+new Date(c.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+(stale?' · 資料已超過 48 小時，價格需重新確認':'')+' · 價格與供貨由 DK 確認'+(changed?' · 商品資料已更新，已下架的選項已移出草稿，請重新核對':'');
  $('catalogCategory').innerHTML='<option value="0">所有分類</option>'+c.categories.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');$('builderLayout').hidden=false;$('mobileTotalBox').hidden=false;render(false);
 }catch(_){$('catalogStatus').textContent='配單資料載入失敗';$('builderFailure').hidden=false;$('builderLayout').hidden=true;$('mobileTotalBox').hidden=true;}}
 $('retryLoad').onclick=load;load();
})();
