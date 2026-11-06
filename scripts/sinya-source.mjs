import {plain} from './coolpc-catalog.mjs';

// Contract observed in Sinya's public DIY Vue client on 2026-11-07.
export const SINYA_GROUPS_URL='https://www.sinya.com.tw/diy/show_option';
export const SINYA_PRODUCTS_URL='https://gateway.sinya.com.tw/api/diy/show_group_prod';
export const COMPONENT_CATEGORIES=['1','2','3','105','4','5','11','150','9','8','96'];
const conditional=/搭板|搭機|限搭|任搭|組裝價|裝機價|會員價|組合|套裝|獨家|限組|限購|加購|專案|促銷|特價|折價券|折扣碼|coupon|combo/i;

export function parseSinyaProducts(payload,category,group,capturedAt=new Date().toISOString()){
 const rows=Array.isArray(payload)?payload:payload?.status==='success'?payload.data:null;
 if(!Array.isArray(rows))throw Error('sinya_invalid_product_response');
 const products=[];
 for(const r of rows){
  if(String(r.sub_slave_id)!==String(category))throw Error('sinya_category_mismatch');
  const id=String(r.prod_id||''),name=plain(String(r.prod_name||'')),price=Number(r.price);
  const label=[name,group,r.price_comment||'',r.discount_text||''].join(' ');
  if(!/^\d+$/.test(id)||!name||!Number.isSafeInteger(price)||price<=0||price>1000000)continue;
  if(Number(r.display_price_status)!==1||Number(r.current_price)!==price||Number(r.special_price)!==0)continue;
  if(!Number.isFinite(Number(r.stocks))||Number(r.stocks)<=0||Number(r.max_amount)<=0)continue;
  if(r.price_comment||r.activity_start_date||r.activity_end_date||conditional.test(label))continue;
  if(/\+\s*(?:華碩|技嘉|微星|XPG|AMD|Intel|Kingston|金士頓|威剛)/i.test(name))continue;
  products.push({source:'sinya',sourceProductId:id,brand:plain(String(r.brand_text||'')),name,model:name,
   price,group:plain(group),category:String(category),priceLabel:'public_item_price',
   url:'https://www.sinya.com.tw/prod/'+id,capturedAt});
 }
 return products;
}

export async function collectSinya({fetchImpl=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const capturedAt=new Date().toISOString(),products=new Map(),coverage=[];
 async function json(url,options={}){
  const res=await fetchImpl(url,{...options,signal:AbortSignal.timeout(25000),headers:{'User-Agent':'DKComputer-PriceMonitor/1.0',...(options.headers||{})}});
  if(!res.ok)throw Error('sinya_HTTP_'+res.status);
  const body=await res.text();if(Buffer.byteLength(body)>6000000)throw Error('sinya_response_too_large');
  return JSON.parse(body);
 }
 for(const category of COMPONENT_CATEGORIES){
  const metadata=await json(SINYA_GROUPS_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id='+category});
  if(!Array.isArray(metadata.showOption)||!metadata.showOption.length||metadata.showOption.length>250)throw Error('sinya_invalid_group_metadata_'+category);
  let groupsFetched=0,excludedGroups=0,accepted=0;
  for(const group of metadata.showOption){
   if(String(group.prod_sub_slave_id)!==category||!/^\d+$/.test(String(group.group_id||'')))throw Error('sinya_invalid_group_identity');
   const title=plain(String(group.title||''));
   if(group.link||conditional.test(title)){excludedGroups++;continue;}
   const url=new URL(SINYA_PRODUCTS_URL);url.searchParams.set('group_id',group.group_id);url.searchParams.set('sub_slave_id',category);
   await pause(150);
   const rows=parseSinyaProducts(await json(url),category,title,capturedAt);groupsFetched++;
   for(const product of rows){
    const old=products.get(product.sourceProductId);
    if(old&&(old.price!==product.price||old.name!==product.name))throw Error('sinya_conflicting_duplicate_product');
    if(!old){products.set(product.sourceProductId,product);accepted++;}
   }
  }
  coverage.push({category,groupsFetched,excludedGroups,accepted});
 }
 if(products.size<100)throw Error('sinya_insufficient_verified_prices');
 return {schemaVersion:1,source:'sinya',capturedAt,coverage,products:[...products.values()]};
}
