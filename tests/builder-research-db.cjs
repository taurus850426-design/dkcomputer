const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{PGlite}=require('@electric-sql/pglite');
const files=fs.readdirSync('supabase/migrations').filter(x=>/builder_research/.test(x)).sort();
async function setup(){const db=new PGlite();await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');for(const f of files)await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));return db;}
const reserve=(db,key,client='test')=>db.query('select public.builder_reserve_research($1,$2) as r',['game:'+key,client]).then(r=>r.rows[0].r);
test('isolated migrations repeat safely; research cache and quota cannot be read or called by public roles',async()=>{
 const db=await setup();try{for(const f of files)await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));const {rows}=await db.query("select count(*)::int as n from public.builder_research_cache");assert.equal(rows[0].n,9);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select * from public.builder_research_config'),/permission denied/);await assert.rejects(reserve(db,'GTA'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
test('billing must be explicitly confirmed; concurrent reservations cannot overshoot the combined monthly cap',async()=>{
 const db=await setup();try{assert.equal((await reserve(db,'GTA')).reason,'not_enabled');await db.exec('update builder_research_config set enabled=true');assert.equal((await reserve(db,'GTA')).allowed,false);await db.exec('update builder_research_config set billing_confirmed=true,monthly_limit_milli=20000,fixed_cost_milli=0,buffer_milli=0');const results=await Promise.all(Array.from({length:10},(_,i)=>reserve(db,'query'+i,'client'+i)));assert.equal(results.filter(x=>x.allowed).length,2);assert.ok(results.filter(x=>!x.allowed).every(x=>x.reason==='budget_limit'));assert.equal((await db.query('select reserved_milli from builder_research_months')).rows[0].reserved_milli,20000);await assert.rejects(db.exec('update builder_research_config set monthly_limit_milli=2000001'),/check constraint/);
 }finally{await db.close();}
});
test('cache leases deduplicate requests; provider failures remain charged and cannot poison last-good data',async()=>{
 const db=await setup();try{await db.exec('update builder_research_config set enabled=true,billing_confirmed=true');const r=await reserve(db,'newgame');assert.equal(r.allowed,true);assert.equal((await reserve(db,'newgame','other')).reason,'busy');let result=await db.query('select builder_finish_research($1,$2,$3) as ok',[r.id,JSON.stringify({candidates:[{name:'Newgame'}]}),true]);assert.equal(result.rows[0].ok,true);assert.equal((await db.query('select builder_finish_research($1,$2,$3) as ok',[r.id,null,false])).rows[0].ok,false);assert.equal((await db.query("select payload->'candidates'->0->>'name' as name from builder_research_cache where cache_key='game:newgame'")).rows[0].name,'Newgame');const f=await reserve(db,'failedgame');await db.query('select builder_finish_research($1,null,false)',[f.id]);assert.equal((await db.query('select reserved_milli from builder_research_months')).rows[0].reserved_milli,20000);
 const usage=(await db.query('select builder_research_usage() as u')).rows[0].u;assert.equal(usage.fixedReserveTwd,1000);assert.equal(usage.lookupReserveTwd,20);assert.equal(usage.remainingTwd,780);
 }finally{await db.close();}
});
test('daily client limits, global hourly limits and administrative warnings are enforced in SQL',async()=>{
 const db=await setup();try{await db.exec('update builder_research_config set enabled=true,billing_confirmed=true');for(let i=0;i<5;i++)assert.equal((await reserve(db,'sameclient'+i)).allowed,true);assert.equal((await reserve(db,'sixth')).reason,'rate_limited');for(let i=0;i<7;i++)assert.equal((await reserve(db,'other'+i,'other'+i)).allowed,true);assert.equal((await reserve(db,'global','otherone')).reason,'rate_limited');await db.exec('update builder_research_months set reserved_milli=700000');assert.equal((await db.query('select builder_research_usage() as u')).rows[0].u.warning,true);
 }finally{await db.close();}
});
