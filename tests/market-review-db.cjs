// Run with @electric-sql/pglite 0.5.8 installed, or PGLITE_PATH pointing to its package.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const uid = '00000000-0000-0000-0000-000000000001';

test('market review database integration', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table public.profiles(id uuid primary key);
      insert into public.profiles values('${uid}');
      create function auth.uid() returns uuid language sql as $$select '${uid}'::uuid$$;
      create function public.is_admin() returns boolean language sql as $$select current_setting('test.is_admin',true)='yes'$$;
      set test.is_admin='yes';`);
    const foundation = read('supabase-used-valuation-stage02-foundation.sql');
    for (const name of ['used_market_batches','used_market_prices','used_valuation_audit_logs']) {
      const start = foundation.indexOf('CREATE TABLE public.' + name + ' (');
      await db.exec(foundation.slice(start, foundation.indexOf('\n);', start) + 3));
    }
    const funcs = read('supabase-used-valuation-stage03-market-admin.sql');
    for (const name of ['dk_used_market_require_admin','dk_used_market_norm_text','dk_used_market_batch_snapshot','dk_used_market_price_snapshot','dk_used_market_write_audit','backoffice_used_market_create_batch','backoffice_used_market_create_price']) {
      const start = funcs.indexOf('CREATE FUNCTION public.' + name + '(');
      await db.exec(funcs.slice(start, funcs.indexOf('$$;', start) + 3));
    }
    await db.exec(read('supabase-stage33-auto-market.sql'));
    await db.exec(read('supabase-stage34-market-quality.sql'));
    await db.exec(read('supabase-stage35-market-review.sql'));
    await t.test('migration is rerunnable', async () => db.exec(read('supabase-stage35-market-review.sql')));
    const watch = (await db.query("select id from public.used_market_watchlist where model='i5-10400F'")).rows[0].id;
    const batch = (await db.query("select public.backoffice_used_market_create_batch('{\"batch_code\":\"TEST\"}') as result")).rows[0].result.id;
    const insert = async (suffix, opts = {}) => (await db.query(`insert into public.used_market_observations
      (watchlist_id,provider,source_name,title,price,item_url,accepted,raw_data,collected_at)
      values($1,'TEST',$2,'二手 i5-10400F',$3,$4,$5,$6,now()+($7::int * interval '1 second')) returning id`,
      [watch,opts.source || '台灣賣家',1000,'https://shop.test/' + suffix,opts.accepted ?? true,JSON.stringify({ rules_version: opts.version ?? 2 }),opts.offset ?? 0])).rows[0].id;
    const review = (id, region='TW', price=1000, approved=true) => db.query('select public.backoffice_used_market_review($1,$2,$3,$4,$5)',[id,region,approved,price,'核對台灣二手單品與含運價格']);
    const summary = async () => (await db.query('select * from public.used_market_review_summary where watchlist_id=$1',[watch])).rows[0];
    const transfer = () => db.query('select public.backoffice_used_market_import_reviewed($1,$2)',[watch,batch]);
    const a = await insert('a');
    const b = await insert('b');
    const c = await insert('c');
    const overseas = await insert('overseas',{source:'eBay'});
    const legacy = await insert('legacy',{version:1});
    const rejected = await insert('rejected',{accepted:false});
    await t.test('unreviewed, overseas, legacy and rejected rows do not create prices', async () => {
      assert.equal((await summary()).market_mid,null);
      assert.equal(Number((await summary()).overseas_count),1);
      await review(overseas,'OVERSEAS',9000);
      await assert.rejects(review(legacy), /已過期/);
      await assert.rejects(review(rejected), /只能確認/);
      assert.equal(Number((await summary()).accepted_count),0);
    });
    await t.test('non-admin cannot read review rows or invoke writes; direct writes denied', async () => {
      await db.exec("set role authenticated; set test.is_admin='no'");
      assert.equal((await db.query('select * from public.used_market_reviews')).rows.length,0);
      await assert.rejects(review(a),/admin only/);
      await assert.rejects(transfer(),/admin only/);
      await assert.rejects(db.exec('delete from public.used_market_reviews'),/permission denied/);
      await db.exec("reset role; set test.is_admin='yes'");
    });
    await t.test('review validation and sample threshold are enforced server-side', async () => {
      await assert.rejects(review(a,'UNKNOWN'),/只能確認/);
      await assert.rejects(review(a,'TW',-1),/只能確認/);
      await review(a,'TW',1000); await review(b,'TW',2000);
      assert.equal((await summary()).market_mid,null);
      await assert.rejects(transfer(),/樣本不足/);
      await review(c,'TW',3000);
      assert.equal(Number((await summary()).accepted_count),3);
      assert.equal(Number((await summary()).market_mid),2000);
    });
    await t.test('import creates one draft row with traceable evidence, never activates', async () => {
      await transfer();
      const price = (await db.query('select * from public.used_market_prices')).rows[0];
      assert.equal(Number(price.market_mid),2000);
      assert.equal(price.sample_count,3);
      assert.equal((await db.query('select status from public.used_market_batches')).rows[0].status,'DRAFT');
      assert.equal((await db.query('select snapshot from public.used_market_candidate_imports')).rows[0].snapshot.length,3);
      await assert.rejects(transfer(),/已匯入/);
      assert.equal((await db.query('select * from public.used_market_prices')).rows.length,1);
    });
    await t.test('active batch cannot receive an import', async () => {
      await db.query("update public.used_market_batches set status='ACTIVE' where id=$1",[batch]);
      await assert.rejects(transfer(),/只能匯入草稿/);
    });
    await t.test('new collection invalidates old confirmation; rejecting removes eligibility', async () => {
      const newer = await insert('a',{offset:10});
      assert.equal(Number((await summary()).accepted_count),2);
      await assert.rejects(review(a),/較新抓取/);
      await review(newer);
      assert.equal(Number((await summary()).accepted_count),3);
      await review(newer,'TW',null,false);
      assert.equal((await summary()).market_mid,null);
    });
    await t.test('deleting draft price preserves import audit snapshot', async () => {
      await db.exec('delete from public.used_market_prices');
      const record = (await db.query('select * from public.used_market_candidate_imports')).rows[0];
      assert.equal(record.price_id,null);
      assert.equal(record.snapshot.length,3);
    });
  } finally { await db.close(); }
});
