import { randomUUID } from 'node:crypto';
import moderation from '../lib/activity-moderation.cjs';
export class BoundaryError extends Error { constructor(code,status=403){super(code);this.status=status;} }
const deny=(code,status)=>{throw new BoundaryError(code,status);};
export const entitled=(s,now=Date.now())=>!!s && ['active','trialing'].includes(s.status) && new Date(s.current_period_end).getTime()>now && s.verified_payment === true;
export function validateConfig(config){
 if(config.mode!=='test')deny('test_mode_required',503);
 for(const plan of ['monthly','annual']){
  const p=config[plan];
  if(!p?.price?.startsWith('price_')||!p?.linkId?.startsWith('plink_'))deny('sandbox_configuration_required',503);
  if(['price_1TPmH9RrMKZPnWh6iNNzYe3T','price_1TPmOWRrMKZPnWh6fANoj8uT'].includes(p.price))deny('live_price_forbidden',503);
  const u=new URL(p.url);if(u.origin!=='https://buy.stripe.com'||!u.pathname.startsWith('/test_'))deny('test_payment_link_required',503);
 }
 return config;
}
export function createPlusService({transaction,stripe,config}){
 validateConfig(config);
 const rows=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows;
 const household=async(tx,subject)=>{
  if(typeof subject!=='string'||!subject||subject.length>256)deny('authentication_required',401);
  await rows(tx,'INSERT INTO account_profiles(identity_subject) VALUES($1) ON CONFLICT DO NOTHING',[subject]);
  await rows(tx,'INSERT INTO households(owner_subject) VALUES($1) ON CONFLICT DO NOTHING',[subject]);
  return (await rows(tx,'SELECT id FROM households WHERE owner_subject=$1 FOR UPDATE',[subject]))[0];
 };
 const membership=async(tx,subject)=>{
  const h=await household(tx,subject);
  const s=(await rows(tx,'SELECT * FROM subscriptions WHERE household_id=$1 FOR UPDATE',[h.id]))[0];
  return {h,s};
 };
 return {
  account(subject){return transaction(async tx=>{const {s}=await membership(tx,subject);return {plus:entitled(s),status:s?.status||'inactive'};});},
  checkout(subject,plan){return transaction(async tx=>{
   if(!Object.hasOwn(config,plan)||!['monthly','annual'].includes(plan))deny('invalid_plan',400);
   const {h,s}=await membership(tx,subject);if(entitled(s))deny('already_subscribed',409);
   const pending=await rows(tx,"SELECT count(*)::int AS count FROM stripe_checkout_claims WHERE household_id=$1 AND consumed_at IS NULL AND expires_at>now()",[h.id]);
   if(pending[0].count>=5)deny('checkout_limit',429);
   const ref=randomUUID(),p=config[plan];
   await rows(tx,'INSERT INTO stripe_checkout_claims(reference,household_id,plan,price_id,payment_link_id) VALUES($1,$2,$3,$4,$5)',[ref,h.id,plan,p.price,p.linkId]);
   const url=new URL(p.url);url.searchParams.set('client_reference_id',ref);return {url:url.href};
  });},
  activities(subject,method,input={}){return transaction(async tx=>{
   const {h,s}=await membership(tx,subject);if(!entitled(s))deny('plus_required');
   if(method==='GET')return {activities:await rows(tx,'SELECT id,name,category,duration_minutes,created_at FROM custom_activities WHERE household_id=$1 ORDER BY created_at,id LIMIT 100',[h.id])};
   if(!['POST','PATCH','DELETE'].includes(method))deny('method_not_allowed',405);
   if(method!=='POST'&&!/^[a-f0-9-]{36}$/i.test(input.id||''))deny('invalid_activity_id',400);
   if(method==='DELETE'){
    const saved=await rows(tx,'DELETE FROM custom_activities WHERE id=$1 AND household_id=$2 RETURNING id',[input.id,h.id]);if(!saved.length)deny('activity_not_found',404);return {deleted:input.id};
   }
   const result=moderation.moderateActivity(input);if(!result.ok)deny(result.reason,422);
   if(method==='POST'){
    const count=await rows(tx,'SELECT count(*)::int AS count FROM custom_activities WHERE household_id=$1',[h.id]);if(count[0].count>=20)deny('activity_limit',409);
   }
   const args=[result.value.name,result.value.category,result.policyVersion,h.id];
   const saved=method==='POST'?await rows(tx,'INSERT INTO custom_activities(name,category,moderation_policy_version,household_id) VALUES($1,$2,$3,$4) RETURNING id,name,category,duration_minutes',args):await rows(tx,'UPDATE custom_activities SET name=$1,category=$2,moderation_policy_version=$3 WHERE household_id=$4 AND id=$5 RETURNING id,name,category,duration_minutes',[...args,input.id]);
   if(!saved.length)deny('activity_not_found',404);return {activity:saved[0]};
  });},
  webhook(event){return transaction(async tx=>{
   if(event.livemode!==false)deny('live_event_forbidden',400);
   if(!/^evt_/.test(event.id||'')||!Number.isSafeInteger(event.created))deny('invalid_event',400);
   // Serialize provider reconciliation before fetching current state. All operations
   // reserve the event and write linkage/state/claim atomically, with rollback on failure.
   await rows(tx,'SELECT pg_advisory_xact_lock(73194621)');
   const seen=await rows(tx,'INSERT INTO stripe_processed_events(event_id,event_type,event_created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[event.id,event.type,new Date(event.created*1000)]);
   if(!seen.length)return {duplicate:true};
   const supported=['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'];
   if(!supported.includes(event.type))return {ignored:true};
   let object=event.data?.object,claim=null,linked,subId,customer;
   if(event.type.startsWith('checkout.session.')){
    object=await stripe.checkout.sessions.retrieve(object.id);
    if(object.livemode!==false||object.mode!=='subscription'||object.status!=='complete'||!['paid','no_payment_required'].includes(object.payment_status))deny('checkout_unverified',400);
    if(!/^[a-f0-9-]{36}$/i.test(object.client_reference_id||''))deny('invalid_reference',400);
    claim=(await rows(tx,'SELECT * FROM stripe_checkout_claims WHERE reference=$1 FOR UPDATE',[object.client_reference_id]))[0];
    if(!claim||claim.consumed_at||new Date(claim.expires_at).getTime()<=Date.now())deny('expired_or_consumed_reference',400);
    if(object.payment_link!==claim.payment_link_id)deny('payment_link_mismatch',400);
    subId=object.subscription;customer=object.customer;
    await rows(tx,'SELECT id FROM households WHERE id=$1 FOR UPDATE',[claim.household_id]);
    linked=(await rows(tx,'SELECT * FROM subscriptions WHERE household_id=$1 FOR UPDATE',[claim.household_id]))[0];
    if(linked?.provider_customer_id&&linked.provider_customer_id!==customer)deny('customer_reassignment',409);
    if(linked?.provider_subscription_id&&linked.provider_subscription_id!==subId)deny('subscription_replacement_requires_review',409);
   }else{
    subId=event.type.startsWith('invoice.')?(object.parent?.subscription_details?.subscription||object.subscription):object.id;
    linked=(await rows(tx,'SELECT * FROM subscriptions WHERE provider_subscription_id=$1 FOR UPDATE',[subId]))[0];
    if(!linked)return {ignored:true};customer=linked.provider_customer_id;
   }
   if(typeof subId!=='string'||typeof customer!=='string')deny('invalid_provider_identity',400);
   const sub=await stripe.subscriptions.retrieve(subId,{expand:['latest_invoice']});
   if(sub.livemode!==false||sub.id!==subId||sub.customer!==customer)deny('subscription_mismatch',400);
   const items=sub.items?.data;if(items?.length!==1||items[0].quantity!==1)deny('invalid_subscription_items',400);
   const price=items[0].price.id;if(![config.monthly.price,config.annual.price].includes(price)||claim&&price!==claim.price_id)deny('price_mismatch',400);
   const end=items[0].current_period_end??sub.current_period_end;
   if(!Number.isSafeInteger(end))deny('invalid_period',400);
   // A terminal deletion never resurrects. Other events reconcile current provider
   // state rather than trusting invoice payload or event delivery order.
   const terminal=linked?.terminal||event.type==='customer.subscription.deleted'||sub.status==='canceled';
   const status=terminal?'canceled':sub.status;
   const paid=sub.status==='trialing'||sub.latest_invoice?.status==='paid';
   const hid=claim?.household_id||linked.household_id;
   await rows(tx,`INSERT INTO subscriptions(household_id,provider_customer_id,provider_subscription_id,status,current_period_end,last_provider_event_at,price_id,verified_payment,terminal)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(household_id) DO UPDATE SET status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,last_provider_event_at=EXCLUDED.last_provider_event_at,price_id=EXCLUDED.price_id,verified_payment=EXCLUDED.verified_payment,terminal=EXCLUDED.terminal,updated_at=now()`,[hid,customer,subId,status,new Date(end*1000),new Date(event.created*1000),price,paid,terminal]);
   if(claim)await rows(tx,'UPDATE stripe_checkout_claims SET consumed_at=now() WHERE reference=$1',[claim.reference]);
   return {processed:true};
  });}
 };
}
