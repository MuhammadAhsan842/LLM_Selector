import { pageRuntime } from './page.js';
import { inspectAction, safeWebUrl } from './protocol.js';

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
export async function availableTabs() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  return tabs.filter(tab => /^https?:\/\//.test(tab.url || '')).sort((a,b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}
export function createDriver(tabId, options = {}) {
  const timeout = Math.max(400, Math.min(12000, options.verificationTimeout || 5000));
  async function script(operation, payload, signal) {
    signal?.throwIfAborted();
    const response = await chrome.scripting.executeScript({ target: { tabId }, func: pageRuntime, args: [operation, payload] });
    signal?.throwIfAborted();
    const result = response[0]?.result;
    if (!result) { const error = new Error('The page interrupted execution. Inspect the page before repeating this action.'); error.code = 'INTERRUPTED'; error.dispatched = operation === 'act'; throw error; }
    if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
    return result.value;
  }
  async function waitReady(signal) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      signal?.throwIfAborted();
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular website and grant site access to use Orbit.');
      if (tab.status === 'complete') return tab;
      await delay(150, signal);
    }
    throw new Error('The page is still loading. Wait a moment and try again.');
  }
  const payload = (action, page) => ({ action, snapshotId: page.snapshotId, expectedUrl: page.url });
  async function observe(signal, hints = {}) {
    await waitReady(signal);
    try {
      const context = hints.context || options.context || 8192;
      return await script('observe', { task: hints.task || options.task || '', maxControls: context <= 4096 ? 24 : 40, maxText: context <= 4096 ? 2500 : 5000 }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (/Cannot access|permission|manifest/.test(error.message)) throw new Error(`Cannot read this page. Enable website access. ${error.message}`);
      throw error;
    }
  }
  async function verify(action, page, before, signal) {
    const deadline = Date.now() + timeout;
    let stable = 0, last = '', after = null, recovered = false;
    do {
      await delay(150, signal);
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== page.url && ['click','press','navigate','back'].includes(action.action)) {
        return { status: 'verified', evidence: 'The tab navigated to a different URL.' };
      }
      if (tab.status === 'loading') continue;
      try { after = await script('probe', payload(action, page), signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (['STALE_PAGE','INTERRUPTED'].includes(error.code)) {
          const fresh = await observe(signal);
          if (fresh.documentId !== before.documentId) return { status: 'verified', evidence: 'The document was replaced.' };
        }
        continue;
      }
      let evidence = '';
      recovered ||= after.recovered;
      if (['type','select'].includes(action.action) && after.matches) evidence = 'The field retained the requested value.';
      else if (action.action === 'press' && action.value === 'Tab' && after.focusHash !== before.focusHash) evidence = 'Keyboard focus moved to another control.';
      else if (action.action === 'scroll' && (action.target ? JSON.stringify(after.target) !== JSON.stringify(before.target) : after.y !== before.y || after.x !== before.x)) evidence = 'The requested scroll position changed.';
      else if (['click','press'].includes(action.action) && (after.textHash !== before.textHash || JSON.stringify(after.target) !== JSON.stringify(before.target))) evidence = 'Rendered page content or control state changed.';
      const signature = `${evidence}:${after.textHash}:${after.matches}:${JSON.stringify(after.target)}`;
      stable = evidence && signature === last ? stable + 1 : 0; last = signature;
      if (evidence && stable >= 2) return { status: 'verified', evidence, recovered };
    } while (Date.now() < deadline);
    if (['type','select'].includes(action.action)) { const error = new Error('The field did not retain the requested value.'); error.code = 'VALUE_NOT_RETAINED'; error.dispatched = true; throw error; }
    if (action.action === 'scroll') return { status: 'no_change', evidence: 'No scroll change was observed; the page or panel may already be at its boundary.' };
    return { status: 'unverified', evidence: 'The action was dispatched once, but no lasting visible outcome was observed. Do not repeat a consequential action.' };
  }
  async function execute(action, page, signal, authorization = {}) {
    signal?.throwIfAborted();
    if ((await chrome.tabs.get(tabId)).url !== page.url) { const error = new Error('The tab navigated while the agent was deciding.'); error.code = 'STALE_PAGE'; throw error; }
    const prepared = await script('prepare', payload(action, page), signal);
    const freshPage = prepared.descriptor ? { ...page, elements: [prepared.descriptor] } : page;
    const policy = inspectAction(action, freshPage);
    if (policy.approval && !authorization.approved) { const error = new Error('This action requires a fresh user approval.'); error.code = 'APPROVAL_REQUIRED'; throw error; }
    signal?.throwIfAborted();
    const started = performance.now();
    const receipt = { action: action.action, target: action.target, status: 'verified', recovered: prepared.recovered, summary: '', output: '', evidence: '' };
    if (['assert','wait_for'].includes(action.action)) {
      const until = Date.now() + (action.action === 'wait_for' ? timeout : 0);
      let found;
      do {
        const checkPage = (await chrome.tabs.get(tabId)).url === page.url ? page : await observe(signal);
        const result = await script('probe', payload(action, checkPage), signal);
        found = result.textFound;
        if (found || Date.now() >= until) break;
        await delay(150, signal);
      } while (true);
      if (!found) { const error = new Error(`Expected visible page text was not found: ${action.value.slice(0, 160)}`); error.code = 'ASSERTION_FAILED'; throw error; }
      receipt.summary = 'Expected visible page text was found.'; receipt.evidence = receipt.summary;
    } else if (action.action === 'navigate' || action.action === 'back') {
      if (action.action === 'navigate') await chrome.tabs.update(tabId, { url: safeWebUrl(action.value) });
      else await chrome.tabs.goBack(tabId);
      const tab = await waitReady(signal);
      if (action.action === 'navigate' && tab.url !== safeWebUrl(action.value)) {
        receipt.status = 'unverified'; receipt.evidence = 'The page redirected; inspect its actual destination.';
      } else if (action.action === 'back' && tab.url === page.url) {
        receipt.status = 'unverified'; receipt.evidence = 'No navigation change was observed.';
      } else receipt.evidence = 'The browser reached the requested URL.';
      receipt.summary = action.action === 'back' ? 'Used browser back navigation.' : 'Opened the requested address.';
    } else if (action.action === 'wait') {
      await delay(700, signal); receipt.summary = 'Waited for the page.'; receipt.evidence = 'The wait completed; this does not prove any page outcome.';
    } else {
      let result;
      try { result = await script('act', payload(action, page), signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error.code !== 'INTERRUPTED' && !/context.*destroy|frame.*removed/i.test(error.message)) throw error;
        const verified = await verify(action, page, prepared.before, signal);
        return { ...receipt, ...verified, summary: 'Page execution was interrupted; inspected the outcome without repeating the action.', durationMs: Math.round(performance.now() - started) };
      }
      receipt.summary = result.summary; receipt.output = result.output || '';
      receipt.recovered ||= result.recovered;
      if (['read','extract'].includes(action.action)) receipt.evidence = 'Extracted from rendered DOM; hidden controls and field values are excluded.';
      else {
        const verification = await verify(action, page, result.before, signal);
        receipt.recovered ||= verification.recovered;
        receipt.status = verification.status; receipt.evidence = verification.evidence;
      }
    }
    receipt.durationMs = Math.round(performance.now() - started);
    return receipt;
  }
  async function check(criteria, signal) {
    const page = await observe(signal);
    const results = [];
    for (const text of criteria) {
      const result = await script('probe', payload({ action: 'assert', target: 0, value: text }, page), signal);
      results.push({ text, passed: result.textFound });
    }
    return results;
  }
  return { observe, execute, check, async perform(action, page, signal) {
    const result = await execute(action, page, signal);
    return result.output || result.summary;
  } };
}
