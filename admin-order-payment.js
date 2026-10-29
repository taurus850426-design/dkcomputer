(function(root){
 'use strict';
 const el=id=>document.getElementById(id);
 const number=x=>Number.isFinite(Number(x))?Number(x):0;
 const money=x=>'NT$ '+number(x).toLocaleString('zh-TW');
 function summary(order){const due=Math.max(0,number(order.total_sale)+number(order.shipping_income)-number(order.discount)),received=number(order.received_amount);return{due,received,deposit:order.deposit_amount==null?null:number(order.deposit_amount),balance:Math.max(0,due-received),overpaid:Math.max(0,received-due)};}
 function text(order){if(['lost','cancelled'].includes(order.status))return '已結案，不需收取尾款；原報價紀錄保留。';const s=summary(order);return(s.deposit===null?'訂金未分類':'訂金 '+money(s.deposit))+'｜累計已收 '+money(s.received)+'｜尚欠尾款 '+money(s.balance)+(s.overpaid?'｜溢收 '+money(s.overpaid):'');}
 let autoReceived=null;
 function current(){return{status:el('orderStatus')?.value,total_sale:el('orderTotalSale')?.value,shipping_income:el('orderShipping')?.value,discount:el('orderDiscount')?.value,received_amount:el('orderReceivedAmount')?.value,deposit_amount:el('orderDepositAmount')?.value===''?null:el('orderDepositAmount')?.value};}
 function refresh(){const target=el('orderPaymentSummary');if(target)target.textContent=text(current());}
 function load(order){if(el('orderDepositAmount'))el('orderDepositAmount').value=order?.deposit_amount??'';autoReceived=null;refresh();}
 function value(){const input=el('orderDepositAmount');return!input||input.value===''?undefined:Number(input.value);}
 function bind(){document.addEventListener('input',event=>{
   const id=event.target.id;if(!['orderDepositAmount','orderReceivedAmount','orderTotalSale','orderShipping','orderDiscount'].includes(id))return;
   if(id==='orderDepositAmount'){
     const dep=value(),received=number(el('orderReceivedAmount').value);
     if(dep!==undefined&&Number.isFinite(dep)&&dep>=0&&(dep>received||autoReceived===received)) {el('orderReceivedAmount').value=dep;autoReceived=dep;}
   }else if(id==='orderReceivedAmount')autoReceived=null;
   const s=summary(current());const status=el('orderPaymentStatus');if(status)status.value=s.received<=0?'unpaid':s.received<s.due?'partial':'paid';
   const date=el('orderPaymentDate');if(s.received>0&&date&&!date.value)date.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());refresh();
 });document.addEventListener('change',event=>{if(['orderPaymentStatus','orderStatus'].includes(event.target.id))refresh();});}
 const api={summary,text,load,value,refresh,bind};if(typeof module!=='undefined'&&module.exports)module.exports=api;else{root.DKOrderPayment=api;bind();}
})(typeof window!=='undefined'?window:globalThis);
