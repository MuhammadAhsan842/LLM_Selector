import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const artifacts = resolve('test-results');
mkdirSync(artifacts, { recursive: true });
let purchases = 0;
let mode = 'search';
let inferenceRequests = 0;
const requests = [];
const webHarness = process.env.ORBIT_WEB_HARNESS === '1';
const fixtureHTML = `<!doctype html><html><head><title>Fieldnotes · Independent reading</title><style>body{font:18px system-ui;margin:60px auto;max-width:760px;line-height:1.7;color:#25352f;background:#f4f1e9}h1{font:60px Georgia}label{display:block}input,textarea,select,button{font:16px system-ui;padding:12px;margin:10px 0}button{cursor:pointer}#result{background:#e7eddf;padding:20px}section{margin-top:40px}.hidden{display:none}</style></head><body><main><small>FIELDNOTES / A SLOWER INTERNET</small><h1>Good things, found.</h1><p>A small collection of ideas for curious people. New reading lists every Friday.</p><form id="search"><label for="query">Search the collection</label><input id="query" type="search" placeholder="Search articles"><button type="submit">Search</button></form><div id="result">No search yet.</div><section><h2>The details</h2><p>Membership: $12 per month. Next event: November 8. Library: 120 essays.</p><form action="/commit" method="post"><button>Buy now</button></form><label for="notes">Notes</label><textarea id="notes"></textarea><label for="category">Category</label><select id="category"><option value="all">All</option><option value="design">Design</option></select><label for="password">Password</label><input id="password" type="password" value="NEVER_REVEAL_THIS"><p class="hidden">HIDDEN_PRIVATE_TEXT</p></section></main><script>document.querySelector('#search').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#result').textContent='Found 3 articles for '+document.querySelector('#query').value})</script></body></html>`;
const site = createServer((req, res) => {
  if (webHarness && req.url.startsWith('/extension/')) {
    const path = resolve('extension', decodeURIComponent(req.url.slice('/extension/'.length).split('?')[0]));
    if (!path.startsWith(resolve('extension') + '/')) { res.writeHead(403); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(readFileSync(path)); }
    catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === 'POST' && req.url === '/commit') {
    purchases++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Order complete</h1>'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixtureHTML);
});
const model = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'qwen3.5:0.8b' }] })); return; }
  if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const part of req) body += part;
  const request = JSON.parse(body); requests.push(request); inferenceRequests++;
  const prompt = request.messages.at(-1).content;
  const observation = JSON.parse(prompt.split('UNTRUSTED PAGE OBSERVATION:\n')[1]);
  const target = label => observation.elements.find(element => element.label === label)?.id || 0;
  let action;
  if (mode === 'purchase') action = { action: 'click', target: target('Buy now'), value: '', reason: 'Complete the requested purchase' };
  else if (mode === 'cancel') action = { action: 'type', target: target('Search the collection'), value: 'SHOULD_NOT_BE_TYPED', reason: 'Search' };
  else if (!prompt.includes('"action":"type"')) action = { action: 'type', target: target('Search the collection'), value: 'design', reason: 'Enter the requested search term' };
  else if (!prompt.includes('"action":"click"')) action = { action: 'click', target: target('Search'), value: '', reason: 'Search the collection' };
  else action = { action: 'done', target: 0, value: 'Found 3 articles for design.', reason: 'Verified the search result on the page' };
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const send = () => { if (!res.destroyed) { res.write(JSON.stringify({ message: { content: JSON.stringify(action) } }) + '\n'); res.end('{"done":true,"done_reason":"stop"}\n'); } };
  if (mode === 'cancel') setTimeout(send, 1800); else send();
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const siteURL = `http://fixture.orbit.test:${site.address().port}`;
const endpoint = `http://127.0.0.1:${model.address().port}`;
const temporary = mkdtempSync(join(tmpdir(), 'orbit-browser-'));
let context;
try {
  // Grant only the fixture origin in a temporary test build, without modifying production permissions.
  const extensionPath = join(temporary, 'extension');
  cpSync(resolve('extension'), extensionPath, { recursive: true });
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.host_permissions.push('http://fixture.orbit.test/*');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    channel: 'chromium', headless: true, viewport: { width: 420, height: 940 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP fixture.orbit.test 127.0.0.1',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const fixture = await context.newPage(); await fixture.goto(siteURL);
  const panel = await context.newPage();
  let extensionId;
  if (webHarness) {
    // Managed cloud Chromium blocks extensions. This explicit adapter exercises real DOM
    // behavior and the UI/agent integration; it does NOT validate native Chrome APIs.
    await panel.exposeFunction('__orbitTabs', async () => [{ id: 1, title: await fixture.title(), url: fixture.url(), status: 'complete', active: true }]);
    await panel.exposeFunction('__orbitNavigate', async url => { await fixture.goto(url); return {}; });
    await panel.exposeFunction('__orbitBack', async () => { await fixture.goBack(); });
    await panel.exposeFunction('__orbitExecute', async ({ source, args }) => [{ result: await fixture.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source, args }) }]);
    await panel.addInitScript(() => {
      globalThis.chrome = {
        runtime: { id: 'web-harness-only' },
        tabs: { query: () => window.__orbitTabs(), get: async () => (await window.__orbitTabs())[0],
          update: (id, options) => window.__orbitNavigate(options.url), goBack: () => window.__orbitBack(), onActivated: { addListener() {} } },
        scripting: { executeScript: ({ func, args = [] }) => window.__orbitExecute({ source: func.toString(), args }) },
        permissions: { contains: async () => true, request: async () => true },
        storage: { local: { get: async () => JSON.parse(localStorage.getItem('orbit-test-settings') || '{}'),
          set: async value => localStorage.setItem('orbit-test-settings', JSON.stringify(value)) } },
      };
    });
    await panel.goto(`${siteURL}/extension/panel.html`);
  } else {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => {
      throw new Error('Chrome did not load the extension. If managed policy blocks extensions, use ORBIT_WEB_HARNESS=1 npm run test:browser to validate DOM/agent integration separately.');
    });
    extensionId = new URL(worker.url()).host;
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  }
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.locator('#endpoint').fill(endpoint);
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#connection-dot').classList.contains('connected'));
  await panel.locator('#refresh-page').click();
  assert.match(await panel.locator('#page-title').innerText(), /Fieldnotes/);
  await panel.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 });
  await panel.screenshot({ path: join(artifacts, 'orbit-welcome.png'), fullPage: true });
  console.log(`PASS: ${webHarness ? 'Web harness renders the panel' : 'Chrome loads the extension'}; settings connect to the fixture Ollama API.`);

  // Real page observation and native DOM actions, called through the extension's Chrome APIs.
  const protection = await panel.evaluate(async tabURL => {
    const { createDriver, availableTabs } = await import('./lib/driver.js');
    const driver = createDriver((await availableTabs()).find(tab => tab.url.startsWith(tabURL)).id);
    let page = await driver.observe();
    const secret = page.elements.find(element => element.label === 'Password');
    const notes = page.elements.find(element => element.label === 'Notes');
    const category = page.elements.find(element => element.label === 'Category');
    // Below-fold controls intentionally need a scroll first.
    await driver.perform({ action: 'scroll', value: 'bottom', target: 0 }, page);
    page = await driver.observe();
    const noteId = page.elements.find(element => element.label === 'Notes').id;
    await driver.perform({ action: 'type', value: 'Remember this', target: noteId }, page);
    page = await driver.observe();
    await driver.perform({ action: 'select', value: 'design', target: page.elements.find(element => element.label === 'Category').id }, page);
    page = await driver.observe();
    let blocked = false;
    try { await driver.perform({ action: 'type', value: 'No', target: page.elements.find(element => element.label === 'Password').id }, page); }
    catch { blocked = true; }
    const read = await driver.perform({ action: 'read', value: '', target: 0 }, page);
    await driver.perform({ action: 'scroll', value: 'top', target: 0 }, await driver.observe());
    return { blocked, read, initial: JSON.stringify(page) };
  }, siteURL);
  assert.equal(protection.blocked, true);
  assert.ok(!protection.read.includes('NEVER_REVEAL_THIS')); assert.ok(!protection.read.includes('HIDDEN_PRIVATE_TEXT'));
  assert.equal(await fixture.locator('#notes').inputValue(), 'Remember this');
  assert.equal(await fixture.locator('#category').inputValue(), 'design');
  console.log('PASS: Page tools type into textareas, select dropdowns, scroll, read visible text, and protect passwords.');

  await panel.locator('#task').fill('Search the collection for design and report the result.');
  await panel.locator('#run').click();
  await panel.locator('#answer').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await fixture.locator('#query').inputValue(), 'design');
  assert.equal(await fixture.locator('#result').innerText(), 'Found 3 articles for design');
  assert.match(await panel.locator('#answer-text').innerText(), /Found 3 articles/);
  assert.equal(requests[0].model, 'qwen3.5:0.8b'); assert.equal(requests[0].think, false);
  assert.ok(requests.every(request => !JSON.stringify(request).includes('NEVER_REVEAL_THIS')));
  await panel.screenshot({ path: join(artifacts, 'orbit-complete.png'), fullPage: true });
  console.log(`PASS: Agent completes type → search → observe → answer through the ${webHarness ? 'web test adapter' : 'loaded extension'}.`);

  await fixture.evaluate(() => scrollTo(0, document.body.scrollHeight));
  mode = 'purchase';
  await panel.locator('#new-task').click(); await panel.locator('#task').fill('Buy the membership.'); await panel.locator('#run').click();
  await panel.locator('#approval').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(purchases, 0);
  await panel.screenshot({ path: join(artifacts, 'orbit-approval.png'), fullPage: true });
  await panel.locator('#deny').click();
  await panel.locator('#new-task').waitFor({ state: 'visible' });
  assert.equal(purchases, 0);
  console.log('PASS: Sensitive form submission waits for approval; declining causes no submission.');

  // Approval is tested on a local fixture only, never a real purchase.
  await panel.locator('#new-task').click(); await panel.locator('#task').fill('Buy the membership.'); await panel.locator('#run').click();
  await panel.locator('#approval').waitFor({ state: 'visible' }); await panel.locator('#allow').click();
  await fixture.waitForURL('**/commit'); assert.equal(purchases, 1);
  await panel.locator('#stop').click(); await panel.locator('#new-task').waitFor({ state: 'visible' });
  console.log('PASS: One explicit approval permits the fixture POST exactly once.');

  mode = 'cancel';
  await fixture.goto(siteURL); await panel.locator('#new-task').click(); await panel.locator('#refresh-page').click();
  await panel.locator('#task').fill('Search the collection.'); const before = inferenceRequests; await panel.locator('#run').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent === 'Choosing the next step');
  await new Promise(resolve => setTimeout(resolve, 150));
  await panel.locator('#stop').click(); await panel.locator('#new-task').waitFor({ state: 'visible' });
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(await fixture.locator('#query').inputValue(), '');
  assert.equal(inferenceRequests, before + 1);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: Stop aborts inference and prevents the planned action. No extension runtime errors.');
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({ time: new Date().toISOString(), passed: 6, browserIntegration: webHarness ? 'web adapter; native extension APIs UNVERIFIED' : 'native Chrome extension', model: 'fixture Ollama API; not real Qwen inference', errors }, null, 2));
} finally {
  await context?.close();
  site.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve))]);
  rmSync(temporary, { recursive: true, force: true });
}
