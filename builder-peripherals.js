(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DKBuilderPeripherals=factory();})(typeof window==='object'?window:globalThis,function(){
'use strict';
const slots=[{key:'monitor',title:'螢幕',plain:'選購螢幕，可留空',optional:true},{key:'keyboard',title:'鍵盤',plain:'選購鍵盤，可留空',optional:true},{key:'mouse',title:'滑鼠',plain:'選購滑鼠，可留空',optional:true}];
function isPart(p,key){const n=String(p.name||''),g=String(p.group||''),cat=Number(p.categoryId??p.category);if(/套裝搭購|搭購優惠|預購|缺貨|登錄送|滿\d+.*[折送]|買一送一|優惠洽|鍵鼠|鍵盤滑鼠組|\bcombo\b|組合|\+.*(?:滑鼠|鍵盤|手托)/i.test(n))return false;
if(key==='monitor')return cat===13&&!/投影|掛燈|支撐架|周邊支架|增高架|筆電支架/.test(g)&&!/(?:電視|Google TV|螢幕掛燈|ScreenBar)/i.test(n)&&/(?:\d+吋|攜式螢幕|觸控式螢幕)/.test(g);
if(key==='keyboard')return cat===17&&/鍵盤|Ducky|Cherry|Keychron|Varmilo/i.test(g)&&/鍵盤|機械式|剪刀腳|薄膜|有線|無線|三模/i.test(n)&&!/^(?:.*?)(?:替換鍵帽|鍵帽組|獨立手托)/.test(n.split('/')[0]);
if(key==='mouse')return cat===18&&/滑鼠/.test(g)&&/滑鼠/.test(n)&&!/鼠墊|數位|繪圖|簡報/.test(g)&&!/充電底座|Mouse Dock|鼠線夾|腳貼|防滑貼/i.test(n.split('/')[0]);return false;}
function category(p,key){const n=String(p.name||''),g=String(p.group||'');if(key==='monitor'){const size=g.match(/(\d+)吋/),res=g.match(/(\d+)\s*[*x×]\s*(\d+)/);return size?size[1]+'吋'+(res?' · '+res[1]+'×'+res[2]:''):'攜帶式／觸控螢幕';}if(/三模/.test(n))return '三模';const wireless=/無線|2\.4\s*G|wireless|藍[牙芽]|bluetooth/i.test(n),wired=/有線|\bwired\b/i.test(n);return wireless&&wired?'有線／無線雙用':wireless?'無線':wired?'有線':'其他連接方式';}
return {slots,isPart,category};});
