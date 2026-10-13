import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import Stripe from 'stripe';
import policy from '../../lib/billing-policy.cjs';
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 const env=process.env, origin=env.SPINFAMILY_CHECKOUT_ORIGIN;
 if(!policy.validConfig(env)||!/^https:\/\/[^/]+$/.test(origin||''))return respond({error:'billing_not_configured'},503);
 try{
  const db=getDatabase();
  const rows=await db.sql`SELECT s.provider_customer_id FROM subscriptions s
    INNER JOIN households h ON h.id=s.household_id WHERE h.owner_subject=${user.id}`;
  if(!rows[0]?.provider_customer_id)return respond({error:'billing_account_not_found'},404);
  const stripe=new Stripe(env.STRIPE_SECRET_KEY);
  const session=await stripe.billingPortal.sessions.create({customer:rows[0].provider_customer_id,return_url:origin+'/'});
  return respond({url:session.url});
 }catch{return respond({error:'billing_portal_unavailable'},503);}
}
export const config={path:'/api/billing/portal',method:'POST'};
