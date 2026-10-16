import { inspectAction, observationText, systemPrompt } from './protocol.js';
import { nextAction } from './ollama.js';

export async function runAgent({ task, settings, driver, signal, emit = () => {}, approve, decide = nextAction, successCriteria = [] }) {
  if (!task?.trim() || task.length > 4000) throw new Error('Use a task between 1 and 4,000 characters.');
  if (!Array.isArray(successCriteria) || successCriteria.length > 8) throw new Error('Use at most eight completion checks.');
  const criteria = successCriteria.map(text => String(text).trim()).filter(Boolean);
  if (criteria.some(text => text.length > 400)) throw new Error('Each completion check must be at most 400 characters.');
  const history = [], committed = new Set();
  const metrics = { executed: 0, verified: 0, unverified: 0, recovered: 0, errors: 0, model: settings.model };
  let lastSignature = '', repeats = 0, errors = 0, completionFailures = 0;
  let lastResult = 'Task started.', model = settings.model;
  const limit = Math.min(30, Math.max(1, Number(settings.maxSteps) || 16));
  function recoverModel() {
    if (settings.recoveryModel && model !== settings.recoveryModel) {
      model = settings.recoveryModel; metrics.model = model;
      emit({ type: 'note', text: `Using the configured local recovery model: ${model}.` });
    }
  }
  for (let step = 1; step <= limit; step++) {
    signal.throwIfAborted();
    emit({ type: 'state', state: 'observing', step, limit });
    const page = await driver.observe(signal, { task, context: settings.context });
    emit({ type: 'page', page: { title: page.title, url: page.url }, limitations: page.limitations });
    const system = systemPrompt();
    let recent = history.slice(-4), evidence = lastResult.slice(0, 2800), prefix, observationBudget;
    // Conservative UTF-8 budget; actual tokenization depends on the local model.
    // Never silently drop a user task or completion requirement to fit a page.
    do {
      prefix = `USER TASK: ${task}\nREQUIRED COMPLETION CHECKS (exact rendered text): ${JSON.stringify(criteria)}\nStep ${step}/${limit}. Recent action receipts (dispatched does not mean successful): ${JSON.stringify(recent)}\nLast result excerpt: ${evidence}\nUNTRUSTED PAGE OBSERVATION:\n`;
      observationBudget = (Number(settings.context) || 8192) * 2 - new TextEncoder().encode(system + prefix).length - 1800;
      if (observationBudget >= 1024) break;
      if (recent.length > 1) recent.shift();
      else if (evidence.length > 300) evidence = evidence.slice(0, Math.floor(evidence.length * .65));
      else if (recent.length) recent = [];
      else throw new Error('The task and completion requirements exceed this context window. Shorten them or select a larger context window.');
    } while (true);
    const messages = [ { role: 'system', content: system }, { role: 'user', content: prefix + observationText(page, Math.min(14000, observationBudget)) } ];
    emit({ type: 'state', state: 'planning', step, limit });
    let action;
    try { action = await decide({ ...settings, model }, messages, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!/invalid JSON|invalid browser action/.test(error.message)) throw error;
      recoverModel();
      emit({ type: 'note', text: 'Repairing the action format before taking a browser action.' });
      messages.push({ role: 'user', content: `${error.message} Return one valid action using the exact JSON schema.` });
      action = await decide({ ...settings, model }, messages, signal);
    }
    signal.throwIfAborted();
    if (action.action === 'done') {
      let checks = [];
      if (criteria.length) {
        if (!driver.check) throw new Error('This browser driver cannot verify the requested completion checks.');
        emit({ type: 'state', state: 'verifying', step, limit });
        checks = await driver.check(criteria, signal);
        if (!Array.isArray(checks) || checks.length !== criteria.length || checks.some((check,index) => check.text !== criteria[index] || typeof check.passed !== 'boolean')) throw new Error('The verifier returned incomplete completion checks. The task cannot be marked verified.');
        emit({ type: 'checks', checks });
        if (checks.some(check => !check.passed)) {
          lastResult = `Task completion was REJECTED. These exact page-text checks have not passed: ${JSON.stringify(checks.filter(check => !check.passed).map(check => check.text))}. Inspect, wait, or take a different action. Do not claim success.`;
          emit({ type: 'warning', text: 'The requested completion checks have not passed. Replanning instead of marking the task complete.', step });
          history.push({ action: 'done', status: 'rejected', missing: checks.filter(check => !check.passed).map(check => check.text) });
          completionFailures++;
          if (completionFailures >= 3) throw new Error('The model tried to finish three times without meeting the completion checks. The task is incomplete.');
          recoverModel(); continue;
        }
      }
      const completion = criteria.length ? 'criteria_verified' : 'model_reported';
      const answer = action.value || 'The model finished without an answer.';
      emit({ type: 'done', answer, steps: metrics.executed, completion, checks, metrics: { ...metrics } });
      return { answer, steps: metrics.executed, completion, metrics: { ...metrics } };
    }
    emit({ type: 'action', action, step });
    const target = page.elements.find(element => element.id === action.target);
    const signature = JSON.stringify([action.action, target ? [target.kind,target.label,target.href,target.scope] : action.target, action.value, page.url]);
    repeats = signature === lastSignature ? repeats + 1 : 0; lastSignature = signature;
    if (repeats >= 2) throw new Error('The model repeated the same action three times. Stopped to avoid a loop.');
    try {
      const policy = inspectAction(action, page);
      if (policy.approval && committed.has(signature)) throw new Error('This consequential action was already dispatched once. Inspect its outcome or stop; it will not be repeated.');
      let approved = false;
      if (policy.approval) {
        emit({ type: 'state', state: 'approval', step, limit });
        approved = await approve({ action, reason: policy.reason, page, signal });
        signal.throwIfAborted();
        if (!approved) {
          const answer = 'Stopped. The action was declined and was not performed.';
          emit({ type: 'done', answer, steps: metrics.executed, completion: 'stopped', metrics: { ...metrics } });
          return { answer, steps: metrics.executed, completion: 'stopped', metrics: { ...metrics } };
        }
      }
      signal.throwIfAborted();
      emit({ type: 'state', state: 'acting', step, limit });
      let receipt;
      try {
        receipt = driver.execute ? await driver.execute(action, page, signal, { approved }) : {
          status: 'unverified', summary: await driver.perform(action, page, signal), evidence: 'Legacy driver has no verification receipt.', output: '',
        };
      } catch (error) {
        if (error.dispatched && policy.approval) committed.add(signature);
        throw error;
      }
      if (policy.approval) committed.add(signature);
      metrics.executed++; metrics[receipt.status === 'verified' ? 'verified' : 'unverified']++;
      if (receipt.recovered) metrics.recovered++;
      lastResult = JSON.stringify(receipt);
      history.push({ action: action.action, target: action.target, value: ['read','extract'].includes(action.action) ? '' : action.value.slice(0, 250), status: receipt.status, result: receipt.summary, evidence: receipt.evidence });
      emit({ type: 'result', text: receipt.output || receipt.summary, receipt, step, metrics: { ...metrics } });
      if (receipt.recovered) emit({ type: 'note', text: 'Recovered the uniquely matching control after the website rerendered it.' });
      if (receipt.status === 'unverified') emit({ type: 'note', text: 'The action was sent once. Its outcome still needs visible evidence.' });
      errors = 0;
    } catch (error) {
      signal.throwIfAborted();
      metrics.errors++; errors++;
      lastResult = `${error.dispatched ? 'The action was dispatched, but its outcome is not verified. Do not repeat a consequential action.' : 'The action was NOT completed.'} ${error.message}. Observe again or finish with an honest explanation.`;
      history.push({ action: action.action, status: error.dispatched ? 'uncertain' : 'rejected', error: error.message });
      emit({ type: 'warning', text: error.message, step });
      if (errors >= 2) recoverModel();
      if (errors >= 3) throw new Error(`Stopped after three unsuccessful actions. ${error.message}`);
    }
  }
  throw new Error(`Reached the ${limit}-step limit. The task may be incomplete. Try a smaller task or raise the limit in settings.`);
}
