import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {adoptionFixture} from './adoption-fixture.ts';import {SEND,READ} from '../../adapter/schema.ts';
test('actual minimal entry→Core adoption: exact current item enters shared claim; canonical association BEFORE refused full READ; terminal unknown',async t=>{
 const h=adoptionFixture(t);const r=await h.invoke();assert.equal(r.details.state,'unknown');
 assert.deepEqual(h.dispatches,[SEND,READ]);assert.equal(h.rows('deliveries')[0].state,'delivery_unknown');
 const a=h.rows('canonical_associations');assert.equal(a.length,1);assert.equal(a[0].legacy_unmapped,0);assert.equal(a[0].read_verified,0);
 const again=await h.invoke();assert.equal(again.details.admission.reason,'prior_attempt_terminal');assert.deepEqual(h.dispatches,[SEND,READ]);
 assert(!JSON.stringify([r,again]).includes(h.token));assert(!JSON.stringify([r,again]).includes(h.chat));
});
test('actual minimal entry holds changed key/revision/payload/link and known legacy keys BEFORE native calls',async t=>{
 const h=adoptionFixture(t);
 for(const changed of [{decision_key:'other/new'},{revision:'b'.repeat(64)},{text:'An ambiguous reopened old item.'},{review_link:{label:'Review',url:'https://review.example.invalid/'}}]){
  const r=await h.invoke({...h.args,...changed});assert.equal(r.details.state,'held');assert.equal(r.details.admission.reason,'continuation_one_item_mismatch');
 }
 const old=await h.invoke({...h.args,decision_key:'old/exact',revision:'b'.repeat(40)});assert.equal(old.details.admission.reason,'continuation_legacy_exact_key');
 assert.deepEqual(h.dispatches,[]);assert.deepEqual(h.rows('deliveries'),[]);
});
test('actual minimal entry has no model novelty/reconfigure argument, and no FYIP classification authority from adoption',async t=>{
 const h=adoptionFixture(t);for(const field of ['novel','origin','current_request','adopt','profile_id']){
  const r=await h.invoke({...h.args,[field]:true});assert.equal(r.isError,true);
 }
 const fyip={decision_key:h.args.decision_key,revision:h.args.revision,candidate:{kind:'milestone',title:'Review ready',previous_state:'Gate absent',current_state:'Gate available',materiality:'Enables durable review',reconciled:true,evidence:[{kind:'milestone',detail:'Gate added with durable verification'}]}};
 const r=await h.tools.get('notification_publish_fyip').execute('synthetic-fyip',fyip,new AbortController().signal,undefined,h.ctx);
 assert.equal(r.details.state,'held');assert.equal(r.details.admission.reason,'continuation_one_item_mismatch');assert.deepEqual(h.rows('fyip_decisions'),[]);assert.deepEqual(h.dispatches,[]);
});
test('actual entry adoption preserves abort/late canonical and lifetime no-retry with SAME production mode, no transport bypass',async t=>{
 const h=adoptionFixture(t),c=new AbortController();let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});h.state.sendHook=()=>{entered();return wait;};
 const pending=h.invoke(h.args,c);await ready;c.abort();
 try { const result=await pending;assert.equal(result.isError,true);assert.deepEqual(result.details,{code:'cancelled'});
  const again=await h.invoke();assert.equal(again.isError,true);assert.deepEqual(again.details,{code:'busy'});
 } finally { release();await new Promise<void>(r=>setImmediate(r)); }
 assert.equal(h.rows('deliveries')[0].state,'delivery_unknown');assert.equal(h.dispatches.length,1);
});
test('actual entry catches source/profile drift and secrets without delivery or leaking private material',async t=>{
 for(const kind of ['source','profile','secret']){const h=adoptionFixture(t);if(kind==='source')fs.appendFileSync(h.legacy,' ');if(kind==='profile')fs.appendFileSync(h.profile,'\n');
  const r=await h.invoke(kind==='secret'?{...h.args,text:h.token}:h.args);assert.equal(r.details.state,'held');assert.deepEqual(h.dispatches,[]);assert(!JSON.stringify(r).includes(h.token));assert(!JSON.stringify(r).includes(h.chat));
 }
});
