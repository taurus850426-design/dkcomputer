(function(root){
 'use strict';
 const historical=(row,type)=>type==='order'?['completed','refunded'].includes(row.status):['received','cancelled'].includes(row.status);
 function filter(rows,{type,view='active',query='',status=''}={}){
  const q=String(query).trim().toLocaleLowerCase();
  return rows.filter(row=>{
   if(status&&row.status!==status)return false;
   if(!q&&!status&&view!=='all'&&historical(row,type)!==(view==='history'))return false;
   if(!q)return true;
   const fields=type==='order'?[row.order_no,row.customer_name,row.customer_phone,row.customer_line]:[row.orderNo,row.note,row.sourceSalesOrderNo,row.sourceCustomerName,...(row.items||[]).flatMap(x=>[x.requestText,x.selectedSpec,x.selectedVendor,x.manualVendor,x.itemNote])];
   return fields.some(x=>String(x||'').toLocaleLowerCase().includes(q));
  });
 }
 const api={filter,historical};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DKRecordHistory=api;
})(typeof window!=='undefined'?window:globalThis);
