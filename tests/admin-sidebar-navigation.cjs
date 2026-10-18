const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','admin3.js'),'utf8');
const start=source.indexOf('  function confirmLeaveForTab(toTab) {');
const end=source.indexOf('  function firstPermittedChildInGroup',start);
function setup(answer){
 let closes=0,prompts=0;const editor={hidden:false},tabPurchase={hidden:false};
 const document={getElementById:id=>id==='poEditorView'?editor:id==='poBackToListBtn'?{click:()=>{closes++;editor.hidden=true}}:null};
 const run=new Function('document','confirm','tabPurchase','tabPublish','publishFormCard',source.slice(start,end)+';return confirmLeaveForTab;');
 const guard=run(document,()=>{prompts++;return answer},tabPurchase,null,null);
 return {guard,editor,tabPurchase,closes:()=>closes,prompts:()=>prompts};
}
test('cancel sidebar navigation keeps the unsaved purchase editor open',()=>{
 const s=setup(false);assert.equal(s.guard('inv'),false);assert.equal(s.editor.hidden,false);assert.equal(s.closes(),0);
});
test('confirmed navigation closes editor through the existing close button',()=>{
 const s=setup(true);assert.equal(s.guard('vendors'),true);assert.equal(s.closes(),1);assert.equal(s.editor.hidden,true);
});
test('staying in purchase or switching from another module does not discard purchase draft',()=>{
 const s=setup(true);assert.equal(s.guard('purchase'),true);s.tabPurchase.hidden=true;assert.equal(s.guard('inv'),true);
 assert.equal(s.closes(),0);assert.equal(s.prompts(),0);
});
