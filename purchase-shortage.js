/* Shortage edits use the server's locked document; failed requests never overwrite the editor. */
(function (root) {
  'use strict';
  const labels = {wait:'等補貨',vendor:'更換廠商',replace:'更換規格',cancel:'取消品項',resume:'恢復供貨',ordered:'替代品已叫貨'};
  const spec = item => String(item?.selectedSpec || item?.requestText || '未命名品項');
  const vendor = item => String(item?.selectedVendor || item?.manualVendor || '');
  const price = item => Number(item?.selectedUnitPrice)>0 ? Number(item.selectedUnitPrice) : Number(item?.manualUnitPrice || 0);
  function notification(entry) {
    const old=entry.before, next=entry.after;
    const lines=['DK Computer 叫貨異動通知','廠商：'+vendor(old),'原品項：'+spec(old)+' × '+old.quantity];
    if(entry.mode==='cancel') lines.push('此品項取消，請勿出貨；其餘已確認品項照常。');
    else if(['vendor','replace'].includes(entry.mode)) {
      lines.push('原品項取消，請勿按原內容出貨。');
      if(vendor(old)===vendor(next)) lines.push('替代品：'+spec(next)+' × '+next.quantity+'；另以確認叫貨訊息通知，本訊息尚未對替代品下單。');
      lines.push('其餘已確認品項照常，請回覆確認，謝謝。');
    } else if(entry.mode==='wait') lines.push('此品項等待補貨，請回覆預計到貨日期；勿自行更換規格，謝謝。');
    else lines.push('此品項供貨／叫貨狀態已確認，請回覆預計到貨時間，謝謝。');
    return lines.join('\n');
  }
  let context=null, quotes=[], baseline='', busy=false, uncertain=false;
  const el=id=>document.getElementById(id);
  const field=id=>el('poShortage'+id);
  const values=()=>['Mode','Vendor','Spec','Price','Quantity','Date','Reason','SyncSpec','Confirmed','Quote'].map(id=>field(id).type==='checkbox'?field(id).checked:field(id).value);
  function pending(){return !!context&&!field('Modal').hidden&&JSON.stringify(values())!==baseline;}
  function view(){
    if(!context)return;
    const mode=field('Mode').value, replacement=['vendor','replace'].includes(mode);
    field('Replacement').hidden=!replacement;
    field('Spec').readOnly=mode!=='replace';
    field('Quantity').readOnly=!!(context.item.sourceSalesOrderId||context.item.sourceSalesOrderLineKey)||mode!=='replace';
    field('DateField').hidden=mode!=='wait';
    field('SyncField').hidden=mode!=='replace'||!context.item.sourceSalesOrderId;
    field('ConfirmField').hidden=!(['vendor','replace','cancel'].includes(mode)&&(['ordered','partial'].includes(context.order.status)||context.item.procurementStatus==='ordered'))&&mode!=='ordered';
    field('ConfirmLabel').textContent=mode==='ordered'?'我已傳送替代品叫貨內容，並確認廠商接單。':'我已向原廠商確認取消／更換原品項，避免重複出貨。';
    const old=context.item;
    const next=replacement?(mode==='replace'?field('Spec').value:spec(old))+' × '+field('Quantity').value+'｜'+field('Vendor').value+'｜進價 '+field('Price').value:labels[mode];
    const difference=replacement?(Number(field('Price').value)*Number(field('Quantity').value)-price(old)*Number(old.quantity)):0;
    field('Comparison').textContent='原本：'+spec(old)+' × '+old.quantity+'｜'+vendor(old)+'｜進價 '+price(old)+'\n處理後：'+next+(replacement?'\n採購總額差額：'+(difference>=0?'+':'')+difference+' 元；客戶售價與折扣不變。':'');
  }
  function close(force){
    if(busy)return;
    if(!force&&pending()&&!root.confirm('缺貨處理尚未確認，確定放棄本次填寫？'))return;
    field('Modal').hidden=true;context=null;
  }
  function open(options){
    if(busy||options.isBusy())return;
    const item=options.item;
    if(item.procurementStatus==='received'||!['draft','ordered','partial'].includes(options.order.status))return;
    context=options;uncertain=false;
    field('Mode').innerHTML=Object.entries(labels).filter(([key])=>key==='resume'?item.shortageState==='waiting':key==='ordered'?item.shortageState==='replacement_pending':key==='wait'?item.shortageState!=='replacement_pending':true).map(([key,label])=>'<option value="'+key+'">'+label+'</option>').join('');
    field('Mode').value=item.shortageState==='replacement_pending'?'ordered':item.shortageState==='waiting'?'resume':'wait';
    field('Vendor').value=vendor(item);field('Spec').value=spec(item);field('Price').value=price(item)||'';
    field('Quantity').value=item.quantity;field('Date').value=item.shortageExpectedDate||'';
    field('Reason').value='';field('SyncSpec').checked=false;field('Confirmed').checked=false;field('Msg').textContent='';field('Save').disabled=false;
    quotes=(options.quotes||[]).filter(q=>q&&Number(q.price)>0&&!q.deletedAt&&!q.deleted_at&&(!q.category||!item.category||q.category===item.category)).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    field('Quote').replaceChildren(new Option('手動填寫新報價',''));
    quotes.forEach((q,i)=>field('Quote').add(new Option([q.vendor,q.brand,q.spec,q.price,q.date].filter(Boolean).join('｜'),String(i))));
    view();baseline=JSON.stringify(values());field('Modal').hidden=false;field('Mode').focus();
  }
  async function save(){
    if(!context||busy||uncertain)return;
    const captured=context, mode=field('Mode').value, replacement=['vendor','replace'].includes(mode);
    const change={type:'shortage',purchase_item_id:captured.item.id,mode,reason:field('Reason').value.trim(),
      expected_date:field('Date').value,supplier_confirmed:field('Confirmed').checked,sync_spec:mode==='replace'&&field('SyncSpec').checked};
    if(!change.reason){field('Msg').textContent='請填寫缺貨處理原因。';return;}
    if(!field('ConfirmField').hidden&&!change.supplier_confirmed){field('Msg').textContent='請先確認廠商取消／接單，再勾選確認。';return;}
    if(replacement){
      change.vendor=field('Vendor').value.trim();change.spec=field('Spec').value.trim();change.unit_price=Number(field('Price').value);change.quantity=Number(field('Quantity').value);
      if(!change.vendor||!change.spec||!(change.unit_price>0)||!Number.isFinite(change.unit_price)||!Number.isInteger(change.quantity)||change.quantity<=0){field('Msg').textContent='請填寫廠商、替代規格、有效進價與正整數數量。';return;}
      const q=field('Quote').value!==''?quotes[Number(field('Quote').value)]:null;
      change.quote_id=q?.id||null;change.quoted_at=q?.date?.slice(0,10)||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
    }
    const source=(root.DK?.getOrders?.()||[]).find(o=>String(o.id)===String(captured.item.sourceSalesOrderId||''));
    change.expected_source_updated_at=source?.updated_at||source?.updatedAt||null;
    busy=true;captured.setBusy(true);field('Save').disabled=true;field('Close').disabled=true;field('Msg').textContent='正在儲存並核對雲端結果…';
    field('Modal').querySelectorAll('input,select,textarea').forEach(node=>node.disabled=true);
    try{
      const result=await root.DK?.upsertPurchaseOrderToSupabase?.(captured.order,change);
      if(!result?.ok){
        uncertain=true;
        field('Msg').textContent='結果尚未確認，請關閉並重新從雲端同步核對後再操作；本次未覆蓋編輯內容。'+String(result?.error||'雲端功能未載入');
        return;
      }
      await captured.onSaved(result.order||captured.order);
      if(root.DK?.fetchV2DataFromSupabase)try{await root.DK.fetchV2DataFromSupabase();}catch(_){}
      busy=false;close(true);
    }catch(error){uncertain=true;field('Msg').textContent='結果待確認，請重新同步原單後核對：'+String(error?.message||error);}
    finally{busy=false;captured.setBusy(false);field('Close').disabled=false;field('Save').disabled=uncertain;field('Modal').querySelectorAll('input,select,textarea').forEach(node=>node.disabled=false);}
  }
  function bind(){
    if(!field('Modal')||field('Modal').dataset.bound)return;
    field('Modal').dataset.bound='1';
    field('Close').addEventListener('click',()=>close(false));field('Save').addEventListener('click',save);
    field('Modal').addEventListener('input',event=>{if(['Vendor','Spec','Price'].some(id=>field(id)===event.target))field('Quote').value='';view();});
    field('Mode').addEventListener('change',()=>{
      field('Confirmed').checked=false;field('SyncSpec').checked=false;field('Quote').value='';
      field('Vendor').value=vendor(context.item);field('Spec').value=spec(context.item);field('Price').value=price(context.item)||'';field('Quantity').value=context.item.quantity;
      field('Msg').textContent='';view();
    });
    field('Quote').addEventListener('change',()=>{
      const q=quotes[Number(field('Quote').value)];if(field('Quote').value===''||!q)return;
      const quotedSpec=[q.brand,q.spec].filter(Boolean).join(' ');
      if(field('Mode').value==='vendor'&&quotedSpec.replace(/\s/g,'').toLowerCase()!==spec(context.item).replace(/\s/g,'').toLowerCase()){
        field('Quote').value='';field('Msg').textContent='這筆報價規格不同，請改選「更換規格」，或手動填寫已核對的同規格報價。';return;
      }
      field('Vendor').value=q.vendor||'';field('Price').value=q.price;if(field('Mode').value==='replace')field('Spec').value=quotedSpec;view();
    });
    field('Modal').addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();close(false);}
      if(event.key==='Tab'){
        const controls=Array.from(field('Modal').querySelectorAll('button,input,select,textarea')).filter(node=>!node.disabled&&!node.closest('[hidden]'));
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    root.addEventListener('beforeunload',event=>{if(pending()||busy){event.preventDefault();event.returnValue='';}});
  }
  const api={open,close,pending,bind,notification,labels};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else{root.DKPurchaseShortage=api; if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();}
})(typeof window!=='undefined'?window:globalThis);
