const panel=document.getElementById('tomorrowPanel');
const choices=document.getElementById('tomorrowChoices'),status=document.getElementById('tomorrowStatus'),results=document.getElementById('tomorrowResults');
const button=document.getElementById('tomorrowGenerate');
let revision=0,loaded=false;
button.textContent='Choose for tomorrow';
const reset=()=>{revision++;results.replaceChildren();status.textContent='';};
window.addEventListener('spinfamily:history',e=>{reset();panel.hidden=!e.detail||Boolean(e.detail.error);loaded=false;choices.replaceChildren();button.textContent='Choose for tomorrow';});
panel.addEventListener('input',reset);
button.addEventListener('click',async()=>{
 const epoch=++revision;button.disabled=true;results.replaceChildren();
 try{
  if(!loaded){
   status.textContent='Loading household planning choices…';
   const data=await window.spinFamilyHistory.planningChoices();if(epoch!==revision)return;
   for(const a of data.activities){
    const row=document.createElement('div'),name=document.createElement('span');name.textContent=a.name+' ';row.append(name);
    for(const [key,label] of [['include','Prefer'],['exclude','Exclude'],['pins','Must include'],['routines','Routine']]){
     const wrap=document.createElement('label'),input=document.createElement('input');
     input.type='checkbox';input.value=a.id;input.dataset.choice=key;wrap.append(input,document.createTextNode(label+' '));row.append(wrap);
    }choices.append(row);
   }
   loaded=true;button.textContent='Generate suggestions';status.textContent='Choose routines or overrides below, then generate suggestions.';return;
  }
  status.textContent='Checking feasible suggestions for tomorrow…';
  const options={start:document.getElementById('tomorrowStart').value,end:document.getElementById('tomorrowEnd').value,energy:document.getElementById('tomorrowEnergy').value};
  for(const key of ['include','exclude','pins','routines'])options[key]=[...choices.querySelectorAll('input[data-choice="'+key+'"]:checked')].map(e=>e.value);
  const fixedStart=document.getElementById('tomorrowFixedStart').value,fixedEnd=document.getElementById('tomorrowFixedEnd').value;
  if(fixedStart||fixedEnd)options.fixedEvents=[{id:'caregiver_commitment',start:fixedStart,end:fixedEnd,bufferBeforeMin:0,bufferAfterMin:0}];
  const data=await window.spinFamilyHistory.suggest(options);if(epoch!==revision)return;
  status.textContent=data.date+' · '+data.timezone+' · '+data.message;
  for(const [i,p] of data.plans.entries()){
   const card=document.createElement('article');card.className='history-record';
   const title=document.createElement('strong');title.textContent='Suggestion '+(i+1);card.append(title);
   for(const a of p.activities){
    const line=document.createElement('p'),clock=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
    line.textContent=clock(a.start)+'–'+clock(a.end)+' · '+a.name;card.append(line);
   }results.append(card);
  }
 }catch(e){if(epoch===revision)status.textContent=e.message==='save_plan_timezone_first'?'Save your first household plan to set its timezone.':'Tomorrow’s private suggestions are unavailable in this preview. Your free wheel and completion history remain available.';}
 finally{button.disabled=false;}
});

