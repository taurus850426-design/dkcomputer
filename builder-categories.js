(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKBuilderCategories=api;})(typeof window==='object'?window:globalThis,function(){
'use strict';
const other='其他規格／待確認';
function capacity(n){return n>=1000?(n/1000)+'TB':n+'GB';}
function category(p,key){const f=p.facts||{};switch(key){
 case 'cpu':return f.socket?(/^[0-9]/.test(f.socket)?'Intel LGA '+f.socket:'AMD '+f.socket):other;
 case 'board':return f.socket?[(/^[0-9]/.test(f.socket)?'Intel LGA '+f.socket:'AMD '+f.socket),f.ddr].filter(Boolean).join(' · '):other;
 case 'ram':return f.ddr&&f.capacityGB?f.ddr+' · '+f.capacityGB+'GB':other;
 case 'ssd':return f.capacityGB?'NVMe · '+capacity(f.capacityGB):other;
 case 'gpu':return f.gpuModel||other;
 case 'cooler':return f.heightMM?(f.heightMM>=150?'塔式散熱 · 150mm 以上':'小型散熱 · 150mm 以下'):other;
 case 'case':return {ITX:'ITX 小型機殼',MATX:'M-ATX 機殼',ATX:'ATX 機殼',EATX:'E-ATX 大型機殼'}[f.form]||other;
 case 'psu':return f.watts?([550,650,750,850,1000].find(n=>f.watts<=n)||'1000 以上')+'W 級距':other;
 default:return other;
}}
const brands=[['ASUS',/華碩|\bASUS\b/i],['MSI',/微星|\bMSI\b/i],['GIGABYTE',/技嘉|\bGIGABYTE\b/i],['ASRock',/華擎|\bASRock\b/i],['Intel',/^Intel\b/i],['AMD',/^AMD\b/i],['Kingston',/金士頓|\bKingston\b/i],['Crucial',/美光|\bCrucial\b/i],['Corsair',/海盜船|\bCorsair\b/i],['G.SKILL',/芝奇|\bG[.]?SKILL\b/i],['TEAMGROUP',/十銓|\bTEAMGROUP\b/i],['ADATA',/威剛|\bADATA\b|\bXPG\b/i],['Samsung',/三星|\bSamsung\b/i],['WD',/威騰|^WD\b|Western Digital/i],['Seagate',/希捷|\bSeagate\b/i],['Thermalright',/利民|\bThermalright\b/i],['Cooler Master',/酷碼|Cooler\s?Master/i],['DeepCool',/九州風神|\bDeepCool\b/i],['Noctua',/貓頭鷹|\bNoctua\b/i],['Fractal Design',/Fractal Design/i],['Lian Li',/聯力|Lian\s?Li/i],['Montech',/君主|\bMontech\b/i],['FSP',/全漢|\bFSP\b/i],['Seasonic',/海韻|\bSeasonic\b/i],['Super Flower',/振華|Super Flower/i]];
function brand(p){const name=String(p.name||'');for(const [label,rule] of brands)if(rule.test(name))return label;return name.match(/^([A-Za-z][A-Za-z0-9.-]*|[\u4e00-\u9fff]{2,5})/)?.[1]||'其他品牌';}
function values(products,fn){return [...new Set(products.map(fn))].sort((a,b)=>a.localeCompare(b,'zh-TW',{numeric:true}));}
return{category,brand,values};
});
