import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import Stripe from 'stripe';
import policy from '../../lib/billing-policy.cjs';
const {allowedPrices,validConfig}=policy;
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 const env=process.env;
 if(!validConfig(env))return respond({error:'billing_not_configured'},503);
 const origin=env.SPINFAMILY_CHECKOUT_ORIGIN;
 if(!/^https:\/\/[^/]+$/.test(origin||''))return respond({error:'checkout_origin_missing'},503);
 const raw=await req.text();
 if(raw.length>1024)return respond({error:'invalid_request'},400);
 let body;
 try{body=JSON.parse(raw);}catch{return respond({error:'invalid_json'},400);}
 const selected=body?.period==='monthly'?env.SPINFAMILY_PLUS_MONTHLY_PRICE_ID:body?.period==='annual'?env.SPINFAMILY_PLUS_ANNUAL_PRICE_ID:null;
 if(!selected||!allowedPrices(env).has(selected))return respond({error:'invalid_plan'},400);
 const stripe=new Stripe(env.STRIPE_SECRET_KEY);
 try{
  const db=getDatabase();
  await db.sql`INSERT INTO account_profiles(identity_subject) VALUES (${user.id}) ON CONFLICT DO NOTHING`;
  const householdRows=await db.sql`INSERT INTO households(owner_subject) VALUES (${user.id})
      ON CONFLICT(owner_subject) DO UPDATE SET owner_subject=EXCLUDED.owner_subject RETURNING id`;
  const householdId=householdRows[0].id;
  const existing=await db.sql`SELECT provider_customer_id,status,current_period_end FROM subscriptions WHERE household_id=${householdId}`;
  const record=existing[0];
  if(record&&['active','trialing'].includes(record.status)&&record.current_period_end&&new Date(record.current_period_end)>new Date())
   return respond({error:'already_subscribed'},409);
  let customerId=record?.provider_customer_id;
  if(!customerId){
   const created=await stripe.customers.create({metadata:{spinfamily_household_id:String(householdId)}},{
    idempotencyKey:'spinfamily-household-'+householdId
   });
   customerId=created.id;
   await db.sql`INSERT INTO subscriptions (household_id,provider_customer_id,stripe_livemode)
      VALUES (${householdId},${customerId},${env.STRIPE_SECRET_KEY.startsWith('sk_live_')})
      ON CONFLICT (household_id) DO UPDATE SET provider_customer_id=COALESCE(subscriptions.provider_customer_id,EXCLUDED.provider_customer_id)`;
   const linked=await db.sql`SELECT provider_customer_id FROM subscriptions WHERE household_id=${householdId}`;
   customerId=linked[0].provider_customer_id;
  }
  const session=await stripe.checkout.sessions.create({
   mode:'subscription',customer:customerId,
   line_items:[{price:selected,quantity:1}],
   success_url:origin+'/?billing=return',
   cancel_url:origin+'/?billing=cancel',
   client_reference_id:String(householdId),
   metadata:{spinfamily_household_id:String(householdId)},
   subscription_data:{metadata:{spinfamily_household_id:String(householdId)}},
  });
  // Session linkage must be written before exposing the checkout URL.
  await db.sql`INSERT INTO billing_checkout_sessions
    (provider_session_id,household_id,provider_customer_id,provider_price_id,stripe_livemode)
    VALUES (${session.id},${householdId},${customerId},${selected},${session.livemode})
    ON CONFLICT(provider_session_id) DO NOTHING`;
  return respond({url:session.url},201);
 }catch{return respond({error:'checkout_unavailable'},503);}
}
export const config={path:'/api/billing/checkout',method:'POST'};
