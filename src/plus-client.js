import './tomorrow-client.js';
import './family-profiles.js';
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
const openSignIn = byId('accountOpenSignIn');
const openCreate = byId('accountOpenCreate');
const membershipText = byId('accountMembershipText');
let authBusy = false, signupAllowed = true, logoutBusy = false, sessionUncertain = false;
const sessionReady=()=>Boolean(activeUser)&&!logoutBusy&&!sessionUncertain;
let activeUser = null, isPlus = false, checkoutReady=false, portalReady=false, generation=0;

function message(value) { status.textContent = value; }
function accountPanel(open,mode='signin'){
  panel.hidden=!open;
  openSignIn.setAttribute('aria-expanded',String(open));
  openCreate.setAttribute('aria-expanded',String(open));
  if(open){
    if(!activeUser&&!sessionUncertain)message(mode==='signup'?'Create a free account to save family plans and streaks. No purchase required.':'Sign in to save your family progress. No purchase required.');
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
    (activeUser||sessionUncertain?signOut:email).focus();
  }
}
openSignIn.addEventListener('click',()=>accountPanel(true,'signin'));
openCreate.addEventListener('click',()=>accountPanel(true,'signup'));
function resetActivities() {
  window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:null}));
  // Clearing a household's activities on logout prevents account crossover.
  window.spinFamilyHydrateCustomActivities?.([]);
}
function updateControls() {
  window.dispatchEvent(new CustomEvent('spinfamily:entitlement',{detail:{plus:isPlus&&sessionReady()}}));
  const authenticated = Boolean(activeUser)||sessionUncertain;
  authForm.hidden = authenticated;
  signOut.hidden = !authenticated;
  monthly.hidden = !authenticated || isPlus || !checkoutReady;
  annual.hidden = !authenticated || isPlus || !checkoutReady;
  manage.hidden = !authenticated || !portalReady;
  byId('activityForm').hidden = !isPlus;
  signOut.disabled=logoutBusy||authBusy;
  membershipText.textContent=logoutBusy?'Signing out…':sessionUncertain?'Session could not be verified':!authenticated?'Guest · Progress is not saved':isPlus?'Plus household · Progress saved':'Free household · Progress saved';
  openSignIn.hidden=false;
  openSignIn.textContent=authenticated?'Account':'Sign in';
  openSignIn.disabled=logoutBusy;
  openCreate.hidden=authenticated || !signupAllowed;
  signUp.hidden=!signupAllowed;
  signIn.disabled=authBusy;signUp.disabled=authBusy;
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
  activeUser=user;sessionUncertain=false;
  window.spinFamilyProfiles?.activate(Boolean(activeUser));
  checkoutReady=false;portalReady=false;
  isPlus=false;
  resetActivities();
  if(!activeUser) {
    message('Guest mode: the wheel is free. Create a free account to save family progress.');
    updateControls();return;
  }
  updateControls();
  message('Signed in. Loading your saved family progress…');
  try{await loadHistory();}catch{if(epoch===generation)window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:{error:'Saved progress is temporarily unavailable.'}}));}
  if(epoch!==generation)return;
  let subscriptionChecked=false;
  try {
    const data=await api('/api/household/activities');
    if(epoch!==generation)return;
    isPlus=true;
    window.spinFamilyHydrateCustomActivities?.(data.activities||[]);
    message('SpinFamily Plus is active. Your custom activities are saved to your household.');
  } catch (error) {
    if(epoch!==generation)return;
    if(error.message==='plus_required'||error.message==='household_not_found'){
      subscriptionChecked=true;
      message('Free account active. Your plans, completions and streaks can be saved. Plus adds custom activities.');
    }else message('Subscription check is unavailable. Premium features are temporarily disabled.');
  }
  try{
    const ready=await api('/api/billing/status');
    if(epoch!==generation)return;
    checkoutReady=ready.checkoutReady===true;portalReady=ready.portalReady===true;
  }catch{}
  if(epoch!==generation)return;
  if(subscriptionChecked&&!checkoutReady)message('Free account active. Progress saving is free; Plus checkout is temporarily unavailable.');
  updateControls();
}
async function authorize(action) {
  if(authBusy||logoutBusy||sessionUncertain)return;
  const address=email.value.trim(),secret=password.value;
  if(!email.reportValidity())return message('Enter a valid email address to '+(action==='signup'?'create your free account.':'sign in.'));
  if(!password.reportValidity())return message('Enter a password of at least 8 characters.');
  if(!address||!secret)return message('Email and password are required.');
  authBusy=true;updateControls();message(action==='signup'?'Creating your free account…':'Signing in…');
  try{
    if(action==='signup'){
      await signup(address,secret);
      password.value='';
      message('Account request submitted. If confirmation is required, check your email before signing in.');
      return;
    }
    await login(address,secret);
    password.value='';
    await refresh();
    accountPanel(false);
  }catch(error){
    const msg=String(error?.message||'').slice(0,180);
    message((action==='signup'?'Account creation failed: ':'Sign-in failed: ')+(msg||'Check your details or try again.'));
  }finally{authBusy=false;updateControls();}
}
signIn.addEventListener('click',()=>authorize('login'));
signUp.addEventListener('click',()=>authorize('signup'));
authForm.addEventListener('submit',event=>{event.preventDefault();authorize('login');});
signOut.addEventListener('click',async()=>{
  if(logoutBusy||authBusy)return;
  const epoch=++generation;
  logoutBusy=true;sessionUncertain=true;isPlus=false;checkoutReady=false;portalReady=false;
  window.spinFamilyProfiles?.activate(false);
  resetActivities();updateControls();message('Signing out…');
  try{
    await logout();
    if(epoch!==generation)return;
    activeUser=null;sessionUncertain=false;
    message('Signed out. Guest mode is available, or sign in to save progress.');
  }catch{
    // A rejected provider request does not establish that either session ended.
    try{
      const [user,server]=await Promise.all([getUser(),api('/api/account/session')]);
      if(epoch!==generation)return;
      if(!user&&!server.authenticated){
        activeUser=null;sessionUncertain=false;
        message('Signed out. Guest mode is available, or sign in to save progress.');
      }else if(user&&server.authenticated&&server.subject===user.id){
        activeUser=user;sessionUncertain=false;
        // Keep requests disabled until fresh household authorization is restored.
        await refresh();
        message('Sign-out did not complete. You are still signed in. Please retry.');
      }else message('Sign-out did not complete. Session status could not be verified. Please retry.');
    }catch{sessionUncertain=true;isPlus=false;resetActivities();message('Sign-out did not complete. Session status could not be verified. Please retry.');}
  }finally{
    logoutBusy=false;updateControls();
  }
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
  if(!activeUser||sessionUncertain)return null;
  const epoch=generation,subject=activeUser.id;
  const data=await api('/api/household/plans');
  if(epoch!==generation||!activeUser||activeUser.id!==subject)throw new Error('session_changed');
  window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:data}));
  return data;
}
window.spinFamilyHistory={
  eligible:sessionReady,
  async older(cursor){
    if(!sessionReady()||typeof cursor!=='string'||cursor.length>160)throw new Error('invalid_history_cursor');
    const epoch=generation,subject=activeUser.id;
    const data=await api('/api/household/plans?cursor='+encodeURIComponent(cursor));
    if(epoch!==generation||!activeUser||activeUser.id!==subject||sessionUncertain)throw new Error('session_changed');
    return data;
  },
  async planningChoices(){
    if(!sessionReady()||!isPlus)throw new Error('plus_required');
    const epoch=generation,data=await api('/api/household/suggestions');
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    return data;
  },
  async suggest(options){
    if(!sessionReady()||!isPlus)throw new Error('plus_required');
    const epoch=generation,data=await api('/api/household/suggestions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options)});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    return data;
  },
  refresh:loadHistory,
  async accept(plan){
    if(!sessionReady())throw new Error('authentication_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'accept',plan})});
    if(epoch!==generation||!activeUser)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  },
  async complete(id){
    if(!sessionReady())throw new Error('authentication_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'complete',id})});
    if(epoch!==generation||!activeUser)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  },
  async remove(id){
    if(!sessionReady())throw new Error('authentication_required');
    const epoch=generation;
    const result=await api('/api/household/plans',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'delete',id})});
    if(epoch!==generation||!activeUser)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:result}));
    return result;
  }
};
window.spinFamilyPlus={
  async add(name,category,planning){
    if(!sessionReady()||!isPlus)throw new Error('plus_required');
    const epoch=generation;
    const data=await api('/api/household/activities',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({name,category,...(planning?{planning}:{})})});
    if(epoch!==generation||!activeUser||!isPlus)throw new Error('session_changed');
    window.dispatchEvent(new CustomEvent('spinfamily:catalog-changed'));
    return data.activity;
  }
};
(async()=>{
  try{
    const settings=await getSettings();
    signupAllowed=!Boolean(settings.disableSignup);
    updateControls();
    if(!signupAllowed)message('Free registration is currently closed by the identity provider. Existing accounts can still sign in.');
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
