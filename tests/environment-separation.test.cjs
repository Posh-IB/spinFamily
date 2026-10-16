'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
test('production bindings cannot fall back to preview prices, origin or webhook secret',async()=>{
 const {environment}=await import('../server/database.mjs');
 const values={STRIPE_SECRET_KEY:'rk_live_synthetic',STRIPE_WEBHOOK_SECRET:'whsec_preview',
  SPINFAMILY_PLUS_MONTHLY_PRICE_ID:'price_previewMonthly',SPINFAMILY_PLUS_ANNUAL_PRICE_ID:'price_previewAnnual',
  SPINFAMILY_CHECKOUT_ORIGIN:'https://preview.example',SPINFAMILY_PRODUCTION_WEBHOOK_SECRET:'whsec_production',
  SPINFAMILY_PRODUCTION_MONTHLY_PRICE_ID:'price_productionMonthly',SPINFAMILY_PRODUCTION_ANNUAL_PRICE_ID:'price_productionAnnual',
  SPINFAMILY_PRODUCTION_CHECKOUT_ORIGIN:'https://production.example'};
 const previous=globalThis.Netlify;
 globalThis.Netlify={env:{get:key=>values[key]}};
 try{
  const live=environment({deploy:{context:'production'}}),preview=environment({deploy:{context:'deploy-preview'}});
  assert.equal(live.STRIPE_WEBHOOK_SECRET,'whsec_production');
  assert.equal(live.SPINFAMILY_PLUS_MONTHLY_PRICE_ID,'price_productionMonthly');
  assert.equal(live.SPINFAMILY_PLUS_ANNUAL_PRICE_ID,'price_productionAnnual');
  assert.equal(live.SPINFAMILY_CHECKOUT_ORIGIN,'https://production.example');
  assert.equal(preview.STRIPE_WEBHOOK_SECRET,'whsec_preview');
  assert.equal(preview.SPINFAMILY_PLUS_MONTHLY_PRICE_ID,'price_previewMonthly');
  assert.equal(preview.SPINFAMILY_PLUS_ANNUAL_PRICE_ID,'price_previewAnnual');
  assert.equal(preview.SPINFAMILY_CHECKOUT_ORIGIN,'https://preview.example');
  delete values.SPINFAMILY_PRODUCTION_WEBHOOK_SECRET;
  assert.equal(environment({deploy:{context:'production'}}).STRIPE_WEBHOOK_SECRET,undefined);
 }finally{globalThis.Netlify=previous;}
});
