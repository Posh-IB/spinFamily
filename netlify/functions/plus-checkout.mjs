import security from '../../lib/request-security.cjs';
import { getUser } from '@netlify/identity';
import Stripe from 'stripe';
import policy from '../../lib/billing-policy.cjs';
import {transaction,environment} from '../../server/database.mjs';
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req,context){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 if(!security.sameOriginMutation(req))return respond({error:'invalid_origin'},403);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 const env=environment(context),origin=env.SPINFAMILY_CHECKOUT_ORIGIN;
 if(!policy.validConfig(env)||!/^https:\/\/[^/]+$/.test(origin||'')||new URL(req.url).origin!==origin)
  return respond({error:'billing_not_configured'},503);
 const raw=await req.text();
 if(raw.length>1024)return respond({error:'invalid_request'},400);
 let body;
 try{body=JSON.parse(raw);}catch{return respond({error:'invalid_json'},400);}
 const price=body?.period==='monthly'?env.SPINFAMILY_PLUS_MONTHLY_PRICE_ID:body?.period==='annual'?env.SPINFAMILY_PLUS_ANNUAL_PRICE_ID:null;
 if(!price)return respond({error:'invalid_plan'},400);
 const stripe=new Stripe(env.STRIPE_SECRET_KEY,{timeout:10000,maxNetworkRetries:1});
 try{
  // Persist an attempt BEFORE calling Stripe. After a crash the same idempotency
  // key is reused; a second request cannot create another payable session.
  const attempt=await transaction(async db=>{
   await db.query('INSERT INTO account_profiles(identity_subject) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
   const h=await db.query('INSERT INTO households(owner_subject) VALUES($1) ON CONFLICT(owner_subject) DO UPDATE SET owner_subject=EXCLUDED.owner_subject RETURNING id',[user.id]);
   const id=h.rows[0].id;
   const old=await db.query('SELECT * FROM billing_checkout_attempts WHERE household_id=$1',[id]);
   if(old.rowCount){
    if(new Date(old.rows[0].expires_at)>new Date())return old.rows[0];
    return (await db.query("UPDATE billing_checkout_attempts SET attempt_id=gen_random_uuid(),price_id=$2,provider_session_id=NULL,expires_at=now()+interval '1 hour',created_at=now() WHERE household_id=$1 RETURNING *",[id,price])).rows[0];
   }
   return (await db.query('INSERT INTO billing_checkout_attempts(household_id,price_id) VALUES($1,$2) RETURNING *',[id,price])).rows[0];
  });
  return await transaction(async db=>{
   await db.query('SELECT id FROM households WHERE id=$1 FOR UPDATE',[attempt.household_id]);
   const record=(await db.query('SELECT * FROM subscriptions WHERE household_id=$1 FOR UPDATE',[attempt.household_id])).rows[0];
   // Never replace an established subscription automatically. Portal is the
   // supported management path, including delinquent/canceled subscriptions.
   if(record?.provider_subscription_id)return respond({error:'subscription_exists_use_portal'},409);
   const current=(await db.query('SELECT * FROM billing_checkout_attempts WHERE household_id=$1',[attempt.household_id])).rows[0];
   if(current.price_id!==price)return respond({error:'checkout_already_pending'},409);
   if(new Date(current.expires_at)<=new Date())return respond({error:'checkout_attempt_expired_contact_support'},409);
   let customer=record?.provider_customer_id;
   if(!customer){
    const created=await stripe.customers.create({}, {idempotencyKey:'spinfamily-customer-'+attempt.household_id});
    customer=created.id;
    await db.query('INSERT INTO subscriptions(household_id,provider_customer_id,stripe_livemode) VALUES($1,$2,$3)',[attempt.household_id,customer,env.STRIPE_SECRET_KEY.startsWith('sk_live_')]);
   }
   // Also inspect Stripe: a paid session may have completed while webhook
   // delivery is delayed. Never issue another subscription in that interval.
   const existing=await stripe.subscriptions.list({customer,status:'all',limit:100});
   if(existing.data.some(s=>!['canceled','incomplete_expired'].includes(s.status)))return respond({error:'subscription_exists_use_portal'},409);
   const session=current.provider_session_id?await stripe.checkout.sessions.retrieve(current.provider_session_id):
    await stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price,quantity:1}],
     success_url:origin+'/?billing=return',cancel_url:origin+'/?billing=cancel',
     expires_at:Math.floor(new Date(current.expires_at).getTime()/1000)},
     {idempotencyKey:'spinfamily-checkout-'+current.attempt_id});
   if(session.status!=='open'||session.customer!==customer||session.livemode!==env.STRIPE_SECRET_KEY.startsWith('sk_live_'))return respond({error:'checkout_not_open'},409);
   await db.query(`INSERT INTO billing_checkout_sessions(provider_session_id,household_id,provider_customer_id,provider_price_id,stripe_livemode)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[session.id,attempt.household_id,customer,price,session.livemode]);
   await db.query('UPDATE billing_checkout_attempts SET provider_session_id=$2 WHERE household_id=$1',[attempt.household_id,session.id]);
   return respond({url:session.url},201);
  });
 }catch{return respond({error:'checkout_unavailable'},503);}
}
export const config={path:'/api/billing/checkout',method:'POST'};
