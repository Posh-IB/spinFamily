'use strict';
// Browser mutations must originate from the same deployed Netlify site.
// Stripe webhooks are separate: authenticated by Stripe signatures instead.
function sameOriginMutation(request){
  if(!request || !request.headers || typeof request.headers.get!=='function')return false;
  const supplied=request.headers.get('origin');
  if(!supplied || supplied==='null')return false;
  try{
    const origin=new URL(supplied);
    const destination=new URL(request.url);
    return origin.protocol==='https:' && origin.origin===destination.origin;
  }catch{return false;}
}
module.exports={sameOriginMutation};
