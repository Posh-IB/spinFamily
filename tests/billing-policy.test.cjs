'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowedPrices,parseStripePeriod,snapshot,validConfig}=require('../lib/billing-policy.cjs');
const env={STRIPE_SECRET_KEY:'sk_test_012345ABCDEF',STRIPE_WEBHOOK_SECRET:'whsec_012345ABCDEF',
 SPINFAMILY_PLUS_MONTHLY_PRICE_ID:'price_Monthly1',SPINFAMILY_PLUS_ANNUAL_PRICE_ID:'price_Annual22',CONTEXT:'deploy-preview'};
const sub=(status='active')=>({id:'sub_ABC',customer:'cus_ABC',livemode:false,status,items:{data:[{quantity:1,price:{id:'price_Monthly1'},current_period_end:1800000000}]}});
test('preview refuses live key and production refuses accidental activation',()=>{
 assert.equal(validConfig(env),true);
 assert.equal(validConfig({...env,STRIPE_SECRET_KEY:'sk_live_ABCDEF01234'}),false);
 assert.equal(validConfig({...env,CONTEXT:'production'}),false);
 assert.equal(validConfig({...env,CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true'}),false);
 assert.equal(validConfig({...env,STRIPE_SECRET_KEY:'sk_live_ABCDEF01234',CONTEXT:'production',SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true'}),true);
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
