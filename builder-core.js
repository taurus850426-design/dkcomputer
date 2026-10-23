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
 function isPart(item,key){const f=item.facts||{};if(item.category!==slots.find(s=>s.key===key)?.category)return false;
  return {cpu:!!f.socket&&!!f.cores,board:!!f.socket&&!!f.ddr&&!!f.form,ram:f.desktop===true&&!!f.ddr&&!!f.capacityGB,ssd:f.nvme===true&&!!f.capacityGB,gpu:!!f.gpuModel,cooler:f.air===true,case:!!f.form&&!f.restricted,psu:!!f.watts&&!f.compact}[key]===true;
 }
 function check(item,key,selected){
  const f=item.facts||{}, reasons=[],pending=[];const p=selected||{};
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
 function resolve(ids,products){const selected={};for(const s of slots){const p=products.find(p=>p.id===ids?.[s.key]&&isPart(p,s.key));if(p)selected[s.key]=p;}return selected;}
 function validate(selected,needs={}){
  const errors=[],pending=[];let total=0;
  for(const s of slots){const p=selected[s.key];if(!p){if(s.key==='gpu'&&selected.cpu?.facts.integrated&&!needs.usages?.includes('game'))continue;if(s.key==='cooler'&&selected.cpu?.facts.stockCooler)continue;pending.push('尚未選擇'+s.title);continue;}if(!Number.isSafeInteger(p.price)||p.price<=0){errors.push(s.title+'價格無效');continue;}total+=p.price;const c=check(p,s.key,selected);if(c.state==='incompatible')errors.push(...c.reasons);else if(c.state==='pending')pending.push(...c.reasons);}
  if(needs.usages?.includes('game')&&!selected.gpu)pending.push('遊戲用途需確認顯示效能');
  if(selected.ram&&selected.ram.facts.capacityGB<Number(needs.ramGB||16))pending.push('記憶體容量低於本次需求目標');
  pending.push('需由 DK 確認 CPU 支援清單／BIOS、記憶體相容性、SSD 插槽、散熱、電源瓦數與接頭、供貨及最終價格');
  if(needs.usages?.some(x=>['game','create','stream'].includes(x)))pending.push('遊戲畫質／幀數與軟體效能尚未完成配置實測核對');
  return {total,overBudget:Math.max(0,total-Number(needs.budget||0)),errors:[...new Set(errors)],pending:[...new Set(pending)]};
 }
 function suggest(products,needs){
  // Budget draft only. No claim of a verified game target, and no hidden relaxation of filters.
  const selected={},budget=Number(needs.budget)||30000,game=needs.usages?.some(x=>['game','create','stream'].includes(x));
  const share=game?{cpu:.18,board:.12,ram:.13,ssd:.1,gpu:.32,cooler:.03,case:.05,psu:.07}:{cpu:.26,board:.19,ram:.2,ssd:.15,gpu:0,cooler:.03,case:.08,psu:.09};
  for(const s of slots){
   if(s.key==='gpu'&&!game&&selected.cpu?.facts.integrated)continue;
   if(s.key==='cooler'&&selected.cpu?.facts.stockCooler)continue;
   let list=products.filter(p=>isPart(p,s.key)&&check(p,s.key,selected).state==='basic');
   if(s.key==='cpu'&&game){const stock=list.filter(p=>p.facts.stockCooler);if(stock.length)list=stock;}
   if(s.key==='case')list=list.filter(p=>p.facts.maxCoolerMM>=160);
   if(s.key==='cpu'&&!game)list=list.filter(p=>p.facts.integrated);
   if(s.key==='ram')list=list.filter(p=>p.facts.capacityGB>=Number(needs.ramGB||16));
   if(s.key==='ssd')list=list.filter(p=>p.facts.capacityGB>=500);
   if(s.key==='psu')list=list.filter(p=>p.facts.watts>=650&&p.facts.atx3);
   if(s.key==='case'&&needs.color!=='any')list=list.filter(p=>p.name.includes(needs.color==='white'?'白':'黑'));
   list.sort((a,b)=>Math.abs(a.price-budget*share[s.key])-Math.abs(b.price-budget*share[s.key])||a.price-b.price);
   if(list[0])selected[s.key]=list[0];
  }
  return Object.fromEntries(Object.entries(selected).map(([k,p])=>[k,p.id]));
 }
 function summary(needs,selected,catalog){
  const q=validate(selected,needs),usages={office:'文書／日常',game:'遊戲',create:'剪輯／設計',stream:'直播',unsure:'請 DK 協助'};
  return ['【DK 配單需求草稿】','用途：'+(needs.usages||[]).map(x=>usages[x]||x).join('、'),'遊戲／軟體：'+(needs.appNames||[]).join('、'),'遊玩目標：'+(needs.targets||[]).join('；'),'主機預算：'+money(needs.budget),'螢幕：'+(needs.resolution||'待確認')+'；'+(needs.monitor||'待確認'),'外觀：'+({any:'不限',white:'白色',black:'黑色'}[needs.color]||'不限'),'價格資料：'+catalog.updatedAt,...slots.map(s=>s.title+'：'+(selected[s.key]?selected[s.key].name+'｜'+money(selected[s.key].price):'待確認／未選')),'參考零件小計：'+money(q.total),'小計不含未選零件、組裝服務、作業系統與周邊；未確認為 DK 正式報價。',...q.errors.map(x=>'需更正：'+x),...q.pending.map(x=>'待確認：'+x)].join('\n');
 }
 return {slots,money,isPart,check,resolve,validate,suggest,summary};
});
