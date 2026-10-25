// First-party, account-level product measurement. Default off; no third-party SDK.
// Deliberately excludes form inputs, profile data, activity names and payment details.
const consent=document.getElementById('analyticsConsent');
const panel=document.getElementById('analyticsPreference');
const status=document.getElementById('analyticsConsentStatus');
const screens={spinPage:'home',activitiesPage:'activities',familyPage:'family',guidePage:'guide',aboutPage:'more'};
let authenticated=false,enabled=false,generation=0,sessionId=crypto.randomUUID(),queue=[],sending=false,timer=null;
let screen='home',activeSince=null;
const allow=new Set(['session_started','screen_viewed','screen_exited','wheel_spun','plan_viewed','plan_accepted','plan_completed','custom_activity_created','upgrade_clicked','checkout_started','checkout_canceled']);
function emit(name,options={}){
 if(!enabled||!authenticated||!allow.has(name))return;
 const event={eventId:crypto.randomUUID(),name,screen,...options};
 queue.push(event);
 if(queue.length>=12)flush();else schedule();
}
function schedule(){if(timer!==null)return;timer=setTimeout(()=>{timer=null;flush();},1200);}
async function flush(){
 if(!enabled||!authenticated||sending||queue.length===0)return;
 if(timer!==null){clearTimeout(timer);timer=null;}
 sending=true;
 const events=queue.splice(0,12),body=JSON.stringify({sessionId,events});
 try{
  const response=await fetch('/api/product/events',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,headers:{'content-type':'application/json'},body});
  if(response.status===403||response.status===401){enabled=false;queue=[];consent.checked=false;status.textContent='Usage measurement is off.';}
 }catch{/* Measurement never blocks app interactions. */}
 finally{sending=false;if(enabled&&queue.length)schedule();}
}
function stopVisible(){
 if(activeSince===null)return;
 const elapsed=Math.min(300000,Math.max(0,Math.round(performance.now()-activeSince)));
 activeSince=null;
 if(elapsed>=1000)emit('screen_exited',{activeMs:elapsed});
}
function startVisible(){
 if(!enabled||!authenticated||document.visibilityState!=='visible')return;
 emit('screen_viewed');
 activeSince=performance.now();
}
function deactivate(){
 generation++;stopVisible();authenticated=false;enabled=false;activeSince=null;
 queue=[];consent.checked=false;panel.hidden=true;if(timer!==null){clearTimeout(timer);timer=null;}
}
async function setAccount(signedIn){
 deactivate();
 if(!signedIn)return;
 authenticated=true;
 const epoch=generation;
 panel.hidden=false;consent.disabled=true;status.textContent='Loading your preference…';
 try{
  const response=await fetch('/api/product/consent',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('unavailable');
  const state=await response.json();if(epoch!==generation)return;
  enabled=state.enabled===true;consent.checked=enabled;
  status.textContent=enabled?'Limited interaction metrics are on. Uncheck to delete collected events.':'Off by default. No activity events are being collected.';
  if(enabled){sessionId=crypto.randomUUID();emit('session_started');startVisible();if(new URL(location.href).searchParams.get('billing')==='cancel')emit('checkout_canceled');}
 }catch{if(epoch===generation){enabled=false;consent.checked=false;status.textContent='Usage measurement unavailable; tracking remains off.';}}
 finally{if(epoch===generation)consent.disabled=false;}
}
consent.addEventListener('change',async()=>{
 if(!authenticated)return;
 const next=consent.checked;
 consent.disabled=true;status.textContent='Updating preference…';
 if(!next){stopVisible();enabled=false;queue=[];}
 try{
  const response=await fetch('/api/product/consent',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:next})});
  if(!response.ok)throw Error('unavailable');
  const state=await response.json();
  enabled=state.enabled===true;consent.checked=enabled;
  if(enabled){sessionId=crypto.randomUUID();emit('session_started');startVisible();}
  status.textContent=enabled?'Limited interaction metrics are on. Uncheck to delete collected events.':'Usage measurement is off; prior events were deleted.';
 }catch{enabled=false;consent.checked=false;status.textContent='Preference could not be confirmed. Tracking is off.';}
 finally{consent.disabled=false;}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopVisible();else startVisible();});
window.addEventListener('pagehide',()=>{stopVisible();flush();});
window.spinFamilyAnalytics={
 setAccount,
 track(name,options){emit(name,options);},
 changeScreen(id){
  const next=screens[id];if(!next||next===screen)return;
  stopVisible();screen=next;startVisible();
 },
};
