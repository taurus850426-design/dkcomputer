const {test}=require('node:test'),assert=require('node:assert/strict'),policy=require('../builder-policy.js');
const modules=Promise.all([import('../supabase/functions/builder-research/research.mjs'),import('../supabase/functions/builder-research/steam.mjs')]);
test('only HTTPS official domains can supply evidence; lookalike URLs, credentials and active links are rejected',async()=>{
 const [m]=await modules;for(const u of ['http://store.steampowered.com/app/1/','https://store.steampowered.com.evil.test/app/1','https://user:pass@adobe.com/','javascript:alert(1)','https://127.0.0.1/'])assert.equal(m.safeSource(u),'');assert.equal(m.safeSource('https://helpx.adobe.com/a'),'https://helpx.adobe.com/a');assert.deepEqual(m.snippets({web:{results:[{url:'https://evil.test',title:'official'}]}}),[]);
});
test('hallucinated facts and invented URLs stay unmapped even if the model emits syntactically valid JSON',async()=>{
 const [m]=await modules,source={url:'https://store.steampowered.com/app/1/',text:'Recommended Processor Ryzen 5 3600 Graphics RTX 3060 Memory 16 GB RAM Storage 100 GB',title:'Game'};
 const good={name:'Game',version:'PC',kind:'game',sourceUrl:source.url,cpu:'Ryzen 5 3600',gpu:'RTX 3060',ramGB:16,storageGB:100,evidence:source.text,question:''};assert.ok(m.validateCandidates({candidates:[good]},[source],'game',policy)[0].profile);
 for(const extra of [{cpu:'Ryzen 9 9950X'},{gpu:'RTX 5090'},{evidence:'A fabricated quote'},{ramGB:999}])assert.equal(m.validateCandidates({candidates:[{...good,...extra}]},[source],'game',policy)[0].profile,null);
 assert.deepEqual(m.validateCandidates({candidates:[{...good,sourceUrl:'https://adobe.com/invented'}]},[source],'game',policy),[]);
});
test('paid research has bounded calls, strict extraction output, no retries and no model-selected product IDs',async()=>{
 const [m]=await modules,calls=[],source={url:'https://playvalorant.com/specs/',title:'Game',description:'Recommended Processor Ryzen 5 3600 Graphics RTX 3060 Memory 16 GB RAM Storage 100 GB'};
 const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});if(String(url).includes('brave'))return Response.json({web:{results:[source]}});return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({candidates:[{name:'Game',version:'PC',kind:'game',sourceUrl:source.url,cpu:'Ryzen 5 3600',gpu:'RTX 3060',ramGB:16,storageGB:100,evidence:source.description,question:''}]})}]}]});};
 const out=await m.research('Game','game',{fetchImpl,braveKey:'test',openaiKey:'test',policy});assert.equal(calls.length,3);assert.equal(out.length,1);assert.ok(out[0].profile);const request=JSON.parse(calls[2].options.body);assert.equal(request.store,false);assert.equal(request.max_output_tokens,1800);assert.equal(request.text.format.strict,true);assert.ok(request.input.length<14000);assert.ok(!JSON.stringify(request).includes('productId'));
});
test('Steam versions come from app IDs and typed store facts; minimum and recommended remain distinct',async()=>{
 const [,m]=await modules;assert.equal(m.steamId('https://evil.test/app/3240220/'),'');assert.equal(m.steamId('https://store.steampowered.com/app/3240220/'),'3240220');const data={'1':{success:true,data:{name:'Game Legacy',type:'game',platforms:{windows:true},pc_requirements:{minimum:'<strong>Processor:</strong> Ryzen 5 3600<br><strong>Graphics:</strong> RTX 3060<br><strong>Memory:</strong> 16 GB RAM<br><strong>Storage:</strong> 100 GB available space'}}}};const fact=m.steamRequirements(data,'1');assert.equal(fact.name,'Game Legacy');assert.equal(fact.requirementLevel,'minimum');assert.equal(fact.ramGB,16);assert.equal(fact.storageGB,100);assert.ok(policy.fromRequirements(fact));data['1'].data.type='dlc';assert.equal(m.steamRequirements(data,'1'),null);
});
test('oversized / failed provider output aborts cleanly and Taiwan month boundaries are explicit',async()=>{
 const [m]=await modules;await assert.rejects(m.boundedJson(new Response('x'.repeat(100)),20),/provider_size/);await assert.rejects(m.boundedJson(new Response('',{status:429})),/provider_unavailable/);assert.equal(m.monthKey(new Date('2026-10-31T16:00:00Z')),'2026-11');assert.equal(m.monthKey(new Date('2026-10-31T15:59:59Z')),'2026-10');
});
test('browser and edge share the exact same versioned deterministic policy',()=>{
 const fs=require('node:fs');assert.equal(fs.readFileSync('builder-policy.js','utf8'),fs.readFileSync('supabase/functions/builder-research/policy.js','utf8'));
});
