import './tomorrow-client.js';
import { signup, login, logout, getUser, handleAuthCallback, getSettings, oauthLogin } from '@netlify/identity';

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
let activeUser = null, isPlus = false, checkoutReady=false, portalReady=false, generation=0;

function message(value) { status.textContent = value; }
function resetActivities() {
  window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:null}));
  // Clearing a household's activities on logout prevents account crossover.
  window.spinFamilyHydrateCustomActivities?.([]);
}
function updateControls() {
  const authenticated = Boolean(activeUser);
  authForm.hidden = authenticated;
  signOut.hidden = !authenticated;
  monthly.hidden = !authenticated || isPlus || !checkoutReady;
  annual.hidden = !authenticated || isPlus || !checkoutReady;
  manage.hidden = !authenticated || !portalReady;
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
  const epoch=++generation;
  const user=await getUser();
  if(epoch!==generation)return;
  activeUser=user;
  checkoutReady=false;portalReady=false;
  isPlus=false;
  resetActivities();
  if(!activeUser) {
    message('Guest mode: the family wheel and curated activities remain free. Sign in for SpinFamily Plus.');
    updateControls();return;
  }
  updateControls();
  message('Signed in. Checking your SpinFamily Plus subscription…');
  let subscriptionChecked=false;
  try {
    const data=await api('/api/household/activities');
    if(epoch!==generation)return;
    isPlus=true;
    window.spinFamilyHydrateCustomActivities?.(data.activities||[]);
    try { await loadHistory(); } catch { if(epoch===generation)window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:{error:'History is temporarily unavailable.'}})); }
    message('SpinFamily Plus is active. Your custom activities are saved to your household.');
  } catch (error) {
    if(epoch!==generation)return;
    if(error.message==='plus_required'||error.message==='household_not_found'){
      subscriptionChecked=true;
      message('Signed in. Choose a SpinFamily Plus plan to save custom activities.');
    }else message('Subscription check is unavailable. Premium features are temporarily disabled.');
  }
  try{
    const ready=await api('/api/billing/status');
    if(epoch!==generation)return;
    checkoutReady=ready.checkoutReady===true;portalReady=ready.portalReady===true;
  }catch{}
  if(epoch!==generation)return;
  if(subscriptionChecked&&!checkoutReady)message('Signed in. Plus checkout is not available yet. Free activities remain available.');
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
  ++generation;activeUser=null;isPlus=false;checkoutReady=false;portalReady=false;resetActivities();updateControls();
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
async function loadHistory(){
  if(!activeUser||!isPlus)return null;
  const epoch=generation,subject=activeUser.id;
  const data=await api('/api/household/plans');
  if(epoch!==generation||!activeUser||!isPlus||activeUser.id!==subject)throw new Error('session_changed');
  window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:data}));
  return data;
}
window.spinFamilyHistory={
  eligible:()=>Boolean(activeUser&&isPlus),
  async planningChoices(){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation,data=await api('/api/household/suggestions');
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    return data;
  },
  async suggest(options){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation,data=await api('/api/household/suggestions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options)});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    return data;
  },
  refresh:loadHistory,
  async accept(plan){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'accept',plan})});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  },
  async complete(id){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'complete',id})});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  },
  async remove(id){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'delete',id})});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  }
};
window.spinFamilyPlus={
  async add(name,category){
    if(!activeUser||!isPlus)throw new Error('plus_required');
    const epoch=generation;
    const data=await api('/api/household/activities',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({name,category})});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    return data.activity;
  }
};
(async()=>{
  try{
    const settings=await getSettings();
    signUp.hidden=settings.disableSignup;
    for(const [provider,enabled] of Object.entries(settings.providers||{})){
      if(!enabled||provider==='email')continue;
      const button=document.createElement('button');button.type='button';
      button.textContent='Continue with '+provider;
      button.addEventListener('click',()=>oauthLogin(provider));authForm.append(button);
    }
    await handleAuthCallback();await refresh();
  }
  catch{activeUser=null;isPlus=false;resetActivities();updateControls();
    message('Account services are temporarily unavailable. Free activities still work.');}
})();
