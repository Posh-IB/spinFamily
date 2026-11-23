'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const policy=require('../lib/billing-policy.cjs');
const html=fs.readFileSync('index.html','utf8');
const source=fs.readFileSync('server/database.mjs','utf8');
const checkout=fs.readFileSync('netlify/functions/plus-checkout.mjs','utf8');
const webhook=fs.readFileSync('netlify/functions/stripe-webhook.mjs','utf8');

test('SpinFamily customer-facing plans match approved November 2026 pricing',()=>{
 assert.match(html,/id="plusMonthly"[^>]*>Plus monthly — \$7<\/button>/);
 assert.match(html,/id="plusAnnual"[^>]*>Plus yearly — \$75<\/button>/);
 assert.doesNotMatch(html,/Plus monthly — \$4\.99/);
 assert.doesNotMatch(html,/Plus yearly — \$49/);
});
test('production billing uses production price environment variables, not preview price IDs',()=>{
 assert.match(source,/SPINFAMILY_PRODUCTION_MONTHLY_PRICE_ID/);
 assert.match(source,/SPINFAMILY_PRODUCTION_ANNUAL_PRICE_ID/);
 assert.match(source,/SPINFAMILY_PRODUCTION_WEBHOOK_SECRET/);
 assert.match(checkout,/body\?\.period==='monthly'/);
 assert.match(checkout,/body\?\.period==='annual'/);
 assert.match(webhook,/stripe\.webhooks\.constructEvent/);
});
test('live subscription environment requires matching live key, two distinct configured prices and explicit enablement',()=>{
 const env={CONTEXT:'production',STRIPE_SECRET_KEY:'rk_live_ExampleKey12345',STRIPE_WEBHOOK_SECRET:'whsec_ExampleKey12345',
   SPINFAMILY_ENABLE_PRODUCTION_BILLING:'true',
   SPINFAMILY_PLUS_MONTHLY_PRICE_ID:'price_1UezrsCqVYNS8CiEwjTqK2bC',
   SPINFAMILY_PLUS_ANNUAL_PRICE_ID:'price_1UezrvCqVYNS8CiEZDg4z9c6'};
 assert.equal(policy.validConfig(env),true);
 assert.equal(policy.validConfig({...env,STRIPE_SECRET_KEY:'rk_test_ExampleKey12345'}),false);
 assert.equal(policy.validConfig({...env,SPINFAMILY_ENABLE_PRODUCTION_BILLING:'false'}),false);
 assert.equal(policy.validConfig({...env,SPINFAMILY_PLUS_ANNUAL_PRICE_ID:env.SPINFAMILY_PLUS_MONTHLY_PRICE_ID}),false);
});
