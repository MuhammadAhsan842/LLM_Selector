import { DEFAULT_SETTINGS, validateEndpoint } from './lib/protocol.js';
import { listModels } from './lib/ollama.js';
import { createDriver, availableTabs } from './lib/driver.js';
import { runAgent } from './lib/agent.js';

const $ = id => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let tabId = null;
let controller = null;
let connected = false;
let transcript = [];
let toastTimer;
let connectionVersion = 0;

function toast(message) {
  if ($('settings').open) {
    $('settings-feedback').textContent = message;
    $('settings-feedback').dataset.tone = 'info';
    $('settings-feedback').hidden = false;
    return;
  }
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function showSettings() {
  $('settings-feedback').hidden = true;
  if (!$('settings').open) $('settings').showModal();
  $('endpoint').focus();
}
function closeSettings() { $('settings').close(); }
function showError(message) {
  $('connection-help').hidden = false; $('connection-error').textContent = message;
  if ($('settings').open) {
    $('settings-feedback').textContent = message;
    $('settings-feedback').dataset.tone = 'error';
    $('settings-feedback').hidden = false;
  }
}
function setView(view) {
  if (view === 'activity' && $('activity-tab').disabled) return;
  document.body.dataset.view = view;
  for (const name of ['workspace', 'activity']) {
    $(`${name}-tab`).classList.toggle('active', view === name);
    $(`${name}-tab`).setAttribute('aria-pressed', String(view === name));
  }
  $('welcome').hidden = view !== 'workspace' || Boolean(controller);
  $('suggestions').hidden = view !== 'workspace' || Boolean(controller);
  $('workspace-signoff').hidden = view !== 'workspace' || Boolean(controller);
  $('activity-section').hidden = view !== 'activity';
  $('main-content').scrollTo({ top: 0 });
}
function updateTaskCount() { $('task-count').textContent = `${$('task').value.length} / 4000`; }
function updatePage(page) {
  $('page-title').textContent = page?.title || 'Open a website to get started';
  $('page-title').title = page?.url || '';
  let domain = '';
  try { domain = new URL(page.url).hostname.replace(/^www\./, ''); } catch {}
  $('page-domain').textContent = domain || 'Choose a page for your task';
  $('site-icon').textContent = domain ? domain[0].toUpperCase() : '—';
}
function updatePhase(state) {
  const phases = ['observing', 'planning', 'acting', 'done'];
  const index = phases.indexOf(state === 'approval' ? 'acting' : state);
  $('phase-rail').classList.toggle('complete', state === 'done');
  $('phase-rail').querySelectorAll('[data-phase]').forEach((node, position) => {
    node.classList.toggle('current', position === index);
    node.classList.toggle('passed', position < index);
  });
}
function setRunning(running) {
  $('run').hidden = running; $('stop').hidden = !running;
  $('task').disabled = running; $('refresh-page').disabled = running;
  $('save-settings').disabled = running; $('new-task').hidden = running;
  $('header-new-task').disabled = running;
  $('keyboard-hint').hidden = running;
  $('run').disabled = !connected;
}

async function connect() {
  const version = ++connectionVersion;
  $('connection').textContent = 'Checking local model…';
  $('connection-dot').className = 'dot';
  $('runtime-label').className = 'runtime-label'; $('runtime-label').textContent = 'Connecting';
  connected = false; $('run').disabled = true;
  try {
    const models = await listModels(settings);
    if (version !== connectionVersion) return;
    $('model-options').replaceChildren(...models.map(name => Object.assign(document.createElement('option'), { value: name })));
    if (!models.includes(settings.model)) throw new Error(`Ollama is running, but ${settings.model} is not installed. Run: ollama pull ${settings.model}`);
    connected = true; $('connection').textContent = settings.model;
    $('connection-dot').className = 'dot connected'; $('connection-help').hidden = true;
    $('runtime-label').className = 'runtime-label ready'; $('runtime-label').textContent = 'Ready';
    $('run').disabled = false;
  } catch (error) {
    if (version !== connectionVersion) return;
    $('connection').textContent = 'Connect your local model'; $('connection-dot').className = 'dot error';
    $('runtime-label').className = 'runtime-label offline'; $('runtime-label').textContent = 'Offline';
    showError(error.message);
  }
}

async function refreshPage() {
  if (controller) return;
  const tabs = await availableTabs();
  if (controller) return;
  if (tabs.length) {
    tabId = tabs[0].id; updatePage({ title: tabs[0].title || tabs[0].url, url: tabs[0].url });
  } else { tabId = null; updatePage(null); }
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  element.setAttribute('d', path); svg.append(element); return svg;
}
function activity(title, description = '', warning = false, detail = '') {
  const main = $('main-content');
  const following = main.scrollHeight - main.scrollTop - main.clientHeight < 100;
  const li = document.createElement('li');
  if (warning) li.className = 'warning';
  const marker = document.createElement('span'); marker.className = 'activity-icon';
  marker.append(icon(warning ? 'M12 7v6m0 4h.01M12 3 2 21h20Z' : 'M4 7h16M4 12h11M4 17h7'));
  const content = document.createElement('div'); content.className = 'activity-content';
  const heading = document.createElement('strong'); heading.textContent = title; content.append(heading);
  if (description) { const p = document.createElement('p'); p.textContent = description; content.append(p); }
  if (detail) {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'View result';
    const pre = document.createElement('pre'); pre.textContent = detail;
    details.append(summary, pre); content.append(details);
  }
  li.append(marker, content);
  $('activity').append(li);
  if (following && document.body.dataset.view === 'activity') li.scrollIntoView({ block: 'nearest' });
}

function emit(event) {
  transcript.push({ time: new Date().toISOString(), ...event });
  if (event.type === 'state') {
    const labels = { observing: 'Reading the page', planning: 'Choosing the next step', acting: 'Working on it', approval: 'Waiting for your approval' };
    $('status').textContent = labels[event.state] || event.state;
    $('step-counter').textContent = `${event.step} / ${event.limit} steps`;
    $('status-bar').className = `status-bar${event.state === 'approval' ? ' idle' : ''}`;
    $('session-status').textContent = event.state === 'approval' ? 'REVIEW' : 'RUNNING';
    updatePhase(event.state);
    $('activity-tab').classList.toggle('attention', event.state === 'approval');
    if (event.state === 'approval') setView('activity');
  } else if (event.type === 'page') {
    updatePage(event.page);
  } else if (event.type === 'action' && event.action.action !== 'done') {
    const a = event.action;
    const labels = { click: 'Click a control', type: 'Fill a field', select: 'Choose an option', scroll: 'Explore the page', navigate: 'Open a page', back: 'Go back', read: 'Read the page', wait: 'Wait for the page' };
    activity(`${event.step}. ${labels[a.action] || a.action}`, a.reason);
    $('activity-count').textContent = String(event.step);
  } else if (event.type === 'result') {
    const last = $('activity').lastElementChild;
    if (last) {
      const details = document.createElement('details'); const summary = document.createElement('summary');
      summary.textContent = 'View result'; const pre = document.createElement('pre'); pre.textContent = event.text;
      details.append(summary, pre); last.querySelector('.activity-content').append(details);
      last.classList.add('complete');
      last.querySelector('.activity-icon').replaceChildren(icon('m5 12 4 4 10-10'));
    }
  } else if (event.type === 'warning' || event.type === 'note') {
    activity(event.type === 'warning' ? 'Couldn’t complete that step' : 'A small adjustment', event.text, true);
  } else if (event.type === 'done') {
    $('answer').hidden = false; $('answer-text').textContent = event.answer;
    const declined = event.answer.startsWith('Stopped.');
    $('status').textContent = declined ? 'Stopped by you' : 'Task complete';
    $('status-bar').className = `status-bar idle${declined ? '' : ' complete'}`;
    $('session-status').textContent = declined ? 'STOPPED' : 'COMPLETE';
    $('step-counter').textContent = `${event.steps} action${event.steps === 1 ? '' : 's'}`;
    if (!declined) updatePhase('done');
  }
}

function approve({ action, reason, page, signal }) {
  const element = page.elements.find(item => item.id === action.target);
  $('approval-reason').textContent = reason;
  $('approval-detail').textContent = `${action.action.toUpperCase()} ${element?.label || ''}\n${action.value || element?.href || ''}\nOn: ${page.url}`;
  $('approval').hidden = false; $('approval').scrollIntoView({ block: 'nearest' });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      $('allow').removeEventListener('click', allow); $('deny').removeEventListener('click', deny);
      signal.removeEventListener('abort', abort); $('approval').hidden = true;
    };
    const allow = () => { cleanup(); resolve(true); };
    const deny = () => { cleanup(); resolve(false); };
    const abort = () => { cleanup(); reject(signal.reason); };
    $('allow').addEventListener('click', allow); $('deny').addEventListener('click', deny);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function startTask() {
  if (controller) return;
  const task = $('task').value.trim();
  if (!task) { $('task').focus(); return toast('Tell Orbit what you’d like to do.'); }
  if (!connected) { showSettings(); return toast('Connect a local model first.'); }
  if (!tabId) await refreshPage();
  if (!tabId) return toast('Open a regular website, then choose “Use current page”.');
  controller = new AbortController();
  transcript = [{ type: 'task', task, model: settings.model, time: new Date().toISOString() }];
  $('activity').replaceChildren(); $('answer').hidden = true;
  $('activity-tab').disabled = false; $('activity-count').textContent = '0';
  $('steps-disclosure').open = true;
  closeSettings(); $('status-bar').className = 'status-bar';
  setView('activity');
  setRunning(true);
  try {
    await runAgent({ task, settings: { ...settings }, driver: createDriver(tabId), signal: controller.signal, emit, approve });
  } catch (error) {
    const stopped = controller.signal.aborted;
    const message = stopped ? 'Stopped. No further actions will be taken. Actions already completed are not undone.' : error.message;
    $('status').textContent = stopped ? 'Stopped by you' : 'Needs your attention';
    $('status-bar').className = `status-bar idle${stopped ? '' : ' failed'}`;
    $('session-status').textContent = stopped ? 'STOPPED' : 'PAUSED';
    activity(stopped ? 'Task stopped' : 'Task paused', message, true);
    transcript.push({ type: 'error', text: message, time: new Date().toISOString() });
  } finally {
    controller = null; setRunning(false); $('approval').hidden = true;
    $('activity-tab').classList.remove('attention');
  }
}

$('run').addEventListener('click', startTask);
$('stop').addEventListener('click', () => controller?.abort(new DOMException('Stopped by user', 'AbortError')));
$('task').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); startTask(); } });
$('task').addEventListener('input', updateTaskCount);
$('workspace-tab').addEventListener('click', () => setView('workspace'));
$('activity-tab').addEventListener('click', () => setView('activity'));
$('settings-toggle').addEventListener('click', showSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', event => {
  const box = $('settings').getBoundingClientRect();
  if (event.target === $('settings') && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeSettings();
});
$('open-setup').addEventListener('click', showSettings);
$('connection').addEventListener('click', () => { if (!controller) connect(); });
$('refresh-page').addEventListener('click', () => refreshPage().catch(error => toast(error.message)));
$('grant-access').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    $('access-row').hidden = granted;
    if (granted) { await refreshPage(); toast('Website access enabled. You stay in control of sensitive actions.'); }
  } catch (error) { toast(error.message); }
});
$('save-settings').addEventListener('click', async () => {
  $('settings-feedback').hidden = true;
  try {
    const endpoint = validateEndpoint($('endpoint').value.trim());
    const model = $('model').value.trim();
    const maxSteps = Number($('max-steps').value);
    if (!/^[a-zA-Z0-9_.:/-]{1,150}$/.test(model)) throw new Error('Enter a valid Ollama model name.');
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw new Error('Choose a step limit between 1 and 30.');
    settings = { endpoint, model, maxSteps, context: Number($('context').value) };
    await chrome.storage.local.set({ settings });
    $('save-settings').disabled = true;
    await connect();
    if (connected) { closeSettings(); toast('Your local model is connected.'); }
  } catch (error) {
    $('settings-feedback').textContent = error.message; $('settings-feedback').dataset.tone = 'error'; $('settings-feedback').hidden = false;
  } finally { $('save-settings').disabled = Boolean(controller); }
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
  $('task').value = button.dataset.task; updateTaskCount(); $('task').focus(); $('task').scrollIntoView({ block: 'nearest' });
}));
async function resetTask() {
  if (controller) return;
  $('task').value = ''; updateTaskCount(); transcript = [];
  $('activity').replaceChildren(); $('answer').hidden = true;
  $('activity-tab').disabled = true; $('activity-count').textContent = '0';
  $('new-task').hidden = true;
  setView('workspace');
  await refreshPage(); $('task').focus();
}
$('new-task').addEventListener('click', resetTask);
$('header-new-task').addEventListener('click', resetTask);
$('copy-answer').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('answer-text').textContent); toast('Answer copied.'); }
  catch { toast('Select and copy the answer below.'); }
});
$('copy-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('origin-command').textContent); toast('Ollama startup command copied.'); }
  catch { toast('Select and copy the command shown above.'); }
});
$('export').addEventListener('click', () => {
  if (!transcript.length) return toast('Run a task to create a session to export.');
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, events: transcript }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `orbit-session-${Date.now()}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.tabs.onActivated.addListener(() => { if (!controller) refreshPage().catch(() => {}); });
window.addEventListener('pagehide', () => controller?.abort(new DOMException('Panel closed', 'AbortError')));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) controller?.abort(new DOMException('Panel hidden', 'AbortError'));
});

async function init() {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $('keyboard-hint').querySelector('kbd').textContent = 'Cmd';
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  $('endpoint').value = settings.endpoint; $('model').value = settings.model;
  $('max-steps').value = settings.maxSteps; $('context').value = settings.context;
  $('origin-command').textContent = `OLLAMA_ORIGINS="chrome-extension://${chrome.runtime.id}" ollama serve`;
  $('access-row').hidden = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  await Promise.all([refreshPage(), connect()]);
}
init().catch(error => toast(error.message));
