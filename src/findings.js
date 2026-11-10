import findingsHtml from '../deliverables/vocalcoach-findings.html?raw';

// Size the same standalone deck to its panel without changing its content.
const panelStyles = `<style>
  html, body, .deck { height: 100%; }
  body { overflow: hidden; }
  .deck { display: flex; flex-direction: column; }
  .deck .slide { flex: 1; min-height: 0; }
  .deck .controls { flex-shrink: 0; }
</style>`;

document.getElementById('product-findings').srcdoc = findingsHtml.replace(
  '</head>',
  `${panelStyles}</head>`,
);
