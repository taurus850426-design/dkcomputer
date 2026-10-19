// ECPay official AIO SHA256 protocol: developers.ecpay.com.tw/2902/.
export async function sha256(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function checkMac(fields,key,iv){
 const sorted=Object.keys(fields).filter(k=>k.toLowerCase()!=='checkmacvalue').sort((a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0);
 const raw='HashKey='+key+'&'+sorted.map(k=>k+'='+String(fields[k])).join('&')+'&HashIV='+iv;
 const encoded=encodeURIComponent(raw).replace(/%20/g,'+').replace(/~/g,'%7e').replace(/'/g,'%27').toLowerCase();
 return (await sha256(encoded)).toUpperCase();
}
export function constantEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
export function paymentConfiguration(env){
 const mode=env('ECPAY_MODE');
 if(!['test','live'].includes(mode))throw Error('Payment mode not configured');
 const merchant=env('ECPAY_MERCHANT_ID'),key=env('ECPAY_HASH_KEY'),iv=env('ECPAY_HASH_IV');
 if(!merchant||!key||!iv)throw Error('Payment credentials not configured');
 if(mode==='live'&&(merchant==='3002607'||key==='pwFHCqoQZGmho4w6'||iv==='EkRm7iFT261dpevs'||env('SHOP_LIVE_APPROVED')!=='true'))throw Error('Live payment is not approved');
 return {mode,merchant,key,iv,action:mode==='test'?'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5':'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'};
}
export async function paymentFields(order,config,notifyUrl,backUrl){
 const amount=Number(order.subtotal)+Number(order.shipping_fee);
 if(!Number.isSafeInteger(amount)||amount<1)throw Error('Invalid approved amount');
 const date=new Date(order.payment_started_at);if(!Number.isFinite(date.getTime()))throw Error('Invalid payment date');
 const taipei=new Date(date.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ').replace(/-/g,'/');
 const fields={MerchantID:config.merchant,MerchantTradeNo:order.trade_no,MerchantTradeDate:taipei,PaymentType:'aio',TotalAmount:String(amount),TradeDesc:'DK商品訂購',ItemName:'DK商品訂購 '+order.order_no,ReturnURL:notifyUrl,ClientBackURL:backUrl,ChoosePayment:'Credit',EncryptType:'1'};
 fields.CheckMacValue=await checkMac(fields,config.key,config.iv);return fields;
}
export async function verifyNotification(fields,config){
 if(fields.MerchantID!==config.merchant||!/^\d+$/.test(fields.TradeAmt||'')||!fields.TradeNo||!/^[A-Za-z0-9]{1,20}$/.test(fields.MerchantTradeNo||''))throw Error('Invalid payment notification');
 if(!Number.isSafeInteger(Number(fields.TradeAmt))||Number(fields.TradeAmt)<1)throw Error('Invalid payment amount');
 const expected=await checkMac(fields,config.key,config.iv);if(!constantEqual(expected,String(fields.CheckMacValue||'').toUpperCase()))throw Error('Invalid signature');
 if(config.mode==='live'&&fields.SimulatePaid!=='0')throw Error('Simulated or unverifiable live payment');
 return {trade_no:fields.MerchantTradeNo,amount:Number(fields.TradeAmt),gateway_trade_no:fields.TradeNo,success:fields.RtnCode==='1',environment:config.mode,simulated:fields.SimulatePaid==='1'};
}
