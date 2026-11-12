import test from 'node:test';
import assert from 'node:assert/strict';
import { appendResult, canAppendResult, runRepeated, validateCount } from '../workflows.mjs';
const config = { url: 'https://example.com/chat', method: 'POST', headers: [{name:'Authorization',value:'example-only',enabled:true}], body: JSON.stringify({ model:'demo', stream:true, messages:[{role:'user',content:'你好'}] }) };
const result = { record:{outcome:'complete'}, output:{answer:'回答 🧪',reasoning:'思考内容'}, toolCalls:[{key:'tool-0',index:0,id:'call-1',type:'function',name:'test_fn',arguments:'{"value":1}',finishReason:'tool_calls'}] };
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
test('append preserves answer, reasoning and tool calls in separate assistant fields', () => {
  const original = structuredClone(config), next = appendResult(config,result), body = JSON.parse(next.body);
  assert.deepEqual(body.messages.at(-1),{role:'assistant',content:'回答 🧪',reasoning_content:'思考内容',tool_calls:[{id:'call-1',type:'function',function:{name:'test_fn',arguments:'{"value":1}'}}]});
  assert.equal(body.stream,true); assert.deepEqual(next.headers,config.headers); assert.deepEqual(config,original);
  assert.equal(JSON.parse(appendResult(next,result).body).messages.length,3);
  assert.equal(body.messages.at(-1).tool_calls[0].index,undefined);
  assert.equal(body.messages.some(message=>message.role==='tool'),false);
});
test('reasoning-only, tool-only and captured partial output can be appended without text', () => {
  for (const outcome of ['complete','stopped','error']) {
    for (const partial of [{output:{answer:'',reasoning:'思考'},toolCalls:[]},{output:{answer:'',reasoning:''},toolCalls:result.toolCalls}]) {
      const value={record:{outcome},...partial}; assert.equal(canAppendResult(value),true);
      const message=JSON.parse(appendResult(config,value).body).messages.at(-1);
      assert.equal(message.content,'');
      if(partial.output.reasoning) assert.equal(message.reasoning_content,'思考');
      else assert.equal(message.tool_calls[0].id,'call-1');
    }
  }
});
test('empty tool IDs and partial argument strings are preserved for manual editing', () => {
  const message=JSON.parse(appendResult(config,{record:{outcome:'complete'},toolCalls:[{id:'',name:'fn',arguments:"U')"}]}).body).messages.at(-1);
  assert.deepEqual(message.tool_calls,[{id:'',type:'function',function:{name:'fn',arguments:"U')"}}]);
});
test('Responses text input string and array are supported without losing options', () => {
  for (const input of ['hello',[{role:'user',content:'hello'}]]) {
    const next = appendResult({...config,body:JSON.stringify({input,model:'demo',stream:true})},{...result,output:{answer:'回答 🧪'},toolCalls:[]});
    assert.deepEqual(JSON.parse(next.body),{input:[{role:'user',content:'hello'},{role:'assistant',content:'回答 🧪'}],model:'demo',stream:true});
  }
});
test('Responses native reasoning and function items round-trip without losing IDs or encrypted fields', () => {
  const items=[{type:'reasoning',id:'rs_1',summary:[{type:'summary_text',text:'思考'}],encrypted_content:'example-encrypted'},{type:'function_call',id:'fc_1',call_id:'call-1',name:'fn',arguments:'{}'}];
  for(const record of [{outcome:'complete',responseOutput:items},{outcome:'complete',responseOutputItems:{1:items[1],0:items[0]}}]) {
    const value={record,output:{answer:'',reasoning:'思考'},toolCalls:[]}; assert.equal(canAppendResult(value),true);
    assert.deepEqual(JSON.parse(appendResult({...config,body:'{"input":[]}'},value).body).input,items);
  }
});
test('empty/running output and unsupported bodies do not overwrite an edited request', () => {
  for (const value of [null,{...result,record:{outcome:'running'}},{record:{outcome:'complete'},output:{answer:'',reasoning:''},toolCalls:[]}]) { assert.equal(canAppendResult(value),false); assert.throws(()=>appendResult(config,value)); }
  for (const body of ['null','[]','{}','bad JSON','{"messages":"wrong"}']) assert.throws(()=>appendResult({...config,body},result));
  const edited={...config,body:JSON.stringify({temperature:0.4,messages:[{role:'user',content:'手动编辑'}]})};
  const next=JSON.parse(appendResult(edited,result).body); assert.equal(next.temperature,0.4); assert.equal(next.messages[0].content,'手动编辑');
});
