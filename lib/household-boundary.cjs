'use strict';
const {moderateActivity}=require('./activity-moderation.cjs');
const json=(statusCode,body)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(body)});
function verifiedSubject(context){
 // Netlify's verified Identity context is supplied by its functions gateway.
 // NEVER decode an Authorization header or trust a client-supplied user ID.
 const user=context?.clientContext?.user;
 return user&&typeof user.sub==='string'&&user.sub.length>0?user.sub:null;
}
async function handleCustomActivity(event,context,{entitlements,activities}={}){
 if(event.httpMethod!=='POST')return json(405,{error:'method_not_allowed'});
 const subject=verifiedSubject(context);
 if(!subject)return json(401,{error:'authentication_required'});
 if(!entitlements||!activities)return json(503,{error:'service_unavailable'});
 let input;
 try{if((event.body||'').length>4096)return json(413,{error:'payload_too_large'});input=JSON.parse(event.body||'{}');}
 catch{return json(400,{error:'invalid_json'});}
 const result=moderateActivity(input);
 if(!result.ok)return json(422,{error:result.reason,policyVersion:result.policyVersion});
 try{
  // Household must be resolved on the server by verified subject.
  const household=await entitlements.householdForSubject(subject);
  if(!household)return json(403,{error:'household_not_found'});
  const entitled=await entitlements.hasActivePlus(household.id);
  if(!entitled)return json(403,{error:'plus_required'});
  const saved=await activities.createForHousehold(household.id,{...result.value,source:'custom',durationMinutes:20,moderationPolicyVersion:result.policyVersion});
  return json(201,{activity:saved});
 }catch{return json(503,{error:'service_unavailable'});}
}
module.exports={handleCustomActivity,verifiedSubject};
