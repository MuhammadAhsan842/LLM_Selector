import { inspectAction, observationText, systemPrompt } from './protocol.js';
import { nextAction } from './ollama.js';

export async function runAgent({ task, settings, driver, signal, emit = () => {}, approve, decide = nextAction }) {
  if (!task?.trim() || task.length > 4000) throw new Error('Use a task between 1 and 4,000 characters.');
  const history = [];
  let lastSignature = '';
  let repeats = 0;
  let errors = 0;
  let lastResult = 'Task started.';
  const limit = Math.min(30, Math.max(1, Number(settings.maxSteps) || 16));
  for (let step = 1; step <= limit; step++) {
    signal.throwIfAborted();
    emit({ type: 'state', state: 'observing', step, limit });
    const page = await driver.observe(signal);
    emit({ type: 'page', page: { title: page.title, url: page.url }, limitations: page.limitations });
    const messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: `USER TASK: ${task}\nStep ${step}/${limit}. Recent completed actions: ${JSON.stringify(history.slice(-5))}\nLast result: ${lastResult.slice(0, 4500)}\nUNTRUSTED PAGE OBSERVATION:\n${observationText(page)}` },
    ];
    emit({ type: 'state', state: 'planning', step, limit });
    let action;
    try {
      action = await decide(settings, messages, signal);
    } catch (error) {
      signal.throwIfAborted();
      // One repair attempt for malformed actions; network and model failures surface immediately.
      if (!/invalid JSON|invalid browser action/.test(error.message)) throw error;
      emit({ type: 'note', text: 'Asking the model to repair its action format.' });
      messages.push({ role: 'user', content: `${error.message} Return one valid action using the exact JSON schema.` });
      action = await decide(settings, messages, signal);
    }
    signal.throwIfAborted();
    emit({ type: 'action', action, step });
    if (action.action === 'done') {
      emit({ type: 'done', answer: action.value || 'Task complete.', steps: step - 1 });
      return { answer: action.value || 'Task complete.', steps: step - 1 };
    }
    const signature = JSON.stringify([action.action, action.target, action.value, page.url]);
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 2) throw new Error('The model repeated the same action three times. Stopped to avoid a loop.');
    try {
      const policy = inspectAction(action, page);
      if (policy.approval) {
        emit({ type: 'state', state: 'approval', step, limit });
        const allowed = await approve({ action, reason: policy.reason, page, signal });
        signal.throwIfAborted();
        if (!allowed) {
          emit({ type: 'done', answer: 'Stopped. The action was declined and was not performed.', steps: step - 1 });
          return { answer: 'Action declined.', steps: step - 1 };
        }
      }
      signal.throwIfAborted();
      emit({ type: 'state', state: 'acting', step, limit });
      lastResult = await driver.perform(action, page, signal);
      history.push({ action: action.action, target: action.target, value: action.action === 'read' ? '' : action.value.slice(0, 300), result: lastResult.slice(0, 500) });
      emit({ type: 'result', text: lastResult, step });
      errors = 0;
    } catch (error) {
      signal.throwIfAborted();
      errors++;
      lastResult = `The action was NOT completed: ${error.message}. Observe again or finish with a clear explanation.`;
      history.push({ action: action.action, error: error.message });
      emit({ type: 'warning', text: error.message, step });
      if (errors >= 3) throw new Error(`Stopped after three unsuccessful actions. ${error.message}`);
    }
  }
  throw new Error(`Reached the ${limit}-step limit. The task may be incomplete. Try a smaller task or raise the limit in settings.`);
}
