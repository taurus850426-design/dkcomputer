const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function renderer(){
 const source=fs.readFileSync('admin3.js','utf8'),start=source.indexOf('    function fmtQuoteMoney('),end=source.indexOf('    async function buildQuoteCanvas()',start),draws=[];
 const ctx=new Proxy({measureText:s=>({width:[...String(s)].length*17}),fillText:(text,x,y)=>draws.push({text:String(text),x,y}),createLinearGradient:()=>({addColorStop(){}})},{get:(obj,key)=>key in obj?obj[key]:()=>{}});
 const context={document:{createElement:()=>({getContext:()=>ctx})},draws};vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.draw=drawQuoteCanvas;',context);return {...context,draws};
}
const items=n=>Array.from({length:n},(_,i)=>({category:'處理器',title:'CPU '+i,qty:1,unit_price:i?0:6000}));
test('quotation preserves multiline delivery notes and wraps long notes above footer',()=>{
 const r=renderer(),note='來源配單：DK-BUILD-TEST\n取貨方式：寄送｜空盒：保留｜空盒分箱運費 NT$ 150\n'+'其他交貨需求'.repeat(20);
 const canvas=r.draw({items:items(15),note,originalTotal:6150,cashPrice:6000});
 for(const line of note.split('\n'))assert.ok(r.draws.map(x=>x.text).join('').includes(line));
 assert.ok(r.draws.every(x=>!x.text.includes('\n')));
 const heading=r.draws.find(x=>x.text==='備註'),footer=r.draws.findLast(x=>x.text==='DK Computer');
 const noteRows=r.draws.filter(x=>x.y>heading.y&&x.y<footer.y-16);assert.ok(noteRows.length>3);
 assert.ok(noteRows.every(x=>x.x+[...x.text].length*17<=canvas.width-54));
 assert.ok(r.draws.some(x=>x.text==='NT$ 6,150'));assert.ok(r.draws.some(x=>x.text==='NT$ 6,000'));
});
test('oversized quotation rejects output instead of clipping requirements',()=>{
 const r=renderer();assert.throws(()=>r.draw({items:items(15),note:'長備註\n'.repeat(100)}),/超過一張 A4/);
});
test('empty notes keep quotation footer and optional item prices',()=>{
 const r=renderer();r.draw({items:items(2),note:'',originalTotal:6000,cashPrice:6000});assert.equal(r.draws.some(x=>x.text==='備註'),false);assert.equal(r.draws.filter(x=>x.text==='單價').length,1);assert.equal(r.draws.some(x=>x.text==='NT$ 0'),false);
});
