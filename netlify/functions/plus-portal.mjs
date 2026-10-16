import {environment} from '../../server/database.mjs';
import security from '../../lib/request-security.cjs';
import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import Stripe from 'stripe';
import policy from '../../lib/billing-policy.cjs';
const {sameOriginMutation}=security;
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req,context){
 if(req.method!=='POST')return respond({error:'method_not_allowed'},405);
 if(!sameOriginMutation(req))return respond({error:'invalid_origin'},403);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 const env=environment(context), origin=env.SPINFAMILY_CHECKOUT_ORIGIN;
 if(!policy.validConfig(env)||!/^https:\/\/[^/]+$/.test(origin||''))return respond({error:'billing_not_configured'},503);
 try{
  const db=getDatabase();
  const rows=await db.sql`SELECT s.provider_customer_id FROM subscriptions s
    INNER JOIN households h ON h.id=s.household_id WHERE h.owner_subject=${user.id}`;
  if(!rows[0]?.provider_customer_id)return respond({error:'billing_account_not_found'},404);
  const stripe=new Stripe(env.STRIPE_SECRET_KEY);
  const configuration=env.SPINFAMILY_PORTAL_CONFIGURATION_ID;
  if(env.CONTEXT==='production' && !/^bpc_[A-Za-z0-9]+$/.test(configuration||''))return respond({error:'portal_configuration_missing'},503);
  const session=await stripe.billingPortal.sessions.create({customer:rows[0].provider_customer_id,return_url:origin+'/',...(configuration?{configuration}:{})});
  return respond({url:session.url});
 }catch{return respond({error:'billing_portal_unavailable'},503);}
}
export const config={path:'/api/billing/portal',method:'POST'};
