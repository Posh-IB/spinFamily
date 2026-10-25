'use strict';
// Fixed household slots keep the Free limits enforceable on the server.
const DEFAULTS=Object.freeze([
 {slot:'parent1',name:'Mom',kind:'parent',tone:0},
 {slot:'parent2',name:'Dad',kind:'parent',tone:0},
 {slot:'child1',name:'Emma',kind:'child',tone:0},
 {slot:'child2',name:'Lucas',kind:'child',tone:0}
]);
const ALL=new Set(['parent1','parent2','child1','child2','child3','child4','adult1']);
const CHILD_ADDITIONS=new Set(['child3','child4']);
const EXTRA_ADULT='adult1';
const kind=slot=>slot.startsWith('child')?'child':slot==='adult1'?'adult':'parent';
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_profile');
 const keys=Object.keys(body);
 if(body.action==='save'){
  if(keys.length!==4||keys.some(k=>!['action','slot','name','tone'].includes(k)))throw Error('invalid_profile');
  if(!ALL.has(body.slot)||typeof body.name!=='string'||typeof body.tone!=='number')throw Error('invalid_profile');
  const name=body.name.trim().replace(/\s+/gu,' ');
  if(name.length<1||name.length>40||/[\u0000-\u001f\u007f<>]/u.test(name)||
    !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u.test(name))throw Error('invalid_profile');
  if(!Number.isInteger(body.tone)||body.tone<0||body.tone>5)throw Error('invalid_profile');
  return {action:'save',slot:body.slot,name,tone:body.tone};
 }
 if(body.action==='remove'&&keys.length===2&&keys.every(k=>['action','slot'].includes(k))&&
    (CHILD_ADDITIONS.has(body.slot)||body.slot===EXTRA_ADULT))return {action:'remove',slot:body.slot};
 throw Error('invalid_profile');
}
function present(rows,plus){
 const map=new Map((Array.isArray(rows)?rows:[]).filter(r=>ALL.has(r.profile_slot)).map(r=>[r.profile_slot,r]));
 const members=DEFAULTS.map(d=>({slot:d.slot,name:map.get(d.slot)?.display_alias??d.name,kind:d.kind,tone:map.get(d.slot)?.skin_tone??0}));
 for(const slot of ['child3','child4','adult1']){
  if(slot==='adult1'&&!plus)continue;
  const row=map.get(slot);
  if(row)members.push({slot,name:row.display_alias,kind:kind(slot),tone:row.skin_tone});
 }
 return members;
}
module.exports={DEFAULTS,ALL,CHILD_ADDITIONS,EXTRA_ADULT,validate,present};
