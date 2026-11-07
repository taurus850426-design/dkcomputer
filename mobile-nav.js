(function(){
'use strict';
if(document.querySelector('.dk-mobile-nav'))return;
const builder=!!document.getElementById('slotList'),nav=document.createElement('nav');nav.className='dk-mobile-nav';nav.setAttribute('aria-label','快捷操作');
nav.innerHTML=(builder?'<a id="estimateQuick" class="dk-estimate-quick" href="#estimateSummary">查看配單 0 件 · NT$ 0</a>':'')+'<div class="dk-mobile-links"><a href="./builder.html"'+(builder?' aria-current="page"':'')+'>線上估價</a><a href="./shop.html#shopCart"'+(document.getElementById('shopCart')?' aria-current="page"':'')+'>購物車 <span id="mobileCartCount">0</span></a><a href="https://lin.ee/vOtt85O" target="_blank" rel="noopener noreferrer">聯絡我們</a></div>';
document.body.append(nav);document.body.classList.add('has-mobile-nav');
function update(){let count=0;try{const data=JSON.parse(localStorage.getItem('dk_shop_cart_v1')||'[]'),rows=window.DKShopCore?.normalizeCart?window.DKShopCore.normalizeCart(data):normalize(data);count=rows.reduce((n,r)=>n+r.qty,0);}catch(_){}document.getElementById('mobileCartCount').textContent=String(count);}
function normalize(data){if(!Array.isArray(data))return [];const found=new Map();for(const r of data.slice(0,100)){const id=String(r?.id||''),qty=Number(r?.qty);if(id&&id.length<=160&&Number.isInteger(qty)&&qty>=1&&qty<=99)found.set(id,Math.min(99,(found.get(id)||0)+qty));}return Array.from(found,([id,qty])=>({id,qty})).slice(0,20);}
update();window.addEventListener('storage',update);window.addEventListener('pageshow',update);document.addEventListener('dk:cart-change',update);
})();
