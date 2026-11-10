// A native range handles touch, mouse and arrow keys without custom drag math.
export function wireAnswerSlider(input, onAnswer) {
  const control = input.closest('.answer-control');
  let answered = false;

  function paint() {
    const progress = Number(input.value) / 100;
    const travel = Math.max(0, input.clientWidth - 68);
    control.style.setProperty('--answer-offset', `${travel * progress}px`);
    control.style.setProperty('--answer-label-opacity', String(Math.max(0, 1 - progress * 2)));
    input.setAttribute('aria-valuetext', progress >= 0.95 ? 'Answer call' : 'Slide right to answer');
  }

  function reset() {
    if (answered) return;
    input.value = '0';
    paint();
  }

  function commit() {
    if (answered) return;
    if (Number(input.value) < 95) return reset();
    answered = true;
    input.disabled = true;
    onAnswer();
  }

  input.addEventListener('input', paint);
  input.addEventListener('change', commit);
  input.addEventListener('pointercancel', reset);
  input.addEventListener('blur', reset);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    input.value = '100';
    paint();
    commit();
  });
  paint();
}
