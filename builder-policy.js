/* DK planning policies, not FPS benchmarks. Shared by browser, Node and Edge Functions. */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;else root.DKBuilderPolicy=a;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const version='2026-10-23.1';
 const cpuPools=[['7500F','7600','7600X','7700','9700X','7800X3D','9800X3D'],['7700','9700X','7800X3D','9800X3D'],['7800X3D','9800X3D']];
 const gpuPools=[['RTX5060','RTX5060TI','RTX5070','RX9060XT','RX9070','RX9070XT'],['RTX5060TI','RTX5070','RX9060XT','RX9070','RX9070XT'],['RTX5070','RX9070','RX9070XT'],['RX9070XT']];
 const sources={office:'https://www.microsoft.com/en-us/microsoft-365/microsoft-365-and-office-resources',photoshop:'https://helpx.adobe.com/photoshop/system-requirements.html',premiere:'https://helpx.adobe.com/premiere-pro/system-requirements.html',obs:'https://obsproject.com/kb/system-requirements',minecraft:'https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc',lol:'https://www.leagueoflegends.com/en-us/news/game-updates/updated-min-and-recommended-specs-for-lol-tft/'};
 // Values below are DK starting policies based on published requirements, not publisher FPS targets.
 const profiles=[
 ['Grand Theft Auto V Enhanced','game','開放世界／動作','gta gta5 gta v 俠盜獵車手 強化版 enhanced',1,1,16,105,'https://store.steampowered.com/app/3240220/'],
 ['Grand Theft Auto V Legacy','game','開放世界／動作','gta gta5 gta v 俠盜獵車手 傳承版 legacy',0,0,16,125,'https://store.steampowered.com/app/271590/'],
 ['英雄聯盟（LOL）','game','競技／射擊','lol league of legends 英雄聯盟',0,0,16,30,sources.lol],
 ['特戰英豪（VALORANT）','game','競技／射擊','valorant 瓦羅蘭 特戰英豪',0,0,16,60,'https://playvalorant.com/zh-tw/specs/'],
 ['Counter-Strike 2','game','競技／射擊','cs2 csgo 絕對武力',0,0,16,85,'https://store.steampowered.com/app/730/'],
 ['Apex Legends','game','競技／射擊','apex 英雄',0,0,16,75,'https://store.steampowered.com/app/1172470/'],
 ['PUBG','game','競技／射擊','pubg 絕地求生 battlegrounds',0,0,16,50,'https://store.steampowered.com/app/578080/'],
 ['電馭叛客 2077','game','角色扮演／動作','cyberpunk 2077 電馭叛客',1,1,32,70,'https://store.steampowered.com/app/1091500/'],
 ['艾爾登法環','game','角色扮演／動作','elden ring 法環',0,0,16,60,'https://store.steampowered.com/app/1245620/'],
 ['黑神話：悟空','game','角色扮演／動作','black myth wukong 黑神話 悟空',1,1,32,130,'https://store.steampowered.com/app/2358720/'],
 ['魔物獵人 荒野','game','角色扮演／動作','monster hunter wilds 魔物獵人荒野',1,1,32,75,'https://store.steampowered.com/app/2246340/'],
 ['Minecraft','game','沙盒／模擬','minecraft 我的世界 麥塊',0,0,16,20,sources.minecraft],
 ...['Microsoft Word','Microsoft Excel','Microsoft PowerPoint','Google Chrome','Discord','Microsoft Teams','Zoom'].map(n=>[n,'software','文書／日常',n,0,-1,16,5,n==='Google Chrome'?'https://support.google.com/chrome/a/answer/7100626':n==='Discord'?'https://support.discord.com/hc/en-us/articles/213491697':n==='Zoom'?'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748':sources.office]),
 ['Adobe Photoshop','software','剪輯／設計','photoshop ps 修圖',0,0,32,20,sources.photoshop],
 ['Adobe Illustrator','software','剪輯／設計','illustrator ai 向量',0,0,32,20,'https://helpx.adobe.com/illustrator/system-requirements.html'],
 ['Adobe Premiere Pro','software','剪輯／設計','premiere pr 剪輯',1,1,32,100,sources.premiere],
 ['剪映／CapCut','software','剪輯／設計','剪映 capcut',1,0,32,100,'https://www.capcut.com/resource/capcut-desktop-download'],
 ['OBS Studio','software','直播／通訊','obs 直播 錄影',0,0,32,50,sources.obs]
 ].map(([name,kind,category,aliases,cpuTier,gpuTier,ramGB,storageGB,sourceUrl])=>({name,kind,category,aliases,cpuTier,gpuTier,ramGB,storageGB,sourceUrl,checkedAt:null,policyUpdatedAt:'2026-10-23',basis:'policy-estimate',policyVersion:version}));
 function key(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/[\s()：:/\-]/g,'');}
 function lookup(name,external=[]){const local=profiles.find(p=>key(p.name)===key(name)),fresh=external.find(p=>key(p.name)===key(name)||local?.sourceUrl?.includes('store.steampowered.com/app/')&&p.sourceUrl?.replace(/\/$/,'')===local.sourceUrl.replace(/\/$/,''));if(!fresh)return local;if(!local)return fresh;return {...fresh,cpuTier:Math.max(local.cpuTier,fresh.cpuTier),gpuTier:Math.max(local.gpuTier,fresh.gpuTier),ramGB:Math.max(local.ramGB,fresh.ramGB),storageGB:Math.max(local.storageGB,fresh.storageGB)};}
 function normalizedGpu(s){return String(s||'').toUpperCase().replace(/[\s-]/g,'');}
 function fromRequirements(raw){
  // Explicit allowlists only; never infer relative speed from model digits or an AI score.
  if(!raw||!raw.name||!raw.sourceUrl||!raw.cpu||!raw.gpu)return null;
  const cpu=String(raw.cpu).toUpperCase(),gpu=normalizedGpu(raw.gpu);
  const cpuTier=/\b(7800X3D|9800X3D)\b/.test(cpu)?2:/\b(7700X?|9700X|12700K?|13700K?|14700K?)\b/.test(cpu)?1:/\b(1200|1500X|1600X?|2600X?|3600X?|5600X?|7500F|7600X?|2500K|3470|3570K|4460|4590|4690K|6600K|6700K|7400|8400|8600K|9400F|9600K|10400F?|10600K|11400F?|12400F?)\b/.test(cpu)?0:null;
  const gpuTier=/RTX(4080|4090|5080|5090)|RX(7900XTX)/.test(gpu)?3:/RTX(3070|3080|3090|4070|5070)|RX(6800|6900|7800|7900|9070)/.test(gpu)?2:/RTX(2060|2070|2080|3060|4060|5060TI)|RX(5700|6600XT|6700|7600XT|9060)/.test(gpu)?1:/GTX(660|750TI|760|770|780|950|960|970|980|1050|1060|1070|1080|1650|1660)|RTX(3050|5050|5060)|RX(470|480|550|560|570|580|590|5500|5600|6500|6600|7600)/.test(gpu)?0:null;
  if(gpuTier===3)return null;
  if(cpuTier===null||gpuTier===null||!Number.isFinite(raw.ramGB)||raw.ramGB<1||raw.ramGB>256||!Number.isFinite(raw.storageGB)||raw.storageGB<0||raw.storageGB>4000)return null;
  return {...raw,cpuTier,gpuTier,basis:'official-estimate',policyVersion:version};
 }
 function compile(raw,external=[]){
  const n={...raw,autoVersion:1,cpuTier:0,gpuTier:-1,ramGB:16,ssdGB:500,ramModules:2,ramSpeedMT:5200,minPsuWatts:650,ruleSources:[],ruleNotes:[],targets:[],unmapped:[],coverage:[],questions:[],hasGameRule:false};
  let storage=200;const game=raw.usages?.includes('game');
  for(const name of raw.appNames||[]){const p=lookup(name,external);
   if(!p){n.unmapped.push(name+'：尚未取得可用的官方需求，本次配置尚未涵蓋此項目');n.coverage.push({name,state:'uncovered'});continue;}
   n.cpuTier=Math.max(n.cpuTier,p.cpuTier);n.gpuTier=Math.max(n.gpuTier,p.gpuTier);n.ramGB=Math.max(n.ramGB,p.ramGB);storage+=p.storageGB||0;
   n.ruleSources.push(p.sourceUrl);n.coverage.push({name,state:'estimate',checkedAt:p.checkedAt,sourceUrl:p.sourceUrl});
   if(p.kind==='game'){n.hasGameRule=true;n.targets.push(name+'：依公開需求與 DK 選配政策推估，不保證 FPS');}
  }
  if(game){n.gpuTier=Math.max(0,n.gpuTier);if(!raw.appNames?.length)n.questions.push('請加入至少一款想玩的遊戲。');
   if(raw.resolution==='unknown')n.questions.push('尚未確認解析度，先提供 1080P 起始配置；確認螢幕後請重新推薦。');
   const uplift=raw.resolution==='4k'?2:raw.resolution==='1440p'?1:0;n.gpuTier=Math.min(3,n.gpuTier+uplift+(raw.experience==='visual'?1:0));
   if(raw.experience==='smooth')n.cpuTier=Math.min(2,n.cpuTier+1);
  }
  if(raw.usages?.includes('create')){n.ramGB=Math.max(32,n.ramGB);n.gpuTier=Math.max(0,n.gpuTier);}
  if(raw.usages?.includes('stream')||raw.simultaneous==='yes'){n.cpuTier=Math.max(1,n.cpuTier);n.ramGB=Math.max(32,n.ramGB);n.gpuTier=Math.max(0,n.gpuTier);n.ruleNotes.push('已為同時執行預留處理器與 32GB 記憶體；直播先以顯示卡硬體編碼規劃。');}
  if(raw.workload?.trim()||raw.advancedNotes?.trim())n.unmapped.push('補充文字已保留；尚未自動驗證其中的模組、特殊工作量或效能條件。');
  if(raw.workloadLevel==='heavy'){n.cpuTier=Math.max(1,n.cpuTier);n.ramGB=Math.max(64,n.ramGB);storage=Math.max(2000,storage);}
  if(raw.workloadLevel==='video4k'){n.cpuTier=Math.max(1,n.cpuTier);n.ramGB=Math.max(32,n.ramGB);n.gpuTier=Math.max(1,n.gpuTier);storage=Math.max(2000,storage);}
  n.ssdGB=storage>1000?Math.ceil(storage/1000)*1000:1000;n.minVramGB=n.gpuTier>=2||raw.workloadLevel==='video4k'?12:8;
  n.cpuModels=(raw.usages?.some(x=>['game','create','stream'].includes(x))||raw.simultaneous==='yes'||['heavy','video4k'].includes(raw.workloadLevel))?cpuPools[n.cpuTier]:null;n.gpuModels=n.gpuTier<0?null:gpuPools[n.gpuTier];n.minPsuWatts=n.gpuTier>=3?850:n.gpuTier>=2?750:650;
  n.requiresReview=false;n.partial=n.unmapped.length>0||n.questions.length>0;n.ruleSources=[...new Set(n.ruleSources)];
  n.ruleNotes.push('推薦屬需求推估：解析度、外觀與偏好使用 DK 選配政策預留資源，不是各遊戲相同畫質／幀數的實測承諾。');
  n.ruleNotes.push('儲存容量包含系統預留與各項安裝空間估算；大型素材與錄影檔案另依工作量增加。');
  return n;
 }
 return {version,profiles,cpuPools,gpuPools,compile,lookup,key,fromRequirements};
});
