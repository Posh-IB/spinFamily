'use strict';
const {activityId}=require('./recommendation-contract.cjs');
const fields=['durationMin','prepMin','cleanupMin','energy','costCents','locationMode','availabilityConfirmed'];
function planningMetadata(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k)))throw Error('invalid_planning_metadata');
 for(const [k,min,max] of [['durationMin',1,180],['prepMin',0,60],['cleanupMin',0,60],['costCents',0,100000]])if(!Number.isSafeInteger(value[k])||value[k]<min||value[k]>max)throw Error('invalid_planning_metadata');
 if(!['low','medium','high'].includes(value.energy)||!['home','away'].includes(value.locationMode)||typeof value.availabilityConfirmed!=='boolean')throw Error('invalid_planning_metadata');
 return {...value};
}
function householdCatalog(curated,rows){
 const out=[...curated],known=new Set(out.map(a=>a.id));
 for(const row of rows){
  let p;try{p=planningMetadata(row.planning_metadata);}catch{continue;}
  // Outdoor and away ideas need venue/weather integration before they can be suggested.
  if(row.category==='outdoor'||p.locationMode!=='home'||!p.availabilityConfirmed)continue;
  const id=activityId(row);if(known.has(id))continue;
  known.add(id);out.push({id,title:row.name,category:row.category,...p});
 }
 return out;
}
module.exports={planningMetadata,householdCatalog};
