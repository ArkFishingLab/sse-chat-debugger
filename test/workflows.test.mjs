import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAnswer, runRepeated, validateCount } from '../workflows.mjs';
const config = { url: 'https://example.com/chat', method: 'POST', headers: [{name:'Authorization',value:'example-only',enabled:true}], body: JSON.stringify({ model:'demo', stream:true, messages:[{role:'user',content:'你好'}] }) };
const result = { record:{outcome:'complete'}, output:{answer:'回答 🧪',reasoning:'不要回填'}, toolCalls:[{arguments:'不要当成回答'}] };
test('repeated attempts are sequential and independent copies of one frozen request', async () => {
  const original = structuredClone(config), requests = [], progress = []; let active = 0, peak = 0;
  const task = runRepeated(original, 3, async request => {
    active++; peak = Math.max(peak,active); requests.push(structuredClone(request)); request.headers[0].value = 'changed inside attempt';
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return {outcome: requests.length === 2 ? 'error' : 'complete'};
  }, {onProgress:(i,n)=>progress.push([i,n])});
  original.body = 'changed after click'; const results = await task;
  assert.equal(peak,1); assert.equal(results.length,3); assert.ok(requests.every(request => request.body === config.body && request.headers[0].value === 'example-only')); assert.deepEqual(progress,[[1,3],[2,3],[3,3]]);
});
test('stop cancels remaining attempts and preserves completed results', async () => {
  const controller = new AbortController(); let calls = 0;
  const results = await runRepeated(config,5,async()=>{ calls++; controller.abort(); return 'partial'; },{signal:controller.signal});
  assert.equal(calls,1); assert.deepEqual(results,['partial']);
  assert.deepEqual(await runRepeated(config,2,()=>assert.fail(),{signal:controller.signal}),[]);
});
test('invalid batch counts do not send a request', async () => {
  for (const count of [0,-1,1.5,101,NaN]) { assert.throws(()=>validateCount(count)); await assert.rejects(runRepeated(config,count,()=>assert.fail())); }
});
test('continuation appends only assistant answer and preserves request settings without mutation', () => {
  const original = structuredClone(config), next = appendAnswer(config,result), body = JSON.parse(next.body);
  assert.deepEqual(body.messages,[{role:'user',content:'你好'},{role:'assistant',content:'回答 🧪'}]); assert.equal(body.stream,true); assert.deepEqual(next.headers,config.headers); assert.deepEqual(config,original);
  assert.ok(!next.body.includes('不要回填')); assert.ok(!next.body.includes('不要当成回答'));
  assert.equal(JSON.parse(appendAnswer(next,result).body).messages.length,3);
});
test('Responses input string and input array are supported without losing options', () => {
  for (const input of ['hello',[{role:'user',content:'hello'}]]) {
    const next = appendAnswer({...config,body:JSON.stringify({input,model:'demo',stream:true})},result);
    assert.deepEqual(JSON.parse(next.body),{input:[{role:'user',content:'hello'},{role:'assistant',content:'回答 🧪'}],model:'demo',stream:true});
  }
});
test('empty/failed/incomplete output and unsupported request bodies cannot be continued', () => {
  for (const value of [null,{...result,record:{outcome:'error'}},{...result,record:{outcome:'stopped'}},{...result,output:{answer:'  '}}]) assert.throws(()=>appendAnswer(config,value));
  for (const body of ['null','[]','{}','bad JSON','{"messages":"wrong"}']) assert.throws(()=>appendAnswer({...config,body},result));
});
