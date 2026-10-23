/** Parse public estimate options without executing source scripts. No source images are copied. */
import { createHash } from 'node:crypto';
export const SOURCE_URL = 'https://www.coolpc.com.tw/evaluate.php';
export const CATEGORIES = ['品牌主機','筆電與平板','套裝主機','處理器','主機板','記憶體','SSD','傳統硬碟','隨身儲存','散熱器','水冷散熱','顯示卡','螢幕','機殼','電源供應器','風扇與燈效','鍵盤滑鼠與周邊','控制器與數位板','網通設備','NAS','音效與視訊','耳機麥克風','燒錄器','USB擴充與外接盒','攝影機與擷取卡','不斷電系統','擴充卡','線材與轉接','作業系統與軟體','福利品'];
export function plain(s) {
  return s.replace(/<[^>]*>/g,' ').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,e)=>{
    if(e[0]==='#'){const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[e.toLowerCase()];
  }).replace(/\s+/g,' ').trim();
}
export function exclusionReason(text) {
  if(/獨家|独家|專賣|專售|原價屋限定|原價屋特仕|exclusive/i.test(text)) return 'exclusive';
  if(/搭板|搭主機板|搭配主機板|任搭主機板|限搭|限組裝|裝機價|組裝價|組合價|組合包|套裝必搭|套裝加購|主機搭購|須搭|需搭|限購|組裝限定/.test(text)) return 'conditional';
  return '';
}
export function factsFor(category,title,group) {
  title=title.replace(/[｛｝]/g,' '); const text=(title+' '+group).normalize('NFKC'); const f={}; let m;
  const sockets=[...text.matchAll(/\b(AM[45]|LGA\s*1[278]00|1851|1700|1200|1151|1150|sTR5|sTRX4)\b/gi)].map(x=>x[1].toUpperCase().replace(/LGA|\s/g,''));
  if(new Set(sockets).size===1)f.socket=sockets[0];
  m=text.match(/DDR\s*([345])|\bD([45])[-\s]/i);if(m)f.ddr='DDR'+(m[1]||m[2]);
  if(category===6){f.desktop=/桌上型|桌機/.test(group)&&!/筆電|SO-DIMM|伺服器|ECC|RDIMM/i.test(text);m=title.match(/(?:單條|雙通道)?\s*(\d+)\s*G(?:B)?\b/i);if(m)f.capacityGB=Number(m[1]);}
  if(category===4){m=title.match(/【(\d+)核/);if(m)f.cores=Number(m[1]);f.integrated=/具內顯|含內顯|內顯Xe|UHD\d|RDNA\s*\d?內顯/i.test(title)&&!/無內顯/.test(title);f.stockCooler=/含風扇/.test(title)&&!/不含|無風扇/.test(title);}
  if(category===5||category===14){m=title.match(/\b(Mini[- ]?ITX|M[- ]ATX|Micro[- ]?ATX|E[- ]ATX|ATX|ITX)\b/i);if(m)f.form=m[1].toUpperCase().replace(/MINI[- ]?ITX/,'ITX').replace(/MICRO[- ]?ATX|M[- ]ATX/,'MATX').replace(/E[- ]ATX/,'EATX');}
  if(category===14){f.restricted=/僅支援|內附.*電源|含.*電源|附\d{3,4}W|\+.*(?:水冷|電源|風扇)/i.test(title);m=title.match(/(?:顯卡長|卡)(\d+(?:\.\d+)?)(?![\d.(])/);if(m&&!title.slice(m.index+m[0].length).startsWith('('))f.maxGpuMM=Math.round(Number(m[1])*10);m=title.match(/(?:CPU高|U高)(\d+(?:\.\d+)?)(?![\d.(])/i);if(m&&!title.slice(m.index+m[0].length).startsWith('('))f.maxCoolerMM=Math.round(Number(m[1])*10);}
  if(category===12){m=title.match(/(?:長|卡長)\s*(\d+(?:\.\d+)?)/)||title.match(/\/\s*(\d+(?:\.\d+)?)\s*cm\b/i);if(m)f.lengthMM=Math.round(Number(m[1])*10);m=title.match(/\b(RTX\s*\d{4}(?:\s*Ti)?(?:\s*SUPER)?|RX\s*\d{4}(?:\s*XT)?|GTX\s*\d{4}(?:\s*Ti)?)\b/i);if(m)f.gpuModel=m[1].toUpperCase().replace(/\s+/g,' ');}
  if(category===15){f.compact=/SFX|TFX|FLEX/i.test(text);m=title.match(/\b(\d{3,4})\s*W\b/i);if(m)f.watts=Number(m[1]);f.atx3=/ATX\s*3\.[01]/i.test(title);}
  if(category===10){m=title.match(/(?:高[:：]?|高度[:：]?)\s*(\d+(?:\.\d+)?)/);if(m)f.heightMM=Math.round(Number(m[1])*10);f.air=/塔|風冷/.test(text)&&!/水冷|散熱膏|散熱片/.test(text);}
  if(category===7){m=title.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);if(m)f.capacityGB=Math.round(Number(m[1])*(m[2].toUpperCase()==='TB'?1000:1));f.nvme=/M\.2|NVMe/i.test(text)&&/PCI[eE]|NVMe/i.test(text);}
  return f;
}
export function parseCatalog(html,overrides={}) {
  const products=[]; const counts={exclusive:0,conditional:0,blocked:0};const categoryCounts={};
  for(const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)){
    const n=match[1].match(/\bname\s*=\s*["']?n(\d+)\b/i);if(!n)continue;
    const category=Number(n[1]);if(category<1||category>30)continue;
    categoryCounts[category]=0;let group='',last=null;
    for(const token of match[2].matchAll(/<optgroup\b([^>]*)>|<\/optgroup\s*>|<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/?optgroup\b|$)/gi)){
      if(token[1]!==undefined){group=plain(token[1].match(/\blabel\s*=\s*(?:'([^']*)'|"([^"]*)")/i)?.slice(1).find(x=>x!==undefined)||'');last=null;continue;}
      if(token[3]===undefined){group='';last=null;continue;}
      const title=plain(token[3]);
      if(/\bdisabled\b/i.test(token[2])){if(last&&/↪|&#x21AA;/.test(token[3])&&exclusionReason(title)==='exclusive')last.exclusiveNote=true;continue;}
      const priceMatch=[...title.matchAll(/,\s*\$\s*([\d,]+)/g)].pop();if(!priceMatch){last=null;continue;}
      const price=Number(priceMatch[1].replace(/,/g,''));if(!Number.isSafeInteger(price)||price<=0){last=null;continue;}
      const name=title.slice(0,priceMatch.index).replace(/[｛｝]/g,' ').trim();
      const id='cp-'+category+'-'+createHash('sha256').update(name.normalize('NFKC')).digest('hex').slice(0,20);
      last={id,category,name,group,price,facts:factsFor(category,name,group)};products.push(last);categoryCounts[category]++;
    }
  }
  if(Object.keys(categoryCounts).length!==30||products.length<1000)throw Error('來源分類或商品數異常，保留既有資料');
  const kept=[];const ids=new Set();
  for(const p of products){const reason=p.exclusiveNote?'exclusive':exclusionReason(p.name+' '+p.group);delete p.exclusiveNote;if(reason){counts[reason]++;continue;}if(overrides.blockedIds?.includes(p.id)){counts.blocked++;continue;}if(ids.has(p.id))continue;ids.add(p.id);kept.push(p);}
  return {schemaVersion:1,sourceUrl:SOURCE_URL,updatedAt:new Date().toISOString(),categories:CATEGORIES.map((name,i)=>({id:i+1,name})),excluded:counts,products:kept};
}
