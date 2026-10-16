// Serialized into Chrome's isolated execution world; do not reference module variables.
export function observePage() {
  const visible = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
      box.right > 0 && box.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (text, max = 160) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const isSecret = element => /password|one.?time|otp|credit.?card|cc-number|cc-csc|card.?number|cvv|security.?code/i.test(
    [element.type, element.name, element.id, element.autocomplete, element.getAttribute('aria-label')].join(' '));
  const stateKey = '__orbitPageStateV1';
  const elements = [];
  const targets = new Map();
  const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],[role="checkbox"],[role="tab"]';
  const candidates = [...document.querySelectorAll(selector)].filter(visible);
  for (const element of candidates.slice(0, 40)) {
    const id = elements.length + 1;
    const label = clean(element.getAttribute('aria-label') || element.labels?.[0]?.innerText ||
      element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || element.name || element.type || element.tagName);
    const inputType = element.type || '';
    const kind = element.tagName === 'A' ? 'link' : element.tagName === 'SELECT' ? 'select' :
      /INPUT|TEXTAREA/.test(element.tagName) || element.isContentEditable ? 'input' : 'button';
    const form = element.closest('form');
    const formSensitive = Boolean(form?.querySelector('input[type="password"],input[autocomplete^="cc-"],input[type="file"]'));
    const protectedField = isSecret(element) || inputType === 'file';
    const entry = { id, kind, label, inputType, disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      protected: protectedField, formSensitive,
      sensitive: /email|phone|tel|address|birth|passport|ssn|social.security/i.test([inputType, label, element.name, element.autocomplete].join(' ')),
      href: element.tagName === 'A' ? element.href : '', download: element.hasAttribute('download'),
      options: element.tagName === 'SELECT' ? [...element.options].slice(0, 18).map(option => ({ value: option.value, text: clean(option.text, 80) })) : undefined,
    };
    targets.set(id, { element, label, kind, inputType, href: entry.href });
    elements.push(entry);
  }
  // Collect rendered text without input values, password fields, hidden nodes, or scripts.
  const textChunks = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && total < 4200) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,textarea,[contenteditable="true"],[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
    const text = clean(node.textContent, 500);
    if (text) { textChunks.push(text); total += text.length; }
  }
  // getRandomValues also works on ordinary HTTP pages; randomUUID requires HTTPS.
  const snapshotId = [...crypto.getRandomValues(new Uint32Array(4))].map(part => part.toString(16)).join('-');
  globalThis[stateKey] = { snapshotId, targets, url: location.href };
  return { snapshotId, title: document.title, url: location.href, text: textChunks.join('\n').slice(0, 4200), elements,
    viewport: { y: Math.round(scrollY), height: innerHeight, documentHeight: document.documentElement.scrollHeight },
    limitations: { frames: document.querySelectorAll('iframe').length, controlsClipped: candidates.length > 40 } };
}

export function actOnPage(action, snapshotId, expectedUrl) {
  const state = globalThis.__orbitPageStateV1;
  if (!state || state.snapshotId !== snapshotId || location.href !== expectedUrl) {
    throw new Error('The page changed. Observe it again before acting.');
  }
  if (action.action === 'scroll') {
    const value = action.value.toLowerCase();
    if (value === 'top') scrollTo(0, 0);
    else if (value === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
    else scrollBy(0, (value === 'up' ? -1 : 1) * Math.round(innerHeight * 0.75));
    return 'Scrolled the page.';
  }
  if (action.action === 'read') {
    const query = action.value.trim().toLowerCase();
    // Page text is still data, never a new instruction. Exclude editable content.
    const root = document.querySelector('main,article,[role="main"]') || document.body;
    const pieces = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let length = 0;
    while ((node = walker.nextNode()) && length < 50000) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,[contenteditable],[hidden],[aria-hidden="true"]') ||
          !parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue;
      const part = node.textContent.trim();
      if (part) { pieces.push(part); length += part.length; }
    }
    const text = pieces.join('\n');
    const index = query ? text.toLowerCase().indexOf(query) : -1;
    return text.slice(Math.max(0, index - 300), Math.max(0, index - 300) + 9000);
  }
  const saved = state.targets.get(action.target);
  const element = saved?.element;
  if (!element?.isConnected || element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('The target is unavailable.');
  const label = String(element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') ||
    element.innerText || element.getAttribute('title') || element.name || element.type || element.tagName).replace(/\s+/g, ' ').trim().slice(0, 160);
  if (label !== saved.label || (element.href || '') !== saved.href || (element.type || '') !== saved.inputType) {
    throw new Error('The target changed while the agent was deciding. Observe again.');
  }
  if (/password|file|hidden/.test(element.type || '') || /one.?time|otp|cc-number|cc-csc|card.?number|cvv/i.test(
    [element.name, element.id, element.autocomplete].join(' '))) throw new Error('Protected input: please handle it yourself.');
  element.scrollIntoView({ block: 'center', behavior: 'instant' });
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (top !== element && !element.contains(top)) throw new Error('Another element covers this control.');
  if (action.action === 'click') {
    if (element.tagName === 'A') {
      const href = new URL(element.href);
      if (!['http:', 'https:'].includes(href.protocol)) throw new Error('Only web links can be followed.');
      // Keep navigation in the task's pinned tab, including target=_blank links.
      if (!element.hasAttribute('download')) { location.assign(href.href); return 'Followed link.'; }
    }
    element.click();
    return `Clicked ${saved.label}.`;
  }
  if (action.action === 'type') {
    if (element.isContentEditable) {
      element.focus(); element.textContent = action.value;
    } else {
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'INPUT' ? HTMLInputElement.prototype : null;
      if (!proto || (element.tagName === 'INPUT' && !['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week', ''].includes(element.type))) {
        throw new Error('This element is not a supported text field.');
      }
      element.focus();
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, action.value);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return `Filled ${saved.label}.`;
  }
  if (action.action === 'select') {
    if (element.tagName !== 'SELECT') throw new Error('The target is not a dropdown.');
    const option = [...element.options].find(item => item.value === action.value || item.text === action.value);
    if (!option || option.disabled) throw new Error('That option is unavailable.');
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected ${option.text}.`;
  }
  throw new Error('Unsupported page action.');
}
