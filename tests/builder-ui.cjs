const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM,VirtualConsole}=require('jsdom');
const read=p=>fs.readFileSync(p,'utf8'),catalog=JSON.parse(read('data/builder-catalog.json')),games=JSON.parse(read('data/builder-games.json'));
const wait=()=>new Promise(r=>setTimeout(r,10));
async function setup({draft,fail=false,storageFail=false}={}){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));const dom=new JSDOM(read('builder.html'),{url:'https://example.test/dkcomputer/builder.html',runScripts:'outside-only',virtualConsole:vc}),w=dom.window;
 w.AbortSignal=AbortSignal;w.confirm=()=>true;w.HTMLElement.prototype.scrollIntoView=()=>{};if(draft)w.localStorage.setItem('dk_builder_draft_v1',JSON.stringify(draft));
 if(storageFail)w.Storage.prototype.setItem=()=>{throw Error('quota')};const calls=[];
 w.fetch=async(url,options)=>{calls.push({url,options});if(fail)throw Error('offline');return {ok:true,json:async()=>url.includes('games')?games:catalog};};w.eval(read('builder-core.js'));w.eval(read('builder-apps.js'));w.eval(read('builder.js'));await wait();
 const el=id=>w.document.getElementById(id),click=id=>el(id).click(),change=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};return {dom,w,el,click,change,calls,errors};
}
function next(s){s.el('builderForm').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));}
test('shared experience automatically recommends a whole PC and adopts directly without eight part steps',async()=>{
 const s=await setup();s.el('next').click();assert.match(s.el('stepMessage').textContent,/用途/);s.w.document.querySelector('[name=usage][value=game]').click();next(s);s.w.document.querySelector('[data-add-app="特戰英豪（VALORANT）"]').click();assert.equal(s.w.document.querySelector('[data-game-target]'),null);next(s);s.change('budget','50000');s.change('resolution','1080p');s.change('color','allwhite');next(s);assert.equal(s.w.document.querySelectorAll('.build-overview article').length,8);assert.ok(s.el('buildItems').textContent.includes('AMD'));assert.equal(s.el('next').hidden,true);s.click('adoptBuild');assert.match(s.el('summaryText').value,/特戰英豪/);assert.match(s.el('summaryText').value,/整體偏好/);assert.match(s.el('summaryText').value,/實測核對/);assert.equal(s.errors.length,0);assert.equal(s.calls.length,2);assert.ok(s.calls.every(x=>!x.options?.method));s.dom.window.close();
});
function search(s,value){s.el('appSearch').value=value;s.el('appSearch').dispatchEvent(new s.w.Event('input',{bubbles:true}));}
test('keyword aliases, type and category filters add and remove mixed lists without losing selections',async()=>{
 const s=await setup({draft:{version:1,step:1,needs:{usages:['game']},ids:{}}});search(s,'瓦羅蘭');assert.match(s.el('appResults').textContent,/特戰英豪/);s.click('addCustomApp');s.click('addCustomApp');assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).needs.appNames.length,1);
 s.w.document.querySelector('[data-app-kind="software"]').click();s.change('appCategory','文書／日常');search(s,'Excel');s.w.document.querySelector('[data-add-app="Microsoft Excel"]').click();const d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(d.needs.appKinds['Microsoft Excel'],'software');assert.equal(d.needs.appNames.length,2);assert.match(s.el('selectedApps').textContent,/特戰英豪/);s.w.document.querySelector('[data-remove-app="Microsoft Excel"]').click();assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).needs.appNames.length,1);assert.deepEqual(s.errors,[]);s.dom.window.close();
});
test('custom names are bounded, inert, classified and preserved through draft restoration',async()=>{
 const s=await setup({draft:{version:1,step:1,needs:{usages:['office']},ids:{}}});s.w.document.querySelector('[data-app-kind="software"]').click();search(s,'<img src=x onerror=alert(1)>');s.click('addCustomApp');assert.equal(s.el('selectedApps').querySelector('img'),null);let d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(d.needs.appKinds[d.needs.appNames[0]],'software');s.dom.window.close();const restored=await setup({draft:d});assert.match(restored.el('selectedApps').textContent,/<img/);assert.equal(restored.el('selectedApps').querySelector('img'),null);for(let i=0;i<25;i++){search(restored,'自訂軟體'+i);restored.click('addCustomApp');}d=JSON.parse(restored.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(d.needs.appNames.length,20);assert.match(restored.el('appMessage').textContent,/最多/);restored.dom.window.close();
});
test('the new questionnaire preserves legacy targets, chosen parts and custom photo data',async()=>{
 const cpu=catalog.products.find(p=>p.category===4&&p.facts.socket),s=await setup({draft:{version:1,step:2,needs:{usages:['game'],appNames:['特戰英豪（VALORANT）'],gameTargets:{valorant:'144'},resolution:'1080p'},ids:{cpu:cpu.id},others:{gpu:{name:'自己的顯卡',mode:'owned',photo:{dataUrl:'data:image/jpeg;base64,YWJj',name:'gpu.jpg'}}}}});assert.match(s.el('stepBody').textContent,/舊版個別目標/);s.change('monitorModel','測試螢幕');s.change('refreshRate','240');next(s);const d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(d.ids.cpu,cpu.id);assert.equal(d.others.gpu.photo.name,'gpu.jpg');s.click('adoptBuild');assert.match(s.el('summaryText').value,/舊版個別遊玩目標/);assert.match(s.el('summaryText').value,/240Hz/);assert.match(s.el('summaryText').value,/測試螢幕/);assert.deepEqual(s.errors,[]);s.dom.window.close();
});
test('changing preferences preserves existing choices; an unsupported game never produces a partial automatic recommendation',async()=>{
 const cpu=catalog.products.find(p=>p.category===4&&p.facts.socket),s=await setup({draft:{version:1,step:2,needs:{usages:['game'],appNames:['Minecraft'],resolution:'1440p'},ids:{cpu:cpu.id}}});next(s);assert.match(s.el('stepBody').textContent,/已保留目前配單/);s.click('suggestBuild');assert.match(s.el('stepMessage').textContent,/尚未完整/);assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.cpu,cpu.id);assert.equal(s.el('next').hidden,true);s.w.document.querySelector('[data-edit-part="8"]').click();s.click('backToOverview');assert.ok(s.el('adoptBuild'));s.dom.window.close();
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
test('unknown game mapping preserves an existing draft instead of replacing it with an unsupported cheap build',async()=>{
 const cpu=catalog.products.find(x=>x.category===4&&x.facts.socket),s=await setup({draft:{version:1,step:3,needs:{usages:['game'],appNames:['Unknown Game'],budget:50000},ids:{cpu:cpu.id},updatedAt:catalog.updatedAt}});s.click('suggestBuild');assert.match(s.el('stepMessage').textContent,/尚未完整/);assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.cpu,cpu.id);s.dom.window.close();
});
test('all-white insufficient-budget result remains white and manual CPU options respect the game reference',async()=>{
 const s=await setup({draft:{version:1,step:3,needs:{usages:['game'],appNames:['特戰英豪（VALORANT）'],gameTargets:{valorant:'1080p-high-144'},resolution:'1080p',color:'allwhite',budget:10000},ids:{},updatedAt:catalog.updatedAt}});s.click('suggestBuild');assert.match(s.el('stepMessage').textContent,/超出預算/);const d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.ok(d.ids.cooler);for(const k of ['board','ram','gpu','cooler','case','psu'])assert.equal(s.w.DKBuilder.colorOf(catalog.products.find(p=>p.id===d.ids[k])),'white');next(s);assert.ok(!s.el('partProducts').textContent.includes('3400G'));s.dom.window.close();
});
function fillOther(s,{name='Other model',url='',mode='request'}={}){s.el('otherPart').open=true;for(const [id,value]of Object.entries({otherName:name,otherUrl:url})){s.el(id).value=value;s.el(id).dispatchEvent(new s.w.Event('input',{bubbles:true}));}s.change('otherMode',mode);}
const cpuDraft=()=>({version:1,step:4,needs:{usages:['office'],budget:30000},ids:{},updatedAt:catalog.updatedAt});
test('every part step offers custom entry; requests show unpriced total and preserve link in inquiry',async()=>{
 const s=await setup({draft:cpuDraft()});fillOther(s,{name:'Custom CPU',url:'https://example.com/cpu'});s.click('applyOther');assert.equal(s.el('buildTotal').textContent,'待報價');assert.match(s.el('budgetStatus').textContent,/不是整台總價/);const d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(d.others.cpu.name,'Custom CPU');assert.equal(d.ids.cpu,undefined);
 for(let i=0;i<7;i++){next(s);assert.ok(s.el('otherPart'));}s.click('toSummary');assert.match(s.el('summaryText').value,/https:\/\/example.com\/cpu/);assert.match(s.el('summaryText').value,/待報價/);assert.equal(s.errors.length,0);s.dom.window.close();
});
test('owned parts are distinguished from missing purchase prices and survive reload',async()=>{
 const s=await setup({draft:cpuDraft()});fillOther(s,{name:'My CPU',mode:'owned'});s.click('applyOther');assert.match(s.el('budgetStatus').textContent,/自備零件/);const d=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));s.dom.window.close();const restored=await setup({draft:d});assert.equal(restored.el('otherName').value,'My CPU');assert.equal(restored.el('otherMode').value,'owned');assert.match(restored.el('buildItems').textContent,/自備零件/);restored.dom.window.close();
});
test('typing a custom draft without applying preserves current selection and restores unfinished fields',async()=>{
 const cpu=catalog.products.find(p=>p.category===4&&p.facts.socket),s=await setup({draft:{...cpuDraft(),ids:{cpu:cpu.id}}});fillOther(s,{name:'Unfinished model',url:'not-yet-a-valid-link'});const draft=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(draft.ids.cpu,cpu.id);assert.equal(draft.others.cpu,undefined);s.dom.window.close();const restored=await setup({draft});assert.equal(restored.el('otherName').value,'Unfinished model');assert.equal(restored.el('otherUrl').value,'not-yet-a-valid-link');restored.dom.window.close();
});
test('empty or unsafe custom entries cannot replace a selected catalogue part',async()=>{
 const cpu=catalog.products.find(p=>p.category===4&&p.facts.socket),s=await setup({draft:{...cpuDraft(),ids:{cpu:cpu.id}}});s.click('applyOther');assert.match(s.el('otherMessage').textContent,/至少/);fillOther(s,{name:'Bad URL model',url:'javascript:alert(1)'});s.click('applyOther');assert.match(s.el('otherMessage').textContent,/完整/);assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).ids.cpu,cpu.id);assert.equal(s.calls.length,2);s.dom.window.close();
});
test('catalogue selection replaces a custom item without losing its editable draft or double-counting',async()=>{
 const s=await setup({draft:cpuDraft()});fillOther(s);s.click('applyOther');const b=s.el('partProducts').querySelector('[data-part]'),id=b.dataset.part;b.click();const draft=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.equal(draft.others.cpu,undefined);assert.equal(draft.ids.cpu,id);assert.equal(draft.otherDrafts.cpu.name,'Other model');assert.equal(s.el('buildTotal').textContent,s.w.DKBuilder.money(catalog.products.find(p=>p.id===id).price));s.dom.window.close();
});
test('custom HTML is inert and resetting clears selected and unfinished custom data',async()=>{
 const s=await setup({draft:cpuDraft()});fillOther(s,{name:'<img src=x onerror=alert(1)>'});s.click('applyOther');assert.equal(s.el('buildItems').querySelector('img'),null);s.click('toSummary');assert.equal(s.el('stepBody').querySelector('img'),null);assert.match(s.el('summaryText').value,/<img/);s.click('restart');const draft=JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1'));assert.deepEqual(draft.others,{});assert.deepEqual(draft.otherDrafts,{});s.dom.window.close();
});
test('automatic recommendation never overwrites a customer-supplied part',async()=>{
 const s=await setup({draft:cpuDraft()});fillOther(s,{mode:'owned'});s.click('applyOther');s.click('previous');s.click('suggestBuild');assert.match(s.el('stepMessage').textContent,/已保留你的配單/);assert.equal(JSON.parse(s.w.localStorage.getItem('dk_builder_draft_v1')).others.cpu.mode,'owned');s.dom.window.close();
});
test('a photo still being processed protects against leaving before it is saved',async()=>{
 const s=await setup({draft:cpuDraft()});s.w.createImageBitmap=()=>new Promise(()=>{});const file=new s.w.File(['jpeg'],'photo.jpg',{type:'image/jpeg'});Object.defineProperty(s.el('otherPhotoInput'),'files',{value:[file]});s.el('otherPhotoInput').dispatchEvent(new s.w.Event('change',{bubbles:true}));await wait();assert.equal(s.el('applyOther').disabled,true);const event=new s.w.Event('beforeunload',{cancelable:true});s.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);s.dom.window.close();
});
