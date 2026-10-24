'use strict';
const {test,mock}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const url=process.env.DATABASE_TEST_URL;
test('PostgreSQL full history: microsecond pages, tenant cursors, concurrent writes, completion days and hard cap',{skip:!url},async()=>{
 const {Pool}=require('pg');const admin=new Pool({connectionString:url});
 const schema='history_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const scopedUrl=new URL(url);scopedUrl.searchParams.set('options','-c search_path='+schema);
 const db=new Pool({connectionString:scopedUrl.href});let user={id:'history_a'};
 mock.module('@netlify/identity',{namedExports:{getUser:async()=>user}});
 mock.module('@netlify/database',{namedExports:{getConnectionString:()=>scopedUrl.href}});
 const get=cursor=>new Request('https://qa.example/api/household/plans'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
 const post=body=>new Request('https://qa.example/api/household/plans',{method:'POST',headers:{origin:'https://qa.example','content-type':'application/json'},body:JSON.stringify(body)});
 try{
  for(const f of fs.readdirSync('netlify/database/migrations').sort())await db.query(fs.readFileSync('netlify/database/migrations/'+f,'utf8'));
  const handler=(await import('../netlify/functions/household-plans.mjs')).default;
  assert.equal((await handler(get())).status,200);
  const h=(await db.query('SELECT id FROM households WHERE owner_subject=$1',[user.id])).rows[0].id;
  await db.query("UPDATE households SET history_timezone='America/Los_Angeles' WHERE id=$1",[h]);
  const plan={schemaVersion:1,activities:[{name:'Read together',category:'family',durationMinutes:40}],anchorCategory:'family'};
  await db.query("INSERT INTO saved_plans(household_id,client_plan_id,plan_data,created_at) SELECT $1,gen_random_uuid(),$2::jsonb,'2026-01-01T00:00:00.123000Z'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,137) i",[h,JSON.stringify(plan)]);
  let page=await (await handler(get())).json();const first=page;const ids=[];
  do{assert.ok(page.records.length<=50);ids.push(...page.records.map(r=>r.id));page=page.nextCursor?await (await handler(get(page.nextCursor))).json():null;}while(page);
  assert.equal(ids.length,137);assert.equal(new Set(ids).size,137,'microsecond records are never skipped or duplicated');assert.equal(first.progress.acceptedPlans,137);
  user={id:'history_b'};const b=await (await handler(get(first.nextCursor))).json();assert.equal(b.records.length,0,'cursor never grants access to another household');user={id:'history_a'};
  const record=first.records[0].id;
  const completed=await Promise.all(Array.from({length:8},()=>handler(post({action:'complete',id:record}))));assert.ok(completed.every(r=>r.status===200));
  const done=await (await handler(get())).json();assert.equal(done.progress.completedPlans,1);const stamp=done.records[0].completedAt;await handler(post({action:'complete',id:record}));assert.equal((await (await handler(get())).json()).records[0].completedAt,stamp);
  const base={id:randomUUID(),timezone:'America/Los_Angeles',anchorCategory:'family',activities:[{name:'Read together',category:'family',durationMinutes:40},{name:'Fold laundry',category:'chore',durationMinutes:40},{name:'Quiet reading',category:'selfcare',durationMinutes:40}]};
  const accepts=await Promise.all(Array.from({length:8},()=>handler(post({action:'accept',plan:base}))));assert.ok(accepts.every(r=>r.status===200));assert.equal((await db.query('SELECT count(*)::int n FROM saved_plans WHERE household_id=$1 AND client_plan_id=$2',[h,base.id])).rows[0].n,1);
  // These UTC timestamps straddle household-local midnight.
  const rows=(await db.query('SELECT client_plan_id FROM saved_plans WHERE household_id=$1 ORDER BY id LIMIT 3',[h])).rows;
  for(const [i,t] of ['2026-02-01T07:30:00Z','2026-02-01T08:30:00Z','2026-02-02T08:30:00Z'].entries())await db.query("UPDATE saved_plans SET completed_at=$3,completion_source='explicit_caregiver' WHERE household_id=$1 AND client_plan_id=$2",[h,rows[i].client_plan_id,t]);
  const progress=(await (await handler(get())).json()).progress;assert.ok(progress.completedDays>=3);assert.ok(progress.longestDailyStreakInSavedHistory>=3,'local midnight yields three consecutive days');
  await db.query("INSERT INTO saved_plans(household_id,client_plan_id,plan_data,created_at) SELECT $1,gen_random_uuid(),$2::jsonb,'2026-01-01'::timestamptz FROM generate_series(1,9999-(SELECT count(*)::int FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL))",[h,JSON.stringify(plan)]);
  const capped=await Promise.all(Array.from({length:4},()=>handler(post({action:'accept',plan:{...base,id:randomUUID()}}))));assert.equal(capped.filter(r=>r.status===200).length,1);assert.equal(capped.filter(r=>r.status===409).length,3);assert.equal((await (await handler(get())).json()).progress.acceptedPlans,10000);
  await handler(post({action:'delete',id:base.id}));assert.equal((await (await handler(get())).json()).progress.acceptedPlans,9999);
  assert.equal((await handler(get('bad-cursor'))).status,422);
 }finally{mock.restoreAll();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
