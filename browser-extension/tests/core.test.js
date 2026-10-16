import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, safeWebUrl, validateEndpoint, inspectAction, observationText, DEFAULT_SETTINGS } from '../extension/lib/protocol.js';
import { ndjson, nextAction } from '../extension/lib/ollama.js';
import { runAgent } from '../extension/lib/agent.js';

const action = (name, target = 0, value = '') => ({ action: name, target, value, reason: 'Do the requested step' });
const page = { title: 'Fixture', url: 'https://example.com/', snapshotId: 'a', text: 'Example text', elements: [
  { id: 1, kind: 'input', label: 'Search', inputType: 'search' },
  { id: 2, kind: 'button', label: 'Search', inputType: 'submit' },
  { id: 3, kind: 'button', label: 'Buy now' },
  { id: 4, kind: 'input', label: 'Password', inputType: 'password', protected: true },
  { id: 5, kind: 'input', label: 'Email', inputType: 'email', sensitive: true },
  { id: 6, kind: 'link', label: 'Article', href: 'https://example.com/article' },
  { id: 7, kind: 'button', label: 'Something unknown' },
  { id: 8, kind: 'link', label: 'Open', href: 'javascript:alert(1)' },
  { id: 9, kind: 'button', label: 'Next', formSensitive: true },
] };

test('parses constrained Qwen output, fences, and completed thinking blocks', () => {
  const expected = action('click', 2);
  assert.deepEqual(parseAction(JSON.stringify(expected)), expected);
  assert.deepEqual(parseAction('```json\n' + JSON.stringify(expected) + '\n```'), expected);
  assert.deepEqual(parseAction('<think>Some internal text</think>' + JSON.stringify(expected)), expected);
});

test('rejects malformed or executable actions', () => {
  for (const raw of ['null', '{}', 'not json', JSON.stringify(action('eval', 1)), JSON.stringify(action('click', -1)), JSON.stringify({ ...action('type'), value: 2 })]) {
    assert.throws(() => parseAction(raw));
  }
});

test('only permits ordinary web navigation and local model endpoints', () => {
  assert.equal(safeWebUrl('https://example.com/path'), 'https://example.com/path');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://u:p@example.com/', 'http://127.0.0.1:11434/', 'http://169.254.169.254/', 'http://[::1]/']) assert.throws(() => safeWebUrl(url));
  assert.equal(validateEndpoint('http://localhost:11434/'), 'http://localhost:11434');
  for (const url of ['https://example.com', 'http://localhost:11434/redirect', 'http://user:pass@localhost/']) assert.throws(() => validateEndpoint(url));
});

test('enforces approval for sensitive and unknown actions; protects credentials', () => {
  assert.equal(inspectAction(action('type', 1, 'book'), page).approval, false);
  assert.equal(inspectAction(action('click', 2), page).approval, false);
  assert.equal(inspectAction(action('click', 6), page).approval, false);
  for (const id of [3, 5, 7, 9]) assert.equal(inspectAction(action(id === 5 ? 'type' : 'click', id, 'x'), page).approval, true);
  assert.throws(() => inspectAction(action('type', 4, 'secret'), page), /handled directly/);
  assert.throws(() => inspectAction(action('click', 8), page), /http and https/);
  assert.throws(() => inspectAction(action('click', 99), page), /no longer/);
  assert.equal(inspectAction(action('navigate', 0, 'https://example.com/delete/account'), page).approval, true);
});

test('compact observation omits entered field values', () => {
  const text = observationText({ ...page, elements: [{ ...page.elements[0], value: 'PRIVATE', internalDOM: 'secret' }] });
  assert.ok(!text.includes('PRIVATE')); assert.ok(!text.includes('internalDOM'));
});

test('account closure and checkout next steps cannot use the safe-button shortcut', () => {
  for (const label of ['Close account', 'Cancel subscription', 'Next']) {
    const copy = { ...page, url: label === 'Next' ? 'https://example.com/checkout' : page.url,
      elements: [{ id: 1, kind: 'button', label }] };
    assert.equal(inspectAction(action('click', 1), copy).approval, true);
  }
});

test('stream decoder handles split UTF-8, chunk boundaries, and final newline omission', async () => {
  const raw = new TextEncoder().encode('{"a":"世界"}\n{"done":true}');
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < raw.length; i++) controller.enqueue(raw.slice(i, i + 1));
    controller.close();
  } });
  const output = [];
  for await (const item of ndjson(body)) output.push(item);
  assert.deepEqual(output, [{ a: '世界' }, { done: true }]);
});

test('Ollama adapter uses structured output and refuses incomplete streams', async () => {
  const original = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { content: JSON.stringify(action('done', 0, 'answer')) } }) + '\n' + JSON.stringify({ done: true }) + '\n');
    };
    assert.equal((await nextAction(DEFAULT_SETTINGS, [], new AbortController().signal)).value, 'answer');
    assert.equal(request.think, false); assert.equal(request.format.additionalProperties, false);
    assert.equal(request.options.temperature, 0); assert.equal(request.model, 'qwen3.5:0.8b');
    globalThis.fetch = async () => new Response('{"message":{"content":"{}"}}\n');
    await assert.rejects(nextAction(DEFAULT_SETTINGS, []), /before completing/);
  } finally { globalThis.fetch = original; }
});

function fixtureAgent(sequence, overrides = {}) {
  const calls = [];
  const events = [];
  let index = 0;
  return { calls, events, options: { task: 'Search the page', settings: DEFAULT_SETTINGS,
    signal: new AbortController().signal, emit: event => events.push(event),
    driver: { observe: async () => page, perform: async a => { calls.push(a); return 'Completed'; } },
    decide: async () => sequence[Math.min(index++, sequence.length - 1)], approve: async () => true,
    ...overrides,
  } };
}

test('agent observes, acts, carries results forward, and returns final answer', async () => {
  const fixture = fixtureAgent([action('type', 1, 'tea'), action('click', 2), action('done', 0, 'Found tea')]);
  const result = await runAgent(fixture.options);
  assert.equal(result.answer, 'Found tea'); assert.equal(result.steps, 2);
  assert.equal(result.completion, 'model_reported');
  assert.equal(result.metrics.verified, 0, 'A legacy driver must not manufacture verification evidence');
  assert.deepEqual(fixture.calls.map(a => a.action), ['type', 'click']);
  assert.equal(fixture.events.filter(e => e.type === 'page').length, 3);
});

test('declined submission is never executed', async () => {
  const fixture = fixtureAgent([action('click', 3)], { approve: async () => false });
  await runAgent(fixture.options); assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.events.at(-1).type, 'done');
});

test('cancelling during inference prevents any later browser action', async () => {
  const controller = new AbortController();
  const fixture = fixtureAgent([], { signal: controller.signal, decide: async () => {
    controller.abort(new DOMException('Stopped', 'AbortError')); return action('click', 2);
  } });
  await assert.rejects(runAgent(fixture.options), /Stopped/);
  assert.equal(fixture.calls.length, 0);
});

test('loop detection and step limits stop runaway tasks', async () => {
  const loop = fixtureAgent([action('click', 2)]);
  await assert.rejects(runAgent(loop.options), /repeated/); assert.equal(loop.calls.length, 2);
  const limited = fixtureAgent([action('scroll', 0, 'down')], { settings: { ...DEFAULT_SETTINGS, maxSteps: 1 } });
  await assert.rejects(runAgent(limited.options), /1-step limit/); assert.equal(limited.calls.length, 1);
});

test('malformed JSON gets one repair request', async () => {
  let count = 0;
  const fixture = fixtureAgent([], { decide: async () => {
    if (count++ === 0) throw new Error('The model returned invalid JSON.');
    return action('done', 0, 'Repaired');
  } });
  assert.equal((await runAgent(fixture.options)).answer, 'Repaired'); assert.equal(count, 2);
});

test('advanced action schema rejects invalid keyboard, extraction, and empty assertions', () => {
  for (const item of [action('press', 1, 'F12'), action('extract', 0, 'cookies'), action('assert'), action('click')]) assert.throws(() => parseAction(JSON.stringify(item)));
  assert.equal(parseAction(JSON.stringify(action('press', 1, 'Enter'))).value, 'Enter');
  assert.equal(inspectAction(action('press', 1, 'Enter'), page).approval, true);
  assert.throws(() => inspectAction(action('type', 1, 'x'), { ...page, elements: [{ ...page.elements[0], readOnly: true }] }), /read-only/);
});

test('completion is rejected until independently checked page criteria pass', async () => {
  let checks = 0;
  const fixture = fixtureAgent([action('done', 0, 'Complete')]);
  fixture.options.successCriteria = ['Result exists'];
  fixture.options.driver.check = async () => [{ text: 'Result exists', passed: ++checks > 1 }];
  const result = await runAgent(fixture.options);
  assert.equal(result.completion, 'criteria_verified'); assert.equal(checks, 2);
  assert.equal(fixture.events.filter(event => event.type === 'done').length, 1);
});

test('three unsupported completion claims stop with an incomplete task', async () => {
  const fixture = fixtureAgent([action('done', 0, 'All done')]);
  fixture.options.successCriteria = ['Missing result'];
  fixture.options.driver.check = async () => [{ text: 'Missing result', passed: false }];
  await assert.rejects(runAgent(fixture.options), /incomplete/);
  assert.equal(fixture.events.filter(event => event.type === 'done').length, 0);
});

test('an approved consequential action is never replayed after an uncertain result', async () => {
  let count = 0, approvals = 0;
  const fixture = fixtureAgent([action('click', 3)], { approve: async () => { approvals++; return true; } });
  fixture.options.driver.execute = async () => { count++; return { status: 'unverified', summary: 'Sent once', evidence: 'Unknown outcome' }; };
  await assert.rejects(runAgent(fixture.options), /repeated|unsuccessful/);
  assert.equal(count, 1); assert.equal(approvals, 1);
});

test('the configured recovery model is used for format repair', async () => {
  const models = [];
  const fixture = fixtureAgent([], { settings: { ...DEFAULT_SETTINGS, recoveryModel: 'qwen3.5:4b' }, decide: async settings => {
    models.push(settings.model);
    if (models.length === 1) throw new Error('The model returned invalid JSON.');
    return action('done', 0, 'Repaired');
  } });
  await runAgent(fixture.options);
  assert.deepEqual(models, ['qwen3.5:0.8b', 'qwen3.5:4b']);
});

test('large multilingual observations are bounded without corrupting JSON', () => {
  const large = { ...page, text: '世界'.repeat(10000), elements: Array.from({length:60},(_,i)=>({id:i+1,kind:'select',label:'選択'.repeat(40),options:Array.from({length:20},(_,j)=>({value:`long-option-${j}`.repeat(20),text:'項目'.repeat(50)}))})) };
  const encoded = observationText(large, 3000);
  assert.ok(new TextEncoder().encode(encoded).length <= 3000);
  assert.ok(JSON.parse(encoded).limitations.contextClipped);
});

test('transient model-server overload retries once before a browser action is chosen', async () => {
  const original = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => {
      if (++requests === 1) return new Response('{"error":"busy"}', {status:503});
      return new Response(JSON.stringify({message:{content:JSON.stringify(action('done',0,'Ready'))},done:true})+'\n');
    };
    assert.equal((await nextAction(DEFAULT_SETTINGS, [])).value,'Ready'); assert.equal(requests,2);
  } finally { globalThis.fetch = original; }
});

test('cancelling a model retry prevents the second request', async () => {
  const original = globalThis.fetch; const controller = new AbortController(); let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; controller.abort(new DOMException('Cancelled','AbortError')); return new Response('{}',{status:503}); };
    await assert.rejects(nextAction(DEFAULT_SETTINGS, [], controller.signal),/Cancelled/); assert.equal(requests,1);
  } finally { globalThis.fetch = original; }
});

test('an empty verifier response cannot satisfy nonempty completion criteria', async () => {
  const fixture = fixtureAgent([action('done',0,'Complete')]);
  fixture.options.successCriteria=['Required result']; fixture.options.driver.check=async()=>[];
  await assert.rejects(runAgent(fixture.options),/incomplete completion checks/);
});
