import './style.css';
import { GALLERY_CONFIGS } from './configs12';
import { buildCongruenceMatrix, equivalenceClasses } from './matrix';
import { UniquenessScene } from './scene';
import { UNIT_SOLID } from './unitShape';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app missing');

const result = buildCongruenceMatrix(GALLERY_CONFIGS, UNIT_SOLID);
const classes = equivalenceClasses(result);

app.innerHTML = `
  <header>
    <h1>Shape Uniqueness Matrix</h1>
    <p>Oh congruence (rotations + reflections) · lattice unit prism</p>
    <a href="/">← All projects</a>
  </header>
  <aside class="sidebar">
    <h2>Gallery configs</h2>
    <ul class="config-list" id="config-list"></ul>
    <div class="summary" id="summary"></div>
  </aside>
  <div class="main">
    <div id="viewport"></div>
    <div class="matrix-wrap">
      <h2>Congruence matrix</h2>
      <div id="matrix-host"></div>
    </div>
  </div>
`;

const listEl = app.querySelector<HTMLUListElement>('#config-list')!;
const summaryEl = app.querySelector<HTMLDivElement>('#summary')!;
const viewport = app.querySelector<HTMLDivElement>('#viewport')!;
const matrixHost = app.querySelector<HTMLDivElement>('#matrix-host')!;

summaryEl.innerHTML = `<strong>${result.classCount}</strong> distinct classes out of
  <strong>${GALLERY_CONFIGS.length}</strong> configs
  <br/><span style="color:var(--muted);font-size:0.85rem">
  Classes: ${classes.map((g) => `[${g.map((i) => i + 1).join(',')}]`).join(' ')}
  </span>`;

const scene = new UniquenessScene(viewport);

function select(index: number): void {
  const cfg = GALLERY_CONFIGS[index]!;
  scene.setConfig(cfg, UNIT_SOLID);
  listEl.querySelectorAll('button').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });
  highlightMatrix(index);
}

for (let i = 0; i < GALLERY_CONFIGS.length; i++) {
  const cfg = GALLERY_CONFIGS[i]!;
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = cfg.label;
  btn.addEventListener('click', () => select(i));
  li.appendChild(btn);
  listEl.appendChild(li);
}

function highlightMatrix(index: number): void {
  matrixHost.querySelectorAll('.hl, .hl-row, .hl-col').forEach((el) => {
    el.classList.remove('hl', 'hl-row', 'hl-col');
  });
  matrixHost.querySelectorAll(`[data-row="${index}"]`).forEach((el) => {
    el.classList.add('hl-row');
  });
  matrixHost.querySelectorAll(`[data-col="${index}"]`).forEach((el) => {
    el.classList.add('hl-col');
  });
  matrixHost.querySelector(`th[data-idx="${index}"]`)?.classList.add('hl');
}

function renderMatrix(): void {
  const n = GALLERY_CONFIGS.length;
  const table = document.createElement('table');
  table.className = 'congruence';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(document.createElement('th'));
  for (let j = 0; j < n; j++) {
    const th = document.createElement('th');
    th.textContent = String(j + 1);
    th.dataset.idx = String(j);
    th.title = GALLERY_CONFIGS[j]!.label;
    th.addEventListener('click', () => select(j));
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = String(i + 1);
    th.dataset.idx = String(i);
    th.title = GALLERY_CONFIGS[i]!.label;
    th.addEventListener('click', () => select(i));
    tr.appendChild(th);
    for (let j = 0; j < n; j++) {
      const td = document.createElement('td');
      const match = result.matrix[i]![j]!;
      td.className = match ? 'match' : 'miss';
      td.dataset.row = String(i);
      td.dataset.col = String(j);
      td.title = match ? 'congruent' : 'distinct';
      td.addEventListener('click', () => select(i));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  matrixHost.replaceChildren(table);
}

renderMatrix();
select(0);
