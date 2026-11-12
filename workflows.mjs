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

export function appendAnswer(config, result) {
  if (!result || result.record?.outcome !== 'complete' || !result.output?.answer?.trim()) throw Error('请选择一次已完成且包含回答正文的运行');
  const body = JSON.parse(config.body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('请求正文须为 JSON 对象');
  const answer = result.output.answer;
  if (Array.isArray(body.messages)) body.messages.push({ role: 'assistant', content: answer });
  else if (typeof body.input === 'string') body.input = [{ role: 'user', content: body.input }, { role: 'assistant', content: answer }];
  else if (Array.isArray(body.input)) body.input.push({ role: 'assistant', content: answer });
  else throw Error('追加结果需要 messages 数组，或 Responses 的 input 字符串 / 数组');
  return { ...structuredClone(config), body: JSON.stringify(body, null, 2) };
}
