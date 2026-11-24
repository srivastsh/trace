export const fixtureTurns = 1200;
export const eventsPerRun = 36;

export function seedWorkload({ turns, mode }) {
  const thread = document.querySelector('#thread');
  const composer = document.querySelector('#prompt-textarea');
  const render = index => {
    const turn = document.createElement('article');
    turn.dataset.testid = `conversation-turn-${index}`;
    turn.style.height = '51px';
    const message = document.createElement('div');
    message.setAttribute('data-message-author-role', index % 2 ? 'assistant' : 'user');
    message.setAttribute('data-message-id', `perf-${index}`);
    message.textContent = `Synthetic renderer benchmark message ${index} with a repeatable vocabulary.`;
    turn.append(message);
    return turn;
  };
  const range = (start, length) => Array.from({ length }, (_, offset) => render(start + offset));
  if (mode === 'virtualized') {
    const setVirtualRows = () => {
      const start = Math.max(0, Math.min(turns - 24, Math.floor(scrollY / 81) - 8));
      if (thread.dataset.start === String(start)) return;
      thread.dataset.start = String(start);
      thread.style.paddingTop = `${start * 81}px`;
      thread.style.paddingBottom = `${(turns - 24 - start) * 81}px`;
      thread.replaceChildren(...range(start, 24));
    };
    setVirtualRows();
    addEventListener('scroll', setVirtualRows, { passive: true });
  } else {
    thread.replaceChildren(...range(0, turns));
  }
  const measurements = { input: [], wheel: [] };
  const record = type => () => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => measurements[type].push(performance.now() - start)));
  };
  composer.addEventListener('input', record('input'));
  addEventListener('wheel', record('wheel'), { passive: true });
  window.tracePerformance = measurements;
  scrollTo(0, 1600);
  composer.focus({ preventScroll: true });
}

export function summarize(values) {
  const ordered = values.toSorted((a, b) => a - b);
  const at = p => Number(ordered[Math.ceil(p * ordered.length) - 1].toFixed(2));
  return { medianMs: at(0.5), p95Ms: at(0.95), samples: ordered.length };
}
