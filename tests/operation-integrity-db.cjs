const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('Stage 36 optimistic writes and transaction boundaries (isolated database)', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create table public.purchase_orders(id text primary key,order_no text,status text,created_at timestamptz,
        updated_at timestamptz,supplier_order_date text,expected_date text,note text,items_json jsonb not null default '[]',
        deleted_at timestamptz,data_json jsonb not null default '{}');
      create table public.orders(id text primary key,updated_at timestamptz,status text,total_sale numeric,extra jsonb default '{}');
      create table public.operation_test_effects(kind text,value jsonb);
      create function public.dk_require_backoffice() returns text language plpgsql as $$ begin
        if current_setting('test.role',true) not in ('admin','staff') then raise exception 'not authenticated'; end if;
        return current_setting('test.role',true); end $$;
      set test.role='admin';
      create function public.backoffice_sync_procurement_cost(text,text,numeric,text,text,date) returns jsonb language plpgsql as $$ begin
        insert into public.operation_test_effects values('cost',jsonb_build_object('order',$1,'line',$2,'price',$3));
        if $3=999 then raise exception 'injected cost failure'; end if;
        return '{}'; end $$;
      create function public.backoffice_clear_procurement_cost(text,text) returns jsonb language plpgsql as $$ begin
        insert into public.operation_test_effects values('clear',jsonb_build_object('order',$1,'line',$2)); return '{}'; end $$;
      create function public.backoffice_receive_purchase_item(text,text,text,text,text,text,text,numeric,numeric,text,date,text)
        returns jsonb language plpgsql as $$ begin
          insert into public.operation_test_effects values('receive',jsonb_build_object('qty',$8,'price',$9,'name',$6));
          if $12='fail' then raise exception 'injected receipt failure'; end if;
          return jsonb_build_object('item_id','stock-A','ledger_id','ledger-A','reserved_for_order',$1<>''); end $$;
      create function public.backoffice_set_purchase_receipt_destination(text,text,text,text,text,text)
        returns jsonb language plpgsql as $$ begin
          insert into public.operation_test_effects values('destination',jsonb_build_object('destination',$5)); return '{}'; end $$;
      create function public.backoffice_update_order_v2(text,text,text,text,text,text,numeric,numeric,text,text,jsonb)
        returns jsonb language plpgsql as $$ begin
          update public.orders set total_sale=(select sum((x->>'qty')::numeric*(x->>'unit_price')::numeric) from jsonb_array_elements($11) x),
            status=$10,updated_at=clock_timestamp() where id=$1; return jsonb_build_object('id',$1); end $$;
      create function public.backoffice_set_order_operations(text,text,numeric,date,text,text,date,text)
        returns jsonb language plpgsql as $$ declare due numeric; begin
          select total_sale into due from public.orders where id=$1;
          if $2='paid' and $3<due then raise exception 'paid amount is below order total'; end if;
          if $2='partial' and ($3<=0 or $3>=due) then raise exception 'partial payment amount invalid'; end if;
          update public.orders set extra=extra||jsonb_build_object('payment_status',$2,'received_amount',$3,
            'payment_date',$4,'delivery_status',$6,'delivered_at',$7),updated_at=clock_timestamp() where id=$1;
          insert into public.operation_test_effects values('operations',jsonb_build_object('id',$1)); return '{}'; end $$;
      create function public.backoffice_set_order_quote_note(text,text) returns jsonb language plpgsql as $$ begin
        if $2='fail' then raise exception 'injected note failure'; end if;
        update public.orders set extra=extra||jsonb_build_object('quote_note',$2) where id=$1; return '{}'; end $$;
      create function public.backoffice_set_order_customer_source(text,text) returns jsonb language plpgsql as $$ begin
        update public.orders set extra=extra||jsonb_build_object('customer_source',$2) where id=$1; return '{}'; end $$;
      create function public.backoffice_create_order_v2(text,text,text,text,text,numeric,numeric,text,text,jsonb)
        returns jsonb language plpgsql as $$ declare new_id text := 'new-'||$1; begin
          insert into public.orders values(new_id,clock_timestamp(),$9,
            (select sum((x->>'qty')::numeric*(x->>'unit_price')::numeric) from jsonb_array_elements($10) x),'{}');
          return jsonb_build_object('id',new_id); end $$;
      grant select,insert,update,delete on public.purchase_orders to authenticated,anon;
    `);
    await db.exec(read('supabase-stage36-operation-integrity.sql'));
    await db.exec(read('supabase-stage36-operation-integrity-enforce.sql'));
    const item = (id='item-A',price=100) => ({ id, requestText:'BLACK PC',category:'CPU',quantity:1,
      selectedVendor:'原廠商',selectedUnitPrice:price,selectedSpec:'BLACK PC',selectedQuoteId:'quote-A',quotedAt:'2026-10-16',
      sourceSalesOrderId:'sales-A',sourceSalesOrderLineKey:'line-A',procurementStatus:'pending',itemNote:'原備註' });
    const row = (id='po-A',items=[item()]) => ({id,order_no:'PO-'+id,status:'ordered',created_at:'2026-10-16T00:00:00Z',
      updated_at:'2026-10-16T00:00:00Z',supplier_order_date:'',expected_date:'',note:'原客戶備註',items_json:items,data_json:{}});
    const write = async (r,version=null,action={type:'save'}) => (await db.query(
      'select public.backoffice_purchase_operation($1::jsonb,$2,$3::jsonb) as result',
      [JSON.stringify(r),version,JSON.stringify(action)])).rows[0].result;
    const get = async id => (await db.query('select to_jsonb(p) as row from public.purchase_orders p where id=$1',[id])).rows[0]?.row;
    const count = async kind => Number((await db.query('select count(*) n from public.operation_test_effects where kind=$1',[kind])).rows[0].n);
    let saved;
    await t.test('installation is rerunnable and creates no business rows', async () => {
      await db.exec(read('supabase-stage36-operation-integrity.sql'));
      assert.equal((await db.query('select * from public.purchase_orders')).rows.length,0);
    });
    await t.test('new document preserves quantities, notes and original quote while syncing cost', async () => {
      saved=(await write(row())).purchase_order;
      assert.equal(saved.note,'原客戶備註'); assert.equal(saved.items_json[0].quantity,1);
      assert.equal(saved.items_json[0].selectedVendor,'原廠商'); assert.equal(await count('cost'),1);
      assert.ok(saved.items_json[0].costSyncedAt);
    });
    await t.test('two editors: second stale save rejected without overwriting first cost or price', async () => {
      const version=saved.updated_at;
      const a=structuredClone(saved); a.items_json[0].selectedUnitPrice=200;
      const b=structuredClone(saved); b.items_json[0].selectedUnitPrice=300;
      saved=(await write(a,version)).purchase_order;
      await assert.rejects(write(b,version),/其他裝置/);
      assert.equal((await get('po-A')).items_json[0].selectedUnitPrice,200);
      assert.equal(await count('cost'),2);
    });
    await t.test('cost failure rolls back BOTH cost effect and PO contents', async () => {
      const bad=structuredClone(saved);bad.items_json[0].selectedUnitPrice=999;
      await assert.rejects(write(bad,saved.updated_at),/injected cost failure/);
      assert.deepEqual(await get('po-A'),saved); assert.equal(await count('cost'),2);
    });
    await t.test('ordinary save cannot forge receipt state or whole-document received status',async()=>{
      const bad=structuredClone(saved);bad.items_json[0].procurementStatus='received';
      await assert.rejects(write(bad,saved.updated_at),/登記到貨/);
      const status=structuredClone(saved);status.status='received';
      await assert.rejects(write(status,saved.updated_at),/未到貨/);
      assert.deepEqual(await get('po-A'),saved);
    });
    await t.test('receipt uses authoritative server quantity and cost, then updates PO atomically', async () => {
      const forged=structuredClone(saved);forged.items_json[0].quantity=50;forged.items_json[0].selectedUnitPrice=1;
      const result=await write(forged,saved.updated_at,{type:'receive',purchase_item_id:'item-A',destination:'customer',received_at:'2026-10-16'});
      saved=result.purchase_order;
      assert.equal(saved.status,'received');assert.equal(saved.items_json[0].quantity,1);
      assert.equal(saved.items_json[0].selectedUnitPrice,200);
      assert.equal(saved.items_json[0].receiptLedgerId,'ledger-A');
      const effect=(await db.query("select value from public.operation_test_effects where kind='receive'")).rows[0].value;
      assert.equal(effect.qty,1);assert.equal(effect.price,200);
    });
    await t.test('duplicate receipt / stale retry never adds inventory twice', async () => {
      await assert.rejects(write(saved,saved.updated_at,{type:'receive',purchase_item_id:'item-A',destination:'customer',received_at:'2026-10-16'}),/已到貨/);
      assert.equal(await count('receive'),1);
    });
    await t.test('received quote/quantity/removal protected; destination changes no receipt quantity',async()=>{
      const bad=structuredClone(saved);bad.items_json[0].selectedUnitPrice=400;
      await assert.rejects(write(bad,saved.updated_at),/已到貨品項/);
      const removed=structuredClone(saved);removed.items_json=[];
      await assert.rejects(write(removed,saved.updated_at),/已到貨品項/);
      saved=(await write(saved,saved.updated_at,{type:'destination',purchase_item_id:'item-A',destination:'inventory',note:'用途更正'})).purchase_order;
      assert.equal(saved.items_json[0].receiptDestination,'inventory'); assert.equal(await count('receive'),1);
      assert.equal(await count('destination'),1);
    });
    await t.test('receipt failure rolls back inventory and leaves PO pending',async()=>{
      const pending=(await write(row('po-fail'))).purchase_order;
      await assert.rejects(write(pending,pending.updated_at,{type:'receive',purchase_item_id:'item-A',destination:'inventory',received_at:'2026-10-16',note:'fail'}),/receipt failure/);
      assert.deepEqual(await get('po-fail'),pending); assert.equal(await count('receive'),1);
    });
    await t.test('deleting pending item clears linked cost in same transaction',async()=>{
      const r=(await write(row('po-remove'))).purchase_order;r.items_json=[];
      const next=(await write(r,r.updated_at)).purchase_order;
      assert.equal(next.items_json.length,0); assert.equal(await count('clear'),1);
    });
    await t.test('unknown baseline cannot overwrite old row; explicit legacy NULL version works',async()=>{
      const legacy=row('legacy');legacy.updated_at=null;
      await db.query('insert into public.purchase_orders select (jsonb_populate_record(null::public.purchase_orders,$1::jsonb)).*',[JSON.stringify(legacy)]);
      await assert.rejects(write(legacy),/其他裝置/);
      assert.ok((await write(legacy,'legacy:null')).purchase_order.updated_at);
    });
    await t.test('legacy received snapshots and NULL creation dates survive metadata-only edits exactly',async()=>{
      const old=row('legacy-received',[item()]);old.status='received';old.updated_at=null;old.created_at=null;
      // Older rows may have no per-item receipt/default fields; retain them without inventing receipts.
      delete old.items_json[0].procurementStatus;
      await db.query('insert into public.purchase_orders select (jsonb_populate_record(null::public.purchase_orders,$1::jsonb)).*',[JSON.stringify(old)]);
      const normalized=structuredClone(old);normalized.created_at='2026-10-17T00:00:00Z';normalized.note='新的整單備註';
      Object.assign(normalized.items_json[0],{procurementStatus:'pending',costSyncedAt:'',receiptNote:'',receiptLedgerId:'',receiptDestination:'',quoteStatus:'quoted',manualVendor:'',manualUnitPrice:null});
      const result=(await write(normalized,'legacy:null')).purchase_order;
      assert.equal(result.created_at,null);assert.equal(result.note,'新的整單備註');assert.deepEqual(result.items_json,old.items_json);
      const changed=structuredClone(result);changed.items_json[0].quantity=2;
      await assert.rejects(write(changed,result.updated_at),/已到貨品項/);
      const extra=structuredClone(result);extra.items_json.push(item('extra'));
      await assert.rejects(write(extra,result.updated_at),/已到貨整單/);
    });
    await t.test('tombstone prevents delayed save from resurrecting removed document',async()=>{
      const r=(await write(row('deleted'))).purchase_order;r.deleted_at='2026-10-16T01:00:00Z';
      const tomb=(await write(r,r.updated_at)).purchase_order;
      await assert.rejects(write({...tomb,deleted_at:null},tomb.updated_at),/已刪除/);
    });
    await t.test('staff writes rejected; direct table and legacy RPC writes disabled',async()=>{
      await db.exec("set role authenticated; set test.role='staff'");
      await assert.rejects(write(row('staff')),/admin only/);
      await assert.rejects(db.exec("update public.purchase_orders set note='bad'"),/permission denied/);
      await assert.rejects(db.exec("select public.backoffice_sync_procurement_cost('a','b',100,'v','q',null)"),/permission denied/);
      await db.exec("reset role; set test.role='admin'");
    });
    const orderPayload={id:'sales-A',order_no:'ORD-A',status:'confirmed',items:[{qty:1,unit_price:100}],payment_status:'unpaid',received_amount:0,delivery_status:'pending',quote_note:'原備註'};
    const update=async(p,v)=>(await db.query('select public.backoffice_update_order_checked($1,$2::jsonb) result',[v,JSON.stringify(p)])).rows[0].result;
    const order=async()=> (await db.query("select to_jsonb(o) as row from public.orders o where id='sales-A'")).rows[0].row;
    await db.exec("insert into public.orders values('sales-A','2026-10-16T00:00:00Z','confirmed',100,'{}')");
    await t.test('order stale edit rejected, including note/payment/delivery side effects',async()=>{
      const before=await order();await update(orderPayload,before.updated_at);const after=await order();
      await assert.rejects(update({...orderPayload,quote_note:'stale'},before.updated_at),/其他裝置/);
      assert.deepEqual(await order(),after);
    });
    await t.test('order note failure rolls back main edit, payment and delivery together',async()=>{
      const before=await order();await assert.rejects(update({...orderPayload,quote_note:'fail'},before.updated_at),/note failure/);
      assert.deepEqual(await order(),before);
    });
    await t.test('paid amount is validated against the NEW total; failure rolls everything back',async()=>{
      const before=await order();
      await assert.rejects(update({...orderPayload,items:[{qty:1,unit_price:200}],payment_status:'paid',received_amount:100},before.updated_at),/below order total/);
      assert.deepEqual(await order(),before);
      await update({...orderPayload,items:[{qty:1,unit_price:50}],payment_status:'paid',received_amount:50},before.updated_at);
      assert.equal(Number((await order()).total_sale),50);
    });
    await t.test('quick payment/delivery refuses an outdated order version',async()=>{
      const before=await order();
      const q=(p,v)=>db.query('select public.backoffice_set_order_operations_checked($1,$2::jsonb)',[v,JSON.stringify(p)]);
      await q({...orderPayload,payment_status:'paid',received_amount:50},before.updated_at);
      const after=await order();
      await assert.rejects(q({...orderPayload,delivery_status:'delivered'},before.updated_at),/其他裝置/);
      assert.deepEqual(await order(),after);
    });
    await t.test('new-order details failure rolls back creation; retry cannot create duplicate order',async()=>{
      const create=p=>db.query('select public.backoffice_create_order_checked($1::jsonb) result',[JSON.stringify(p)]);
      await assert.rejects(create({...orderPayload,order_no:'NEW',quote_note:'fail'}),/note failure/);
      assert.equal((await db.query("select * from public.orders where id='new-NEW'")).rows.length,0);
      await create({...orderPayload,order_no:'NEW'});
      await assert.rejects(create({...orderPayload,order_no:'NEW'}),/duplicate key/);
      assert.equal((await db.query("select * from public.orders where id='new-NEW'")).rows.length,1);
    });
    await t.test('completed pre-delivery check and new payment persist atomically',async()=>{
      const before=await order();
      await update({...orderPayload,status:'completed',delivery_status:'delivered',delivered_at:'2026-10-16',payment_status:'paid',received_amount:100},before.updated_at);
      assert.equal((await order()).status,'completed');
    });
  } finally { await db.close(); }
});
