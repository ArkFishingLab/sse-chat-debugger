export function validateCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('执行次数须为 1–100 的整数');
}

// Every attempt receives a fresh copy of the same initial request.
export async function runRepeated(config, count, execute, { signal, onProgress = () => {} } = {}) {
  validateCount(count);
  const request = structuredClone(config), results = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    onProgress(i + 1, count);
    results.push(await execute(structuredClone(request)));
  }
  return results;
}

export function canAppendResult(result) {
  return !!result && result.record?.outcome !== 'running' && (
    !!result.output?.answer?.length || !!result.output?.reasoning?.length
    || !!result.toolCalls?.length || !!result.record?.responseOutput?.length
    || !!Object.keys(result.record?.responseOutputItems || {}).length
  );
}

// This only edits a request. Tool calls are never executed or given fake results.
export function appendResult(config, result) {
  if (!canAppendResult(result)) throw Error('请选择包含回答、思考或工具调用的运行');
  const body = JSON.parse(config.body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('请求正文须为 JSON 对象');
  const answer = result.output?.answer || '', reasoning = result.output?.reasoning || '';
  const calls = (result.toolCalls || []).map(call => ({
    id: call.id || '', type: call.type || 'function',
    function: { name: call.name || '', arguments: call.arguments || '' }
  }));
  if (Array.isArray(body.messages)) {
    const assistant = { role: 'assistant', content: answer };
    if (reasoning) assistant.reasoning_content = reasoning;
    if (calls.length) assistant.tool_calls = calls;
    body.messages.push(assistant);
  } else if (typeof body.input === 'string' || Array.isArray(body.input)) {
    if (typeof body.input === 'string') body.input = [{ role: 'user', content: body.input }];
    const native = result.record?.responseOutput?.length ? result.record.responseOutput
      : Object.entries(result.record?.responseOutputItems || {}).sort(([a],[b]) => Number(a)-Number(b)).map(([,item]) => item);
    if (native.length) body.input.push(...structuredClone(native));
    else {
      if (reasoning) throw Error('Responses 思考回填需要原生 output item；请接收完整的 response.output_item.done 或 response.completed 事件');
      if (answer) body.input.push({ role: 'assistant', content: answer });
      for (const call of calls) body.input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  } else throw Error('追加结果需要 messages 数组，或 Responses 的 input 字符串 / 数组');
  return { ...structuredClone(config), body: JSON.stringify(body, null, 2) };
}
