import Stripe from 'stripe';
import { transaction,environment } from '../../server/database.mjs';
import policy from '../../lib/billing-policy.cjs';
const {validConfig,snapshot}=policy;
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const handled=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);
export default async function handler(req,context){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 const env=environment(context);
 if(!validConfig(env))return respond({error:'billing_not_configured'},503);
 const signature=req.headers.get('stripe-signature');
 if(!signature)return respond({error:'invalid_signature'},400);
 const raw=await req.text();
 if(raw.length>1048576)return respond({error:'payload_too_large'},413);
 const stripe=new Stripe(env.STRIPE_SECRET_KEY);
 let event;
 try{event=stripe.webhooks.constructEvent(raw,signature,env.STRIPE_WEBHOOK_SECRET);}catch{return respond({error:'invalid_signature'},400);}
 if(!handled.has(event.type))return respond({received:true});
 const live=policy.stripeLivemode(env.STRIPE_SECRET_KEY);
 if(event.livemode!==live)return respond({error:'environment_mismatch'},400);
 let outcome='ignored_irrelevant';
 try{
  const duplicate=await transaction(async client=>{
   // Serialize before provider retrieval. A later event cannot commit stale state
   // fetched before another transaction acquired its lock.
   await client.query('SELECT pg_advisory_xact_lock(73194621)');
   if((await client.query('SELECT 1 FROM stripe_processed_events WHERE event_id=$1',[event.id])).rowCount)return true;
   const object=event.data?.object;
   let subscription=null,session=null;
   if(event.type.startsWith('checkout.session.')){
    session=await stripe.checkout.sessions.retrieve(object.id);
    if(session.mode!=='subscription'||session.status!=='complete'||session.payment_status!=='paid'||!session.subscription)return false;
    subscription=await stripe.subscriptions.retrieve(session.subscription,{expand:['latest_invoice']});
   }else{
    const id=event.type.startsWith('invoice.')?(object.subscription||object.parent?.subscription_details?.subscription):object?.id;
    if(!id)return false;
    subscription=await stripe.subscriptions.retrieve(id,{expand:['latest_invoice']});
   }
   const state=snapshot(subscription,env);
   const inserted=await client.query(`INSERT INTO stripe_processed_events
      (event_id,event_type,event_created_at,outcome)
      VALUES($1,$2,to_timestamp($3),$4)
      ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [event.id,event.type,event.created,'ignored_irrelevant']);
   if(!inserted.rowCount){
    return true;
   }
   if(!state&&subscription?.id){
    await client.query("UPDATE subscriptions SET status='inactive',verified_payment=false,updated_at=now() WHERE provider_subscription_id=$1",[subscription.id]);
   }
   if(state){
    let row;
    if(session){
     const link=await client.query(`SELECT household_id,provider_customer_id,provider_price_id,stripe_livemode,consumed_at
       FROM billing_checkout_sessions WHERE provider_session_id=$1 FOR UPDATE`,[session.id]);
     if(link.rowCount&&link.rows[0].provider_customer_id===state.customerId&&
       link.rows[0].provider_price_id===state.priceId&&link.rows[0].stripe_livemode===live&&
       session.customer===state.customerId&&session.livemode===live){
      row=await client.query(`SELECT household_id,provider_customer_id,provider_subscription_id,status,terminal
        FROM subscriptions WHERE household_id=$1 FOR UPDATE`,[link.rows[0].household_id]);
      if(row.rowCount){
       const old=row.rows[0];
       if(old.provider_customer_id!==state.customerId||
         (old.provider_subscription_id&&old.provider_subscription_id!==state.subscriptionId))outcome='ignored_conflict';
       else outcome='applied';
      }else outcome='ignored_unlinked';
     }else outcome='ignored_unlinked';
    }else{
     row=await client.query(`SELECT household_id,provider_customer_id,provider_subscription_id,terminal
       FROM subscriptions WHERE provider_subscription_id=$1 FOR UPDATE`,[state.subscriptionId]);
     if(row.rowCount&&row.rows[0].provider_customer_id===state.customerId)outcome='applied';
     else outcome='ignored_unlinked';
    }
    if(outcome==='applied'&&row.rows[0].terminal&&!state.terminal)outcome='ignored_terminal';
    if(outcome==='applied'){
     await client.query(`UPDATE subscriptions SET
       provider_subscription_id=$2,provider_price_id=$3,stripe_livemode=$4,status=$5,
       current_period_end=$6,last_provider_event_at=to_timestamp($7),updated_at=now(),verified_payment=$9,terminal=$10
       WHERE household_id=$1 AND provider_customer_id=$8`,
       [row.rows[0].household_id,state.subscriptionId,state.priceId,state.livemode,
        state.status,state.periodEnd,event.created,state.customerId,state.verifiedPayment,state.terminal]);
     if(session)await client.query('UPDATE billing_checkout_sessions SET consumed_at=COALESCE(consumed_at,now()) WHERE provider_session_id=$1',[session.id]);
    }
   }
   await client.query('UPDATE stripe_processed_events SET outcome=$2 WHERE event_id=$1',[event.id,outcome]);
   return false;
  });
  return respond({received:true,...(duplicate?{duplicate:true}:{})});
 }catch{return respond({error:'webhook_processing_failed'},503);}
}
export const config={path:'/api/billing/stripe-webhook',method:'POST'};
