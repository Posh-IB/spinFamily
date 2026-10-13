import {authenticated,body,json} from '../../server/runtime.mjs';
export default async (req,context)=>{
 if(!['GET','POST','PATCH','DELETE'].includes(req.method))return json({error:'method_not_allowed'},405);
 return authenticated(req,async(s,id)=>s.activities(id,req.method,req.method==='GET'?{}:await body(req)),context);
};
export const config={path:'/api/household/activities',method:['GET','POST','PATCH','DELETE']};
