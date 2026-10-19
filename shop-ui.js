(function(){
 'use strict';
 const KEY='dk_shop_cart_v1',TRACK='dk_shop_request_v1',config=window.DKShopConfig||{},core=window.DKShopCore;
 let catalog=[],service=null,busy=false,captchaToken='',tracking=null;
 const el=id=>document.getElementById(id),money=n=>'NT$ '+Number(n).toLocaleString('zh-TW');
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function read(){try{return core.normalizeCart(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch(_){return [];}}
 function write(rows){localStorage.setItem(KEY,JSON.stringify(core.normalizeCart(rows)));render();}
 function note(text){if(el('shopFormMsg'))el('shopFormMsg').textContent=text;}
 function add(id){const rows=read(),existing=rows.find(x=>x.id===id);if(existing){if(existing.qty>=99){note("單一商品最多99件，請直接聯絡我們洽詢大量訂購");return false;}existing.qty++;}else rows.push({id,qty:1});const q=core.quote(rows,catalog);if(q.errors.length){note(q.errors.join('；'));return false;}try{write(rows);return true;}catch(_){note('無法儲存購物車，請確認瀏覽器允許網站儲存資料。');return false;}}
 function render(){
  const rows=read(),q=core.quote(rows,catalog);
  if(el('shopCount'))el('shopCount').textContent=rows.reduce((n,x)=>n+x.qty,0);
  if(!el('shopCartItems'))return;
  el('shopCartItems').innerHTML=rows.length?rows.map(line=>{const item=catalog.find(p=>String(p.id)===line.id);return '<div class="shop-cart-line"><h3>'+esc(item?.name||'已下架商品')+'</h3><div class="shop-cart-controls"><label>數量 <input type="number" min="1" max="99" value="'+line.qty+'" data-shop-qty="'+esc(line.id)+'"></label><button type="button" class="shop-secondary" data-shop-remove="'+esc(line.id)+'">移除</button></div></div>';}).join(''):'<p class="shop-help">購物車還沒有商品。</p>';
  el('shopTotal').textContent=money(q.total);el('shopErrors').textContent=q.errors.join('；');el('shopErrors').className='shop-error';
  el('shopSubmit').disabled=busy||!service?.enabled||!rows.length||!!q.errors.length;
 }
 async function api(action,data={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{const headers={'Content-Type':'application/json'};
  if(service?.mode==='test'&&action==='create'){const auth=await window.DK.getSupabaseRestAuthHeaders({requireUser:true});if(!auth.ok)throw Error('請先以管理員登入後台再測試');Object.assign(headers,auth.headers);}
  const response=await fetch(window.DK.getSupabaseProjectUrl()+'/functions/v1/shop-checkout',{method:'POST',headers,body:JSON.stringify({action,...data}),signal:controller.signal});const result=await response.json();if(!response.ok)throw Error(result.error||'服務暫時無法使用，請稍後重試');return result;}finally{clearTimeout(timer);}
 }
 async function reload(){
  if(el('shopProducts'))el('shopProducts').textContent='正在載入商品…';
  try{catalog=await window.DK.fetchInventoryFromSupabase();if(!Array.isArray(catalog))throw Error();
   if(el('shopProducts'))el('shopProducts').innerHTML=catalog.map(item=>{const valid=core.quote([{id:String(item.id),qty:1}],catalog).errors.length===0;let image='';try{const u=new URL(item.photos?.[0]||'');if(u.protocol==='https:')image='<img src="'+esc(u.href)+'" alt="" loading="lazy">';}catch(_){}return '<article class="shop-product">'+image+'<div class="shop-product-body"><h3><a href="./product.html?id='+encodeURIComponent(item.id)+'&shop-preview=1">'+esc(item.name)+'</a></h3><strong>'+esc(item.price>0?money(item.price):'價格待確認')+'</strong><p>'+esc(item.qty==null?'數量待確認':'上架數量 '+item.qty+' 件')+'</p><button type="button" class="shop-primary" data-shop-add="'+esc(item.id)+'" '+(valid?'':'disabled')+'>'+(valid?'加入購物車':'請先聯絡確認')+'</button></div></article>';}).join('')||'<p>目前沒有可選購商品。</p>';
  }catch(_){catalog=[];if(el('shopProducts'))el('shopProducts').textContent='無法取得最新商品，請稍後更新；購物車已保留。';}render();
 }
 function product(item){
  if(!config.enabled&&!config.preview)return;
  const old=el('shopProductAdd');if(old)old.remove();
  const host=el('productPageLineBtn');if(!host)return;
  const wrap=document.createElement('div');wrap.id='shopProductAdd';wrap.className='shop-add-wrap';
  const button=document.createElement('button');button.type='button';button.className='btn btn-primary';button.textContent='加入購物車';
  button.onclick=async()=>{button.disabled=true;try{catalog=await window.DK.fetchInventoryFromSupabase();const errors=core.quote([{id:String(item.id),qty:1}],catalog).errors;if(errors.length)throw Error(errors.join('；'));if(!add(String(item.id)))throw Error('無法加入購物車，請前往購物車確認數量');button.textContent='已加入購物車';}catch(e){button.textContent=e.message;}finally{button.disabled=false;}};
  const link=document.createElement('a');link.href='./shop.html?shop-preview=1';link.className='btn btn-ghost';link.textContent='查看購物車';wrap.append(button,link);host.after(wrap);
 }
 async function refreshStatus(){
  if(!tracking)return;el('shopTracking').hidden=false;
  try{const row=await api('status',{id:tracking.id,token:tracking.token});
   const labels={awaiting_confirmation:'店家確認供貨中',awaiting_payment:'供貨已確認，請安排付款',payment_pending:'已開啟付款流程，等待核對結果',payment_review:'付款結果待核對，請聯絡店家',paid:'付款已確認，等待出貨安排',fulfilled:'已完成出貨',test_paid:'測試付款完成（不會安排出貨）',cancelled:'本次訂購已取消'};
   el('shopOrderStatus').textContent=row.order_no+'｜'+(labels[row.status]||'待確認')+'｜商品 '+money(row.subtotal)+(row.shipping_fee!=null?'＋運費 '+money(row.shipping_fee)+'＝'+money(row.subtotal+row.shipping_fee):'；運費待確認');
   el('shopPay').hidden=!(row.status==='awaiting_payment'&&row.payment==='credit');el('shopPay').textContent=row.environment==='test'?'前往測試刷卡（不實際收款）':'前往信用卡付款';
  }catch(e){el('shopOrderStatus').textContent=e.message;el('shopPay').hidden=true;}
 }
 async function startPayment(){
  if(busy||!tracking)return;busy=true;el('shopPay').disabled=true;
  try{const result=await api('pay',{id:tracking.id,token:tracking.token});if(!['https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5','https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'].includes(result.action))throw Error('付款網址無法驗證');const form=document.createElement('form');form.method='POST';form.action=result.action;for(const [name,value]of Object.entries(result.fields)){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=String(value);form.append(input);}document.body.append(form);form.submit();}
  catch(e){el('shopOrderStatus').textContent=e.message;}finally{busy=false;el('shopPay').disabled=false;}
 }
 async function init(){
  window.DKShopUI={product};
  if(!el('shopForm'))return;
  try{tracking=JSON.parse(sessionStorage.getItem(TRACK)||'null');}catch(_){}
  document.addEventListener('click',e=>{const a=e.target.closest('[data-shop-add]'),r=e.target.closest('[data-shop-remove]');if(a){if(add(a.dataset.shopAdd))note('已加入購物車');}if(r)try{write(read().filter(x=>x.id!==r.dataset.shopRemove));}catch(_){note('無法更新購物車');}});
  document.addEventListener('change',e=>{if(e.target.matches('[data-shop-qty]')){const rows=read();const row=rows.find(x=>x.id===e.target.dataset.shopQty);const qty=Number(e.target.value);if(!row||!Number.isInteger(qty)||qty<1||qty>99){render();return;}row.qty=qty;try{write(rows);}catch(_){note('無法更新購物車');}}});
  el('shopReload').onclick=reload;el('shopRefreshStatus').onclick=refreshStatus;el('shopPay').onclick=startPayment;
  const form=el('shopForm');form.elements.fulfillment.onchange=()=>{el('shopAddressField').hidden=form.elements.fulfillment.value!=='delivery';form.elements.address.required=form.elements.fulfillment.value==='delivery';};
  form.onsubmit=async e=>{e.preventDefault();if(busy||!service?.enabled)return;try{const customer=core.validateCustomer(Object.fromEntries(new FormData(form)));if(!form.elements.consent.checked)throw Error('請先確認資料使用說明');const cart=read(),q=core.quote(cart,catalog);if(!cart.length||q.errors.length)throw Error(q.errors.join('；')||'購物車還沒有商品');
    const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({customer,cart})))),x=>x.toString(16).padStart(2,'0')).join('');let pending;try{pending=JSON.parse(sessionStorage.getItem('dk_shop_pending_v1')||'null');}catch(_){}if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,key:crypto.randomUUID(),token:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')};sessionStorage.setItem('dk_shop_pending_v1',JSON.stringify({key:pending.key,token:pending.token,fingerprint}));
    busy=true;render();note('正在送出，請勿重複操作…');const row=await api('create',{customer,cart,key:pending.key,token:pending.token,captcha:captchaToken});tracking={id:row.id,token:pending.token};sessionStorage.setItem(TRACK,JSON.stringify(tracking));localStorage.removeItem(KEY);sessionStorage.removeItem('dk_shop_pending_v1');form.reset();note('已送出訂購需求，尚未付款。請等待店家確認供貨與運費。');render();await refreshStatus();
   }catch(e){note(e.message||'送出失敗，購物車已保留');}finally{busy=false;captchaToken='';window.turnstile?.reset();render();}};
  await reload();
  try{service=await api('config');}catch(_){service={enabled:false};}
  el('shopBanner').textContent=service.enabled?(service.mode==='test'?'測試模式：訂購與刷卡均供驗證，不實際收款或出貨。':'選購後由店家確認供貨，再安排付款。'):'購物系統預覽中，尚未開放正式訂購與收款。可先試用加入購物車及填寫結帳資料。';el('shopSubmit').textContent=service.enabled?(service.mode==='test'?'送出測試訂購需求':'送出訂購需求'):'尚未開放正式訂購';
  if(service.enabled&&service.siteKey){const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.onload=()=>window.turnstile.render(el('shopCaptcha'),{sitekey:service.siteKey,callback:t=>{captchaToken=t;}});document.head.append(script);}render();if(tracking)await refreshStatus();
 }
 init();
})();
