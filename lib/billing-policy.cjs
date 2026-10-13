'use strict';
const PRICE_ENV=['SPINFAMILY_PLUS_MONTHLY_PRICE_ID','SPINFAMILY_PLUS_ANNUAL_PRICE_ID'];
function allowedPrices(env){return new Set(PRICE_ENV.map(k=>env[k]).filter(p=>typeof p==='string'&&/^price_[A-Za-z0-9]+$/.test(p)));}
function parseStripePeriod(subscription){
 const end=subscription?.items?.data?.map(x=>x.current_period_end).filter(Number.isFinite)??[];
 if(Number.isFinite(subscription?.current_period_end))end.push(subscription.current_period_end);
 return end.length ? new Date(Math.min(...end)*1000) : null;
}
function snapshot(subscription,env){
 const prices=allowedPrices(env);
 const items=subscription?.items?.data??[];
 const item=items.find(x=>prices.has(x.price?.id));
 if(!item)return null;
 if(typeof subscription.id!=='string'||typeof subscription.customer!=='string'||subscription.livemode!==env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))return null;
 const status=subscription.status;
 if(!['inactive','trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(status))return null;
 return {subscriptionId:subscription.id,customerId:subscription.customer,priceId:item.price.id,
  status,periodEnd:parseStripePeriod(subscription),livemode:subscription.livemode};
}
function validConfig(env){
 const key=env.STRIPE_SECRET_KEY,hook=env.STRIPE_WEBHOOK_SECRET;
 if(!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key||'')||!/^whsec_[A-Za-z0-9]+$/.test(hook||''))return false;
 if(allowedPrices(env).size!==2)return false;
 // Critical: preview builds may NEVER use a live Stripe secret.
 if(env.CONTEXT!=='production'&&key.startsWith('sk_live_'))return false;
 if(env.CONTEXT==='production'&&env.SPINFAMILY_ENABLE_PRODUCTION_BILLING!=='true')return false;
 return true;
}
module.exports={allowedPrices,parseStripePeriod,snapshot,validConfig};