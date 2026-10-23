// Read-only official store snapshots. Run explicitly; never treats changed requirements as benchmarks.
import {createRequire} from 'node:module';import {writeFile,readFile} from 'node:fs/promises';import {fetchSteam} from '../supabase/functions/builder-research/steam.mjs';
const require=createRequire(import.meta.url),policy=require('../builder-policy.js');
const output=new URL('../data/builder-requirements.json',import.meta.url);
let previous=[];try{previous=JSON.parse(await readFile(output,'utf8')).profiles||[];}catch{}
const profiles=[];
for(const p of policy.profiles.filter(p=>p.sourceUrl.includes('store.steampowered.com/app/'))){try{const fact=await fetchSteam(p.sourceUrl);if(!fact)throw Error('missing');profiles.push({...fact,name:p.name,storeName:fact.name});console.log(p.name+': '+fact.requirementLevel);}catch{const old=previous.find(x=>x.name===p.name);if(old)profiles.push(old);console.log(p.name+': unavailable; retained previous facts/policy');}}
await writeFile(output,JSON.stringify({schemaVersion:1,profiles},null,2)+'\n');
