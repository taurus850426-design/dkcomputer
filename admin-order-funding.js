/* Only reads funding; results never become part of a sales-order payload. */
(function(root){
 'use strict';
 const generations=new WeakMap();
 function describe(row){
  if(!row)return {label:'待確認',title:'出資資料暫時無法讀取，未推定出資方。'};
  const boss=Number(row.boss_qty),hala=Number(row.hala_qty),qty=Number(row.requested_qty);
  if(!['actual','estimated'].includes(row.mode)||![boss,hala,qty].every(Number.isFinite)||boss<0||hala<0||qty<=0||boss+hala!==qty)return {label:'待確認',title:'出資分配與目前品項數量不一致或紀錄不足，請核對；未推定出資方。'};
  const owner=boss>0&&hala>0?'HALA／BOSS':boss>0?'BOSS':'HALA',estimated=row.mode==='estimated';
  return {label:owner+(estimated?'（預估）':''),title:(estimated?'依現有出資批次及既有出庫順序預估，儲存／出庫時可能改變。':'依此訂單實際出庫的出資分配。')+' 同品項於本單合計：HALA '+hala+' 件、BOSS '+boss+' 件。'};
 }
 async function populate(tbody,dk,orderId,lines,canRead){
  if(!tbody)return;const generation=(generations.get(tbody)||0)+1;generations.set(tbody,generation);
  const cells=[...tbody.querySelectorAll('[data-order-funding]')];
  if(!canRead()){cells.forEach(c=>{c.hidden=true;c.textContent='';});return;}
  const requested=lines.filter(x=>x.item_id&&x.fulfillment_type!=='service'&&x.fulfillment_type!=='procurement').map(x=>({item_id:String(x.item_id),qty:Number(x.qty)}));
  for(const cell of cells){cell.hidden=false;const line=lines[Number(cell.dataset.orderFunding)];cell.textContent=line?.fulfillment_type==='service'?'不適用':!line?.item_id?'待到貨確認':'讀取中…';}
  if(!requested.length)return;
  let result;try{result=await dk.stage7OrderFunding(orderId||null,requested);}catch(_){result=null;}
  if(generations.get(tbody)!==generation)return;
  for(const cell of cells){
   if(!cell.isConnected)continue;if(!canRead()){cell.hidden=true;cell.textContent='';continue;}
   const line=lines[Number(cell.dataset.orderFunding)];if(!line?.item_id||line.fulfillment_type==='service'||line.fulfillment_type==='procurement')continue;
   const row=result?.ok&&Array.isArray(result.data)?result.data.find(x=>x.item_id===String(line.item_id)):null;
   const info=describe(row);cell.textContent=info.label;cell.title=info.title;
  }
 }
 const api={describe,populate};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DKOrderFunding=api;
})(typeof window!=='undefined'?window:globalThis);
