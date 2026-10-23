/* Read-only admin usage panel. Reuses authenticated session; never puts server secrets in the browser. */
(function(){
 'use strict';
 const logout=document.getElementById('logoutBtn');if(!logout)return;
 const button=document.createElement('button');button.type='button';button.className='btn btn-ghost';button.textContent='配單服務用量';button.hidden=true;logout.before(button);
 const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','配單服務每月用量');dialog.style.cssText='max-width:560px;width:calc(100% - 40px);border:1px solid #aaa;border-radius:16px;padding:24px;color:#111;background:#fff';
 const title=document.createElement('h2');title.textContent='配單服務用量';const body=document.createElement('p');body.style.whiteSpace='pre-line';body.setAttribute('role','status');const close=document.createElement('button');close.type='button';close.className='btn';close.textContent='關閉';close.onclick=()=>dialog.close();dialog.append(title,body,close);document.body.append(dialog);
 let requested=false;
 async function load(show=false){if(window.DKBuilderServiceConfig?.enabled===false){if(show){body.textContent='外部搜尋與用量服務尚未啟用；常見遊戲的自動配單仍可正常使用。';dialog.showModal();}return;}if(typeof callBackofficeEdgeFunction!=='function')return;if(show){body.textContent='正在讀取…';dialog.showModal();}
  const r=await callBackofficeEdgeFunction('builder-research',{action:'usage'});const u=r.data?.usage;
  if(!r.ok||!u){if(show)body.textContent=r.status===403?'只有管理員可以查看。':'用量服務尚未啟用或暫時無法讀取。';return;}
  button.textContent=u.warning?'配單用量・接近上限':'配單服務用量';
  const money=n=>'NT$ '+Number(n||0).toLocaleString('zh-TW');
  body.textContent='月份：'+u.month+'\n狀態：'+(u.enabled?'已啟用':'尚未啟用付費查找')+'\n每月總預算：'+money(u.limitTwd)+'\n固定服務預留：'+money(u.fixedReserveTwd)+'\n費率／稅費緩衝：'+money(u.bufferTwd)+'\n搜尋與整理已預留：'+money(u.lookupReserveTwd)+'\n剩餘查找額度：'+money(u.remainingTwd)+(u.warning?'\n已達提醒門檻；用完後停止新增付費查找，已保存資料仍可使用。':'')+(u.schedulerPrerequisitesReady?'':'\n注意：每日更新排程的必要擴充尚未齊備。')+'\n\n以上為保守預留帳，不是服務商實際帳單。';
 }
 button.onclick=()=>load(true);
 function sync(){button.hidden=logout.hidden||window.DK?.getCurrentRole?.()!=='admin';if(!button.hidden&&!requested){requested=true;load();}if(logout.hidden){requested=false;dialog.close();}}
 new MutationObserver(sync).observe(logout,{attributes:true,attributeFilter:['hidden']});sync();
})();
