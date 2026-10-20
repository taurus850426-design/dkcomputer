export async function sha256(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function hmac(secret,value){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function issueChallenge(secret,ip,now=Date.now()){const seed=now+'.'+crypto.randomUUID();return seed+'.'+await hmac(secret,seed+'.'+ip);}
export async function verifyChallenge(token,secret,ip,now=Date.now()){
 const parts=String(token||'').split('.');if(parts.length!==3||!/^\d{13}$/.test(parts[0])||!/^[0-9a-f-]{36}$/.test(parts[1])||!/^[0-9a-f]{64}$/.test(parts[2]))return false;
 const age=now-Number(parts[0]);return age>=1500&&age<=3600000&&equal(parts[2],await hmac(secret,parts[0]+'.'+parts[1]+'.'+ip));
}
export function customer(raw){
 const out={name:String(raw?.name||'').trim(),phone:String(raw?.phone||'').replace(/[\s-]/g,''),email:String(raw?.email||'').trim(),fulfillment:raw?.fulfillment,address:String(raw?.address||'').trim(),note:String(raw?.note||'').trim(),payment:raw?.payment};
 if(out.name.length<2||out.name.length>80||!/^\+?[0-9]{8,15}$/.test(out.phone)||out.email.length>160||!/^\S+@\S+\.\S+$/.test(out.email)||!['pickup','delivery'].includes(out.fulfillment)||!['transfer','store'].includes(out.payment)||out.note.length>500)throw Error('Invalid contact details');
 if(out.fulfillment==='delivery'&&(out.address.length<8||out.address.length>300))throw Error('Delivery address required');
 if(out.fulfillment==='pickup')out.address='';if(out.payment==='store'&&out.fulfillment!=='pickup')throw Error('Store payment requires pickup');return out;
}
export function cart(raw){
 if(!Array.isArray(raw)||raw.length<1||raw.length>20)throw Error('Invalid cart');
 const rows=raw.map(x=>({id:String(x?.id||''),qty:Number(x?.qty)}));
 if(rows.some(x=>!x.id||x.id.length>160||!Number.isInteger(x.qty)||x.qty<1||x.qty>99)||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('Invalid cart');return rows;
}
export function publicOrder(row){return {id:row.id,order_no:row.order_no,status:row.status,items:row.items,subtotal:row.subtotal,shipping_fee:row.shipping_fee,payment:row.payment,environment:row.environment,customer_message:row.customer_message||'',hold_until:row.hold_until,transfer_last5:row.transfer_last5,created_at:row.created_at};}
