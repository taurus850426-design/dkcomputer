(function(root){
 'use strict';
 function normalizeCart(value){
  if(!Array.isArray(value))return [];
  const found=new Map();
  value.slice(0,100).forEach(row=>{const id=String(row?.id || '');const qty=Number(row?.qty);if(!id||id.length>160||!Number.isInteger(qty)||qty<1||qty>99)return;found.set(id,Math.min(99,(found.get(id)||0)+qty));});
  return Array.from(found,([id,qty])=>({id,qty})).slice(0,20);
 }
 function quote(cart,catalog){
  const items=[],errors=[];
  for(const line of normalizeCart(cart)){
   const item=catalog.find(x=>String(x.id)===line.id);
   if(!item){errors.push('有商品已下架，請移除後再繼續');continue;}
   if(item.requires_quote||['售完','售出','停售','缺貨'].includes(item.stock_status)){errors.push(item.name+'：請先聯絡確認型號與供貨');continue;}
   const price=Number(item.price),available=Number(item.qty);
   if(item.price==null||!Number.isSafeInteger(price)||price<=0){errors.push(item.name+'：需先確認價格');continue;}
   if(item.qty==null||!Number.isInteger(available)||available<line.qty){errors.push(item.name+'：數量不足或待確認');continue;}
   items.push({id:line.id,qty:line.qty,name:String(item.name),price,available,subtotal:price*line.qty});
  }
  return {items,errors,total:items.reduce((n,x)=>n+x.subtotal,0)};
 }
 function validateCustomer(data){
  const customer={name:String(data.name||'').trim(),phone:String(data.phone||'').replace(/[\s-]/g,''),email:String(data.email||'').trim(),fulfillment:data.fulfillment,address:String(data.address||'').trim(),note:String(data.note||'').trim(),payment:data.payment};
  if(customer.name.length<2||customer.name.length>80)throw Error('請填寫聯絡姓名');
  if(!/^\+?[0-9]{8,15}$/.test(customer.phone))throw Error('請填寫有效電話');
  if(customer.email.length>160||!/^\S+@\S+\.\S+$/.test(customer.email))throw Error('請填寫有效電子郵件');
  if(!['pickup','delivery'].includes(customer.fulfillment))throw Error('請選擇取貨方式');
  if(customer.fulfillment==='delivery'&&(customer.address.length<8||customer.address.length>300))throw Error('請填寫完整收件地址');
  if(customer.note.length>500)throw Error('備註請勿超過500字');
  if(!['transfer','store'].includes(customer.payment))throw Error('目前僅提供銀行轉帳或到店付款');
  if(customer.payment==='store'&&customer.fulfillment!=='pickup')throw Error('到店付款僅適用到店自取');
  if(customer.fulfillment==='pickup')customer.address='';
  return customer;
 }
 const api={normalizeCart,quote,validateCustomer};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DKShopCore=api;
})(typeof window!=='undefined'?window:globalThis);
