import {authenticated,body,json} from '../../server/runtime.mjs';
export default (req,context)=>req.method==='POST'?authenticated(req,async(s,id)=>s.checkout(id,(await body(req)).plan),context):json({error:'method_not_allowed'},405);
export const config={path:'/api/household/checkout'};
