'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyStripeSignature,parseVerifiedEvent,subscriptionUpdate}=require('../lib/stripe-entitlement.cjs');
const now=1791840000,secret='whsec_testfixture';
const raw=JSON.stringify({id:'evt_1',livemode:true,type:'customer.subscription.updated',data:{object:{id:'sub_1',customer:'cus_1',status:'active',current_period_end:1792000000,items:{data:[{price:{id:'price_1TPmH9RrMKZPnWh6iNNzYe3T'}}]}}}});
const sig=(body,t=now)=>'t='+t+',v1='+crypto.createHmac('sha256',secret).update(t+'.'+body).digest('hex');
test('requires valid signature and timestamp',()=>{
 assert.equal(verifyStripeSignature(raw,sig(raw),secret,now),true);
 assert.equal(verifyStripeSignature(raw+'x',sig(raw),secret,now),false);
 assert.equal(verifyStripeSignature(raw,sig(raw,now-301),secret,now),false);
});
test('verified event defaults to isolated test mode and deterministic clock',()=>{
 assert.equal(parseVerifiedEvent(raw,sig(raw),secret,{now}),null);
 const testRaw=raw.replace('"livemode":true','"livemode":false');
 assert.equal(parseVerifiedEvent(testRaw,sig(testRaw),secret,{now})?.id,'evt_1');
});
test('subscription update only for previously linked customer and known price',()=>{
 const e=JSON.parse(raw);
 assert.equal(subscriptionUpdate(e,'cus_1').status,'active');
 assert.equal(subscriptionUpdate(e,'cus_other'),null);
 e.data.object.items.data[0].price.id='price_other';
 assert.equal(subscriptionUpdate(e,'cus_1'),null);
});
