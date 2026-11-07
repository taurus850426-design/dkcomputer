(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKBuilderOrderOptions=api;})(typeof window==='object'?window:globalThis,function(){
'use strict';
function normalize(value){return {retain_boxes:value?.retain_boxes===true,fulfillment_preference:['pickup','delivery'].includes(value?.fulfillment_preference)?value.fulfillment_preference:'undecided'};}
function fee(value){const o=normalize(value);return o.retain_boxes&&o.fulfillment_preference==='delivery'?150:0;}
function describe(value){const o=normalize(value);return '取貨方式：'+({pickup:'到店自取',delivery:'寄送',undecided:'待確認'}[o.fulfillment_preference])+'｜空盒：'+(o.retain_boxes?'保留':'不保留')+(fee(o)?'｜空盒分箱運費 NT$ 150':o.retain_boxes&&o.fulfillment_preference==='undecided'?'｜若寄送，空盒分箱另加 NT$ 150（尚未計入）':'');}
function serviceLine(value){return fee(value)?{line_key:'box_shipping',category:'運費',product_id:'',name:'空盒分箱運費',unit_price:150,qty:1}:null;}
return {normalize,fee,describe,serviceLine};});
