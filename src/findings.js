import findingsHtml from '../deliverables/vocalcoach-findings.html?raw';

// Size the same standalone deck to its panel without changing its content.
const panelStyles = `<style>
  html, body, .deck { height: 100%; }
  body { overflow: hidden; }
  .deck { display: flex; flex-direction: column; }
  .deck .slide { flex: 1; min-height: 0; }
  .deck .controls { flex-shrink: 0; }
</style>`;

const deckDocument = findingsHtml.replace(
  '</head>',
  `${panelStyles}</head>`,
);

const stage = document.getElementById('stage');
const phone = document.getElementById('fit');
const findings = document.getElementById('findings');
const frame = document.getElementById('product-findings');
let revealTimer = null;

frame.srcdoc = deckDocument;

export function isShowingFindings() {
  return stage.dataset.phase === 'findings';
}

export function cancelFindingsReveal() {
  clearTimeout(revealTimer);
  revealTimer = null;
}

export function revealFindings(delay = 0) {
  cancelFindingsReveal();
  revealTimer = setTimeout(() => {
    revealTimer = null;
    stage.dataset.phase = 'findings';
    findings.inert = false;
    findings.removeAttribute('aria-hidden');
    frame.focus({ preventScroll: true });
    phone.inert = true;
    phone.setAttribute('aria-hidden', 'true');
  }, delay);
}

export function showDemo() {
  cancelFindingsReveal();
  stage.dataset.phase = 'demo';
  phone.inert = false;
  phone.removeAttribute('aria-hidden');
  phone.focus({ preventScroll: true });
  findings.inert = true;
  findings.setAttribute('aria-hidden', 'true');
  frame.srcdoc = deckDocument;
}
