/* Budget-aware selection policy. Classes below are planning priorities, not benchmark scores. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./builder-advisor.js'):root.DKBuilderAdvisor);if(typeof module==='object'&&module.exports)module.exports=api;else root.DKBuilderFit=api;})(typeof window==='object'?window:globalThis,function(advisor){
 'use strict';
 const version=1;
 const sources=[
  {name:'VALORANT 官方需求',url:'https://playvalorant.com/zh-tw/specs/',note:'提供不同幀數的參考硬體；未指定所有解析度與設定。'},
  {name:'PUBG 官方需求',url:'https://support.pubg.com/hc/en-us/articles/115002108373-What-are-the-minimum-and-recommended-requirements-to-play-PUBG',note:'一般與競技需求不同，不能直接視為 1440P 實測。'},
  {name:'Cyberpunk 2077 官方需求',url:'https://support.cdprojektred.com/en/cyberpunk/pc/installation-sp/issue/1556/cyberpunk-2077-system-requirements',note:'畫質、解析度與光追有不同條件；本次預設不含光追。'},
  {name:'NVIDIA RTX 5060 系列規格與測試條件',url:'https://www.nvidia.com/en-sg/geforce/graphics-cards/50-series/rtx-5060-family/',note:'1440P 展示使用 5060 Ti 16GB，且包含 DLSS／補幀；不當作原生 FPS 保證。'}
 ].map(s=>({...s,checkedAt:'2026-10-23'}));
 const cpus=[
  ['14100',0],['12400F',1],['12400',1],['5600X',1],['5600',1],
  ['7500F',2],['7600X',2],['7600',2],['9600X',2],['8600G',1],['8500G',0],['14400F',2],['14400',2],['225F',2],['225',2],
  ['7700',3],['9700X',3],['14700',3],['265KF',3],['265K',3],
  ['5800X3D',3],['7800X3D',4],['9800X3D',4],['9900X',3],['9950X',3],['285K',3]
 ];
 const gpuClasses={RTX3050:0,RTX5050:1,RTX3060:1,RTX4060:2,RTX5060:2,RTX4060TI:3,RTX5060TI:3,RTX4070:4,RTX4070SUPER:4,RTX5070:4,RTX4070TI:5,RTX4070TISUPER:5,RTX5070TI:5,RTX4080:6,RTX4080SUPER:6,RTX5080:6,RTX4090:7,RTX5090:7};
 const cpuClass=p=>cpus.find(([model])=>new RegExp('(^|[^A-Z0-9])'+model+'([^A-Z0-9]|$)','i').test(p?.name||''))?.[1]??-1;
 const gpuClass=p=>gpuClasses[String(p?.facts?.gpuModel||'').replace(/\s+/g,'').toUpperCase()]??-1;
 const powerFor=p=>gpuClass(p)>=6?850:gpuClass(p)>=5?750:p?650:550;
 // Application priorities are explicit planning policies, not a universal CPU benchmark ranking.
 const contentCpu=p=>[['9950X',5],['285K',5],['9900X',4],['265K',4],['265KF',4],['9700X',3],['14700',3],['7700',3],['9800X3D',3],['7800X3D',2],['5800X3D',2]].find(([model])=>new RegExp('(^|[^A-Z0-9])'+model+'([^A-Z0-9]|$)','i').test(p.name))?.[1]??Math.min(cpuClass(p),2);
 const vram=p=>Number((p?.name?.match(/(?:^|[^0-9])(\d{1,2})\s*G(?:B)?(?:[^A-Z0-9]|$)/i)||[])[1])||0;
 function targetLabel(n){return (n.resolution==='1440p'?'2K／1440P（2560×1440）':n.resolution==='4k'?'4K':n.resolution==='unknown'?'暫定 1080P':'1080P')+' · '+({medium:'一般畫質',high:'高畫質',ultra:'極高畫質'}[n.gameQuality]||'高畫質')+' · '+(n.targetFps||60)+' FPS 目標（推估）';}
 function compile(raw,base,policy){
  const n={...base,fitVersion:version,gameQuality:['medium','high','ultra'].includes(raw.gameQuality)?raw.gameQuality:'high',targetFps:['60','144','240'].includes(String(raw.targetFps))?Number(raw.targetFps):60};
  const games=(raw.appNames||[]).map(name=>policy.lookup(name,raw.researchProfiles||[])).filter(p=>p?.kind==='game');
  const game=raw.usages?.includes('game'),creative=raw.usages?.some(x=>['create','stream'].includes(x))||raw.workloadLevel==='video4k';
  n.lightGames=game&&games.length>0&&games.every(p=>/英雄聯盟|VALORANT|Minecraft/i.test(p.name));
  const heavy=games.some(p=>p.gpuTier>=1),multi=raw.simultaneous==='yes'||raw.usages?.includes('stream');
  let cpuMin=game?(n.lightGames&&n.targetFps===60?0:1):0,gpuMin=game?(n.lightGames?0:2):creative?2:-1;
  if(heavy)cpuMin=2;
  if(game&&n.targetFps>=144)cpuMin=Math.max(cpuMin,2);
  if(game&&n.targetFps>=240)cpuMin=4;
  if(multi||creative||raw.workloadLevel==='heavy')cpuMin=Math.max(cpuMin,3);
  if(game){
   if(raw.resolution==='1440p'&&!n.lightGames)gpuMin++;
   if(raw.resolution==='4k')gpuMin+=n.lightGames?2:3;
   if(n.gameQuality==='medium'&&!n.lightGames)gpuMin=Math.max(2,gpuMin-1);
   if(n.gameQuality==='ultra')gpuMin++;
   if(n.targetFps>=144&&!n.lightGames)gpuMin++;
   if(n.targetFps>=240)gpuMin++;
   if(heavy)gpuMin=Math.max(gpuMin,raw.resolution==='4k'?6:raw.resolution==='1440p'?4:3);
  }
  n.cpuMin=cpuMin;n.gpuMin=gpuMin;n.needsDiscrete=gpuMin>=0;
  n.cpuModels=cpus.filter(([,rank])=>rank>=cpuMin).map(([model])=>model);
  n.gpuModels=gpuMin<0?null:Object.keys(gpuClasses).filter(model=>gpuClasses[model]>=gpuMin);
  // DDR4 remains a valid budget platform. Requirements do not mandate DDR5 clock rates.
  n.ramModules=2;n.ramSpeedMT=0;
  n.ramGB=Math.max(base.ramGB,game&&n.targetFps>=144&&!n.lightGames?32:16);
  n.minVramGB=gpuMin<0?0:gpuMin===0?6:game&&raw.resolution==='4k'&&!n.lightGames||gpuMin>=5?16:game&&raw.resolution==='1440p'&&n.gameQuality!=='medium'&&!n.lightGames?12:8;
  n.minPsuWatts=gpuMin>=6?850:gpuMin>=4?750:gpuMin<0?550:650;
  n.goalLabel=game?targetLabel(n):'依工作量規劃；文書解析度不會自動要求獨立顯卡';
  n.ruleNotes=[...base.ruleNotes,'本次以用途、畫質／FPS 目標與主機預算比較不同 CPU 平台及記憶體世代；FPS 是選配目標，尚非整機實測。'];
  if(game&&raw.resolution==='1440p')n.ruleNotes.push('2K 指 2560×1440；一般文書、競技遊戲與大型遊戲採不同的選配條件。');
  if(game&&n.minVramGB>=12)n.ruleNotes.push('已為高解析度／高畫質預留至少 '+n.minVramGB+'GB 顯示記憶體，8GB 版本不會被當成相同方案。');
  const relevant=game?sources.filter(s=>s.name.startsWith('NVIDIA')||games.some(p=>s.name.startsWith('VALORANT')&&/VALORANT/.test(p.name)||s.name.startsWith('PUBG')&&p.name==='PUBG'||s.name.startsWith('Cyberpunk')&&/電馭叛客|Cyberpunk/i.test(p.name))):[];
  n.fitSources=relevant;n.ruleSources=[...new Set([...base.ruleSources,...relevant.map(s=>s.url)])];
  if(advisor&&raw.advisorVersion===1){advisor.compile(raw,n,policy);n.cpuModels=cpus.filter(([,rank])=>rank>=n.cpuMin).map(([model])=>model);n.gpuModels=n.gpuMin<0?null:Object.keys(gpuClasses).filter(model=>gpuClasses[model]>=n.gpuMin);n.needsDiscrete=n.gpuMin>=0;}
  return n;
 }
 function solve(products,n,core,budget){
  const bySlot={};for(const slot of core.slots)bySlot[slot.key]=products.filter(p=>Number.isSafeInteger(p.price)&&p.price>0&&core.isPart(p,slot.key)&&core.preferred(p,slot.key)&&!core.requirementReasons(p,slot.key,n).length).filter(p=>slot.key!=='cpu'||cpuClass(p)>=n.cpuMin).filter(p=>slot.key!=='gpu'||gpuClass(p)>=n.gpuMin&&vram(p)>=n.minVramGB).filter(p=>slot.key!=='psu'||p.facts.atx3).filter(p=>slot.key!=='ram'||p.facts.capacityGB<=(n.ramCeiling||Math.max(n.ramGB,32))).filter(p=>slot.key!=='ssd'||p.facts.capacityGB<=(n.ssdCeiling||Math.max(n.ssdGB,2000))).sort((a,b)=>a.price-b.price||a.id.localeCompare(b.id));
  if(!n.needsDiscrete)bySlot.cpu=bySlot.cpu.filter(p=>p.facts.integrated);
  if(n.advisorVersion===1){bySlot.case=bySlot.case.filter(p=>advisor.caseAllowed(p,n));if(n.network==='wifi')bySlot.board=bySlot.board.filter(p=>/wi[ -]?fi|無線/i.test(p.name));}
  const weights=n.cpuPriority==='creative'?{cpu:14,gpu:9}:n.needsDiscrete?(n.targetFps>=144?{cpu:9,gpu:10}:{cpu:4,gpu:14}):{cpu:4,gpu:0};
  if(n.allocation==='performance'&&n.needsDiscrete)weights.gpu+=4;
  function score(p,key){const f=p.facts,look=n.advisorVersion===1&&n.allocation==='appearance'&&['ram','gpu','cooler'].includes(key)&&/ARGB|RGB|白|WHITE/i.test(p.name)?2:0;
   if(key==='cpu')return (n.cpuPriority==='creative'?contentCpu(p):Math.min(cpuClass(p),n.cpuCeiling??n.cpuMin+1))*weights.cpu;
   if(key==='gpu')return Math.min(gpuClass(p),n.gpuCeiling??n.gpuMin+2)*weights.gpu+(vram(p)>=16?1:0)+look;
   if(key==='ram')return (n.advisorVersion===1?Math.min(f.capacityGB,n.ramCeiling)/16*(n.cpuPriority==='creative'?4:2):n.ramGB<32&&f.capacityGB>=32?4:0)+look;
   if(key==='ssd')return n.advisorVersion===1?Math.min(f.capacityGB,n.ssdCeiling)/1000*2:n.ssdGB<2000&&f.capacityGB>=2000?2:0;
   if(n.advisorVersion===1&&key==='cooler')return (n.noise==='quiet'?5:0)+look;
   if(n.advisorVersion===1&&key==='case'&&n.lookStyle==='any')return n.allocation==='appearance'?(advisor.caseProfile(p)?.style==='showcase'?6:2):advisor.caseProfile(p)?.style==='plain'?2:0;
   return 0;
  }
  const group=(p,key)=>key==='cpu'?[p.facts.socket,p.facts.stockCooler,cpuClass(p),n.cpuPriority==='creative'?contentCpu(p):''].join(':'):key==='board'?[p.facts.socket,p.facts.ddr,p.facts.form].join(':'):key==='ram'?[p.facts.ddr,p.facts.capacityGB,p.facts.modules].join(':'):key==='gpu'?[gpuClass(p),vram(p),Math.ceil(p.facts.lengthMM/50)].join(':'):key==='ssd'?String(p.facts.capacityGB):key==='cooler'?[...(p.facts.supportedSockets||[]),p.facts.heightMM,n.advisorVersion===1&&/ARGB|RGB/i.test(p.name)?'rgb':'plain'].join(':'):key==='case'?[p.facts.form,p.facts.maxGpuMM,p.facts.maxCoolerMM,n.advisorVersion===1?advisor.caseProfile(p)?.style:''].join(':'):String(p.facts.watts);
  for(const slot of core.slots){const seen=new Set();bySlot[slot.key]=bySlot[slot.key].filter(p=>{const k=group(p,slot.key);if(seen.has(k))return false;seen.add(k);return true;});}
  const lowerBound=core.slots.map(slot=>['gpu','cooler'].includes(slot.key)?0:bySlot[slot.key][0]?.price||0);
  let beam=[{parts:{},cost:0,score:0,missing:[]}];
  for(let i=0;i<core.slots.length;i++){
   const slot=core.slots[i],next=[];
   for(const state of beam){
    if(slot.key==='gpu'&&!n.needsDiscrete||slot.key==='cooler'&&state.parts.cpu?.facts.stockCooler&&n.color!=='allwhite'&&n.noise!=='quiet'){next.push(state);continue;}
    const choices=bySlot[slot.key].filter(p=>core.check(p,slot.key,state.parts).state==='basic'&&(slot.key!=='psu'||p.facts.watts>=powerFor(state.parts.gpu)));
    if(!choices.length){next.push({...state,missing:[...state.missing,slot.title]});continue;}
    for(const p of choices.slice(0,slot.key==='cpu'||slot.key==='gpu'?24:12))next.push({parts:{...state.parts,[slot.key]:p},cost:state.cost+p.price,score:state.score+score(p,slot.key),missing:state.missing});
   }
   // Keep low-cost paths for each platform as well as affordable useful upgrades.
   const cheapest=[...next].sort((a,b)=>a.missing.length-b.missing.length||a.cost-b.cost),reserve=new Map();
   for(const state of cheapest){const p=state.parts,k=[p.cpu?.facts.socket,p.cpu?.facts.stockCooler,p.board?.facts.ddr,p.board?.facts.form,p.gpu?.facts.lengthMM].join(':');if(!reserve.has(k))reserve.set(k,state);}
   const remain=lowerBound.slice(i+1).reduce((a,b)=>a+b,0),ranked=[...next].sort((a,b)=>a.missing.length-b.missing.length||Number(b.cost+remain<=budget)-Number(a.cost+remain<=budget)||b.score-a.score||a.cost-b.cost);
   beam=[...new Set([...cheapest.slice(0,24),...reserve.values(),...ranked.slice(0,104)])].slice(0,192);
  }
  const complete=beam.filter(s=>!s.missing.length&&core.validate(s.parts,n).errors.length===0);
  return {complete,partial:[...beam].sort((a,b)=>a.missing.length-b.missing.length||a.cost-b.cost)[0]};
 }
 function plans(products,raw,core){
  const n=core.compileExperience({...raw,fitVersion:1}),budget=Number(raw.budget)||30000,search=solve(products,n,core,budget),sorted=[...search.complete].sort((a,b)=>a.cost-b.cost||b.score-a.score),minimum=sorted[0];
  const pack=(s,key,title,needs,reason,tradeoffs=[])=>({key,title,needs:{...needs,minPsuWatts:Math.max(needs.minPsuWatts,powerFor(s?.parts?.gpu))},reason,tradeoffs,requiresConfirmation:tradeoffs.length>0,ids:Object.fromEntries(Object.entries(s?.parts||{}).map(([k,p])=>[k,p.id])),total:s?.cost||0,missing:s?.missing||core.slots.map(s=>s.title),warnings:[...needs.unmapped,...needs.questions,...needs.ruleNotes],partial:needs.partial,hasGameRule:needs.hasGameRule,overBudget:Math.max(0,(s?.cost||0)-budget),fit:{budget,withinBudget:!s?.missing?.length&&(s?.cost||0)<=budget,goal:needs.goalLabel,basis:'selection-policy-estimate',score:s?.score||0}});
  if(!minimum)return [pack(search.partial,'balanced','目前條件待確認',n,'現有商品資料找不到可確認完整符合的組合，空缺與未驗證需求已列出。')];
  const within=sorted.filter(s=>s.cost<=budget).sort((a,b)=>b.score-a.score||a.cost-b.cost),best=n.budgetMode==='value'?minimum:within[0]||minimum;
  const result=[],add=p=>{const signature=core.slots.map(s=>p.ids[s.key]||'').join('|');if(!result.some(o=>core.slots.map(s=>o.ids[s.key]||'').join('|')===signature))result.push(p);};
  if(within.length&&minimum.cost<best.cost)add(pack(minimum,'budget','符合目標入門',n,'保留相同解析度與效能目標，優先降低整台主機費用；DDR4 與 DDR5 平台都會比較。'));
  add(pack(best,'balanced',within.length?'預算內推薦':'目前目標最低候選',n,within.length?'在主機預算內，依用途優先分配給顯卡／處理器，再考慮記憶體與儲存餘裕；不要求把預算花完。':'目前符合條件的完整候選仍超出預算 '+core.money(minimum.cost-budget)+'；這是現有資料與選配條件的結果，不是遊戲最低花費。'));
  if(!within.length&&raw.usages?.includes('game')&&(n.gameQuality!=='medium'||n.targetFps>60)){
   const changed={...raw,fitVersion:1,gameQuality:'medium',targetFps:60},relaxed=core.compileExperience(changed),alternatives=solve(products,relaxed,core,budget).complete,affordable=alternatives.filter(s=>s.cost<=budget).sort((a,b)=>b.score-a.score||a.cost-b.cost),cheapest=[...alternatives].sort((a,b)=>a.cost-b.cost)[0],trade=affordable[0]||cheapest;
   if(trade&&trade.cost<minimum.cost)add(pack(trade,'tradeoff',trade.cost<=budget?'預算內取捨方案':'降低目標參考',relaxed,'保留原解析度、外觀與工作量，調整遊戲畫質／流暢目標；必須由你確認後才套用。',[...(n.gameQuality!=='medium'?['遊戲改為一般畫質']:[]),...(n.targetFps>60?['流暢目標改為 60 FPS']:[])]));
  }
  const higher=sorted.filter(s=>s.cost>best.cost&&s.score>best.score).sort((a,b)=>a.cost-b.cost||b.score-a.score)[0];
  if(higher&&result.length<3)add(pack(higher,'upgrade',higher.cost<=budget?'預算內升級':'加價升級',n,'保留相同目標，增加有用途差異的硬體餘裕；請比較實際更換項目與價差，再決定是否需要。'));
  if(n.advisorVersion===1){for(const option of result){option.thermal=advisor.thermal(core.resolve?core.resolve(option.ids,products):Object.fromEntries(Object.entries(option.ids).map(([k,id])=>[k,products.find(p=>p.id===id)])),option.needs,products);option.requirementTrace=option.needs.requirementTrace;option.title=option.key==='budget'?'划算方案':option.key==='balanced'?(within.length?'推薦方案':'完整需求參考方案'):option.key==='upgrade'?'升級方案':option.title;option.priceStatus='reference';if(budget>=80000&&option.total<budget*0.65){option.warnings.push(n.needsDiscrete?'目前可自動選配的效能型號與散熱資料有限，這張單不代表已完成此預算的高階比較。':'日常用途不必花完預算；目前候選已達規劃門檻，餘額可保留。');option.reason+=' '+option.warnings[option.warnings.length-1];}}}
  return result;
 }
 return {version,sources,advisor,cpuClass,gpuClass,vram,targetLabel,compile,solve,plans};
});
