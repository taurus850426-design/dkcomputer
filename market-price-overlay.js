(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKMarketOverlay=api;})(typeof window==='object'?window:globalThis,function(){'use strict';
function apply(catalog,overlay){
 if(!catalog||!Array.isArray(catalog.products))return catalog;
 const map=new Map((overlay?.products||[]).filter(x=>x&&x.id&&Number.isFinite(Number(x.dkPrice))&&Number(x.dkPrice)>0&&x.status==='ok').map(x=>[String(x.id),x]));
 return {...catalog,products:catalog.products.map(p=>{const o=map.get(String(p.id));return o?{...p,price:Number(o.dkPrice),marketUpdatedAt:o.updatedAt||overlay.updatedAt||null}:p;})};
}
return {apply};});