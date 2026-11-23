'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowedPrices,parseStripePeriod,snapshot,validConfig,verifyMerchant,ROOTLAYER_STRIPE_ACCOUNT_ID}=require('../lib/billing-policy.cjs');
const env={STRIPE_SECRET_KEY:'sk_test_012345ABCDEF',STRIPE_WEBHOOK_SECRET:'whsec_012345ABCDEF',
 SPINFAMILY_PLUS_MONTHLY_PRICE_ID:'price_Monthly1',SPINFAMILY_PLUS_ANNUAL_PRICE_ID:'price_Annual22',CONTEXT:'deploy-preview'};
const sub=(status='active')=>({id:'sub_ABC',customer:'cus_ABC',livemode:false,status,items:{data:[{quantity:1,price:{id:'price_Monthly1'},current_period_end:1800000000}]}});
test('preview refuses live key and production refuses accidental activation',()=>{
 assert.equal(validConfig(env),true);
 assert.equal(validConfig({...env,STRIPE_SECRET_KEY:'sk_live_ABCDEF01234'}),false);
 assert.equal(validConfig({...env,CONTEXT:'production'}),false);
 assert.equal(validConfig({...env,CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true'}),false);
 assert.equal(validConfig({...env,STRIPE_SECRET_KEY:'sk_live_ABCDEF01234',CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true',SPINFAMILY_MERCHANT_ACCOUNT_ID:ROOTLAYER_STRIPE_ACCOUNT_ID}),true);
});
test('rejects unset or duplicate Stripe price mapping',()=>{
 assert.equal(validConfig({...env,SPINFAMILY_PLUS_ANNUAL_PRICE_ID:'price_Monthly1'}),false);
 assert.equal(validConfig({...env,STRIPE_WEBHOOK_SECRET:undefined}),false);
 assert.equal(allowedPrices(env).size,2);
});
test('subscription snapshot permits only configured prices and matching mode',()=>{
 assert.equal(snapshot(sub(),env).status,'active');
 assert.equal(snapshot(sub('canceled'),env).status,'canceled');
 assert.equal(snapshot({...sub(),livemode:true},env),null);
 assert.equal(snapshot({...sub(),items:{data:[{price:{id:'price_other'}}]}},env),null);
});
test('period end from subscription items and not client-provided timestamp',()=>{
 assert.equal(parseStripePeriod(sub()).toISOString(),'2027-01-15T08:00:00.000Z');
 assert.equal(parseStripePeriod({items:{data:[]}}),null);
});

test('restricted keys preserve mode separation and subscription validation',()=>{
 const restricted={...env,STRIPE_SECRET_KEY:'rk_test_ABCDEF01234'};
 assert.equal(validConfig(restricted),true);
 assert.equal(snapshot(sub(),restricted).livemode,false);
 assert.equal(validConfig({...restricted,STRIPE_SECRET_KEY:'rk_live_ABCDEF01234'}),false);
 const production={...restricted,STRIPE_SECRET_KEY:'rk_live_ABCDEF01234',CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true',SPINFAMILY_MERCHANT_ACCOUNT_ID:ROOTLAYER_STRIPE_ACCOUNT_ID};
 assert.equal(validConfig(production),true);
 assert.equal(snapshot({...sub(),livemode:true},production).livemode,true);
 assert.equal(validConfig({...env,STRIPE_SECRET_KEY:'pk_test_ABCDEF01234'}),false);
});

test('production must use Rootlayer merchant identity, never a legacy CDDT account',()=>{
 const production={...env,STRIPE_SECRET_KEY:'rk_live_ABCDEF01234',CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true'};
 assert.equal(validConfig(production),false);
 assert.equal(validConfig({...production,SPINFAMILY_MERCHANT_ACCOUNT_ID:'acct_1QeSzoRrMKZPnWh6'}),false);
 assert.equal(validConfig({...production,SPINFAMILY_MERCHANT_ACCOUNT_ID:ROOTLAYER_STRIPE_ACCOUNT_ID}),true);
});
test('checkout, portal and webhook can verify API key belongs to Rootlayer account',async()=>{
 const envProd={CONTEXT:'production',SPINFAMILY_MERCHANT_ACCOUNT_ID:ROOTLAYER_STRIPE_ACCOUNT_ID};
 assert.equal(await verifyMerchant({accounts:{retrieve:async()=>({id:ROOTLAYER_STRIPE_ACCOUNT_ID})}},envProd),true);
 assert.equal(await verifyMerchant({accounts:{retrieve:async()=>({id:'acct_1QeSzoRrMKZPnWh6'})}},envProd),false);
 assert.equal(await verifyMerchant({accounts:{retrieve:async()=>{throw Error('missing_account_permission')}}},envProd),false);
 assert.equal(await verifyMerchant({accounts:{retrieve:async()=>({id:ROOTLAYER_STRIPE_ACCOUNT_ID})}},{...envProd,SPINFAMILY_MERCHANT_ACCOUNT_ID:'acct_other'}),false);
});
