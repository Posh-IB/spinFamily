import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
test('browser publish directory contains only approved static assets and Identity client',async()=>{
 execFileSync('node',['scripts/build.mjs']);const names=await readdir('dist');assert.deepEqual(names.sort(),['assets','household.js','index.html']);
 const bundle=await readFile('dist/household.js','utf8');for(const value of ['SPINFAMILY_STRIPE_TEST_KEY','pg_advisory_xact_lock','createPlusService','stripe_processed_events'])assert.ok(!bundle.includes(value),value);
 assert.ok(!(await readdir('netlify/functions')).includes('custom-activity.cjs'));
});
test('automatic hosted builds remain held pending verified isolation',async()=>{assert.match(await readFile('netlify.toml','utf8'),/ignore = "exit 0"/);});
