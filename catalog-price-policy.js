/* One policy for source ingestion and the customer catalogue. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKCatalogPricePolicy=api;})(typeof window==='object'?window:globalThis,function(){
'use strict';
function reason(text){
 const value=String(text||'').normalize('NFKC');
 if(/獨家|独家|專賣|專售|原價屋限定|原價屋特仕|exclusive/i.test(value))return 'exclusive';
 if(/搭板|搭主機板|搭配主機板|任搭|限搭|限組裝|裝機價|組裝價|組合價|組合包|套裝必搭|套裝加購|主機搭購|須搭|需搭|限購|組裝限定/.test(value))return 'conditional';
 return '';
}
function accepts(p){return !!p&&!reason(String(p.name||'')+' '+String(p.group||''));}
return{reason,accepts};
});
