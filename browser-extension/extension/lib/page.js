// Runs in Chrome's isolated world. All helpers are inside this function so the
// implementation can be serialized by chrome.scripting without eval or remote code.
export async function pageRuntime(operation, payload = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const clean = (text, max = 180) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const nonce = () => [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join('-');
  const hash = text => { let h = 2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const state = globalThis.__orbitPageStateV2 ||= { documentId: nonce(), nextId: 1, ids: new WeakMap(), snapshots: new Map() };
  const roots = [];
  let blockedFrames = 0;
  let scanned = 0;
  function discover(root, scope = 'page', frames = []) {
    if (roots.length >= 40 || scanned > 16000) return;
    roots.push({ root, scope, frames });
    let index = 0;
    for (const element of root.querySelectorAll('*')) {
      if (++scanned > 16000) break;
      const key = `${element.localName}:${element.id || element.getAttribute('name') || index++}`;
      if (element.shadowRoot) discover(element.shadowRoot, `${scope}/shadow:${key}`, frames);
      if (element.localName === 'iframe' || element.localName === 'frame') {
        try {
          if (element.contentDocument?.documentElement) discover(element.contentDocument, `${scope}/frame:${key}`, [...frames, element]);
          else blockedFrames++;
        } catch { blockedFrames++; }
      }
    }
  }
  discover(document);
  const styles = element => element.ownerDocument.defaultView.getComputedStyle(element);
  function rendered(element, viewport = false) {
    if (!element?.isConnected || !element.getClientRects().length || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = styles(element), box = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || box.width < 1 || box.height < 1) return false;
    if (!viewport) return true;
    const win = element.ownerDocument.defaultView;
    if (box.bottom <= 0 || box.top >= win.innerHeight || box.right <= 0 || box.left >= win.innerWidth) return false;
    const info = roots.find(entry => entry.root === element.getRootNode());
    return !info || info.frames.every(frame => rendered(frame, true));
  }
  function labelText(element, includeHidden = false) {
    if (!element || element.matches?.('input,textarea,select,[contenteditable]')) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts = []; let node, length = 0;
    while ((node = walker.nextNode()) && length < 1200) {
      if (node.parentElement?.closest('input,textarea,select,[contenteditable],script,style,[hidden],[aria-hidden="true"]')) continue;
      if (!includeHidden && !rendered(node.parentElement)) continue;
      parts.push(node.textContent); length += node.textContent.length;
    }
    return parts.join(' ');
  }
  function label(element) {
    const root = element.getRootNode();
    const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => labelText(root.getElementById?.(id) || element.ownerDocument.getElementById(id), true)).join(' ');
    const editable = /^(input|textarea|select)$/.test(element.localName) || element.isContentEditable;
    return clean(element.getAttribute('aria-label') || labelled || [...(element.labels || [])].map(item => labelText(item)).join(' ') ||
      element.getAttribute('placeholder') || (!editable ? labelText(element) : '') || element.title || element.name || element.type || element.localName);
  }
  const controls = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"],[contenteditable="true"]';
  function describe(element, info) {
    const tag = element.localName, inputType = element.type || '';
    const name = label(element);
    const kind = tag === 'a' ? 'link' : tag === 'select' ? 'select' : /^(input|textarea)$/.test(tag) || element.isContentEditable || ['textbox', 'combobox'].includes(element.getAttribute('role')) ? 'input' : element.matches(controls) ? 'button' : 'scroll';
    const hints = [inputType, name, element.name, element.id, element.autocomplete].join(' ');
    const form = element.form || element.closest('form');
    const context = clean(labelText(element.closest('fieldset')?.querySelector('legend')) || element.closest('[role="dialog"]')?.getAttribute('aria-label'), 100);
    return {
      kind, label: name, inputType, context, scope: info.scope, tag, name: element.name || '', domId: element.id || '',
      role: element.getAttribute('role') || '', href: tag === 'a' ? element.href : '', download: element.hasAttribute('download'),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]')),
      readOnly: Boolean(element.readOnly || element.getAttribute('aria-readonly') === 'true'),
      protected: /password|one.?time|otp|credit.?card|cc-(number|csc|exp|name|type)|card.?number|cvv|security.?code/i.test(hints) || inputType === 'file',
      sensitive: /email|phone|tel|address|birth|passport|ssn|social.security/i.test(hints),
      formSensitive: Boolean(form?.querySelector('input[type="password"],input[autocomplete^="cc-"],input[type="file"]')),
      formAction: form?.action || '', formMethod: form?.method || '',
      options: tag === 'select' ? [...element.options].slice(0, 30).map(option => ({ value: option.value, text: clean(option.text, 80) })) : undefined,
    };
  }
  function identity(value) {
    // Generated DOM IDs can change on a framework rerender. All semantic and
    // security-relevant fields must remain identical before a unique recovery.
    return JSON.stringify(['scope','tag','kind','role','label','inputType','name','href','download','protected','sensitive','formSensitive','formAction','formMethod']
      .map(key => value[key] ?? ''));
  }
  function allControls(viewport = false) {
    const result = [];
    for (const info of roots) {
      for (const element of info.root.querySelectorAll(controls)) {
        if (rendered(element, viewport)) result.push({ element, info, descriptor: describe(element, info) });
      }
    }
    return result;
  }
  function textContent(max = 18000, viewport = false) {
    const chunks = []; let length = 0;
    for (const { root } of roots) {
      const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && length < max) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]') || !rendered(parent, viewport)) continue;
        const part = clean(node.textContent, 1200);
        if (part) { chunks.push(part); length += part.length; }
      }
      if (length >= max) break;
    }
    return chunks.join('\n').slice(0, max);
  }
  function resolveTarget(snapshot, id) {
    const saved = snapshot.targets.get(id);
    if (!saved) fail('TARGET_MISSING', 'That control was not in the observation.');
    const currentInfo = roots.find(entry => entry.scope === saved.descriptor.scope);
    if (saved.element.isConnected && currentInfo) {
      const current = describe(saved.element, currentInfo);
      if (identity(current) !== identity(saved.descriptor)) fail('TARGET_CHANGED', 'The control or its form changed. A fresh observation and approval are required.');
      return { element: saved.element, descriptor: { ...current, id }, recovered: false };
    }
    const matches = allControls().filter(candidate => identity(candidate.descriptor) === identity(saved.descriptor));
    if (matches.length !== 1) fail(matches.length ? 'TARGET_AMBIGUOUS' : 'TARGET_MISSING', matches.length ? 'Several controls match the old target. Refusing to guess.' : 'The original control disappeared. Observe the page again.');
    state.ids.set(matches[0].element, id);
    snapshot.targets.set(id, { element: matches[0].element, descriptor: matches[0].descriptor });
    return { element: matches[0].element, descriptor: { ...matches[0].descriptor, id }, recovered: true };
  }
  function getSnapshot() {
    const snapshot = state.snapshots.get(payload.snapshotId);
    if (!snapshot || snapshot.url !== location.href || payload.expectedUrl !== location.href || Date.now() - snapshot.created > 600000) fail('STALE_PAGE', 'The page or observation changed. Observe it again.');
    return snapshot;
  }
  function targetState(element) {
    return element ? { checked: Boolean(element.checked), expanded: element.getAttribute('aria-expanded'), selected: element.getAttribute('aria-selected'),
      pressed: element.getAttribute('aria-pressed'), activeDescendant: element.getAttribute('aria-activedescendant'), x: Math.round(element.scrollLeft), y: Math.round(element.scrollTop) } : null;
  }
  function probe(snapshot, action) {
    let target;
    try { target = action.target ? resolveTarget(snapshot, action.target) : null; } catch {}
    const element = target?.element;
    const text = textContent(['assert','wait_for'].includes(action.action) ? 50000 : 18000);
    let matches = null;
    if (action.action === 'type' && element) matches = (element.isContentEditable ? element.textContent : element.value) === action.value;
    if (action.action === 'select' && element) matches = [...(element.selectedOptions || [])].some(option => option.value === action.value || option.text === action.value);
    const focusHash = hash(roots.map(({root,scope}) => { const active=root.activeElement; return `${scope}:${active?.localName}:${active?.id}:${active?.name}`; }).join('|'));
    return { documentId: state.documentId, url: location.href, textHash: hash(text), textLength: text.length, focusHash,
      target: targetState(element), matches, recovered: Boolean(target?.recovered), textFound: action.value ? clean(text, 50000).toLowerCase().includes(clean(action.value, 6000).toLowerCase()) : false,
      x: Math.round(scrollX), y: Math.round(scrollY), ready: document.readyState };
  }
  function guard(target, action) {
    const { element, descriptor } = target;
    if (descriptor.disabled) fail('DISABLED', 'This control is disabled.');
    if (descriptor.protected) fail('PROTECTED', 'Protected input: passwords, codes, payment details, and uploads must be handled directly by you.');
    if (descriptor.readOnly && ['type','select'].includes(action.action)) fail('READ_ONLY', 'This field is read-only.');
    if (!rendered(element)) fail('NOT_VISIBLE', 'This control is not visible.');
  }
  try {
    if (operation === 'observe') {
      const tokens = clean(payload.task, 4000).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 2);
      let candidates = allControls(true);
      for (const info of roots) {
        for (const element of info.root.querySelectorAll('main,section,div,[role="region"],[role="listbox"]')) {
          if (candidates.length > 400) break;
          if (rendered(element, true) && element.clientHeight > 90 && element.scrollHeight > element.clientHeight + 100 && /auto|scroll/.test(styles(element).overflowY)) candidates.push({ element, info, descriptor: describe(element, info) });
        }
      }
      const modal = candidates.filter(({ element }) => element.closest('[role="dialog"],[aria-modal="true"],dialog[open]'));
      if (modal.length) candidates = modal;
      candidates.forEach((candidate, index) => {
        const haystack = `${candidate.descriptor.label} ${candidate.descriptor.context}`.toLowerCase();
        candidate.rank = tokens.reduce((score, token) => score + (haystack.includes(token) ? 5 : 0), 0) + (candidate.element === candidate.element.ownerDocument.activeElement ? 3 : 0) - index / 1000;
      });
      const limit = Math.min(60, Math.max(16, payload.maxControls || 40));
      const picked = candidates.sort((a,b) => b.rank - a.rank).slice(0, limit);
      const targets = new Map();
      const elements = picked.map(({ element, descriptor }) => {
        let id = state.ids.get(element);
        if (!id) { id = state.nextId++; state.ids.set(element, id); }
        targets.set(id, { element, descriptor });
        return { ...descriptor, id };
      });
      const snapshotId = nonce();
      state.snapshots.set(snapshotId, { targets, url: location.href, created: Date.now() });
      while (state.snapshots.size > 8) state.snapshots.delete(state.snapshots.keys().next().value);
      return { ok: true, value: { snapshotId, documentId: state.documentId, title: document.title, url: location.href, text: textContent(payload.maxText || 5000, true), elements,
        viewport: { y: Math.round(scrollY), height: innerHeight, documentHeight: document.documentElement.scrollHeight },
        limitations: { crossOriginFrames: blockedFrames, accessibleRoots: roots.length, controlsClipped: candidates.length > limit, scanLimited: scanned > 16000 } } };
    }
    const action = payload.action || { action: 'read', target: 0, value: '' };
    const snapshot = getSnapshot();
    if (operation === 'probe') return { ok: true, value: probe(snapshot, action) };
    if (operation === 'prepare') {
      const target = action.target ? resolveTarget(snapshot, action.target) : null;
      if (target && ['click','type','select','press'].includes(action.action)) guard(target, action);
      return { ok: true, value: { descriptor: target?.descriptor || null, recovered: Boolean(target?.recovered), before: probe(snapshot, action) } };
    }
    if (operation !== 'act') fail('UNSUPPORTED', 'Unknown page operation.');
    if (action.action === 'read') {
      const text = textContent(50000), index = action.value ? text.toLowerCase().indexOf(action.value.toLowerCase()) : 0;
      const start = Math.max(0, index - 300);
      return { ok: true, value: { summary: 'Read rendered page text.', output: text.slice(start, start + 11000), before: probe(snapshot, action) } };
    }
    if (action.action === 'extract') {
      let output = [];
      for (const { root } of roots) {
        if (action.value === 'links') output.push(...[...root.querySelectorAll('a[href]')].filter(element => rendered(element) && /^https?:/.test(element.href) && !new URL(element.href).username && !new URL(element.href).password).slice(0, 60).map(element => ({ text: label(element), url: element.href })));
        else if (action.value === 'headings') output.push(...[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(element => rendered(element)).slice(0, 60).map(element => ({ level: Number(element.localName[1]), text: clean(element.textContent, 300) })));
        else if (action.value === 'tables') output.push(...[...root.querySelectorAll('table')].filter(element => rendered(element)).slice(0, 6).map(table => ({ caption: clean(labelText(table.caption)), rows: [...table.rows].filter(row => rendered(row)).slice(0, 30).map(row => [...row.cells].slice(0, 12).map(cell => clean(labelText(cell), 300))) })));
        else fail('UNSUPPORTED', 'Choose links, tables, or headings.');
      }
      const originalCount = output.length;
      output = output.slice(0, action.value === 'tables' ? 6 : 80);
      let truncated = output.length !== originalCount;
      const encoder = new TextEncoder();
      while (output.length && encoder.encode(JSON.stringify(output)).length > 16000) {
        const last = output.at(-1);
        if (action.value === 'tables' && last.rows.length > 1) last.rows.pop();
        else output.pop();
        truncated = true;
      }
      return { ok: true, value: { summary: `Extracted ${action.value}.${truncated ? ' Output was limited; inspect additional sections separately.' : ''}`, output: JSON.stringify(output), truncated, before: probe(snapshot, action) } };
    }
    const target = action.target ? resolveTarget(snapshot, action.target) : null;
    const element = target?.element;
    if (action.action === 'scroll') {
      const scroller = element || window;
      const before = probe(snapshot, action), direction = action.value.toLowerCase();
      const height = element?.clientHeight || innerHeight;
      if (direction === 'top') scroller.scrollTo({ top: 0, behavior: 'instant' });
      else if (direction === 'bottom') scroller.scrollTo({ top: element?.scrollHeight || document.documentElement.scrollHeight, behavior: 'instant' });
      else scroller.scrollBy({ top: (direction === 'up' ? -1 : 1) * Math.round(height * .75), behavior: 'instant' });
      return { ok: true, value: { summary: 'Scrolled the page or panel.', before, recovered: Boolean(target?.recovered) } };
    }
    if (!target) fail('TARGET_MISSING', 'This action needs a control ID.');
    guard(target, action);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    for (const frame of roots.find(info => info.scope === target.descriptor.scope)?.frames || []) frame.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const box = element.getBoundingClientRect(), win = element.ownerDocument.defaultView;
    const point = { x: Math.max(1, Math.min(win.innerWidth - 1, box.left + box.width / 2)), y: Math.max(1, Math.min(win.innerHeight - 1, box.top + box.height / 2)) };
    let framePoint = { ...point };
    for (const frame of [...(roots.find(info => info.scope === target.descriptor.scope)?.frames || [])].reverse()) {
      const rect = frame.getBoundingClientRect();
      framePoint = { x: framePoint.x + rect.left + frame.clientLeft, y: framePoint.y + rect.top + frame.clientTop };
      let hit = frame.ownerDocument.elementFromPoint(framePoint.x, framePoint.y);
      while (hit?.shadowRoot) { const deep = hit.shadowRoot.elementFromPoint(framePoint.x, framePoint.y); if (!deep || deep === hit) break; hit = deep; }
      if (hit !== frame && !frame.contains(hit)) fail('OBSCURED', 'Another element covers this frame. No action was taken.');
    }
    let top = element.ownerDocument.elementFromPoint(point.x, point.y);
    while (top?.shadowRoot) { const deep = top.shadowRoot.elementFromPoint(point.x, point.y); if (!deep || deep === top) break; top = deep; }
    if (top !== element && !element.contains(top)) fail('OBSCURED', 'Another element covers this control. It was not clicked.');
    const before = probe(snapshot, action);
    if (action.action === 'click') {
      if (element.localName === 'a') {
        const href = new URL(element.href);
        if (!['http:','https:'].includes(href.protocol)) fail('UNSAFE_URL', 'Only web links can be followed.');
        // Preserve website routing and handlers; keep ordinary target=_blank links in this task's tab.
        const oldTarget = element.getAttribute('target');
        if (oldTarget && oldTarget !== '_self') element.setAttribute('target', '_self');
        element.click();
        if (oldTarget) element.setAttribute('target', oldTarget);
      } else element.click();
    } else if (action.action === 'type') {
      element.focus();
      // A focus handler can change the control; check again before writing anything.
      guard({ element, descriptor: describe(element, roots.find(info => info.scope === target.descriptor.scope)) }, action);
      if (element.isContentEditable) element.textContent = action.value;
      else {
        const proto = element.localName === 'textarea' ? win.HTMLTextAreaElement.prototype : element.localName === 'input' ? win.HTMLInputElement.prototype : null;
        if (!proto || (element.localName === 'input' && !['text','search','email','url','tel','number','date','time','datetime-local','month','week',''].includes(element.type))) fail('UNSUPPORTED', 'This is not a supported text field.');
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, action.value);
      }
      element.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    } else if (action.action === 'select') {
      if (element.localName !== 'select') fail('UNSUPPORTED', 'This control is not a dropdown.');
      const option = [...element.options].find(item => item.value === action.value || item.text === action.value);
      if (!option || option.disabled || option.parentElement?.disabled) fail('OPTION_MISSING', 'That option is unavailable.');
      element.value = option.value;
      element.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    } else if (action.action === 'press') {
      if (!['Enter','Escape','Tab','ArrowDown','ArrowUp','Home','End'].includes(action.value)) fail('UNSUPPORTED', 'Unsupported key.');
      element.focus();
      const accepted = element.dispatchEvent(new win.KeyboardEvent('keydown', { key: action.value, code: action.value, bubbles: true, cancelable: true, composed: true }));
      if (accepted && action.value === 'Enter') {
        if (element.localName === 'button') element.click();
        else if (element.form && element.localName === 'input') element.form.requestSubmit();
      } else if (accepted && action.value === 'Tab') {
        const focusable = allControls(true).filter(item => !item.descriptor.disabled && item.element.tabIndex >= 0);
        focusable[(focusable.findIndex(item => item.element === element) + 1) % focusable.length]?.element.focus();
      }
      element.dispatchEvent(new win.KeyboardEvent('keyup', { key: action.value, bubbles: true, composed: true }));
    } else fail('UNSUPPORTED', 'Unsupported browser action.');
    return { ok: true, value: { summary: `${action.action} dispatched to ${target.descriptor.label}.`, before, recovered: target.recovered } };
  } catch (error) { return { ok: false, error: { code: error.code || 'PAGE_ERROR', message: error.message } }; }
}
