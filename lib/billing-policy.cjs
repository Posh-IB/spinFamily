'use strict';
const PRICE_ENV=['SPINFAMILY_PLUS_MONTHLY_PRICE_ID','SPINFAMILY_PLUS_ANNUAL_PRICE_ID'];
function stripeLivemode(key){return /^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(key||'');}
function allowedPrices(env){return new Set(PRICE_ENV.map(k=>env[k]).filter(p=>typeof p==='string'&&/^price_[A-Za-z0-9]+$/.test(p)));}
function parseStripePeriod(subscription){
 const end=subscription?.items?.data?.map(x=>x.current_period_end).filter(Number.isFinite)??[];
 if(Number.isFinite(subscription?.current_period_end))end.push(subscription.current_period_end);
 return end.length ? new Date(Math.min(...end)*1000) : null;
}
function snapshot(subscription,env){
 const prices=allowedPrices(env);
 const items=subscription?.items?.data??[];
 const item=items.length===1&&items[0].quantity===1&&prices.has(items[0].price?.id)?items[0]:null;
 if(!item)return null;
 if(typeof subscription.id!=='string'||typeof subscription.customer!=='string'||subscription.livemode!==stripeLivemode(env.STRIPE_SECRET_KEY))return null;
 const status=subscription.status;
 if(!['inactive','trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(status))return null;
 return {subscriptionId:subscription.id,customerId:subscription.customer,priceId:item.price.id,
  status,periodEnd:parseStripePeriod(subscription),livemode:subscription.livemode,
  verifiedPayment:subscription.latest_invoice?.status==='paid',terminal:['canceled','incomplete_expired'].includes(status)};
}
function validConfig(env){
 const key=env.STRIPE_SECRET_KEY,hook=env.STRIPE_WEBHOOK_SECRET;
 if(!/^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key||'')||!/^whsec_[A-Za-z0-9]+$/.test(hook||''))return false;
 if(allowedPrices(env).size!==2)return false;
 // Critical: preview builds may NEVER use a live Stripe secret.
 if(!['production','deploy-preview','branch-deploy'].includes(env.CONTEXT))return false;
 if(env.CONTEXT!=='production'&&stripeLivemode(key))return false;
 if(env.CONTEXT==='production'&&!stripeLivemode(key))return false;
 if(env.CONTEXT==='production'&&env.SPINFAMILY_ENABLE_PRODUCTION_BILLING!=='true')return false;
 return true;
}
module.exports={stripeLivemode,allowedPrices,parseStripePeriod,snapshot,validConfig};