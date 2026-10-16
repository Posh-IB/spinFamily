import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import contract from '../../lib/recommendation-contract.cjs';
import catalogData from '../../server/recommendation-catalog.json' with {type:'json'};
import {transaction} from '../../server/database.mjs';
import {requestPrivateSuggestions} from '../../server/private-personalization.mjs';
const {recommendationInput,displayResult}=contract;
const response=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const fail=(error,status)=>response({error},status);
export default async function handler(req,context){
 if(!['GET','POST'].includes(req.method))return fail('method_not_allowed',405);
 if(req.method==='POST'&&!security.sameOriginMutation(req))return fail('invalid_origin',403);
 // This controlled candidate cannot enable the new service in production.
 if(context?.deploy?.context==='production')return fail('personalization_unavailable',503);
 let user;try{user=await getUser();}catch{return fail('authentication_unavailable',503);}
 if(!user?.id)return fail('authentication_required',401);
 let options={};
 if(req.method==='POST'){
  const raw=await req.text();if(raw.length>8192)return fail('payload_too_large',413);
  try{options=JSON.parse(raw);}catch{return fail('invalid_json',400);}
 }
 try{
  return await transaction(async db=>{
   const hh=(await db.query('SELECT id,history_timezone FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
   if(!hh)return fail('household_not_found',403);
   const s=(await db.query('SELECT status,verified_payment,terminal,current_period_end FROM subscriptions WHERE household_id=$1 FOR UPDATE',[hh.id])).rows[0];
   if(s?.verified_payment!==true||s.terminal||!['active','trialing'].includes(s.status)||!s.current_period_end||new Date(s.current_period_end)<=new Date())return fail('plus_required',403);
   if(!hh.history_timezone)return fail('save_plan_timezone_first',409);
   if(req.method==='GET')return response({activities:catalogData.map(({id,title})=>({id,name:title})),timezone:hh.history_timezone});
   // Caller cannot supply household, history, catalog, date, feedback or completion credit.
   const rows=(await db.query("SELECT client_plan_id,plan_data,completed_at,completion_source FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL AND completed_at IS NOT NULL AND completion_source='explicit_caregiver' ORDER BY completed_at DESC LIMIT 100",[hh.id])).rows;
   let input;try{input=recommendationInput(rows,hh.history_timezone,options,catalogData);}catch{return fail('invalid_options',422);}
   try{
    const result=await requestPrivateSuggestions(input,{endpoint:globalThis.Netlify?.env.get('SPINFAMILY_PRIVATE_ENGINE_URL'),token:globalThis.Netlify?.env.get('SPINFAMILY_PRIVATE_ENGINE_TOKEN')});
    return response(displayResult(result,input));
   }catch{return fail('personalization_unavailable',503);}
  });
 }catch{return fail('personalization_unavailable',503);}
}
export const config={path:'/api/household/suggestions',method:['GET','POST']};
