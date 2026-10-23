/* Explicit customer choices and verified enclosure packages; not measured FPS. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKBuilderAdvisor=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const labels={primaryUse:{auto:'依全部用途均衡安排',office:'文書與多工優先',game:'遊戲優先',create:'創作工作優先',stream:'直播與錄影優先'},budgetMode:{value:'夠用划算，省下不必要的花費',balanced:'預算內提升有用的體驗'},lookStyle:{any:'不限風格',plain:'簡約少燈',rgb:'電競燈效',showcase:'全景展示'},allocation:{performance:'效能優先',balanced:'效能與外觀均衡',appearance:'外觀優先'},noise:{normal:'一般散熱安排',quiet:'希望降低噪音'},storageGB:{0:'依安裝需求安排',1000:'至少 1TB',2000:'至少 2TB',4000:'至少 4TB'},network:{any:'有線網路／不限',wifi:'需要 Wi-Fi'}};
 const cases=[
  {match:/^Montech Air 903 BASE (?:黑|白) /i,style:'plain',fans:3,layout:'前方 2 顆 140mm 進氣、後方 1 顆 140mm 排氣',source:'https://www.montechpc.com/air-903-base',pwm:true},
  {match:/^Montech Air 903 MAX (?:黑|白) /i,style:'rgb',fans:4,layout:'前方 3 顆 140mm ARGB 進氣、後方 1 顆 140mm 排氣',source:'https://www.montechpc.com/air-903-max',pwm:true},
  {match:/^Montech XR (?:黑|白) /i,style:'showcase',fans:3,layout:'側面 2 顆 120mm 進氣、後方 1 顆 120mm 排氣',source:'https://www.montechpc.com/xr',pwm:true}
 ].map(c=>({...c,checkedAt:'2026-10-24'}));
 function normalize(raw){const n={advisorVersion:1};for(const [k,values]of Object.entries(labels))n[k]=Object.hasOwn(values,raw[k])?raw[k]:({budgetMode:'balanced',allocation:'balanced'}[k]||Object.keys(values)[0]);n.storageGB=Number(n.storageGB);if(n.primaryUse!=='auto'&&!raw.usages?.includes(n.primaryUse))n.primaryUse='auto';return n;}
 function caseProfile(p){return p&&!p.isCustom&&!p.facts?.restricted?cases.find(c=>c.match.test(p.name)):null;}
 function caseAllowed(p,n){const c=caseProfile(p);return !!c&&(n.lookStyle==='any'||c.style===n.lookStyle);}
 function thermal(parts,n,products=[]){
  if(n.advisorVersion!==1)return {total:0,items:[],pending:[],unpriced:false};
  const p=parts.case,c=caseProfile(p);if(!p)return {total:0,items:[],pending:['機殼尚未選擇，必要風扇及配件費用待確認'],unpriced:true};
  if(c)return {total:0,items:[],included:c.fans,layout:c.layout,source:c.source,pending:['已含 '+c.fans+' 顆風扇；'+c.layout+'。PWM／燈光接頭、集線器容量與整機負載仍需裝機前核對。'],unpriced:false};
  // Never infer included fans from fan mounting capacity, or assume "no information" means zero.
  const none=/(?:不附|無附|不含)(?:贈)?風扇/.test(p.name),a21=/^華碩 A21 黑 /i.test(p.name);
  if(none||a21){const fan=products.filter(p=>p.category===16&&Number.isSafeInteger(p.price)&&p.price>0&&/12cm|120mm/i.test(p.name)&&/PWM/i.test(p.name)&&!/反葉|三顆|三入|3入|3顆|套組|控制器|集線器|水冷|\*\s*[23456]/i.test(p.name)&&(!['white','allwhite'].includes(n.color)||/白|white/i.test(p.name))).sort((a,b)=>a.price-b.price)[0];
   // A21's bare chassis is verified for three front 120mm mounts and one rear.
   if(a21&&fan){const quantity=3;return {total:fan.price*quantity,items:[{id:fan.id,name:fan.name,quantity,price:fan.price}],layout:'規劃前方 2 顆進氣、後方 1 顆排氣；贈品風扇規格未確認，不計入必要散熱數量',pending:['已預留 3 顆 120mm PWM 風扇；主板接頭數／電流、分接線或集線器需求與費用待確認。'],unpriced:true};}
  }
  return {total:0,items:[],pending:['此機殼的附贈風扇、進排氣位置、接頭與必要控制器尚未核對；散熱配件費用未完整計入，不能視為完整總價。'],unpriced:true};
 }
 function compile(raw,n,policy){
  if(raw.advisorVersion!==1)return n;Object.assign(n,normalize(raw));
  const profiles=(raw.appNames||[]).map(name=>policy.lookup(name,raw.researchProfiles||[])).filter(Boolean);
  const softwareGpu=Math.max(-1,...profiles.filter(p=>p.kind!=='game').map(p=>p.gpuTier));
  if(softwareGpu>=0){n.gpuMin=Math.max(n.gpuMin,softwareGpu>=1?3:1);n.needsDiscrete=true;}
  if(profiles.some(p=>p.cpuTier>=1))n.cpuMin=Math.max(n.cpuMin,3);
  if(raw.workloadLevel==='video4k'){n.gpuMin=Math.max(n.gpuMin,3);n.minVramGB=Math.max(n.minVramGB,12);}
  n.cpuPriority=n.primaryUse==='create'||n.primaryUse==='auto'&&raw.usages?.includes('create')&&!raw.usages?.includes('game')?'creative':n.needsDiscrete?'game':'office';
  n.ssdGB=Math.max(n.ssdGB,n.storageGB);n.cpuCeiling=n.needsDiscrete?4:Math.max(1,n.cpuMin);n.gpuCeiling=n.needsDiscrete?Math.min(7,n.gpuMin+2):-1;
  n.ramCeiling=Math.max(n.ramGB,n.primaryUse==='create'||['heavy','video4k'].includes(raw.workloadLevel)?64:32);n.ssdCeiling=Math.max(n.ssdGB,2000);
  n.requirementTrace=[
   {input:'用途與優先順序',value:labels.primaryUse[n.primaryUse],effect:'所有已選用途保留最低需求，優先順序用於分配升級餘裕。'},
   {input:'主機預算',value:labels.budgetMode[n.budgetMode],effect:'包含機殼必要散熱配件；不含作業系統、螢幕與周邊。不為花完預算加入無用升級。'},
   {input:'螢幕與遊戲目標',value:n.goalLabel,effect:n.needsDiscrete?'決定 CPU／GPU 起始條件；目標 FPS 尚非實測保證。':'日常文書優先使用內顯，不因 2K 螢幕直接增加獨立顯卡。'},
   {input:'多工與工作量',value:(raw.simultaneous==='yes'?'同時執行；':'')+({normal:'一般工作量',heavy:'大型報表／大量多工',video4k:'4K 剪輯'}[raw.workloadLevel]||'一般工作量'),effect:'目前記憶體至少 '+n.ramGB+'GB；容量門檻會隨軟體與工作量提高。'},
   {input:'儲存空間',value:labels.storageGB[n.storageGB],effect:'目前至少 '+n.ssdGB+'GB，取安裝需求和你指定容量中的較高值。'},
   {input:'外觀與取捨',value:labels.lookStyle[n.lookStyle]+'；'+labels.allocation[n.allocation],effect:'先保留主要效能需求，再比較符合風格的機殼、配色和必要風扇；不默默降低畫質換外觀。'},
   {input:'噪音與網路',value:labels.noise[n.noise]+'；'+labels.network[n.network],effect:(n.noise==='quiet'?'使用可調速機殼風扇與獨立塔散，仍需調校，無分貝保證。':'依一般散熱配置。')+(n.network==='wifi'?'主機板必須明示 Wi-Fi。':'不強制 Wi-Fi 主機板。')}
  ];
  n.ruleNotes.push('外觀優先不會自動降低效能需求；需要改變目標時另列方案，經你確認後才採用。');return n;
 }
 return {labels,cases,normalize,caseProfile,caseAllowed,thermal,compile};
});
