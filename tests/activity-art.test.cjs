const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const sandbox={document:{addEventListener(){}},escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),HTMLImageElement:class{}};
vm.createContext(sandbox);
vm.runInContext(script.slice(script.indexOf('const defaults='),script.indexOf('let custom=[]')),sandbox);
vm.runInContext(script.slice(script.indexOf('const activityArtwork='),script.indexOf('function renderActivities(){')),sandbox);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/activities/manifest.json'),'utf8'));
test('all 20 supplied independent images exist and are mapped exactly once',()=>{
 assert.equal(Object.keys(manifest).length,20);assert.equal(new Set(Object.values(manifest)).size,20);
 for(const [slug,file] of Object.entries(manifest)){assert.ok(fs.statSync(path.join(root,file)).size>1000);const markup=vm.runInContext('cardArt('+JSON.stringify(slug.replaceAll('-',' '))+',"family")',sandbox);assert.ok(markup.includes('src="'+file+'"'));}
 assert.ok(!fs.existsSync(path.join(root,'assets/cinematic-family-atlas.webp')));assert.doesNotMatch(html,/cinematic-family-atlas|cardArtPositions|background-size:300%/);
});
test('19 curated exact illustrations plus explicit bedtime category fallback preserve all 20 catalog activities',()=>{
 const result=vm.runInContext('Object.entries(defaults).flatMap(([cat,items])=>items.map(x=>[x[1],cat,cardArt(x[1],cat)]))',sandbox);
 assert.equal(result.length,20);
 const bedtime=result.find(x=>x[0]==='Early bedtime routine');assert.ok(bedtime[2].includes('src="assets/activities/quiet-reading.webp"'));assert.ok(bedtime[2].includes('Representative Relax &amp; Unwind illustration'));
 for(const [name,category,markup] of result.filter(x=>x[0]!=='Early bedtime routine')){const slug=name.toLowerCase().replaceAll(' ','-');assert.ok(markup.includes('src="'+manifest[slug]+'"'),name);}
});
test('custom and prototype-property names use safe category imagery and escaped alternative text',()=>{
 for(const category of ['chore','outdoor','family','selfcare']){const markup=vm.runInContext('cardArt("A new activity",'+JSON.stringify(category)+')',sandbox);assert.ok(markup.includes('Representative'));assert.ok(markup.includes('data-art-fallback='));}
 for(const name of ['constructor','__proto__','toString'])assert.ok(vm.runInContext('cardArt('+JSON.stringify(name)+',"family")',sandbox).includes('src="assets/activities/arts-and-crafts.webp"'));
 const markup=vm.runInContext('cardArt("<img onerror=alert(1)>","family")',sandbox);assert.ok(!markup.includes('<img onerror'));assert.ok(markup.includes('src="assets/activities/arts-and-crafts.webp"'));
});
test('card framing matches supplied images; load failure handling has a finite fallback',()=>{
 assert.match(html,/aspect-ratio:69\/56;height:auto!important/);assert.match(html,/object-fit:cover;object-position:center/);
 assert.match(script,/image\.getAttribute\('src'\)!==fallback/);assert.match(script,/image.hidden=true/);
});
