import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import Stripe from 'stripe';
import {createPlusService,entitled,validateConfig} from '../server/plus-service.mjs';
import {body,authenticated} from '../server/runtime.mjs';
const config={mode:'test',monthly:{price:'price_test_month',linkId:'plink_test_month',url:'https://buy.stripe.com/test_month'},annual:{price:'price_test_year',linkId:'plink_test_year',url:'https://buy.stripe.com/test_year'}};
const db=new PGlite();
for(const name of (await readdir('netlify/database/migrations')).sort())await db.exec(await readFile('netlify/database/migrations/'+name,'utf8'));
const sessions=new Map(),subscriptions=new Map();
const service=createPlusService({config,transaction:fn=>db.transaction(tx=>fn({query:async(sql,args)=>sql==='SELECT pg_advisory_xact_lock(73194621)'?{rows:[]}:tx.query(sql,args)})),stripe:{checkout:{sessions:{retrieve:async id=>structuredClone(sessions.get(id))}},subscriptions:{retrieve:async id=>structuredClone(subscriptions.get(id))}}});
let serial=0;
const event=(type,obj)=>({id:'evt_'+(++serial),created:Math.floor(Date.now()/1000),livemode:false,type,data:{object:obj}});
async function setup(subject,plan='monthly',customer='cus_'+subject,subscription='sub_'+subject){
 const {url}=await service.checkout(subject,plan),ref=new URL(url).searchParams.get('client_reference_id'),id='cs_'+subject+'_'+serial;
 sessions.set(id,{id,livemode:false,mode:'subscription',status:'complete',payment_status:'paid',payment_link:config[plan].linkId,client_reference_id:ref,customer,subscription});
 subscriptions.set(subscription,{id:subscription,livemode:false,customer,status:'active',items:{data:[{quantity:1,current_period_end:Math.floor(Date.now()/1000)+86400,price:{id:config[plan].price}}]},latest_invoice:{status:'paid'}});
 return {id,ref,customer,subscription,e:event('checkout.session.completed',{id})};
}
const activity={name:'Cook together',category:'family',household_id:'forged'};
test('migrations apply and enforce four-category check and provider uniqueness',async()=>{
 const {rows}=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");assert.equal(rows.length,6);
 await assert.rejects(db.query("INSERT INTO custom_activities(household_id,name,category,moderation_policy_version) VALUES('00000000-0000-0000-0000-000000000000','x','admin','v')"));
});
test('guest cannot resolve a household; free user cannot read or write Plus',async()=>{
 await assert.rejects(service.account(null),/authentication_required/);
 for(const method of ['GET','POST','PATCH','DELETE'])await assert.rejects(service.activities('free',method,activity),/plus_required/);
});
for(const plan of ['monthly','annual'])test(plan+' checkout is single-use, price-bound and persists activities',async()=>{
 const f=await setup(plan,plan);await service.webhook(f.e);assert.equal((await service.account(plan)).plus,true);
 const {activity:saved}=await service.activities(plan,'POST',activity);assert.equal((await service.activities(plan,'GET')).activities[0].id,saved.id);
 assert.equal((await service.account('different')).plus,false);
 await assert.rejects(service.activities('different','DELETE',{id:saved.id}),/plus_required/);
 assert.deepEqual(await service.webhook(f.e),{duplicate:true});
 await assert.rejects(service.webhook(event('checkout.session.completed',{id:f.id})),/consumed_reference/);
});
test('cross-household edit/delete denied even when both have Plus; forged household ignored',async()=>{
 const f=await setup('other');await service.webhook(f.e);
 const own=(await service.activities('monthly','GET')).activities[0];
 for(const method of ['PATCH','DELETE'])await assert.rejects(service.activities('other',method,{...activity,id:own.id}),/activity_not_found/);
 const saved=await service.activities('other','POST',activity);assert.equal((await service.activities('other','GET')).activities[0].id,saved.activity.id);
 assert.equal((await service.activities('monthly','GET')).activities.length,1);
});
test('moderation stops contextual spaced evasions without rejecting ordinary words',async()=>{
 for(const name of ['Play f u c k games','Watch p.o.r.n tonight','Use c0caine','Watch p\u200born','Play fuuuuck games'])await assert.rejects(service.activities('monthly','POST',{name,category:'family'}),/blocked_content/);
 for(const name of ['Watch a classic movie','Take a class','Try an assignment'])assert.equal((await service.activities('monthly','POST',{name,category:'family'})).activity.name,name);
});
test('Plus activity edit and deletion are scoped and persisted',async()=>{
 const {activity:a}=await service.activities('annual','POST',activity);
 assert.equal((await service.activities('annual','PATCH',{id:a.id,name:'Read together',category:'selfcare'})).activity.name,'Read together');
 await service.activities('annual','DELETE',{id:a.id});assert.ok(!(await service.activities('annual','GET')).activities.some(x=>x.id===a.id));
});
test('forged reference rolls back processed event reservation',async()=>{
 const f=await setup('forged');sessions.get(f.id).client_reference_id='00000000-0000-0000-0000-000000000000';
 await assert.rejects(service.webhook(f.e),/expired_or_consumed_reference/);
 assert.equal((await db.query('SELECT * FROM stripe_processed_events WHERE event_id=$1',[f.e.id])).rows.length,0);
 assert.equal((await service.account('forged')).plus,false);
});
for(const [field,value,reason] of [['payment_link','plink_wrong','payment_link_mismatch'],['payment_status','unpaid','checkout_unverified'],['customer','cus_wrong','subscription_mismatch']])test('checkout rejects '+field+' mismatch and preserves claim',async()=>{
 const f=await setup(field);sessions.get(f.id)[field]=value;await assert.rejects(service.webhook(f.e),new RegExp(reason));
 assert.equal((await db.query('SELECT consumed_at FROM stripe_checkout_claims WHERE reference=$1',[f.ref])).rows[0].consumed_at,null);
});
test('expired checkout reference rejected',async()=>{
 const f=await setup('expired');await db.query("UPDATE stripe_checkout_claims SET expires_at=now()-interval '1 second' WHERE reference=$1",[f.ref]);await assert.rejects(service.webhook(f.e),/expired/);
});
test('price mismatch and mixed subscription items cannot grant access',async()=>{
 const f=await setup('price');const sub=subscriptions.get(f.subscription);sub.items.data[0].price.id='price_other';await assert.rejects(service.webhook(f.e),/price_mismatch/);
 sub.items.data.push({...sub.items.data[0]});await assert.rejects(service.webhook(f.e),/invalid_subscription_items/);
});
test('customer cannot be reassigned to an unrelated household',async()=>{
 const f=await setup('thief','monthly','cus_monthly','sub_thief');await assert.rejects(service.webhook(f.e),/unique constraint/);assert.equal((await service.account('thief')).plus,false);
});
test('existing household subscription replacement fails closed',async()=>{
 // checkout endpoint blocks existing entitlement; exercise a claim created before purchase.
 const a=await setup('replace'),b=await setup('replace','monthly','cus_new','sub_new');
 await service.webhook(a.e);await assert.rejects(service.webhook(b.e),/reassignment/);
});
test('checkout request throttles outstanding claims',async()=>{
 for(let i=0;i<5;i++)await service.checkout('limited','monthly');await assert.rejects(service.checkout('limited','monthly'),/checkout_limit/);
});
test('payment failure removes access; verified provider recovery restores it',async()=>{
 const f=await setup('recover');await service.webhook(f.e);const sub=subscriptions.get(f.subscription);sub.status='past_due';sub.latest_invoice.status='open';
 await service.webhook(event('invoice.payment_failed',{subscription:f.subscription}));assert.equal((await service.account('recover')).plus,false);
 sub.status='active';sub.latest_invoice.status='paid';await service.webhook(event('invoice.paid',{parent:{subscription_details:{subscription:f.subscription}}}));assert.equal((await service.account('recover')).plus,true);
});
test('cancel at period end preserves paid access only to end; expiration removes access',async()=>{
 const f=await setup('expiry');await service.webhook(f.e);const sub=subscriptions.get(f.subscription);sub.cancel_at_period_end=true;
 await service.webhook(event('customer.subscription.updated',{id:f.subscription}));assert.equal((await service.account('expiry')).plus,true);
 sub.items.data[0].current_period_end=Math.floor(Date.now()/1000)-1;await service.webhook(event('customer.subscription.updated',{id:f.subscription}));assert.equal((await service.account('expiry')).plus,false);
});
test('deleted subscription cannot be resurrected by stale invoice or provider event',async()=>{
 const f=await setup('terminal');await service.webhook(f.e);await service.webhook(event('customer.subscription.deleted',{id:f.subscription}));assert.equal((await service.account('terminal')).plus,false);
 const e=event('invoice.paid',{subscription:f.subscription});e.created-=86400;await service.webhook(e);assert.equal((await service.account('terminal')).plus,false);
});
test('out-of-order updates retrieve current provider state instead of trusting old payload',async()=>{
 const f=await setup('ordered');await service.webhook(f.e);subscriptions.get(f.subscription).status='unpaid';
 const e=event('customer.subscription.updated',{id:f.subscription,status:'active'});e.created-=86400;await service.webhook(e);assert.equal((await service.account('ordered')).plus,false);
});
test('live events, live config and live payment links are forbidden',async()=>{
 await assert.rejects(service.webhook({...event('invoice.paid',{}),livemode:true}),/live_event_forbidden/);
 assert.throws(()=>validateConfig({...config,mode:'live'}),/test_mode_required/);
 assert.throws(()=>validateConfig({...config,monthly:{...config.monthly,price:'price_1TPmH9RrMKZPnWh6iNNzYe3T'}}),/live_price_forbidden/);
 assert.throws(()=>validateConfig({...config,monthly:{...config.monthly,url:'https://buy.stripe.com/live'}}),/test_payment_link_required/);
});
test('Stripe SDK verifies raw signed body, rejects mutation and expired signature',()=>{
 const payload=JSON.stringify(event('invoice.paid',{})),secret='whsec_synthetic',header=Stripe.webhooks.generateTestHeaderString({payload,secret});
 assert.equal(Stripe.webhooks.constructEvent(payload,header,secret).livemode,false);
 assert.throws(()=>Stripe.webhooks.constructEvent(payload+' ',header,secret));
 assert.throws(()=>Stripe.webhooks.constructEvent(payload,Stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:1}),secret));
});
test('HTTP boundary rejects cross-origin writes and oversized or malformed input',async()=>{
 const r=await authenticated(new Request('https://preview.test/api',{method:'POST',headers:{origin:'https://evil.test'}}),()=>{throw Error('unreachable');});assert.equal(r.status,403);
 await assert.rejects(body(new Request('https://preview.test',{method:'POST',body:'x'.repeat(4097)})),/payload_too_large/);
 await assert.rejects(body(new Request('https://preview.test',{method:'POST',body:'{'})),/invalid_json/);
});
test('paid status without verified payment never grants access',()=>{assert.equal(entitled({status:'active',current_period_end:new Date(Date.now()+10000),verified_payment:false}),false);});
test('activity limit is enforced within the write transaction',async()=>{
 const f=await setup('capacity');await service.webhook(f.e);for(let i=0;i<20;i++)await service.activities('capacity','POST',{name:'Read story '+i,category:'family'});
 await assert.rejects(service.activities('capacity','POST',activity),/activity_limit/);assert.equal((await service.activities('capacity','GET')).activities.length,20);
});
test('household cascade deletion removes activities and subscription',async()=>{
 await db.query('DELETE FROM account_profiles WHERE identity_subject=$1',['capacity']);assert.equal((await service.account('capacity')).plus,false);assert.equal((await db.query("SELECT count(*)::int AS n FROM custom_activities a JOIN households h ON h.id=a.household_id WHERE h.owner_subject='capacity'")).rows[0].n,0);
});
test.after(async()=>db.close());
