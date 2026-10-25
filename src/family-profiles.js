// Free profile editing; the household server owns Plus authorization.
const byId=id=>document.getElementById(id);
const names={parent1:'Mom',parent2:'Dad',child1:'Emma',child2:'Lucas'};
let state=[],signedIn=false,epoch=0;
const bases={parent1:'👩',parent2:'👨',child1:'👧',child2:'👦',child3:'🧒',child4:'🧒',adult1:'🧑'};
const modifiers=['','🏻','🏼','🏽','🏾','🏿'];
const avatar=m=>(bases[m.slot]||'🧑')+modifiers[m.tone||0];
const legacy={parent1:'Mom',parent2:'Dad',child1:'Emma',child2:'Lucas'};
const publicId=slot=>legacy[slot]||slot;
const defaults=()=>['parent1','parent2','child1','child2'].map(slot=>({slot,name:names[slot],kind:slot.startsWith('child')?'child':'parent',tone:0}));
function render(){
 const cards=byId('familyProfileCards');
 cards.replaceChildren();
 for(const m of state){
  const row=document.createElement('div');row.className='profile-card';
  const title=document.createElement('strong');title.textContent=avatar(m)+' '+m.name;row.append(title);
  if(signedIn){
   const input=document.createElement('input');input.value=m.name;input.maxLength=40;input.setAttribute('aria-label','Name for '+m.name);
   const select=document.createElement('select');select.setAttribute('aria-label','Emoji complexion for '+m.name);
   for(let i=0;i<=5;i++){const opt=document.createElement('option');opt.value=String(i);opt.textContent=i===0?'Default emoji':'Skin tone '+i;select.append(opt);}
   select.value=String(m.tone);
   const save=document.createElement('button');save.type='button';save.textContent='Save';
   save.addEventListener('click',()=>change({action:'save',slot:m.slot,name:input.value,tone:Number(select.value)}));
   row.append(input,select,save);
   if(m.slot==='child3'||m.slot==='child4'||m.slot==='adult1'){
    const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.addEventListener('click',()=>change({action:'remove',slot:m.slot}));row.append(remove);
   }
  }
  cards.append(row);
 }
 const availableChildren=['child3','child4'].filter(slot=>!state.some(m=>m.slot===slot));
 byId('familyAddChild').hidden=!signedIn||availableChildren.length===0;
 byId('familyAddAdult').hidden=!signedIn||state.some(m=>m.slot==='adult1');
 const adults=state.find(m=>m.slot==='adult1');
 byId('familyProfileHelp').textContent=signedIn?'Two additional child profiles are included with Free. A third adult profile requires Plus.':'Sign in with a Free account to save names and emoji preferences.';
 const bindings=[['members','#members','data-member'],['familyOptions','.family-options','data-family-member']];
 for(const [key,selector,attr] of bindings){
  const holder=document.querySelector(selector);if(!holder)continue;
  holder.replaceChildren();
  for(const m of state){
   const button=document.createElement('button');button.type='button';button.setAttribute(attr,publicId(m.slot));
   if(key==='members')button.className='member';
   const emoji=document.createElement('span');emoji.className=key==='members'?'member-icon':'family-emoji';emoji.textContent=avatar(m);
   const title=document.createElement('span');title.className='member-name';title.textContent=m.name;
   button.append(emoji,title);holder.append(button);
   button.addEventListener('click',()=>choose(m.slot));
  }
 }
 const select=byId('activityParticipantSelect');select.replaceChildren();
 for(const m of state){const option=document.createElement('option');option.value=publicId(m.slot);option.textContent=m.name;select.append(option);}
 choose(state.some(m=>m.slot===selected)?selected:'parent1');
}
let selected='parent1';
function choose(slot){
 const m=state.find(x=>x.slot===slot||publicId(x.slot)===slot);if(!m)return;
 slot=m.slot;
 selected=m.slot;
 document.querySelectorAll('[data-member]').forEach(el=>{const yes=el.dataset.member===publicId(slot);el.classList.toggle('active',yes);el.setAttribute('aria-pressed',String(yes));});
 document.querySelectorAll('[data-family-member]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.familyMember===publicId(slot))));
 byId('memberContext').textContent=m.name+' is selected for this session. Suggestions are not personalized by member.';
 byId('familySelection').textContent='Currently choosing: '+m.name;
 byId('activityParticipantAvatar').textContent=avatar(m);
 byId('activityParticipantName').textContent='Choosing with '+m.name;
 byId('activityParticipantSelect').value=publicId(slot);
 window.spinFamilyCurrentMemberName=m.name;
}
async function change(body){
 if(!signedIn)return;
 const feedback=byId('familyProfileStatus');feedback.textContent='Saving…';
 try{
  const response=await fetch('/api/household/members',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'save_failed');
  state=data.members;render();feedback.textContent='Family profiles saved.';
 }catch(e){feedback.textContent=e.message==='plus_required'?'An additional adult profile requires Plus.':'Could not save profile. Please check the name and try again.';}
}
async function activate(active){
 epoch++;const token=epoch;signedIn=Boolean(active);state=defaults();render();
 if(!active)return;
 try{
  const response=await fetch('/api/household/members',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('unavailable');const data=await response.json();
  if(token!==epoch)return;
  state=data.members;render();
 }catch{if(token===epoch)byId('familyProfileStatus').textContent='Family profile service is temporarily unavailable.';}
}
byId('familyAddChild').addEventListener('click',()=>{
 const slot=['child3','child4'].find(slot=>!state.some(m=>m.slot===slot));
 if(slot)change({action:'save',slot,name:slot==='child3'?'Child 3':'Child 4',tone:0});
});
byId('familyAddAdult').addEventListener('click',()=>change({action:'save',slot:'adult1',name:'Additional adult',tone:0}));
byId('activityParticipantSelect').addEventListener('change',e=>choose(e.target.value));
window.spinFamilyProfiles={activate,choose,getSelectedName:()=>state.find(m=>m.slot===selected)?.name||'Mom'};
render();
