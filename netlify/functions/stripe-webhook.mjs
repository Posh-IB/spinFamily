import Stripe from 'stripe';
import { getDatabase } from '@netlify/database';
import policy from '../../lib/billing-policy.cjs';
const {validConfig,snapshot}=policy;
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const handled=new Set(['checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);
export default async function handler(req){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 const env=process.env;
 if(!validConfig(env))return respond({error:'billing_not_configured'},503);
 const signature=req.headers.get('stripe-signature');
 if(!signature)return respond({error:'invalid_signature'},400);
 const raw=await req.text();
 if(raw.length>1048576)return respond({error:'payload_too_large'},413);
 const stripe=new Stripe(env.STRIPE_SECRET_KEY);
 let event;
 try{event=stripe.webhooks.constructEvent(raw,signature,env.STRIPE_WEBHOOK_SECRET);}catch{return respond({error:'invalid_signature'},400);}
 if(!handled.has(event.type))return respond({received:true});
 const live=env.STRIPE_SECRET_KEY.startsWith('sk_live_');
 if(event.livemode!==live)return respond({error:'environment_mismatch'},400);
 const object=event.data?.object;
 let subscription=null,session=null;
 try{
  if(event.type==='checkout.session.completed'){
   session=object;
   if(session.mode!=='subscription'||session.status!=='complete'||!session.subscription)return respond({received:true});
   subscription=await stripe.subscriptions.retrieve(session.subscription);
  }else{
   if(!object?.id||!object?.customer)return respond({received:true});
   // Current Stripe state, not potentially stale snapshot embedded in webhook.
   subscription=await stripe.subscriptions.retrieve(object.id);
  }
 }catch{return respond({error:'stripe_lookup_unavailable'},503);}
 const state=snapshot(subscription,env);
 let outcome='ignored_irrelevant';
 try{
  const db=getDatabase(),client=await db.pool.connect();
  try{
   await client.query('BEGIN');
   const inserted=await client.query(`INSERT INTO billing_events
      (provider_event_id,event_type,provider_created_at,outcome)
      VALUES($1,$2,to_timestamp($3),$4)
      ON CONFLICT(provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [event.id,event.type,event.created,'ignored_irrelevant']);
   if(!inserted.rowCount){
    await client.query('ROLLBACK');
    return respond({received:true,duplicate:true});
   }
   if(state){
    let row;
    if(session){
     const link=await client.query(`SELECT household_id,provider_customer_id,provider_price_id,stripe_livemode
       FROM billing_checkout_sessions WHERE provider_session_id=$1 FOR UPDATE`,[session.id]);
     if(link.rowCount&&link.rows[0].provider_customer_id===state.customerId&&
       link.rows[0].provider_price_id===state.priceId&&link.rows[0].stripe_livemode===live&&
       session.customer===state.customerId&&session.livemode===live){
      row=await client.query(`SELECT household_id,provider_customer_id,provider_subscription_id,status
        FROM subscriptions WHERE household_id=$1 FOR UPDATE`,[link.rows[0].household_id]);
      if(row.rowCount){
       const old=row.rows[0];
       if(old.provider_customer_id!==state.customerId||
         (old.provider_subscription_id&&old.provider_subscription_id!==state.subscriptionId&&
          ['active','trialing'].includes(old.status)))outcome='ignored_conflict';
       else outcome='applied';
      }else outcome='ignored_unlinked';
     }else outcome='ignored_unlinked';
    }else{
     row=await client.query(`SELECT household_id,provider_customer_id,provider_subscription_id
       FROM subscriptions WHERE provider_subscription_id=$1 FOR UPDATE`,[state.subscriptionId]);
     if(row.rowCount&&row.rows[0].provider_customer_id===state.customerId)outcome='applied';
     else outcome='ignored_unlinked';
    }
    if(outcome==='applied'){
     await client.query(`UPDATE subscriptions SET
       provider_subscription_id=$2,provider_price_id=$3,stripe_livemode=$4,status=$5,
       current_period_end=$6,last_provider_event_at=to_timestamp($7),updated_at=now()
       WHERE household_id=$1 AND provider_customer_id=$8`,
       [row.rows[0].household_id,state.subscriptionId,state.priceId,state.livemode,
        state.status,state.periodEnd,event.created,state.customerId]);
    }
   }
   await client.query('UPDATE billing_events SET outcome=$2 WHERE provider_event_id=$1',[event.id,outcome]);
   await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  return respond({received:true});
 }catch{return respond({error:'webhook_processing_failed'},503);}
}
export const config={path:'/api/billing/stripe-webhook',method:'POST'};
