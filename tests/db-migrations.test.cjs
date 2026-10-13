'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');
const url=process.env.DATABASE_TEST_URL;
test('two-stage schema migration enforces separate household ownership and webhook deduplication',{skip:!url},async()=>{
 const db=new Client({connectionString:url});
 await db.connect();
 try{
  const dir=path.join(__dirname,'../netlify/database/migrations');
  const files=fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort();
  assert.equal(files.length>=2,true);
  for(const file of files)await db.query(fs.readFileSync(path.join(dir,file),'utf8'));
  for(const table of ['account_profiles','households','subscriptions','custom_activities','stripe_checkout_claims','stripe_processed_events','billing_checkout_sessions','saved_plans']){
   const result=await db.query('SELECT to_regclass($1) AS relation',[table]);
   assert.equal(result.rows[0].relation,table);
  }
  await db.query("INSERT INTO account_profiles(identity_subject) VALUES ('sub_a'),('sub_b')");
  const h=await db.query("INSERT INTO households(owner_subject) VALUES ('sub_a'),('sub_b') RETURNING id,owner_subject");
  assert.equal(h.rows.length,2);
  const a=h.rows.find(x=>x.owner_subject==='sub_a').id;
  const b=h.rows.find(x=>x.owner_subject==='sub_b').id;
  await db.query('INSERT INTO subscriptions(household_id) VALUES($1)',[a]);
  await db.query('INSERT INTO custom_activities(household_id,name,category,moderation_policy_version) VALUES($1,$2,$3,$4)',[a,'Read together','family','v0.1']);
  const isolated=await db.query('SELECT a.name FROM custom_activities a INNER JOIN households h ON a.household_id=h.id WHERE h.owner_subject=$1',['sub_b']);
  assert.equal(isolated.rows.length,0);
  const first=await db.query("INSERT INTO stripe_processed_events(event_id,event_type,event_created_at) VALUES('evt_test','checkout.session.completed',now()) ON CONFLICT DO NOTHING RETURNING event_id");
  const duplicate=await db.query("INSERT INTO stripe_processed_events(event_id,event_type,event_created_at) VALUES('evt_test','checkout.session.completed',now()) ON CONFLICT DO NOTHING RETURNING event_id");
  assert.equal(first.rowCount,1);assert.equal(duplicate.rowCount,0);
  await db.query('INSERT INTO billing_checkout_sessions(provider_session_id,household_id,provider_customer_id,provider_price_id,stripe_livemode) VALUES($1,$2,$3,$4,$5)',['cs_test',a,'cus_a','price_test',false]);
  const owner=await db.query('SELECT household_id FROM billing_checkout_sessions WHERE provider_session_id=$1',['cs_test']);
  assert.equal(owner.rows[0].household_id,a);assert.notEqual(owner.rows[0].household_id,b);
  await assert.rejects(()=>db.query('INSERT INTO custom_activities(household_id,name,category,moderation_policy_version) VALUES($1,$2,$3,$4)',[a,'Activity','bad-category','v0.1']));
 }finally{await db.end();}
});
