import {getUser,getSettings,handleAuthCallback,login,signup,logout,oauthLogin} from '@netlify/identity';
const $=id=>document.getElementById(id);
let user=null,plus=false,generation=0;
const message=text=>{$('householdStatus').textContent=text;};
async function api(path,method='GET',data){const response=await fetch('/api/household/'+path,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok)throw Error(result.error||'service_unavailable');return result;}
function clear(){generation++;plus=false;window.spinHouseholdActivities?.([]);$('savedActivities').replaceChildren();$('householdPlus').hidden=true;$('saveHouseholdActivity').hidden=true;}
async function refresh(){
 const current=++generation;plus=false;window.spinHouseholdActivities?.([]);$('savedActivities').replaceChildren();$('householdPlus').hidden=true;$('saveHouseholdActivity').hidden=true;
 user=await getUser();$('householdLogin').hidden=!!user;$('householdLogout').hidden=!user;
 if(!user){clear();message('Guest mode. Session activities and the wheel stay free.');return;}
 const account=await api('account');if(current!==generation)return;
 plus=account.plus;message(plus?'Plus verified. Saved activities belong to this household.':'Signed in. Plus has not been verified.');$('householdPlus').hidden=!plus;$('saveHouseholdActivity').hidden=!plus;
 if(plus)await load(current);
}
async function load(current=generation){
 const result=await api('activities');if(current!==generation||!plus)return;
 window.spinHouseholdActivities?.(result.activities);$('savedActivities').replaceChildren();
 for(const a of result.activities){const row=document.createElement('li'),name=document.createElement('span');name.textContent=a.name+' ';row.append(name);
  for(const [label,method] of [['Edit','PATCH'],['Delete','DELETE']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',label+' '+a.name);button.onclick=async()=>{const next=method==='PATCH'?prompt('Family-friendly activity name',a.name):null;if(method==='PATCH'&&next===null)return;button.disabled=true;try{await api('activities',method,{id:a.id,name:next,category:a.category});await refresh();}catch(e){message('Saved activity could not be changed: '+e.message);}finally{button.disabled=false;}};row.append(button);} $('savedActivities').append(row);
 }
}
$('householdLogin').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const email=$('householdEmail').value,password=$('householdPassword').value;if(button.value==='signup'){await signup(email,password);message('Check your email to confirm your account.');}else await login(email,password);$('householdPassword').value='';await refresh();}catch{message('Account request could not be completed. Check your details or confirmation email.');}finally{button.disabled=false;}};
$('householdLogout').onclick=async()=>{clear();try{await logout();user=null;await refresh();}catch{message('Sign-out could not be confirmed. Saved activities have been cleared from this view.');}};
$('householdRefresh').onclick=()=>refresh().catch(()=>{clear();message('Household service unavailable. Guest planning remains available.');});
$('saveHouseholdActivity').onclick=async()=>{if(!plus)return;const button=$('saveHouseholdActivity');button.disabled=true;const current=generation;try{await api('activities','POST',{name:$('activityName').value,category:$('activityCategory').value});if(current!==generation)return;await refresh();message('Activity saved to your household.');}catch(e){if(current===generation)message('Activity was not saved: '+e.message);}finally{button.disabled=false;}};
for(const plan of ['monthly','annual'])$('checkout-'+plan).onclick=async()=>{if(!user){message('Sign in before requesting Plus checkout.');return;}try{const result=await api('checkout','POST',{plan});const u=new URL(result.url);if(u.origin!=='https://buy.stripe.com'||!u.pathname.startsWith('/test_'))throw Error('invalid_checkout');window.location.assign(u.href);}catch(e){message('Test checkout unavailable: '+e.message);}};
(async()=>{try{
 const result=await handleAuthCallback();
 if(result?.type==='recovery'||result?.type==='invite'){message('Account callback received. Password setup is not available in this preview.');return;}
 const settings=await getSettings();$('householdSignup').hidden=settings.disableSignup||!settings.providers.email;
 for(const provider of ['google','github','gitlab','bitbucket'])if(settings.providers[provider]){const b=document.createElement('button');b.type='button';b.textContent='Sign in with '+provider;b.onclick=()=>oauthLogin(provider);$('householdProviders').append(b);}
 await refresh();
}catch{clear();message('Account service is not configured for this environment. Guest planning remains available.');}})();
