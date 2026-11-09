'use strict';
// Account deletion removes the signed-in adult's household and every row that hangs off it.
// The request must carry an explicit confirmation so a stray POST cannot erase a family.
const CONFIRMATION='DELETE';
// Any subscription that can still bill the customer blocks deletion until Plus is cancelled,
// so a family is never charged for an account that no longer exists.
const BILLABLE=new Set(['active','trialing','past_due','unpaid','incomplete']);
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_request');
 const keys=Object.keys(body);
 if(keys.length!==1||keys[0]!=='confirm'||body.confirm!==CONFIRMATION)throw Error('invalid_request');
 return {confirm:CONFIRMATION};
}
function subscriptionBlocksDeletion(sub){
 if(!sub)return false;
 if(sub.terminal===true)return false;
 return BILLABLE.has(sub.status);
}
module.exports={CONFIRMATION,validate,subscriptionBlocksDeletion};
