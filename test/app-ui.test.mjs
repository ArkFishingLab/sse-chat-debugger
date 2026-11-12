import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(check) { for (let i=0;i<500;i++) { if (check()) return; await pause(5); } throw Error('UI state did not settle'); }

test('actual page handlers preserve separate runs, append the selected answer, expand JSON, and cancel a batch', async t => {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom = new JSDOM(html,{url:'http://127.0.0.1:8766/'}), document = dom.window.document;
  const original = new Map();
  function expose(key,value) { original.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value}); }
  for (const [key,value] of Object.entries({document,Node:dom.window.Node,Option:dom.window.Option,location:dom.window.location,localStorage:dom.window.localStorage,navigator:{clipboard:{writeText:async()=>{}}}})) expose(key,value);
  t.after(()=>{ dom.window.close(); for (const [key,descriptor] of original) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } });
  const requests=[]; let hold = false;
  expose('fetch',async (url,options={})=>{
    if (url === '/api/profiles') return Response.json({profiles:[],storagePath:'/local-test/requests.json'});
    assert.equal(url,'/api/stream');
    requests.push(JSON.parse(options.body)); const n=requests.length, fail=n===2, encoder=new TextEncoder();
    return new Response(new ReadableStream({start(controller){
      let timer;
      const abort=()=>{ clearTimeout(timer); controller.error(new DOMException('Stopped','AbortError')); };
      options.signal.addEventListener('abort',abort,{once:true});
      const write=object=>controller.enqueue(encoder.encode(JSON.stringify(object)+'\n'));
      write({type:'response',status:fail?500:200,statusText:fail?'error':'OK',headers:{'content-type':'text/event-stream'},at:1});
      write({type:'chunk',text:`data: ${JSON.stringify(fail?{error:{message:'test failure'}}:{choices:[{delta:{reasoning_content:`reason-${n}`,content:`answer-${n}`}}]})}\n\n`,at:5});
      timer=setTimeout(()=>{
        options.signal.removeEventListener('abort',abort);
        if(!fail) write({type:'chunk',text:`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:'test_tool',arguments:`{"n":${n}}`}}]},finish_reason:'tool_calls'}]})}\n\n`,at:9});
        write({type:'done',at:10}); controller.close();
      },hold?200:10);
    }}));
  });
  await import('../app.mjs');
  const $=id=>document.getElementById(id);
  await until(() => !$('save-profile').disabled);
  $('url').value='https://example.com/chat'; $('speed').value='0'; $('repeat-count').value='3';
  const requestBody=$('body').value;
  $('send').click(); assert.equal($('send').disabled,true);
  await until(()=>$('batch-status').textContent.startsWith('执行结束'));
  assert.equal(requests.length,3); assert.ok(requests.every(request=>request.body===requestBody));
  assert.equal($('runs').children.length,3); assert.match($('runs').children[1].textContent,/失败/); assert.equal($('answer').textContent,'answer-3');
  $('runs').children[0].click();
  assert.equal($('answer').textContent,'answer-1'); assert.equal($('reasoning').textContent,'reason-1'); assert.equal($('tool-0').textContent,'{"n":1}');
  const eventCount=$('metric-events').textContent;
  $('runs').children[2].click(); $('runs').children[0].click(); assert.equal($('metric-events').textContent,eventCount);
  assert.match($('inspect-raw').textContent,/answer-1/); assert.doesNotMatch($('inspect-raw').textContent,/answer-3/);
  $('continue').click();
  await until(()=>$('batch-status').textContent==='执行结束 · 1 / 1');
  assert.equal(requests.length,4); const next=JSON.parse(requests[3].body);
  assert.deepEqual(next.messages.at(-1),{role:'assistant',content:'answer-1'}); assert.equal(next.messages.length,2); assert.ok(!requests[3].body.includes('reason-1')); assert.equal($('runs').children.length,4);
  const json='{"nested":{"items":[null,true,"中文 🧪"]},"unsafe":"<img src=x onerror=alert(1)>"}';
  $('body').value=json; $('body-tree').click();
  assert.equal($('json-view').hidden,false); assert.equal($('body').hidden,true); assert.equal($('json-view').querySelector('img'),null);
  $('json-expand').click(); assert.match($('json-view').textContent,/中文 🧪/); assert.ok([...$('json-view').querySelectorAll('details')].every(node=>node.open));
  $('json-collapse').click(); assert.ok([...$('json-view').querySelectorAll('details')].every(node=>!node.open));
  $('body-raw').click(); assert.equal($('body').value,json);
  $('body').value='{bad'; $('body-tree').click(); assert.match($('json-view').textContent,/无法查看 JSON/); assert.equal($('body').value,'{bad'); $('body-raw').click();
  $('body').value=requestBody; hold=true; $('repeat-count').value='5'; $('send').click();
  await until(()=>requests.length===5 && $('answer').textContent==='answer-5');
  $('stop').click(); await until(()=>$('batch-status').textContent.startsWith('已停止'));
  assert.equal(requests.length,5); assert.equal($('runs').children.length,5); assert.match($('runs').lastChild.textContent,/已停止/); assert.equal($('answer').textContent,'answer-5');
  $('runs').children[0].click(); assert.equal($('answer').textContent,'answer-1');
  $('clear').click(); assert.equal($('runs').children.length,0); assert.equal($('continue').disabled,true);
});
