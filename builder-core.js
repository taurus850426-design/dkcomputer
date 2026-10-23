/* Shared pure rules. Source facts are basic filters, never a complete compatibility certification. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKBuilder=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const slots=[
  {key:'cpu',category:4,title:'處理器',plain:'處理日常工作、遊戲邏輯與多工。'},
  {key:'board',category:5,title:'主機板',plain:'讓零件彼此連接，也決定連接埠與升級空間。'},
  {key:'ram',category:6,title:'記憶體',plain:'同時開很多程式時，容量是否足夠很重要。'},
  {key:'ssd',category:7,title:'儲存空間',plain:'放系統、遊戲與檔案的地方。'},
  {key:'gpu',category:12,title:'顯示卡',plain:'影響遊戲畫面、解析度，以及部分創作工作的速度。'},
  {key:'cooler',category:10,title:'散熱器',plain:'幫處理器散熱，還要確認扣具、解熱能力與機殼空間。'},
  {key:'case',category:14,title:'機殼',plain:'挑喜歡的外觀，也要放得下整套零件。'},
  {key:'psu',category:15,title:'電源供應器',plain:'供應整台電腦用電，瓦數、品質與接頭都要核對。'}
 ];
 const money=n=>'NT$ '+Number(n||0).toLocaleString('zh-TW');
 function safeProductUrl(value){
  try{const u=new URL(String(value||'').trim());return ['https:','http:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:'';}catch(_){return '';}
 }
 function cleanOtherDraft(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return {name:'',url:'',mode:'request',photo:null};
  const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  const photo=raw.photo;let cleanPhoto=null;
  if(photo&&typeof photo.dataUrl==='string'&&photo.dataUrl.length<=120000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo.dataUrl))cleanPhoto={dataUrl:photo.dataUrl,name:text(photo.name,100)||'商品照片'};
  return {name:text(raw.name,180),url:text(raw.url,2000),mode:raw.mode==='owned'?'owned':'request',photo:cleanPhoto};
 }
 function normalizeOthers(raw,drafts=false){
  const out={};for(const slot of slots){const value=raw?.[slot.key];if(!value)continue;const v=cleanOtherDraft(value);if(!drafts)v.url=safeProductUrl(v.url);
   if(v.name||v.url||v.photo)out[slot.key]=v;
  }return out;
 }
 function otherItem(slot,raw){
  const value=normalizeOthers({[slot.key]:raw})[slot.key];if(!value)return null;
  return {id:'other:'+slot.key,category:slot.category,name:value.name||(value.photo?'未提供型號（附照片）':'未提供型號（附商品連結）'),price:null,facts:{},isCustom:true,custom:value};
 }

 function isPart(item,key){const f=item.facts||{};if(item.category!==slots.find(s=>s.key===key)?.category)return false;
  return {cpu:!!f.socket&&!!f.cores,board:!!f.socket&&!!f.ddr&&!!f.form,ram:f.desktop===true&&!!f.ddr&&!!f.capacityGB,ssd:f.nvme===true&&!!f.capacityGB,gpu:!!f.gpuModel,cooler:f.air===true,case:!!f.form&&!f.restricted,psu:!!f.watts&&!f.compact}[key]===true;
 }
 function check(item,key,selected){
  const f=item.facts||{}, reasons=[],pending=[];const p={...(selected||{})};
  if(item.isCustom)return {state:'pending',reasons:['自填零件的規格、相容性與供貨待確認']};
  const related={cpu:['board','cooler','psu'],board:['cpu','ram','ssd','case'],ram:['board','cooler'],ssd:['board'],gpu:['case','psu'],cooler:['cpu','ram','case'],case:['board','gpu','cooler','psu'],psu:['cpu','gpu','case']};
  for(const slot of slots){if(!p[slot.key]?.isCustom)continue;if((related[key]||[]).includes(slot.key))pending.push('已選自填'+slot.title+'，需先確認規格才能判斷相容性');delete p[slot.key];}
  if(!isPart(item,key))return {state:'pending',reasons:['商品規格尚未足以自動判斷']};
  const cpu=key==='cpu'?item:p.cpu,board=key==='board'?item:p.board,ram=key==='ram'?item:p.ram,gpu=key==='gpu'?item:p.gpu,cooler=key==='cooler'?item:p.cooler,box=key==='case'?item:p.case;
  if(['cpu','board'].includes(key)&&cpu&&board&&cpu.facts.socket!==board.facts.socket)reasons.push('處理器與主機板插槽不同');
  if(['board','ram'].includes(key)&&board&&ram&&board.facts.ddr!==ram.facts.ddr)reasons.push('主機板與記憶體世代不同');
  if(['board','case'].includes(key)&&board&&box){const fits={ITX:['ITX'],MATX:['ITX','MATX'],ATX:['ITX','MATX','ATX'],EATX:['ITX','MATX','ATX']};if(board.facts.form==='EATX')pending.push('E-ATX 實際板寬需確認');else if(!fits[box.facts.form]?.includes(board.facts.form))reasons.push('主機板尺寸超出機殼支援範圍');}
  if(['gpu','case'].includes(key)&&gpu&&box){if(!gpu.facts.lengthMM||!box.facts.maxGpuMM)pending.push('顯示卡與機殼長度資料待補');else if(gpu.facts.lengthMM>=box.facts.maxGpuMM)reasons.push('顯示卡長度未保留安裝餘裕');}
  if(['cooler','case'].includes(key)&&cooler&&box){if(!cooler.facts.heightMM||!box.facts.maxCoolerMM)pending.push('散熱器與機殼高度資料待補');else if(cooler.facts.heightMM>=box.facts.maxCoolerMM)reasons.push('散熱器高度未保留安裝餘裕');}
  // A cooler socket must be explicitly listed; a generic "Intel/AMD" label is insufficient.
  if(['cpu','cooler'].includes(key)&&cpu&&cooler){const supported=cooler.facts.supportedSockets;if(!Array.isArray(supported))pending.push('散熱器扣具與解熱能力待確認');else if(!supported.includes(cpu.facts.socket))reasons.push('散熱器不支援處理器插槽');}
  if(key==='psu'&&f.watts<450)pending.push('需另行核算整機功耗');
  return {state:reasons.length?'incompatible':pending.length?'pending':'basic',reasons:reasons.length?reasons:pending};
 }
 function resolve(ids,products,others={}){const selected={};for(const s of slots){const custom=otherItem(s,others[s.key]);if(custom){selected[s.key]=custom;continue;}const p=products.find(p=>p.id===ids?.[s.key]&&isPart(p,s.key));if(p)selected[s.key]=p;}return selected;}
 function validate(selected,needs={}){
  const errors=[],pending=[];let total=0,customCount=0,unpricedCount=0,ownedCount=0;
  for(const s of slots){const p=selected[s.key];if(!p){if(s.key==='gpu'&&selected.cpu?.facts.integrated&&!needs.usages?.includes('game'))continue;if(s.key==='cooler'&&selected.cpu?.facts.stockCooler)continue;pending.push('尚未選擇'+s.title);continue;}if(p.isCustom){customCount++;if(p.custom.mode==='owned'){ownedCount++;pending.push(s.title+'為自備零件，規格與相容性待確認；安裝／檢測費用另確認');}else{unpricedCount++;pending.push(s.title+'為自填商品，價格、規格、相容性與供貨待確認，尚未計價');}continue;}if(!Number.isSafeInteger(p.price)||p.price<=0){errors.push(s.title+'價格無效');continue;}total+=p.price;pending.push(...requirementReasons(p,s.key,needs));const c=check(p,s.key,selected);if(c.state==='incompatible')errors.push(...c.reasons);else if(c.state==='pending')pending.push(...c.reasons);}
  if(needs.usages?.includes('game')&&(!selected.gpu||selected.gpu.isCustom))pending.push('遊戲用途需確認顯示效能');
  if(selected.ram&&!selected.ram.isCustom&&selected.ram.facts.capacityGB<Number(needs.ramGB||16))pending.push('記憶體容量低於本次需求目標');
  pending.push(...(needs.unmapped||[]));
  pending.push('需由 DK 確認 CPU 支援清單／BIOS、記憶體相容性、SSD 插槽、散熱、電源瓦數與接頭、供貨及最終價格');
  if(needs.usages?.some(x=>['game','create','stream'].includes(x)))pending.push('遊戲畫質／幀數與軟體效能尚未完成配置實測核對');
  return {total,customCount,unpricedCount,ownedCount,overBudget:Math.max(0,total-Number(needs.budget||0)),errors:[...new Set(errors)],pending:[...new Set(pending)]};
 }
 function colorOf(item){
  const text=String(item.name||'').replace(/白金|白牌|白名單/g,'');
  const white=/白|\bWHITE\b|\bSNOW\b/i.test(text),black=/黑|\bBLACK\b/i.test(text);
  return white&&!black?'white':black&&!white?'black':'unknown';
 }
 function modelMatch(name,model){
  const normalized=String(name||'').normalize('NFKC').toUpperCase();
  const token=String(model).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^A-Z0-9])'+token+'([^A-Z0-9]|$)').test(normalized);
 }
 function compileNeeds(raw,games){
  const needs={...raw,cpuModels:null,gpuModels:null,ruleSources:[],ruleNotes:[],unmapped:[],ramGB:raw.usages?.includes('create')?32:16,ssdGB:500,ramModules:1,ramSpeedMT:0,minPsuWatts:650,hasGameRule:false};
  if(!raw.usages?.includes('game'))return needs;
  const intersect=(a,b)=>a===null?[...b]:a.filter(x=>b.includes(x));
  for(const name of raw.appNames||[]){
   const game=games.find(g=>g.name===name);if(!game){needs.unmapped.push(name+'：尚無效能選配資料');continue;}
   const target=game.targets.find(t=>t.id===raw.gameTargets?.[game.id]);
   if(!target){needs.unmapped.push(name+'：請先選遊玩目標');continue;}
   needs.ramGB=Math.max(needs.ramGB,Number(target.ramGB)||0);
   if(target.resolution&&raw.resolution!=='unknown'&&raw.resolution!==target.resolution){needs.unmapped.push(name+'：遊玩目標與螢幕解析度不同，請確認要以哪個解析度執行');continue;}
   const resolution=target.resolution||raw.resolution;
   const rule=(target.selectionRules||[]).find(r=>r.resolutions.includes(resolution));
   if(!rule){needs.unmapped.push(name+'：此畫質／解析度尚無現售型號對照');continue;}
   needs.hasGameRule=true;needs.cpuModels=intersect(needs.cpuModels,rule.cpuModels);needs.gpuModels=intersect(needs.gpuModels,rule.gpuModels.map(x=>x.replace(/\s+/g,'').toUpperCase()));
   needs.ramGB=Math.max(needs.ramGB,rule.ramGB||0);needs.ramModules=Math.max(needs.ramModules,rule.ramModules||1);needs.ramSpeedMT=Math.max(needs.ramSpeedMT,rule.ramSpeedMT||0);needs.ssdGB=Math.max(needs.ssdGB,rule.ssdGB||0);needs.minPsuWatts=Math.max(needs.minPsuWatts,rule.minPsuWatts||0);
   needs.ruleSources.push(...rule.sourceUrls);needs.ruleNotes.push(rule.basis);
  }
  needs.ruleSources=[...new Set(needs.ruleSources)];needs.ruleNotes=[...new Set(needs.ruleNotes)];
  if(needs.cpuModels?.length===0||needs.gpuModels?.length===0)needs.unmapped.push('多款遊戲的參考型號沒有共同選項，需由 DK 另行搭配');
  return needs;
 }
 function requirementReasons(item,key,needs={}){
  const f=item.facts||{},out=[];
  if(key==='cpu'&&Array.isArray(needs.cpuModels)&&!needs.cpuModels.some(m=>modelMatch(item.name,m)))out.push('不在這次遊戲目標的參考處理器清單');
  if(key==='gpu'&&Array.isArray(needs.gpuModels)&&!needs.gpuModels.includes(String(f.gpuModel||'').replace(/\s+/g,'').toUpperCase()))out.push('不在這次遊戲目標的參考顯示卡清單');
  if(key==='ram'&&(f.capacityGB||0)<(needs.ramGB||16))out.push('記憶體容量低於需求目標');
  if(key==='ram'&&(f.modules||0)<(needs.ramModules||0))out.push('需選擇已明示條數的雙條記憶體組');
  if(key==='ram'&&(f.speedMT||0)<(needs.ramSpeedMT||0))out.push('記憶體標示速度低於參考條件，或尚未建檔');
  if(key==='ssd'&&(f.capacityGB||0)<(needs.ssdGB||500))out.push('儲存容量低於需求目標');
  if(key==='psu'&&(f.watts||0)<(needs.minPsuWatts||650))out.push('電源瓦數低於目前規劃下限');
  if(needs.color==='allwhite'&&['board','ram','gpu','cooler','case','psu'].includes(key)&&colorOf(item)!=='white')out.push('尚未確認為白色款式');
  if(['white','black'].includes(needs.color)&&key==='case'&&colorOf(item)!==needs.color)out.push('機殼顏色與偏好不同');
  return out;
 }
 function plan(products,needs){
  // Explicit model sets are test-based selection references, not a numerical FPS prediction.
  const game=needs.usages?.some(x=>['game','create','stream'].includes(x));if(needs.usages?.includes('game')&&(!needs.hasGameRule||needs.unmapped?.length))return {ids:{},total:0,missing:slots.map(s=>s.title),warnings:[...(needs.unmapped||[]),'遊戲效能對照尚未完整，沒有自動填入處理器與顯示卡；可調整目標或請 DK 協助'],hasGameRule:false,overBudget:0};let beam=[{selected:{},cost:0,missing:[]}];
  for(const slot of slots){const next=[];
   for(const state of beam){
    const skip=slot.key==='gpu'&&!game&&state.selected.cpu?.facts.integrated||slot.key==='cooler'&&state.selected.cpu?.facts.stockCooler&&needs.color!=='allwhite';
    if(skip){next.push(state);continue;}
    let list=products.filter(p=>Number.isSafeInteger(p.price)&&p.price>0&&isPart(p,slot.key)&&check(p,slot.key,state.selected).state==='basic'&&!requirementReasons(p,slot.key,needs).length);
    if(slot.key==='cpu'&&!game)list=list.filter(p=>p.facts.integrated);
    if(slot.key==='case')list=list.filter(p=>p.facts.maxCoolerMM>=160);
    if(slot.key==='psu')list=list.filter(p=>p.facts.atx3);
    list.sort((a,b)=>a.price-b.price||a.id.localeCompare(b.id));
    // Keep several CPU/platform alternatives; select support parts by total cost, not budget share.
    for(const item of list.slice(0,slot.key==='cpu'?12:6))next.push({selected:{...state.selected,[slot.key]:item},cost:state.cost+item.price,missing:state.missing});
    if(!list.length)next.push({...state,missing:[...state.missing,slot.title]});
   }
   next.sort((a,b)=>a.missing.length-b.missing.length||a.cost-b.cost);beam=next.slice(0,32);
  }
  const best=beam[0]||{selected:{},cost:0,missing:slots.map(s=>s.title)};
  const warnings=[...(needs.unmapped||[])];
  if(best.missing.length)warnings.push('目前找不到可確認符合條件的'+best.missing.join('、')+'，已保留空缺；小計不是完整主機價格');
  if(best.cost>Number(needs.budget))warnings.push('目前候選組合超出預算 '+money(best.cost-Number(needs.budget))+'；不會自動降低遊玩目標或改用非白色零件');
  if(game&&!needs.hasGameRule)warnings.push('此需求尚無現售型號效能對照，本次僅為基本規格草稿');
  warnings.push(...(needs.ruleNotes||[]));
  return {ids:Object.fromEntries(Object.entries(best.selected).map(([k,p])=>[k,p.id])),total:best.cost,missing:best.missing,warnings,hasGameRule:!!needs.hasGameRule,overBudget:Math.max(0,best.cost-Number(needs.budget||0))};
 }
 function suggest(products,needs){return plan(products,needs).ids;}
 function partSummary(slot,item){
  if(!item)return slot.title+'：待確認／未選';
  if(!item.isCustom)return slot.title+'：'+item.name+'｜'+money(item.price);
  const value=item.custom,mode=value.mode==='owned'?'自備零件（不計入採購小計，安裝／檢測費用另確認）':'希望 DK 代購（待報價，尚未計價）';
  return slot.title+'：'+item.name+'｜'+mode+'｜規格與相容性待確認'+(value.url?'\n商品連結：'+value.url:'')+(value.photo?'\n附照片：'+value.photo.name+'（照片僅存在本裝置，請另傳官方 LINE）':'');
 }
 function summary(needs,selected,catalog){
  const q=validate(selected,needs),usages={office:'文書／日常',game:'遊戲',create:'剪輯／設計',stream:'直播',unsure:'請 DK 協助'};
  return ['【DK 配單需求草稿】','用途：'+(needs.usages||[]).map(x=>usages[x]||x).join('、'),'遊戲／軟體：'+(needs.appNames||[]).join('、'),'遊玩目標：'+(needs.targets||[]).join('；'),'主機預算：'+money(needs.budget),'螢幕：'+({unknown:'解析度待確認','1080p':'1080P','1440p':'2K／1440P','4k':'4K'}[needs.resolution]||'待確認')+'；'+({existing:'已有螢幕',buy:'需另購螢幕',unknown:'安排待確認'}[needs.monitor]||'待確認'),'外觀：'+({any:'不限',white:'白色機殼',black:'黑色機殼',allwhite:'全白搭配（可見零件與電源）'}[needs.color]||'不限'),...(needs.ruleSources||[]).map(url=>'效能選配參考：'+url),'價格資料：'+catalog.updatedAt,...slots.map(s=>partSummary(s,selected[s.key])),'已計價零件參考小計：'+money(q.total),...(q.unpricedCount?['尚有 '+q.unpricedCount+' 項待報價，未計入小計；目前不是完整主機總價。']:[]),...(q.ownedCount?['另有 '+q.ownedCount+' 項自備零件，不計入採購小計；安裝／檢測費用待確認。']:[]),'小計不含未選零件、組裝服務、作業系統與周邊；未確認為 DK 正式報價。',...q.errors.map(x=>'需更正：'+x),...q.pending.map(x=>'待確認：'+x)].join('\n');
 }
 return {slots,money,isPart,check,resolve,validate,suggest,summary,colorOf,compileNeeds,requirementReasons,plan,safeProductUrl,cleanOtherDraft,normalizeOthers};
});
