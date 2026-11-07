const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),{PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
module.exports=async()=>{
 const db=new PGlite({extensions:{pgcrypto}}),s=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'../fixtures/production-schema-20261107.json.gz'))));
 try{
 await db.exec(`create extension if not exists pgcrypto;set check_function_bodies=off;create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
 for(const k of ['tables','constraints','functions','views','indexes','triggers','rls','policies','grants'])for(const q of (k==='constraints'?s[k].slice().sort((a,b)=>Number(a.includes('FOREIGN KEY'))-Number(b.includes('FOREIGN KEY'))):s[k])||[])await db.exec(q);
 await db.exec('revoke execute on all functions in schema public from public,anon,authenticated');for(const q of s.function_grants)await db.exec(q);
 for(const file of ['20261107013244_scan_order_workflow.sql','20261107022129_scan_lifecycle_integrity.sql','20261106233806_shop_core_order_bridge.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations',file),'utf8'));
 return db;
 }catch(e){await db.close();throw e;}
};
