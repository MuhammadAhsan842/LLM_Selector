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
  assert.deepEqual(await runAgent(fixture.options), { answer: 'Found tea', steps: 2 });
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
