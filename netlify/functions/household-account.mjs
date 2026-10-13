import {authenticated,json} from '../../server/runtime.mjs';
export default (req,context)=>req.method==='GET'?authenticated(req,(s,id)=>s.account(id),context):json({error:'method_not_allowed'},405);
export const config={path:'/api/household/account'};
