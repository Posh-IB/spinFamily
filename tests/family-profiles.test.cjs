'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,present}=require('../lib/family-profiles.cjs');
test('Free family profiles include two adults and two children',()=>{
 const family=present([],false);
 assert.deepEqual(family.map(m=>m.slot),['parent1','parent2','child1','child2']);
 assert.equal(family[0].name,'Mom');assert.equal(family[2].name,'Emma');
});
test('Free can keep two additional children and recolor or rename any profile',()=>{
 const family=present([{profile_slot:'child3',display_alias:'Alex',skin_tone:5},{profile_slot:'child4',display_alias:'Jamie',skin_tone:1},
  {profile_slot:'parent1',display_alias:'Mama',skin_tone:4}],false);
 assert.equal(family.length,6);
 assert.equal(family[0].name,'Mama');assert.equal(family[0].tone,4);
 assert.equal(family[4].name,'Alex');
});
test('Extra adult only appears for verified Plus view',()=>{
 const records=[{profile_slot:'adult1',display_alias:'Auntie',skin_tone:3}];
 assert.equal(present(records,false).length,4);
 assert.equal(present(records,true).at(-1).name,'Auntie');
});
test('Reject injected or unexpected keys and unbounded names or tones',()=>{
 const good={action:'save',slot:'child3',name:' Amélie ',tone:5};
 assert.deepEqual(validate(good),{...good,name:'Amélie'});
 for(const obj of [
  {...good,email:'secret@test.example'}, {...good,slot:'adult2'},
  {...good,name:'<script>alert(1)</script>'}, {...good,name:'   '},
  {...good,tone:6}, {...good,tone:-1}, {...good,tone:'5'},
  {action:'remove',slot:'parent1'},{action:'save',slot:'child5',name:'Sam',tone:0}
 ])assert.throws(()=>validate(obj),/invalid_profile/);
 assert.deepEqual(validate({action:'remove',slot:'child4'}),{action:'remove',slot:'child4'});
});
