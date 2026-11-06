(function () {
  'use strict';
  let dialog, video, status, candidate, accept, photo, stream, timer, target, multiple=false, token=0, last='', hits=0;
  const byId=id=>document.getElementById(id);
  function stopStream() { if(stream) stream.getTracks().forEach(track=>track.stop()); stream=null; if(video) video.srcObject=null; clearTimeout(timer); }
  function close() { token++; stopStream(); target=null; if(dialog?.open) dialog.close(); }
  function init() {
    if(dialog) return;
    dialog=document.createElement('dialog');dialog.id='dkCameraDialog';dialog.setAttribute('aria-labelledby','dkCameraTitle');
    dialog.style.cssText='width:min(94vw,560px);max-height:92dvh;box-sizing:border-box;overflow:auto;border:1px solid #cbd5e1;border-radius:14px;padding:18px;background:white;color:#182033;z-index:10000';
    dialog.innerHTML='<h2 id="dkCameraTitle">手機相機掃碼</h2><p>請對準單一 S/N 或訂單條碼，辨識後核對文字再帶入。商品共用條碼不等於每件序號。</p><video id="dkCameraVideo" autoplay muted playsinline style="display:block;width:100%;max-height:38dvh;background:#111;border-radius:8px;object-fit:contain"></video><p id="dkCameraStatus" role="status" aria-live="polite"></p><label for="dkCameraCandidate">辨識結果（請核對）</label><input id="dkCameraCandidate" readonly style="display:block;width:100%;box-sizing:border-box;font-size:18px;margin:8px 0"/><div style="display:flex;flex-wrap:wrap;gap:10px"><button id="dkCameraAccept" type="button" disabled>確認帶入，不儲存</button><button id="dkCameraRestart" type="button">重新掃描</button><button id="dkCameraClose" type="button">取消</button></div><label style="display:block;margin-top:16px">也可以拍照或選擇條碼照片<input id="dkCameraPhoto" type="file" accept="image/*" capture="environment" style="display:block;max-width:100%"/></label><p style="font-size:14px">影像只在本機辨識，不會上傳。若無法辨識，可關閉後手動輸入編號。</p>';
    document.body.append(dialog);video=byId('dkCameraVideo');status=byId('dkCameraStatus');candidate=byId('dkCameraCandidate');accept=byId('dkCameraAccept');photo=byId('dkCameraPhoto');
    byId('dkCameraClose').addEventListener('click',close);
    byId('dkCameraRestart').addEventListener('click',()=>{candidate.value='';accept.disabled=true;last='';hits=0;start(++token);});
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',()=>{if(!dialog.open){stopStream();target=null;token++;}});
    accept.addEventListener('click',()=>{
      const code=candidate.value.trim(),field=target;
      if(!code || !field || field.disabled || !document.contains(field) || field.closest('[hidden]')) return close();
      if(multiple) {
        const existing=field.value.split(/[\r\n,，;；]+/).map(x=>x.trim()).filter(Boolean);
        if(existing.some(x=>x.toUpperCase()===code.toUpperCase())) {status.textContent='這個序號已在欄位中，沒有重複加入。';return;}
        field.value+=(field.value.trim()?'\n':'')+code;
      } else field.value=code;
      field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));close();field.focus();
    });
    photo.addEventListener('change',async()=>{
      const file=photo.files?.[0];if(!file)return;
      stopStream();const mine=++token;candidate.value='';accept.disabled=true;
      if(file.size>20*1024*1024){status.textContent='照片過大，請改用小於 20 MB 的照片。';return;}
      status.textContent='正在本機辨識照片…';const url=URL.createObjectURL(file);
      try {const img=new Image();img.src=url;await img.decode();const code=await decode(img);if(mine!==token)return;if(code) found(code);else status.textContent='未找到清楚的條碼。請靠近、保持對焦，拍攝單一條碼後重試。';}
      catch(_){if(mine===token)status.textContent='無法讀取照片，請改拍清楚的 JPG／PNG 照片。';}
      finally{URL.revokeObjectURL(url);photo.value='';}
    });
  }
  function found(code) { stopStream();candidate.value=code;accept.disabled=false;status.textContent='已辨識。請確認這是 S/N 或正確的訂單編號，再按「確認帶入」。'; }
  let decoding=Promise.resolve();
  function decode(source) { const result=decoding.catch(()=>{}).then(()=>decodeFrame(source));decoding=result;return result; }
  async function decodeFrame(source) {
    const rawWidth=source.videoWidth||source.naturalWidth||source.width,rawHeight=source.videoHeight||source.naturalHeight||source.height;
    if(!rawWidth||!rawHeight)return '';
    const scale=Math.min(1,1600/Math.max(rawWidth,rawHeight));const canvas=document.createElement('canvas');canvas.width=Math.round(rawWidth*scale);canvas.height=Math.round(rawHeight*scale);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);
    if(typeof window.BarcodeDetector==='function') {try{const detector=new window.BarcodeDetector();const list=await detector.detect(canvas);if(list.length===1&&list[0].rawValue)return list[0].rawValue;}catch(_){}}
    if(typeof window.jsQR==='function'){const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);const qr=window.jsQR(pixels.data,pixels.width,pixels.height);if(qr?.data)return qr.data;}
    if(!window.Quagga?.decodeSingle)return '';
    return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timeout);resolve(value);};const timeout=setTimeout(()=>finish(''),4000);
      try{window.Quagga.decodeSingle({src:canvas.toDataURL('image/png'),numOfWorkers:0,locate:true,inputStream:{size:Math.max(canvas.width,canvas.height)},decoder:{readers:['code_128_reader','code_39_reader','ean_reader','ean_8_reader','upc_reader','upc_e_reader']}},r=>finish(r?.codeResult?.code||''));}catch(_){finish('');}
    });
  }
  async function scan(mine) {
    if(mine!==token||!dialog.open||!stream)return;
    try {const code=await decode(video);if(mine!==token)return;if(code){hits=code===last?hits+1:1;last=code;if(hits>=2){found(code);return;}status.textContent='已讀到一次，請保持不動再核對一次…';}else{last='';hits=0;}}
    catch(_){if(mine===token)status.textContent='請保持對焦，或改用下方照片辨識。';}
    if(mine===token)timer=setTimeout(()=>scan(mine),350);
  }
  async function start(mine) {
    stopStream();status.textContent='正在開啟後置相機，請允許相機權限…';
    if(!navigator.mediaDevices?.getUserMedia){status.textContent='此瀏覽器無法開啟即時相機，請使用下方拍照／選照片，或用 Safari／Chrome 開啟 HTTPS 網址。';return;}
    try {
      const acquired=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
      if(mine!==token||!dialog.open){acquired.getTracks().forEach(t=>t.stop());return;}
      stream=acquired;video.srcObject=stream;await video.play();if(mine!==token)return;
      status.textContent='請對準單一條碼，保持清楚對焦；辨識後不會自動儲存。';scan(mine);
    }catch(error){if(mine!==token)return;stopStream();status.textContent=error.name==='NotAllowedError'?'相機權限未開啟。請到瀏覽器設定允許相機，或使用下方拍照／選照片。':'無法開啟相機。請關閉其他使用相機的程式，或使用下方照片辨識。';}
  }
  function open(field,isMultiple) {
    init();close();target=typeof field==='string'?byId(field):field;multiple=!!isMultiple;
    if(!target||target.disabled)return;
    candidate.value='';accept.disabled=true;last='';hits=0;photo.value='';dialog.showModal();start(++token);
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-camera-target]');if(button)open(button.dataset.cameraTarget,button.dataset.cameraMultiple==='true');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});window.addEventListener('pagehide',close);
  new MutationObserver(()=>{if(target?.closest('[hidden]'))close();}).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['hidden']});
  window.DKCameraScan={open,close};
})();
