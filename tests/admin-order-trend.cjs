const {test}=require('node:test');
const assert=require('node:assert/strict');
const {aggregate}=require('../admin-order-trend.js');
const count=(orders,today='2026-10-18')=>aggregate(orders,today,o=>o.date);
test('rolling twelve months cross year and include empty months',()=>{
 const m=count([]);assert.equal(m.length,12);assert.equal(m[0].month,'2025-11');assert.equal(m[11].month,'2026-10');assert.ok(m.every(x=>x.total===0));
});
test('exclude refunds and orders outside the range, count valid pending orders',()=>{
 const m=count([{date:'2025-10-31'},{date:'2026-11-01'},{date:'2026-10-18',status:'refunded'},{date:'2026-10-18',status:'pending'}]);assert.equal(m.reduce((n,x)=>n+x.total,0),1);
});
test('category aliases match the existing monthly analysis',()=>{
 const orders=['整機','維修','維修／服務','零件升級','',null,'周邊'].map(salesType=>({date:'2026-10-01',salesType}));
 orders.push({date:'2026-10-02',sales_type:'整機'});
 const m=count(orders).at(-1);assert.deepEqual(m,{month:'2026-10',total:8,machine:2,repair:2,upgrade:1,other:3});
});
test('invalid dates are skipped and leap day is accepted in leap years',()=>{
 const m=count([{date:'2024-02-29'},{date:'2024-02-30'},{date:'2024-13-01'},{date:''},{date:'bad'}],'2024-03-01');assert.equal(m.find(x=>x.month==='2024-02').total,1);
});
test('date resolver is used without mutating source orders',()=>{
 const source=[Object.freeze({created:'2026-10-02',salesType:'整機'})];Object.freeze(source);
 const m=aggregate(source,'2026-10-18',o=>o.created);assert.equal(m.at(-1).machine,1);assert.deepEqual(source,[{created:'2026-10-02',salesType:'整機'}]);
});
test('invalid reference month fails explicitly',()=>{assert.throws(()=>count([],'2026-13-01'),/Invalid reference/);});
