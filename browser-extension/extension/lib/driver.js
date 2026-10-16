import { observePage, actOnPage } from './page.js';
import { safeWebUrl } from './protocol.js';

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
  return tabs.filter(tab => /^https?:\/\//.test(tab.url || '')).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

export function createDriver(tabId) {
  async function waitReady(signal) {
    for (let attempt = 0; attempt < 40; attempt++) {
      signal?.throwIfAborted();
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular website and grant site access to use Orbit.');
      if (tab.status === 'complete') return;
      await delay(250, signal);
    }
    throw new Error('The page is still loading. Wait a moment and try again.');
  }
  return {
    async observe(signal) {
      await waitReady(signal);
      try {
        const result = await chrome.scripting.executeScript({ target: { tabId }, func: observePage });
        if (!result[0]?.result) throw new Error('No readable page was returned.');
        return result[0].result;
      } catch (error) {
        throw new Error(`Cannot read this page. Use “Enable website access” and reload restricted pages. ${error.message}`);
      }
    },
    async perform(action, page, signal) {
      signal?.throwIfAborted();
      const current = await chrome.tabs.get(tabId);
      if (current.url !== page.url) throw new Error('The tab navigated while the agent was deciding.');
      let result;
      if (action.action === 'navigate') {
        await chrome.tabs.update(tabId, { url: safeWebUrl(action.value) });
        result = 'Opened the requested page.';
      } else if (action.action === 'back') {
        await chrome.tabs.goBack(tabId);
        result = 'Returned to the previous page.';
      } else if (action.action === 'wait') {
        await delay(1200, signal); result = 'Waited for the page.';
      } else {
        const response = await chrome.scripting.executeScript({ target: { tabId }, func: actOnPage,
          args: [action, page.snapshotId, page.url] });
        result = response[0]?.result || 'Action completed.';
      }
      await delay(450, signal);
      return String(result).slice(0, 9000);
    },
  };
}
