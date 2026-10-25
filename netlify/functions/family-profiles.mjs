import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import policy from '../../lib/family-profiles.cjs';
import {transaction} from '../../server/database.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(!['GET','POST'].includes(req.method))return reply({error:'method_not_allowed'},405);
 if(req.method==='POST'&&!security.sameOriginMutation(req))return reply({error:'invalid_origin'},403);
 let user;
 try{user=await getUser();}catch{return reply({error:'authentication_unavailable'},503);}
 if(!user?.id)return reply({error:'authentication_required'},401);
 let change=null;
 if(req.method==='POST'){
  if(!(req.headers.get('content-type')||'').startsWith('application/json'))return reply({error:'invalid_content_type'},415);
  if(Number(req.headers.get('content-length')||0)>512)return reply({error:'payload_too_large'},413);
  let raw;try{raw=await req.text();}catch{return reply({error:'invalid_profile'},422);}
  if(raw.length>512)return reply({error:'payload_too_large'},413);
  try{change=policy.validate(JSON.parse(raw));}catch{return reply({error:'invalid_profile'},422);}
 }
 try{return await transaction(async db=>{
  // Only verified signed-in household owners can edit profiles.
  await db.query('INSERT INTO account_profiles(identity_subject) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
  const hh=(await db.query('INSERT INTO households(owner_subject) VALUES($1) ON CONFLICT(owner_subject) DO UPDATE SET owner_subject=EXCLUDED.owner_subject RETURNING id',[user.id])).rows[0];
  await db.query('SELECT id FROM households WHERE id=$1 FOR UPDATE',[hh.id]);
  const sub=(await db.query('SELECT status,verified_payment,terminal,current_period_end FROM subscriptions WHERE household_id=$1',[hh.id])).rows[0];
  const plus=sub?.verified_payment===true&&!sub.terminal&&['active','trialing'].includes(sub.status)&&
     sub.current_period_end&&new Date(sub.current_period_end)>new Date();
  if(change){
   if(change.slot===policy.EXTRA_ADULT&&!plus)return reply({error:'plus_required'},403);
   if(change.action==='remove'){
    await db.query('DELETE FROM household_members WHERE household_id=$1 AND profile_slot=$2',[hh.id,change.slot]);
   }else{
    const exists=(await db.query('SELECT id FROM household_members WHERE household_id=$1 AND profile_slot=$2',[hh.id,change.slot])).rows[0];
    if(exists){
     await db.query('UPDATE household_members SET display_alias=$3,skin_tone=$4 WHERE household_id=$1 AND profile_slot=$2',
       [hh.id,change.slot,change.name,change.tone]);
    }else{
     await db.query('INSERT INTO household_members(household_id,profile_slot,display_alias,skin_tone) VALUES($1,$2,$3,$4)',
       [hh.id,change.slot,change.name,change.tone]);
    }
   }
  }
  const members=(await db.query('SELECT profile_slot,display_alias,skin_tone FROM household_members WHERE household_id=$1 AND profile_slot IS NOT NULL ORDER BY profile_slot',[hh.id])).rows;
  return reply({members:policy.present(members,plus),plus:Boolean(plus)});
 });}catch{return reply({error:'family_profiles_unavailable'},503);}
}
export const config={path:'/api/household/members',method:['GET','POST']};
