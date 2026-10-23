const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM,VirtualConsole}=require('jsdom');
const read=p=>fs.readFileSync(p,'utf8'),catalog=JSON.parse(read('data/builder-catalog.json')),games=JSON.parse(read('data/builder-games.json'));
const wait=()=>new Promise(r=>setTimeout(r,10));
async function setup({draft,fail=false,storageFail=false}={}){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));const dom=new JSDOM(read('builder.html'),{url:'https://example.test/dkcomputer/builder.html',runScripts:'outside-only',virtualConsole:vc}),w=dom.window;
 w.AbortSignal=AbortSignal;w.confirm=()=>true;w.HTMLElement.prototype.scrollIntoView=()=>{};if(draft)w.localStorage.setItem('dk_builder_draft_v1',JSON.stringify(draft));
 if(storageFail)w.Storage.prototype.setItem=()=>{throw Error('quota')};const calls=[];
 w.fetch=async(url,options)=>{calls.push({url,options});if(fail)throw Error('offline');return {ok:true,json:async()=>url.includes('games')?games:catalog};};w.eval(read('builder-core.js'));w.eval(read('builder.js'));await wait();
 const el=id=>w.document.getElementById(id),click=id=>el(id).click(),change=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};return {dom,w,el,click,change,calls,errors};
}
function next(s){s.el('builderForm').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));}
test('game questionnaire shows source-specific goals, preserves selections and carries them to final text',async()=>{
 const s=await setup();s.el('next').click();assert.match(s.el('stepMessage').textContent,/用途/);const game=s.w.document.querySelector('[name=usage][value=game]');game.click();next(s);s.w.document.querySelector('[name=game][value=cyberpunk]').click();const target=s.w.document.querySelector('[data-game-target=cyberpunk]');target.value='high1080';target.dispatchEvent(new s.w.Event('change',{bubbles:true}));assert.match(s.el('gameRequirements').textContent,/7800X3D/);next(s);s.change('budget','50000');next(s);assert.match(s.el('stepBody').textContent,/高畫質/);s.click('suggestBuild');assert.ok(s.el('buildItems').textContent.includes('AMD'));next(s);for(let i=0;i<8;i++)next(s);assert.match(s.el('stepTitle').textContent,/配單需求/);assert.match(s.el('summaryText').value,/電馭叛客/);assert.match(s.el('summaryText').value,/實測核對/);assert.equal(s.errors.length,0);assert.equal(s.calls.length,2);assert.ok(s.calls.every(x=>!x.options?.method));s.dom.window.close();
});
test('all thirty catalog categories can be searched without rendering the whole snapshot',async()=>{
 const s=await setup();s.click('catalogTab');assert.equal(s.el('catalogView').hidden,false);assert.equal(s.el('catalogCategory').options.length,31);assert.equal(s.el('catalogProducts').querySelectorAll('article').length,24);s.change('catalogCategory','4');s.el('catalogSearch').value='7500F';s.el('catalogSearch').dispatchEvent(new s.w.Event('input',{bubbles:true}));assert.ok(s.el('catalogProducts').textContent.includes('7500F'));assert.ok(!s.el('catalogProducts').textContent.includes('搭板專案'));s.dom.window.close();
});
test('draft restore drops removed IDs and recalculates prices using current data',async()=>{
 const cpu=catalog.products.find(x=>x.category===4&&x.facts.socket),s=await setup({draft:{version:1,step:12,needs:{usages:['office'],budget:30000},ids:{cpu:cpu.id,gpu:'removed'},updatedAt:'old'}});assert.match(s.el('summaryText').value,new RegExp(cpu.price.toLocaleString('zh-TW')));assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.gpu,undefined);assert.match(s.el('buildTotal').textContent,new RegExp(cpu.price.toLocaleString('zh-TW')));s.dom.window.close();
});
test('failed data fetch keeps draft and shows retry, never rewrites it with an empty build',async()=>{
 const draft={version:1,ids:{cpu:'saved'},step:4},s=await setup({draft,fail:true});assert.equal(s.el('builderFailure').hidden,false);assert.equal(s.el('builderLayout').hidden,true);assert.deepEqual(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')),draft);s.dom.window.close();
});
test('source HTML in draft names is escaped and cannot add active elements',async()=>{
 const s=await setup({draft:{version:1,step:3,needs:{appNames:['<img src=x onerror=alert(1)>'],usages:['game'],budget:30000},ids:{},updatedAt:catalog.updatedAt}});assert.equal(s.el('stepBody').querySelector('img'),null);assert.match(s.el('stepBody').textContent,/<img/);s.dom.window.close();
});
test('CPU platform change requires approval before removing an incompatible board',async()=>{
 const cpu=catalog.products.find(x=>x.category===4&&x.facts.socket==='AM5'&&x.facts.cores),board=catalog.products.find(x=>x.category===5&&x.facts.socket==='AM5'&&x.facts.ddr&&x.facts.form),s=await setup({draft:{version:1,step:4,needs:{usages:['game']},ids:{cpu:cpu.id,board:board.id},updatedAt:catalog.updatedAt}});
 let confirmCount=0;s.w.confirm=()=>{confirmCount++;return false;};const buttons=[...s.el('partProducts').querySelectorAll('[data-part]')];const alternate=buttons.find(b=>catalog.products.find(x=>x.id===b.dataset.part)?.facts.socket!=='AM5');assert.ok(alternate);alternate.click();assert.equal(confirmCount,1);assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.board,board.id);s.w.confirm=()=>true;alternate.click();assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.board,undefined);s.dom.window.close();
});
test('unavailable browser storage leaves unload protection and an explicit save warning',async()=>{
 const s=await setup({storageFail:true});assert.match(s.el('saveStatus').textContent,/無法保存/);const event=new s.w.Event('beforeunload',{cancelable:true});s.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);s.dom.window.close();
});
test('copy failure selects the full text for manual copy and never opens or sends LINE',async()=>{
 const s=await setup({draft:{version:1,step:12,needs:{usages:['office']},ids:{}}});let opened=false;s.w.open=()=>{opened=true;};s.click('copyBuild');await wait();assert.match(s.el('stepMessage').textContent,/手動複製/);assert.equal(s.el('summaryText').selectionEnd,s.el('summaryText').value.length);assert.equal(opened,false);assert.equal(s.errors.length,0);s.dom.window.close();
});
