import Stripe from 'stripe';
import {service,env,json} from '../../server/runtime.mjs';
export default async req=>{
 if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 const secret=env('SPINFAMILY_STRIPE_TEST_WEBHOOK_SECRET');if(!secret?.startsWith('whsec_'))return json({error:'webhook_not_configured'},503);
 const raw=await req.text();if(Buffer.byteLength(raw)>262144)return json({error:'payload_too_large'},413);
 let event;
 try{event=Stripe.webhooks.constructEvent(raw,req.headers.get('stripe-signature'),secret);}catch{return json({error:'invalid_signature'},400);}
 try{return json(await service().webhook(event));}catch(e){return json({error:e.status&&e.status<500?e.message:'reconciliation_unavailable'},e.status||503);}
};
