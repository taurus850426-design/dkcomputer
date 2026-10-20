const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function setup({decodeError=false,printError=false}={}){
 const dom=new JSDOM('<body></body>',{runScripts:'outside-only'}),w=dom.window;
 const append=w.document.body.append.bind(w.document.body);let printed=0,frame;
 w.document.body.append=(node)=>{
  append(node);frame=node;
  // Emulate the loaded about:blank document and decoded canvas image.
  const fn=node.onload;node.onload=null;
  node.contentWindow.focus=()=>{};
  node.contentWindow.print=()=>{if(printError)throw Error('printer unavailable');printed++;};
  node.contentWindow.HTMLImageElement.prototype.decode=async()=>{if(decodeError)throw Error('decode failed');};
  queueMicrotask(()=>fn());
 };
 w.eval(read('admin-quote-print.js'));
 return {dom,w,printed:()=>printed,frame:()=>frame,canvas:{width:1080,height:1528,toDataURL:()=> 'data:image/png;base64,fixture'},close:()=>dom.window.close()};
}
test('prints only decoded quotation image on isolated A4 page and cleans up afterprint',async()=>{
 const s=setup();await s.w.DKQuotePrint(s.canvas,'DK-報價單.png');assert.equal(s.printed(),1);
 const frame=s.frame(),doc=frame.contentDocument;assert.equal(doc.title,'DK-報價單');assert.equal(doc.body.querySelectorAll('img').length,1);assert.match(doc.head.querySelector('style').textContent,/size:A4/);assert.equal(doc.body.querySelector('input'),null);
 await assert.rejects(s.w.DKQuotePrint(s.canvas,'again'),/列印視窗已開啟/);
 frame.contentWindow.dispatchEvent(new s.w.Event('afterprint'));assert.equal(frame.isConnected,false);
 await s.w.DKQuotePrint(s.canvas,'second');assert.equal(s.printed(),2);s.close();
});
test('invalid image never opens a print frame',async()=>{
 const s=setup();await assert.rejects(s.w.DKQuotePrint({width:0,height:0},'bad'));assert.equal(s.printed(),0);assert.equal(s.frame(),undefined);s.close();
});
test('image decode or printer failure removes frame and allows retry',async()=>{
 for(const options of [{decodeError:true},{printError:true}]){const s=setup(options);await assert.rejects(s.w.DKQuotePrint(s.canvas,'bad'));assert.equal(s.printed(),0);assert.equal(s.frame().isConnected,false);s.close();}
});
test('button uses fresh unsaved form data without opening the preview modal or writing orders',async()=>{
 const dom=new JSDOM('<button id="orderQuotePreview">列印報價單</button>',{runScripts:'outside-only'}),document=dom.window.document;
 const source=read('admin3.js'),start=source.indexOf('    let quotePrintBusy = false;'),end=source.indexOf('    document.getElementById("orderQuoteDownload")',start);
 let resolve,builds=0,printed=0,error='';const canvas={currentDraft:true};
 const bind=new Function('document','requirePerm','buildQuoteCanvas','v2Show','orderMsg','window',source.slice(start,end));
 bind(document,()=>true,()=>{builds++;return new Promise(r=>{resolve=r;});},(_,msg)=>{error=msg;},{},{DKQuotePrint:async value=>{assert.equal(value,canvas);printed++;}});
 const button=document.getElementById('orderQuotePreview');button.click();button.click();assert.equal(builds,1);assert.equal(button.disabled,true);
 resolve({canvas,filename:'current.png'});await flush();assert.equal(printed,1);assert.equal(error,'');assert.equal(button.disabled,false);assert.equal(button.textContent,'列印報價單');dom.window.close();
});
test('button retains quote permission guard and reports renderer errors',async()=>{
 const source=read('admin3.js'),start=source.indexOf('    let quotePrintBusy = false;'),end=source.indexOf('    document.getElementById("orderQuoteDownload")',start);
 for(const allowed of [false,true]){const dom=new JSDOM('<button id="orderQuotePreview">列印報價單</button>'),doc=dom.window.document;let builds=0,message='';new Function('document','requirePerm','buildQuoteCanvas','v2Show','orderMsg','window',source.slice(start,end))(doc,()=>allowed,async()=>{builds++;throw Error('render failed');},(_,m)=>{message=m;},{},{});doc.getElementById('orderQuotePreview').click();await flush();assert.equal(builds,allowed?1:0);assert.equal(!!message,allowed);assert.equal(doc.getElementById('orderQuotePreview').disabled,false);dom.window.close();}
});
