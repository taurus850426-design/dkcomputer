/* Batch orchestration reuses the version-checked, per-item receipt operation. */
(function(root){
  'use strict';
  function pendingForOrder(orderId, purchases){
    if (!orderId) return [];
    return (purchases || []).filter(po => po && ['draft','ordered','partial'].includes(po.status)).map(po => {
      const items=(po.items || []).filter(it => it.procurementStatus !== 'received' &&
        (String(it.sourceSalesOrderId || '') === String(orderId) || (!it.sourceSalesOrderId && String(po.sourceSalesOrderId || '') === String(orderId))));
      return {order:po,items};
    }).filter(row => row.items.length);
  }
  function plan(order, options){
    const ready=[],issues=[],reviews=[];
    const remaining=(order?.items || []).filter(it=>it.procurementStatus!=='received');
    if (!order || !['ordered','partial'].includes(order.status)) issues.push('僅已叫貨或部分到貨的單據可統一登記');
    for(const item of remaining){
      const name=String(item.selectedSpec || item.requestText || '未命名品項');
      const linked=!!(item.sourceSalesOrderId && item.sourceSalesOrderLineKey);
      const destination=options.destination==='auto' ? (linked?'customer':'inventory') : options.destination;
      if (!['customer','inventory'].includes(destination)) issues.push(name+'：請選擇到貨用途');
      if (!(Number(options.priceOf(item))>0)) issues.push(name+'：尚無有效廠商報價');
      if (!String(item.category || '').trim()) issues.push(name+'：尚未設定品類');
      if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity)<=0) issues.push(name+'：數量無效');
      if (destination==='customer' && !linked) issues.push(name+'：沒有完整來源訂單，請改選自動判斷或一般庫存');
      const source=(options.orders || []).find(o=>String(o.id)===String(item.sourceSalesOrderId || order?.sourceSalesOrderId || ''));
      if((item.sourceSalesOrderId || order?.sourceSalesOrderId) && !source) issues.push(name+'：來源訂單資料尚未載入，請先同步核對');
      if(source?.status==='refunded') issues.push(name+'：來源訂單已退貨，請逐項核對用途');
      if(source?.status==='completed') reviews.push(item.id);
      ready.push({id:String(item.id),name,destination,quantity:Number(item.quantity)});
    }
    if (!remaining.length) issues.push('所有品項均已到貨，無需重複登記');
    if (reviews.length && !options.allowCompleted) issues.push('含已完成的來源訂單；請先核對是否曾以其他方式入庫，並勾選確認');
    return {ready,issues,reviews,alreadyReceived:(order?.items || []).length-remaining.length};
  }
  const running=new Set();
  async function run(order, batch, options){
    if(batch.issues.length) return {completed:[],error:batch.issues.join('；')};
    if(running.has(order.id)) return {completed:[],error:'此單正在處理中'};
    running.add(order.id);
    const completed=[];
    try {
      for(const entry of batch.ready){
        const item=order.items.find(it=>String(it.id)===entry.id);
        if(!item) return {completed,error:'品項已變更，請重新核對'};
        if(item.procurementStatus==='received') continue;
        const result=await options.receive({purchase_order:order,purchase_order_id:order.id,purchase_item_id:entry.id,
          destination:entry.destination,inventory_item_id:'',received_at:options.date,note:options.note || ''});
        if(!result?.ok) return {completed,error:String(result?.error || '回應不明，請同步核對後再繼續'),failedId:entry.id};
        completed.push(entry.id);
        options.progress?.(completed.length,batch.ready.length);
        if(order.items.find(it=>String(it.id)===entry.id)?.procurementStatus!=='received')
          return {completed,error:'已送出到貨，但尚未取得最新單據，請重新同步核對'};
      }
      return {completed,error:''};
    } catch(e){return {completed,error:String(e?.message || e || '到貨處理失敗')};}
    finally {running.delete(order.id);}
  }
  const api={pendingForOrder,plan,run};
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.DKPurchaseBatch=api;
})(typeof window!=='undefined'?window:globalThis);
