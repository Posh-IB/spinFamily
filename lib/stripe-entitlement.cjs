'use strict';
const crypto=require('node:crypto');
const ALLOWED_PRICES=new Set(['price_1TPmH9RrMKZPnWh6iNNzYe3T','price_1TPmOWRrMKZPnWh6fANoj8uT']);
function verifyStripeSignature(raw,header,secret,now=Math.floor(Date.now()/1000)){
 if(typeof raw!=='string'||!header||!secret)return false;
 const entries=header.split(',').map(x=>x.trim().split('='));
 const timestamp=entries.find(x=>x[0]==='t')?.[1];
 const signatures=entries.filter(x=>x[0]==='v1').map(x=>x[1]);
 if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now-Number(timestamp))>300||!signatures.length)return false;
 const expected=crypto.createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
 return signatures.some(signature=>/^[a-f0-9]{64}$/i.test(signature)&&crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')));
}
function parseVerifiedEvent(raw,header,secret,options={}){
 if(!verifyStripeSignature(raw,header,secret,options.now))return null;
 let event;try{event=JSON.parse(raw);}catch{return null;}
 if(!event||typeof event.id!=='string'||event.livemode!==(options.livemode??false)||typeof event.type!=='string'||!event.data?.object)return null;
 return event;
}
function subscriptionUpdate(event,linkedCustomer){
 const sub=event.data.object;
 if(!['customer.subscription.updated','customer.subscription.deleted'].includes(event.type))return null;
 if(!linkedCustomer||sub.customer!==linkedCustomer||!ALLOWED_PRICES.has(sub.items?.data?.[0]?.price?.id))return null;
 return {id:sub.id,customerId:sub.customer,status:sub.status,periodEnd:sub.current_period_end?new Date(sub.current_period_end*1000):null};
}
module.exports={verifyStripeSignature,parseVerifiedEvent,subscriptionUpdate,ALLOWED_PRICES};
