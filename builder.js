(function(){
 'use strict';
 const core=window.DKBuilder,$=id=>document.getElementById(id),KEY='dk_builder_draft_v1';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usageLabels={office:'文書、上網、看影片',game:'玩遊戲',create:'剪片、修圖、設計',stream:'直播與錄影',unsure:'不確定，想請你推薦'};
 const apps=window.DKBuilderApps||[],defaults=()=>({usages:[],appNames:[],appKinds:{},targets:[],gameTargets:{},budget:30000,color:'any',resolution:'unknown',monitor:'existing',monitorModel:'',refreshRate:'unknown',experience:'unsure',simultaneous:'unknown',workload:'',advancedNotes:'',ramGB:16,experienceVersion:1,workloadLevel:'normal',researchProfiles:[]});
 let catalog,games=[],step=0,view='wizard',needs=defaults(),ids={},others={},otherDrafts={},photoEpoch=0,photoRequests={},photoPending=new Set(),limit=24,partLimit=4,partSearch='',changed=false,dirty=false,appKind='game',appQuery='',appCategory='',appLimit=8,planMessage='',remoteResults=[],remoteEpoch=0,remoteBusy=false,budgetAlternative=null,latestProfiles=[];
 const selected=()=>core.resolve(ids,catalog?.products||[],others);
 function safeRead(){try{return JSON.parse(localStorage.getItem(KEY)||'null');}catch(_){return null;}}
 function restore(){const d=safeRead();if(d?.version!==1)return;const n=d.needs||{};
  needs.usages=Array.isArray(n.usages)?n.usages.filter(x=>Object.hasOwn(usageLabels,x)):[];
  needs.appNames=Array.isArray(n.appNames)?[...new Set(n.appNames.filter(x=>typeof x==='string').slice(0,20).map(x=>findApp(x)?.name||x.slice(0,100)))]:[];
  needs.appKinds={};for(const name of needs.appNames)needs.appKinds[name]=apps.find(a=>a.name===name)?.kind||(['game','software'].includes(n.appKinds?.[name])?n.appKinds[name]:needs.usages.includes('game')?'game':'software');
  for(const key of ['monitorModel','workload','advancedNotes'])needs[key]=typeof n[key]==='string'?n[key].slice(0,key==='monitorModel'?100:1000):'';
  for(const [key,values]of Object.entries({experience:Object.keys(core.experienceLabels),refreshRate:['unknown','60','75','100','120','144','165','180','240','360'],simultaneous:['unknown','yes','no']}))if(values.includes(n[key]))needs[key]=n[key];
  needs.legacyTargets=typeof n.legacyTargets==='string'?n.legacyTargets.slice(0,2000):n.experienceVersion!==1?games.filter(g=>needs.appNames.includes(g.name)&&n.gameTargets?.[g.id]).map(g=>g.name+'：'+(g.targets.find(t=>t.id===n.gameTargets[g.id])?.label||'其他目標，待確認')).join('；'):'';
  needs.budget=Number(n.budget)>0?Math.min(1000000,Number(n.budget)):30000;
  for(const [key,allowed]of Object.entries({color:['any','white','black','allwhite'],resolution:['unknown','1080p','1440p','4k'],monitor:['existing','buy','unknown']}))if(allowed.includes(n[key]))needs[key]=n[key];
  needs.workloadLevel=['normal','heavy','video4k'].includes(n.workloadLevel)?n.workloadLevel:'normal';
  needs.researchProfiles=Array.isArray(n.researchProfiles)?n.researchProfiles.slice(0,20).map(p=>core.policy.fromRequirements(p)).filter(Boolean):[];
  needs.gameTargets={};for(const g of games){const target=n.gameTargets?.[g.id];if(g.targets.some(t=>t.id===target)||target==='custom')needs.gameTargets[g.id]=target;}
  others=core.normalizeOthers(d.others);otherDrafts=core.normalizeOthers(d.otherDrafts,true);const resolved=core.resolve(d.ids,catalog.products);ids=Object.fromEntries(Object.entries(resolved).filter(([k])=>!others[k]).map(([k,p])=>[k,p.id]));
  changed=Object.keys(d.ids||{}).some(k=>ids[k]!==d.ids[k])||d.updatedAt!==catalog.updatedAt;
  step=Number.isInteger(d.step)?Math.max(0,Math.min(12,d.step)):0;
  updateTargets();
 }
 function save(){dirty=true;try{localStorage.setItem(KEY,JSON.stringify({version:1,needs,ids,others,otherDrafts,step,updatedAt:catalog.updatedAt}));dirty=false;$('saveStatus').textContent='草稿已保存在這台裝置；價格會依目前資料重新計算。';}catch(_){$('saveStatus').textContent='此瀏覽器無法保存草稿，離開前請複製需求。';}}
 function updateTargets(){needs=core.compileExperience(needs,games,apps);}
 function refreshSummary(){const p=selected(),q=core.validate(p,needs);
  window.DKBuilderPreview?.update(p);
  $('buildItems').innerHTML=core.slots.map((s,i)=>'<div class="summary-line"><span>'+s.title+'</span><button type="button" data-step="'+(4+i)+'">'+esc(core.partLabel(s.key,p,needs))+'</button>'+(p[s.key]?esc(p[s.key].isCustom?(p[s.key].custom.mode==='owned'?'自備零件 · 相容性待確認':'待報價 · 相容性待確認'):core.money(p[s.key].price)):'')+'</div>').join('');
  const totalLabel=q.total===0&&q.customCount?(q.unpricedCount?'待報價':'費用待確認'):core.money(q.total);$('buildTotal').textContent=totalLabel;$('mobileTotal').textContent=totalLabel;$('budgetStatus').textContent=q.overBudget?'目前小計超出預算 '+core.money(q.overBudget):'主機預算 '+core.money(needs.budget)+'；未選項目仍需預留費用。';if(q.unpricedCount)$('budgetStatus').textContent+=' 尚有 '+q.unpricedCount+' 項待報價，未計入小計；目前不是整台總價。';if(q.ownedCount)$('budgetStatus').textContent+=' 另有 '+q.ownedCount+' 項自備零件，安裝／檢測費用待確認。';$('budgetStatus').className=q.overBudget||q.unpricedCount?'error':'muted small';
 }
 function choice(name,value,text,checked,type='checkbox'){return '<label class="choice"><input type="'+type+'" name="'+name+'" value="'+esc(value)+'" '+(checked?'checked':'')+'>'+esc(text)+'</label>';}
 function sourceLink(url,text){try{const u=new URL(url);if(u.protocol==='https:')return '<a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+'</a>';}catch(_){}return '';}
 function render(focus=true){
  partSearch='';partLimit=4;$('stepMessage').textContent='';$('previous').disabled=step===0;$('next').hidden=step===12||step===3;$('next').textContent=step===2?'查看整台推薦 →':'下一步 →';$('stepLabel').textContent=step<=3?'需求 '+(step+1)+' / 4':step===12?'核對完整需求':'調整零件 '+(step-3)+' / 8';$('builderProgress').max=step<=3?4:13;$('builderProgress').value=step+1;
  let title='',lead='',html='';
  if(step===0){title='你想拿電腦做什麼？';lead='可以複選，我們會一起考慮。';html='<div class="choices">'+Object.entries(usageLabels).map(([v,t])=>choice('usage',v,t,needs.usages.includes(v))).join('')+'</div>';}
  if(step===1){title='把想玩的、想用的加入清單';lead='可以複選。先加入名稱，下一步再統一選擇螢幕與體驗偏好。';html='<div class="tabs" role="group" aria-label="搜尋類型"><button type="button" data-app-kind="game">遊戲</button><button type="button" data-app-kind="software">軟體</button></div><div class="fields"><label>搜尋名稱或關鍵字<input id="appSearch" type="search" maxlength="100" placeholder="例如：瓦羅蘭、Minecraft、Excel" value="'+esc(appQuery)+'"></label><label>分類<select id="appCategory"></select></label></div><p class="muted small">先搜尋常見名稱；找不到可查找外部官方需求，再確認遊戲或軟體版本。</p><button id="searchExternal" type="button" class="secondary">搜尋更多遊戲／軟體</button><div id="remoteResults" class="app-results" aria-live="polite"></div><div id="appResults" class="app-results"></div><button id="appsMore" type="button" class="secondary">顯示更多名稱</button><p id="appSearchStatus" class="small" role="status"></p><button id="addCustomApp" type="button" class="secondary">加入搜尋框中的名稱</button><h3>已加入的遊戲／軟體</h3><div id="selectedApps" class="selected-apps"></div><p id="appMessage" role="status"></p>';}
  if(step===2){title='統一選擇你的使用體驗';lead='所有遊戲共用這次偏好，不用逐款設定。預算先以主機本體計算，螢幕、系統與周邊另計。';html='<div class="fields"><label>主機預算（元）<input id="budget" type="number" min="5000" max="1000000" step="1" required value="'+needs.budget+'"></label><label>螢幕安排<select id="monitor"><option value="existing">已有螢幕</option><option value="buy">還沒買，希望一起推薦（另計）</option><option value="unknown">還不確定</option></select></label><label>螢幕解析度<select id="resolution"><option value="unknown">不清楚，先用 1080P 規劃</option><option value="1080p">1080P／Full HD</option><option value="1440p">2K／1440P</option><option value="4k">4K</option></select></label><label>螢幕型號（選填）<input id="monitorModel" maxlength="100" placeholder="不知道解析度時可填型號" value="'+esc(needs.monitorModel)+'"></label><label>螢幕更新率<select id="refreshRate"><option value="unknown">不清楚</option>'+['60','75','100','120','144','165','180','240','360'].map(v=>'<option value="'+v+'">'+v+'Hz</option>').join('')+'</select></label><label>外觀偏好<select id="color"><option value="any">不限</option><option value="black">黑色機殼</option><option value="white">白色機殼，內部不限色</option><option value="allwhite">全白搭配（可見零件與電源）</option></select></label></div>';
   if(needs.usages.includes('game'))html+='<h3>你比較重視什麼？</h3><div class="choices">'+Object.entries(core.experienceLabels).map(([value,label])=>choice('experience',value,label+'：'+({smooth:'操作反應順暢，願意調低部分畫面效果',balanced:'畫面好看，也兼顧流暢度',visual:'重視場景細節與較高畫質',unsure:'依遊戲、螢幕與預算協助安排'})[value],needs.experience===value,'radio')).join('')+'</div><p class="small muted">這是你的偏好；系統會依各款遊戲可取得的資料整理參考條件，不代表每款遊戲都達到相同畫質或幀數。</p>';
   html+='<label>會同時開遊戲、直播或其他程式嗎？<select id="simultaneous"><option value="unknown">還不確定</option><option value="no">主要分開使用</option><option value="yes">會，希望一起考慮</option></select></label>';
   if(needs.appNames.some(name=>needs.appKinds[name]==='software')||needs.usages.some(x=>['office','create','stream'].includes(x)))html+='<label>主要工作量<select id="workloadLevel"><option value="normal">一般文書／一般創作</option><option value="heavy">大型報表／大量多工（64GB 起）</option><option value="video4k">4K 影片剪輯（32GB、2TB 起）</option></select></label><label>工作量與使用情況（選填）<textarea id="workload" maxlength="1000" rows="3" placeholder="例如：Excel 大型報表、同時開很多分頁、剪輯 4K 影片；軟體版本或模組也可填寫">'+esc(needs.workload)+'</textarea></label>';
   html+='<details class="advanced-needs"><summary>進階需求／補充說明（選填）</summary><label>幀數、光追或其他要求<textarea id="advancedNotes" maxlength="1000" rows="3" placeholder="例如：希望主要競技遊戲 240 FPS、想開光追；特殊條件將單獨標示尚未驗證">'+esc(needs.advancedNotes)+'</textarea></label></details>';
   if(needs.legacyTargets)html+='<p class="notice">舊版個別目標已保留在完整需求：'+esc(needs.legacyTargets)+'。請確認本次共同偏好，如有必須達成的條件可填在進階需求。</p>';
  }
  if(step===3){const p=selected(),q=core.validate(p,needs);title=Object.keys(p).length?'先看看你的整台配置':'需求已整理，還有幾項需要確認';lead='已自動整合已知需求。可以直接採用，或調整外觀與零件；供貨及正式售價另確認。';html='<div class="requirements"><p><strong>遊戲／軟體：</strong>'+esc(needs.appNames.join('、')||'一般日常使用')+'</p><p><strong>整體偏好：</strong>'+esc(core.experienceLabels[needs.experience])+'；'+esc({unknown:'解析度待確認','1080p':'1080P','1440p':'2K／1440P','4k':'4K'}[needs.resolution])+'</p><p><strong>主機預算：</strong>'+core.money(needs.budget)+'</p></div><div class="notice">'+esc('依公開需求及 DK 選配政策，自動整合處理器、顯示卡、記憶體與儲存容量。此為推估方案，未保證特定 FPS；缺少資料的項目會單獨列出。')+' 不會為符合預算自行降低目標或改變外觀條件。</div>';
   if(latestProfiles.some(p=>needs.appNames.includes(p.name)&&!needs.researchProfiles.some(o=>o.name===p.name&&o.checkedAt===p.checkedAt)))html+='<div class="notice">有較新的需求資料；既有零件已保留。<button type="button" id="updateResearch">採用最新需求資料（保留零件）</button></div>';
   if(planMessage)html+='<p class="notice">'+esc(planMessage).replace(/\n/g,'<br>')+'</p>';
   if(needs.unmapped?.length)html+='<div class="notice"><strong>本次尚未驗證的需求</strong><br>'+needs.unmapped.map(esc).join('<br>')+'</div>';
   if(needs.coverage?.length)html+='<div class="requirements"><strong>推薦涵蓋情況</strong>'+needs.coverage.map(c=>'<p>'+esc(c.name)+'：'+esc(c.state==='estimate'?'需求推估':'尚未涵蓋')+(c.checkedAt?' · 資料 '+esc(c.checkedAt.slice(0,10)):' · DK 選配政策')+'</p>').join('')+'</div>';
   if(needs.questions?.length)html+='<div class="notice">'+needs.questions.map(esc).join('<br>')+'</div>';
   if(budgetAlternative)html+='<div class="notice"><strong>預算取捨方案</strong><p>改為 1080P、畫面與流暢兼顧；保留原外觀及工作量。參考小計 '+core.money(budgetAlternative.plan.total)+'。</p><button type="button" id="adoptBudgetAlternative">改用這個目標與方案</button></div>';
   if(q.errors.length)html+='<div class="notice error">'+q.errors.map(esc).join('<br>')+'</div>';
   html+='<div class="build-overview">'+core.slots.map((s,i)=>'<article><div><span class="muted small">'+s.title+'</span><h3>'+esc(core.partLabel(s.key,p,needs))+'</h3><p class="small muted">'+esc(s.plain)+'</p></div><button type="button" class="secondary" data-edit-part="'+(i+4)+'">調整'+s.title+'</button></article>').join('')+'</div><div class="actions overview-actions"><button id="adoptBuild" type="button">'+(needs.partial?'採用暫定配置，查看限制':'採用這份配置，核對需求')+'</button><button id="adjustLook" type="button" class="secondary">調整外觀／使用偏好</button><button id="suggestBuild" type="button" class="secondary">依目前需求重新推薦</button></div><details><summary>推薦參考條件與來源</summary><p class="small">'+esc(needs.targets.join('；')||'未有完整對應目標')+'</p><p class="small muted">'+needs.ruleNotes.map(esc).join('<br>')+'</p>'+needs.ruleSources.map(url=>sourceLink(url,'查看選配參考來源')).join('、')+'</details>';
   if(changed)html+='<p class="notice">商品或價格資料已更新，請重新核對配單。</p>';
  }
  if(step>=4&&step<=11){const s=core.slots[step-4];title='選擇'+s.title;lead=s.plain;html='<label>搜尋'+s.title+'<input id="partSearch" type="search" maxlength="100" placeholder="品牌、型號或顏色"></label><p class="muted small">預設顯示能通過已知規格初步篩選的項目；這不是完整相容性認證。</p><label><input id="showPending" type="checkbox"> 同時查看規格待補的品項（僅供參考，不能自動選入）</label><div id="otherPartHost"></div><p id="partCount" role="status"></p><div id="partProducts" class="cards"></div><button id="partsMore" type="button" class="secondary">顯示更多</button><button id="clearPart" type="button" class="text-button">先不選，交給 DK 確認</button>';}
  if(step===12){title='這是你的配單需求';lead='核對後複製內容，再到官方 LINE 貼上傳送，由 DK 確認配備、供貨與正式報價。';const p=selected(),q=core.validate(p,needs);html='<span class="draft-tag">配單草稿 · 尚未完成店家確認</span>'+otherPhotos(p)+(q.errors.length?'<div class="notice error">'+q.errors.map(esc).join('<br>')+'</div>':'')+'<div class="notice">'+q.pending.map(esc).join('<br>')+'</div><label>完整需求<textarea id="summaryText" readonly rows="14">'+esc(core.summary(needs,p,catalog))+'</textarea></label><div class="actions"><button id="copyBuild" type="button">複製配單需求</button><a class="secondary" id="builderLine" href="https://lin.ee/vOtt85O" target="_blank" rel="noopener noreferrer">開啟官方 LINE</a></div><p class="muted small">此頁不會自動傳送訊息；請在 LINE 貼上後自行傳送。</p>';}
  if(step===3){const q=core.validate(selected(),needs);html='<div class="overview-total"><span>已計價零件參考小計</span><strong>'+esc(q.total?core.money(q.total):'待確認')+'</strong><p class="small muted">組裝、系統與周邊另計；待報價項目未計入，正式價格與供貨由 DK 確認。</p></div>'+html+'<details class="requirements"><summary>查看相容性與待確認事項（'+q.pending.length+'）</summary><p class="small">'+q.pending.map(esc).join('<br>')+'</p></details>';}
  if(step>=4&&step<=11)html='<button id="backToOverview" type="button" class="text-button">← 返回整台配置</button>'+html;
  $('stepTitle').textContent=title;$('stepLead').textContent=lead;$('stepBody').innerHTML=html;
  if(step===1){renderAppCategories();renderApps();renderRemote();}
  if(step===2&&$('workloadLevel'))$('workloadLevel').value=needs.workloadLevel;
  if(step===2)for(const k of ['monitor','resolution','color','refreshRate','simultaneous'])$(k).value=needs[k];
  if(step>=4&&step<=11){renderOtherPart();renderParts();}
  if(step===12){const url=window.DK?.getConfig?.()?.line?.url;try{const u=new URL(url);if(u.protocol==='https:'&&['lin.ee','line.me'].includes(u.hostname))$('builderLine').href=u.href;}catch(_){}}
  refreshSummary();save();if(focus)$('stepTitle').focus({preventScroll:true});
 }

 function currentSlot(){return step>=4&&step<=11?core.slots[step-4]:null;}
 function otherPhotos(parts){return core.slots.filter(slot=>parts[slot.key]?.isCustom&&parts[slot.key].custom.photo).map(slot=>'<figure class="other-photo"><img src="'+esc(parts[slot.key].custom.photo.dataUrl)+'" alt="自填'+esc(slot.title)+'商品照片"><figcaption>'+esc(slot.title)+'照片僅保存在這台裝置，請另傳官方 LINE。</figcaption></figure>').join('');}
 function renderOtherPart(){
  const slot=currentSlot();if(!slot||!$('otherPartHost'))return;
  const draft=core.cleanOtherDraft(otherDrafts[slot.key]||others[slot.key]),active=others[slot.key];
  $('otherPartHost').innerHTML='<details id="otherPart" class="other-part" '+(active||otherDrafts[slot.key]?'open':'')+'><summary>其他／找不到想要的商品</summary><p class="muted small">填寫型號、貼上商品連結，或附上照片，至少提供一項。內容會先暫存，按「套用到配單」後才更新選擇。</p><label>商品名稱／品牌與完整型號<input id="otherName" maxlength="180" placeholder="例如：某品牌顯示卡完整型號" value="'+esc(draft.name)+'"></label><label>商品連結（選填）<input id="otherUrl" type="text" inputmode="url" maxlength="2000" placeholder="https://…" value="'+esc(draft.url)+'"></label><label>取得方式<select id="otherMode"><option value="request">希望 DK 代購（價格與供貨待確認）</option><option value="owned">使用自己已有的零件（相容性與安裝費待確認）</option></select></label><label>商品照片（選填）<input id="otherPhotoInput" type="file" accept="image/jpeg,image/png,image/webp"></label><p class="muted small">每個零件可附一張 JPG、PNG 或 WebP，原始檔最多 10MB。照片會縮小並僅保存在這台裝置，複製配單時請另將照片傳到官方 LINE。</p><div id="otherPhotoPreview"></div><p id="otherMessage" role="status" aria-live="polite"></p><div class="other-actions"><button id="applyOther" type="button">套用到配單</button><button id="removeOther" type="button" class="secondary">清除自填資料</button></div><p class="muted small">自行填入的商品不代表已通過相容性檢查，也不會自動套用原價屋其他型號的價格。</p></details>';
  $('otherMode').value=draft.mode;renderOtherPhoto(slot.key);
 }
 function readOtherDraft(){const slot=currentSlot();if(!slot||!$('otherName'))return null;
  const previous=core.cleanOtherDraft(otherDrafts[slot.key]||others[slot.key]);
  const value=core.cleanOtherDraft({name:$('otherName').value,url:$('otherUrl').value,mode:$('otherMode').value,photo:previous.photo});otherDrafts[slot.key]=value;save();return value;
 }
 function renderOtherPhoto(key){if(currentSlot()?.key!==key||!$('otherPhotoPreview'))return;
  const draft=core.cleanOtherDraft(otherDrafts[key]||others[key]);$('otherPhotoPreview').innerHTML=draft.photo?'<figure class="other-photo"><img src="'+esc(draft.photo.dataUrl)+'" alt="自填商品照片"><figcaption>'+esc(draft.photo.name)+'</figcaption></figure><button id="removeOtherPhoto" type="button" class="text-button">移除照片</button>':'';
  $('applyOther').disabled=photoPending.has(key);if(photoPending.has(key))$('otherMessage').textContent='正在處理照片，完成後即可套用。';
 }
 async function shrinkOtherPhoto(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('請使用 JPG、PNG 或 WebP 照片；HEIC／SVG 請先轉成支援格式。');
  if(!file.size||file.size>10*1024*1024)throw Error('照片最多 10MB，請換一張較小的照片。');
  let bitmap,url;
  try{
   if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(file);
   else{url=URL.createObjectURL(file);bitmap=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('無法讀取照片，請換一張 JPG、PNG 或 WebP。'));img.src=url;});}
   const width=bitmap.width||bitmap.naturalWidth,height=bitmap.height||bitmap.naturalHeight;
   if(!width||!height||width*height>40000000)throw Error('照片解析度過大，請先縮小再加入。');
   const canvas=document.createElement('canvas');let scale=Math.min(1,1280/Math.max(width,height));
   for(let i=0;i<5;i++){
    canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));const context=canvas.getContext('2d');if(!context)throw Error('此瀏覽器無法處理照片，請改貼商品連結。');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const dataUrl=canvas.toDataURL('image/jpeg',Math.max(.5,.8-i*.07));if(dataUrl.length<=120000)return {dataUrl,name:file.name};scale*=.8;
   }
   throw Error('照片仍然過大，請換一張較小的照片。');
  }finally{bitmap?.close?.();if(url)URL.revokeObjectURL(url);}
 }
 async function attachOtherPhoto(file){
  const slot=currentSlot();if(!slot||!file)return;readOtherDraft();const key=slot.key,epoch=photoEpoch,request=(photoRequests[key]||0)+1;photoRequests[key]=request;photoPending.add(key);renderOtherPhoto(key);
  try{
   const photo=await shrinkOtherPhoto(file);if(epoch!==photoEpoch||request!==photoRequests[key])return;
   otherDrafts[key]=core.cleanOtherDraft({...core.cleanOtherDraft(otherDrafts[key]||others[key]),photo});save();
   if(currentSlot()?.key===key&&$('otherMessage'))$('otherMessage').textContent='照片已暫存在此裝置，請按「套用到配單」。';
  }catch(error){if(epoch===photoEpoch&&request===photoRequests[key]&&currentSlot()?.key===key&&$('otherMessage'))$('otherMessage').textContent=error.message||'無法處理照片，原照片已保留。';}
  finally{if(epoch===photoEpoch&&request===photoRequests[key]){photoPending.delete(key);renderOtherPhoto(key);}}
 }
 function appKey(s){return String(s).toLowerCase().replace(/[\s（）():：／/\-]/g,'');}
 function findApp(name){return apps.find(a=>appKey(a.name)===appKey(name)||a.aliases.split(' ').some(x=>appKey(x)===appKey(name)));}
 function renderAppCategories(){const categories=[...new Set(apps.filter(a=>a.kind===appKind).map(a=>a.category))];$('appCategory').innerHTML='<option value="">全部分類</option>'+categories.map(c=>'<option>'+esc(c)+'</option>').join('');$('appCategory').value=appCategory;}
 function renderApps(){if(!$('appResults'))return;
  for(const b of document.querySelectorAll('[data-app-kind]')){b.classList.toggle('active',b.dataset.appKind===appKind);b.setAttribute('aria-pressed',String(b.dataset.appKind===appKind));}
  const query=appKey(appQuery),rows=apps.filter(a=>a.kind===appKind&&(!appCategory||a.category===appCategory)&&(!query||appKey(a.name+' '+a.aliases).includes(query)));
  $('appResults').innerHTML=rows.slice(0,appLimit).map(a=>'<button type="button" class="app-result secondary" data-add-app="'+esc(a.name)+'" '+(needs.appNames.includes(a.name)?'disabled':'')+'><strong>'+esc(a.name)+'</strong><span>'+esc(a.category)+' · '+(needs.appNames.includes(a.name)?'已加入':'＋ 加入清單')+'</span></button>').join('');
  $('appsMore').hidden=rows.length<=appLimit;$('appSearchStatus').textContent=rows.length?'找到 '+rows.length+' 個已收錄名稱。':'本機清單找不到，請點「搜尋更多遊戲／軟體」查找官方需求，或先加入名稱。';
  $('addCustomApp').hidden=!appQuery.trim();$('addCustomApp').textContent='以'+(appKind==='game'?'遊戲':'軟體')+'加入「'+appQuery.trim()+'」';
  $('selectedApps').innerHTML=needs.appNames.length?needs.appNames.map(name=>'<div class="selected-app"><span>'+esc(name)+' <small class="muted">'+(needs.appKinds[name]==='game'?'遊戲':'軟體')+'</small></span><button type="button" class="text-button" data-remove-app="'+esc(name)+'" aria-label="移除'+esc(name)+'">移除</button></div>').join(''):'<p class="muted">還沒有加入項目。</p>';
 }
 function addApp(value){const matches=apps.filter(a=>a.kind===appKind&&(core.policy.key(a.name+' '+a.aliases).includes(core.policy.key(value))));if(/^(gta|gta5|gtav|俠盜獵車手)$/i.test(core.policy.key(value))&&matches.length>1){$('appMessage').textContent='GTA 有不同版本，請從清單選擇 Enhanced 或 Legacy。';return;}const found=findApp(value.trim()),name=(found?.name||value.trim()).slice(0,100),kind=found?.kind||appKind;if(!name)return;
  if(needs.appNames.some(n=>appKey(n)===appKey(name))){$('appMessage').textContent='這個項目已經在清單中。';return;}
  if(needs.appNames.length>=20){$('appMessage').textContent='最多加入 20 個項目，請先移除不需要的名稱。';return;}
  needs.appNames.push(name);needs.appKinds[name]=kind;
  const usage=kind==='game'?'game':found?.category==='文書／日常'||found?.category==='直播／通訊'&&name!=='OBS Studio'?'office':name==='OBS Studio'?'stream':'create';if(!needs.usages.includes(usage))needs.usages.push(usage);
  updateTargets();save();refreshSummary();renderApps();$('appMessage').textContent='已加入 '+name+'。';
 }
 function renderRemote(){if(!$('remoteResults'))return;
  $('searchExternal').disabled=remoteBusy||appQuery.trim().length<2;
  $('searchExternal').textContent=remoteBusy?'正在查找官方需求…':'搜尋更多遊戲／軟體';
  $('remoteResults').innerHTML=remoteResults.map((r,i)=>'<article class="notice"><strong>'+esc(r.name)+'</strong><p>'+esc(r.version||'版本請確認')+' · '+esc(r.profile?'已取得需求，可加入推估':'需求不完整，可先加入並保留限制')+'</p><p>'+esc(r.question||'')+'</p>'+sourceLink(r.sourceUrl,'查看資料來源')+'<p class="small">資料日期：'+esc(r.checkedAt||'未提供')+'</p><button type="button" data-remote-app="'+i+'">確認版本並加入</button></article>').join('');
 }
 async function searchExternal(){const q=appQuery.trim(),kind=appKind;if(q.length<2||remoteBusy)return;const epoch=++remoteEpoch;remoteBusy=true;remoteResults=[];renderRemote();
  const result=await window.DKBuilderResearch?.search(q,kind)||{status:'not_configured',candidates:[]};
  if(epoch!==remoteEpoch)return;remoteBusy=false;if(step!==1||q!==appQuery.trim()||kind!==appKind)return;
  remoteResults=result.candidates||[];renderRemote();
  const labels={not_configured:'外部查找服務尚未啟用；目前仍可使用常見需求配單。',not_enabled:'外部查找暫未啟用，已保存需求仍可使用。',budget_limit:'本期新資料查找額度已用完；已保存需求與配單可繼續使用。',rate_limited:'查找次數較多，請稍後重試；目前配單已保留。',busy:'相同需求正在整理，請稍後再搜尋。',temporarily_unavailable:'外部來源暫時無法使用，請稍後重試。',update_incomplete:'新來源尚不足以重新建立需求，已保留上一版資料。',not_found:'目前找不到可驗證的官方需求，可確認完整名稱或先加入。'};
  $('appSearchStatus').textContent=(result.stale?'目前顯示較舊資料，尚未完成更新。 ':'')+(labels[result.status]||'請確認以下產品與版本，再加入清單。');
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
 function capture(){
  if(step===2){if($('workloadLevel'))needs.workloadLevel=$('workloadLevel').value;needs.budget=Number($('budget').value);for(const k of ['monitor','resolution','color','refreshRate','simultaneous'])needs[k]=$(k).value;for(const k of ['monitorModel','workload','advancedNotes'])if($(k))needs[k]=$(k).value.trim();const chosen=document.querySelector('[name="experience"]:checked');if(chosen)needs.experience=chosen.value;}updateTargets();save();refreshSummary();
 }
 function recommend(){budgetAlternative=null;const plan=core.plan(catalog.products,needs);planMessage=plan.warnings.filter(w=>!needs.ruleNotes.includes(w)).join('\n');if(Object.keys(plan.ids).length)ids=plan.ids;if(plan.overBudget&&(needs.resolution!=='1080p'||needs.experience==='smooth'||needs.experience==='visual')){const alternativeNeeds=core.compileExperience({...needs,resolution:'1080p',experience:'balanced'},games,apps),alternativePlan=core.plan(catalog.products,alternativeNeeds);if(!alternativePlan.missing.length&&alternativePlan.total<=needs.budget&&alternativePlan.total<plan.total)budgetAlternative={needs:alternativeNeeds,plan:alternativePlan};}if(plan.overBudget&&!budgetAlternative)planMessage+='\n保留目前條件時，尚無預算內完整方案；可提高預算或自行調整目標／外觀。';save();return plan;}
 $('builderForm').addEventListener('submit',e=>{e.preventDefault();if(e.submitter?.id==='appSearch')return;capture();if(step===0&&!needs.usages.length){$('stepMessage').textContent='請先選擇至少一個用途。';return;}if(step===0){appKind=needs.usages.includes('game')?'game':'software';appQuery='';appCategory='';appLimit=8;}if(step===1&&!needs.appNames.length&&needs.usages.some(x=>['game','create','stream'].includes(x))){$('stepMessage').textContent='請加入遊戲／軟體名稱。';return;}if(step===2){if(!Object.keys(ids).length&&!Object.keys(others).length)recommend();else planMessage='已保留目前配單；需求若有變更，可按「依目前需求重新推薦」。';}go(Math.min(12,step+1));});
 $('previous').onclick=()=>{capture();go(Math.max(0,step-1));};
 $('builderForm').addEventListener('change',e=>{const t=e.target;if(t.name==='usage'){needs.usages=[...document.querySelectorAll('[name="usage"]:checked')].map(x=>x.value);updateTargets();save();}
  if(t.id==='appCategory'){appCategory=t.value;appLimit=8;renderApps();}
  if(t.id==='otherMode')readOtherDraft();if(t.id==='otherPhotoInput')attachOtherPhoto(t.files?.[0]);if(t.id==='showPending')renderParts();if(['monitor','resolution','color','budget','refreshRate','simultaneous','workloadLevel'].includes(t.id)||t.name==='experience')capture();
 });
 $('builderForm').addEventListener('input',e=>{if(e.target.id==='partSearch'){partSearch=e.target.value.trim();partLimit=4;renderParts();}else if(e.target.id==='appSearch'){appQuery=e.target.value;appLimit=8;remoteEpoch++;remoteBusy=false;remoteResults=[];renderApps();renderRemote();}else if(['monitorModel','workload','advancedNotes','budget'].includes(e.target.id))capture();else if(['otherName','otherUrl'].includes(e.target.id))readOtherDraft();});
 $('builderForm').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&e.target.id==='appSearch'){e.preventDefault();addApp(e.target.value);}});
 $('builderForm').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.appKind){remoteEpoch++;remoteBusy=false;remoteResults=[];appKind=b.dataset.appKind;appCategory='';appQuery='';appLimit=8;$('appSearch').value='';renderAppCategories();renderApps();renderRemote();}
  if(b.id==='updateResearch'){needs.researchProfiles=[...needs.researchProfiles.filter(p=>!latestProfiles.some(n=>n.name===p.name)),...latestProfiles];updateTargets();planMessage='已更新需求資料並保留零件；請按重新推薦，或檢查現有配單的需求提示。';save();render(false);return;}
  if(b.id==='searchExternal'){await searchExternal();return;}
  if(b.dataset.remoteApp!==undefined){const r=remoteResults[Number(b.dataset.remoteApp)];if(!r)return;const profile=r.profile?core.policy.fromRequirements(r.profile):null;if(profile){needs.researchProfiles=needs.researchProfiles.filter(p=>p.name!==profile.name);needs.researchProfiles.push(profile);}if(!apps.some(a=>a.name===r.name))apps.push({name:r.name,kind:r.kind,category:'外部搜尋',aliases:r.name});addApp(r.name);return;}
  if(b.id==='adoptBudgetAlternative'&&budgetAlternative){if(!window.confirm('改為 1080P、畫面與流暢兼顧，並取代目前零件？'))return;needs=budgetAlternative.needs;ids=budgetAlternative.plan.ids;budgetAlternative=null;planMessage='已依你確認的 1080P 目標重新規劃。';save();render(false);return;}
  if(b.dataset.addApp)addApp(b.dataset.addApp);
  if(b.dataset.removeApp){needs.appNames=needs.appNames.filter(n=>n!==b.dataset.removeApp);delete needs.appKinds[b.dataset.removeApp];updateTargets();save();refreshSummary();renderApps();$('appMessage').textContent='已移除 '+b.dataset.removeApp+'。';}
  if(b.id==='addCustomApp')addApp(appQuery);if(b.id==='appsMore'){appLimit+=8;renderApps();}
  if(b.id==='adoptBuild'){go(12);return;}if(b.id==='backToOverview'){go(3);return;}if(b.id==='adjustLook'){go(2);return;}if(b.dataset.editPart){go(Number(b.dataset.editPart));return;}
  if(b.id==='suggestBuild'){if(Object.keys(others).length){$('stepMessage').textContent='目前含有自填／自備零件，請先由 DK 確認規格；已保留你的配單，可繼續手動選配。';return;}const plan=core.plan(catalog.products,needs);if(!Object.keys(plan.ids).length){$('stepMessage').textContent=plan.warnings.join('\n');return;}if(Object.keys(ids).length&&!window.confirm('產生新草稿會取代目前已選零件，是否繼續？'))return;recommend();render(false);$('stepMessage').textContent='已產生配置草稿，參考小計 '+core.money(plan.total)+'。\n'+plan.warnings.join('\n')+'\n尚待完整相容性、整機效能與供貨核對。';}
  if(b.id==='partsMore'){partLimit+=8;renderParts();}if(b.id==='clearPart'){const key=core.slots[step-4].key;delete ids[key];delete others[key];save();refreshSummary();renderOtherPart();renderParts();}
  if(b.dataset.part){const slot=core.slots[step-4],item=catalog.products.find(x=>x.id===b.dataset.part),p=selected();if(!item||core.check(item,slot.key,optionContext(slot.key,p)).state!=='basic'||core.requirementReasons(item,slot.key,needs).length)return;const proposed={...p,[slot.key]:item},bad=core.slots.filter(s=>proposed[s.key]&&s.key!==slot.key&&core.check(proposed[s.key],s.key,proposed).state==='incompatible');if(bad.length&&!window.confirm('這次更換會使'+bad.map(s=>s.title).join('、')+'不相容，將移除這些選項並保留其餘零件。是否繼續？'))return;ids[slot.key]=item.id;delete others[slot.key];for(const s of bad)delete ids[s.key];save();refreshSummary();renderOtherPart();renderParts();$('stepMessage').textContent='已選擇，可按下一步繼續。';}

  if(b.id==='applyOther'){
   const slot=currentSlot(),value=readOtherDraft();if(!slot||!value||photoPending.has(slot.key))return;
   if(value.url&&!core.safeProductUrl(value.url)){$('otherMessage').textContent='請填寫完整的 http:// 或 https:// 商品連結，不可包含帳號密碼。';return;}
   if(!value.name&&!value.url&&!value.photo){$('otherMessage').textContent='請至少填寫商品型號、商品連結，或附上一張照片。';return;}
   others[slot.key]=core.normalizeOthers({[slot.key]:value})[slot.key];delete ids[slot.key];save();refreshSummary();renderParts();$('otherMessage').textContent='已加入配單；'+(value.mode==='owned'?'自備零件的相容性與安裝／檢測費用待確認。':'價格、供貨與相容性待確認，尚未計入小計。');
  }
  if(b.id==='removeOther'){
   const slot=currentSlot();if(!slot)return;photoRequests[slot.key]=(photoRequests[slot.key]||0)+1;photoPending.delete(slot.key);delete others[slot.key];delete otherDrafts[slot.key];save();refreshSummary();renderOtherPart();renderParts();
  }
  if(b.id==='removeOtherPhoto'){
   const slot=currentSlot();if(!slot)return;photoRequests[slot.key]=(photoRequests[slot.key]||0)+1;photoPending.delete(slot.key);readOtherDraft();otherDrafts[slot.key].photo=null;if(others[slot.key])others[slot.key].photo=null;others=core.normalizeOthers(others);save();renderOtherPhoto(slot.key);$('otherMessage').textContent='照片已移除。';refreshSummary();
  }
  if(b.id==='copyBuild'){const text=$('summaryText').value;try{await navigator.clipboard.writeText(text);$('stepMessage').textContent='已複製。請開啟官方 LINE，貼上後自行傳送。';}catch(_){$('summaryText').focus();$('summaryText').select();$('stepMessage').textContent='無法自動複製，已選取內容，請手動複製。';}}
 });
 $('restart').onclick=()=>{if(!window.confirm('清除這台裝置保存的配單並重新開始？'))return;remoteEpoch++;remoteBusy=false;remoteResults=[];budgetAlternative=null;photoEpoch++;photoRequests={};photoPending.clear();ids={};others={};otherDrafts={};needs=defaults();needs.researchProfiles=latestProfiles;planMessage='';changed=false;go(0);};
 $('buildItems').onclick=e=>{const b=e.target.closest('[data-step]');if(b){view='wizard';switchView();go(Number(b.dataset.step));}};
 $('mobileSummary').onclick=()=>$('toSummary').click();
 $('toSummary').onclick=()=>{capture();view='wizard';switchView();go(12);};
 function switchView(){$('wizardView').hidden=view!=='wizard';$('catalogView').hidden=view!=='catalog';$('wizardTab').classList.toggle('active',view==='wizard');$('catalogTab').classList.toggle('active',view==='catalog');if(view==='catalog')renderCatalog();}
 $('wizardTab').onclick=()=>{view='wizard';switchView();};$('catalogTab').onclick=()=>{if(!catalog)return;capture();view='catalog';switchView();};
 for(const id of ['catalogCategory','catalogSearch'])$(id).addEventListener(id==='catalogSearch'?'input':'change',()=>{limit=24;renderCatalog();});$('catalogMore').onclick=()=>{limit+=24;renderCatalog();};
 window.addEventListener('beforeunload',e=>{if(dirty||photoPending.size){e.preventDefault();e.returnValue='';}});
 async function load(){try{
  $('builderFailure').hidden=true;const [c,g,f]=await Promise.all(['./data/builder-catalog.json','./data/builder-games.json','./data/builder-requirements.json'].map(async path=>{const r=await fetch(path,{cache:'no-cache',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();return r.json();}));
  if(c.schemaVersion!==1||!Array.isArray(c.products)||!c.products.length||!Array.isArray(g.games))throw Error('invalid catalog');catalog=c;games=g.games;latestProfiles=(f.profiles||[]).map(p=>core.policy.fromRequirements(p)).filter(Boolean);restore();if(!safeRead())needs.researchProfiles=latestProfiles;updateTargets();
  const stale=Date.now()-Date.parse(c.updatedAt)>48*3600000;$('catalogStatus').textContent='參考原價屋公開標價 · '+c.products.length.toLocaleString('zh-TW')+' 筆商品 · 更新 '+new Date(c.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+(stale?' · 資料已超過 48 小時，價格需重新確認':'')+' · 價格與供貨由 DK 確認'+(changed?' · 商品資料已更新，已下架的選項已移出草稿，請重新核對':'');
  $('catalogCategory').innerHTML='<option value="0">所有分類</option>'+c.categories.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');$('builderLayout').hidden=false;$('mobileTotalBox').hidden=false;render(false);
 }catch(_){$('catalogStatus').textContent='配單資料載入失敗';$('builderFailure').hidden=false;$('builderLayout').hidden=true;$('mobileTotalBox').hidden=true;}}
 $('retryLoad').onclick=load;load().then(async()=>{if(!catalog)return;const profiles=await window.DKBuilderResearch?.catalog?.()||[];for(const raw of profiles){const p=core.policy.fromRequirements(raw);if(!p)continue;const old=latestProfiles.find(x=>x.name===p.name);if(!old||Date.parse(old.checkedAt)<Date.parse(p.checkedAt)){latestProfiles=latestProfiles.filter(x=>x.name!==p.name);latestProfiles.push(p);}}if(!needs.appNames.length&&!Object.keys(ids).length){needs.researchProfiles=latestProfiles;updateTargets();save();}if(step===3)render(false);});
})();
