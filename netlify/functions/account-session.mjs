import {getUser} from '@netlify/identity';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(req.method!=='GET')return reply({error:'method_not_allowed'},405);
 try{
  const user=await getUser();
  return reply({authenticated:Boolean(user?.id),subject:user?.id??null});
 }catch{return reply({error:'authentication_unavailable'},503);}
}
export const config={path:'/api/account/session',method:'GET'};

