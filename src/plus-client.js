import { signup, login, logout, getUser, handleAuthCallback } from '@netlify/identity';

const byId = id => document.getElementById(id);
const panel = byId('plusAccountPanel');
const status = byId('plusAccountStatus');
const authForm = byId('plusAuthForm');
const email = byId('plusEmail');
const password = byId('plusPassword');
const signIn = byId('plusSignIn');
const signUp = byId('plusSignUp');
const signOut = byId('plusSignOut');
const monthly = byId('plusMonthly');
const annual = byId('plusAnnual');
const manage = byId('plusManage');
let activeUser = null, isPlus = false;

function message(value) { status.textContent = value; }
function resetActivities() {
  // Clearing a household's activities on logout prevents account crossover.
  window.spinFamilyHydrateCustomActivities?.([]);
}
function updateControls() {
  const authenticated = Boolean(activeUser);
  authForm.hidden = authenticated;
  signOut.hidden = !authenticated;
  monthly.hidden = !authenticated || isPlus;
  annual.hidden = !authenticated || isPlus;
  manage.hidden = !authenticated || !isPlus;
  byId('activityForm').hidden = !isPlus;
}
async function api(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
  let data={};
  try{data=await response.json();}catch{}
  if(!response.ok)throw new Error(data.error||'Request failed');
  return data;
}
async function refresh() {
  activeUser=await getUser();
  isPlus=false;
  resetActivities();
  if(!activeUser) {
    message('Guest mode: the family wheel and curated activities remain free. Sign in for SpinFamily Plus.');
    updateControls();return;
  }
  message('Signed in. Checking your SpinFamily Plus subscription…');
  try {
    const data=await api('/api/household/activities');
    isPlus=true;
    window.spinFamilyHydrateCustomActivities?.(data.activities||[]);
    message('SpinFamily Plus is active. Your custom activities are saved to your household.');
  } catch (error) {
    if(error.message==='plus_required'||error.message==='household_not_found')
      message('Signed in. Choose a SpinFamily Plus plan to save custom activities.');
    else message('Subscription check is unavailable. Premium features are temporarily disabled.');
  }
  updateControls();
}
async function authorize(action) {
  const address=email.value.trim(),secret=password.value;
  if(!address||!secret)return;
  message('Processing account request…');
  try{
    if(action==='signup'){
      await signup(address,secret);
      message('Check your email for an account confirmation, then sign in.');
      return;
    }
    await login(address,secret);
    password.value='';
    await refresh();
  }catch{message('Account request failed. Check your details or try again.');}
}
signIn.addEventListener('click',()=>authorize('login'));
signUp.addEventListener('click',()=>authorize('signup'));
authForm.addEventListener('submit',event=>{event.preventDefault();authorize('login');});
signOut.addEventListener('click',async()=>{
  try{await logout();activeUser=null;isPlus=false;resetActivities();updateControls();message('Signed out. Guest mode is available.');}
  catch{message('Sign-out did not complete. Please retry.');}
});
for(const [button,period] of [[monthly,'monthly'],[annual,'annual']]){
 button.addEventListener('click',async()=>{
  button.disabled=true;
  try{
    const result=await api('/api/billing/checkout',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({period})
    });
    if(!/^https:\/\/checkout\.stripe\.com\//.test(result.url||''))throw new Error('invalid_checkout');
    window.location.assign(result.url);
  }catch{message('Secure checkout is not yet available. No payment was initiated.');}
  finally{button.disabled=false;}
 });
}
manage.addEventListener('click',async()=>{
  manage.disabled=true;
  try{
    const data=await api('/api/billing/portal',{method:'POST'});
    if(!/^https:\/\/billing\.stripe\.com\//.test(data.url||''))throw new Error('invalid_portal');
    window.location.assign(data.url);
  }catch{message('Subscription management is temporarily unavailable.');}
  finally{manage.disabled=false;}
});
window.spinFamilyPlus={
  async add(name,category){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const data=await api('/api/household/activities',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({name,category})});
    return data.activity;
  }
};
(async()=>{
  try{await handleAuthCallback();await refresh();}
  catch{activeUser=null;isPlus=false;resetActivities();updateControls();
    message('Account services are temporarily unavailable. Free activities still work.');}
})();
