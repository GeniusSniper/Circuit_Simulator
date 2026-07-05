// main.js — app bootstrap: toolbar, palette, inspector, and the simulation loop.

import { Simulation } from './engine.js';
import {
  CELL, DEFS, PALETTE, drawShape, drawMosfet, isMos,
  formatValue, parseValue, componentLabel,
} from './components.js';
import { Editor } from './editor.js';
import { EXAMPLES } from './examples.js';

const $ = id => document.getElementById(id);

// ---------- state ----------

let sim = null;
let dirty = true;
let running = true;
let simTime = 0;
let dt = 50e-6;
let errorMsg = null;
let lastFrame = performance.now();

const scopeHist = [];
const SCOPE_MAX = 4000;

// ---------- editor ----------

const editor = new Editor($('canvas'), {
  onChange() {
    dirty = true;
    errorMsg = null;
    saveSoon();
  },
  onSelect(c) {
    scopeHist.length = 0;
    buildInspector(c);
  },
  onHover(c, g) {
    if (c) {
      const label = componentLabel(c);
      const parts = [DEFS[c.type].name];
      if (label) parts.push(label);
      if (c._v1 !== undefined) {
        if (isMos(c.type)) {
          parts.push('Vgs: ' + formatValue((c._v1 - c._v3) || 0, 'V'));
          parts.push('Vds: ' + formatValue((c._v2 - c._v3) || 0, 'V'));
          parts.push('Id: ' + formatValue(c._i || 0, 'A'));
        } else {
          parts.push('V: ' + formatValue((c._v1 - c._v2) || 0, 'V'));
          parts.push('I: ' + formatValue(c._i || 0, 'A'));
        }
      }
      setHint(parts.join('  ·  '));
    } else if (g && sim) {
      const v = sim.nodeVoltageAt(g.x, g.y);
      setHint(v === null ? defaultHint() : `Node voltage: ${formatValue(v, 'V')}`);
    } else {
      setHint(defaultHint());
    }
  },
  onEdit() {
    const input = document.querySelector('#inspector input');
    if (input) { input.focus(); input.select(); }
  },
});

function defaultHint() {
  if (editor.tool === 'select') {
    return 'Select: click to pick, drag to move, drag endpoints to reshape. Click a switch to toggle it. R rotates, Del deletes.';
  }
  return `Drag on the canvas to place a ${DEFS[editor.tool]?.name || editor.tool} (a plain click places one too). Esc returns to Select.`;
}

function setHint(s) {
  if (!errorMsg) $('status-hint').textContent = s;
}

// ---------- palette ----------

function buildPalette() {
  const pal = $('palette');
  for (const item of PALETTE) {
    const btn = document.createElement('button');
    btn.className = 'pal-btn';
    btn.dataset.type = item.type;
    btn.title = item.name;

    const icon = document.createElement('canvas');
    icon.width = 44 * devicePixelRatio;
    icon.height = 26 * devicePixelRatio;
    icon.style.width = '44px';
    icon.style.height = '26px';
    const ictx = icon.getContext('2d');
    ictx.scale(devicePixelRatio, devicePixelRatio);
    if (item.type === 'select') {
      ictx.fillStyle = '#dfe5f0';
      ictx.beginPath();
      ictx.moveTo(16, 4);
      ictx.lineTo(16, 20);
      ictx.lineTo(20.5, 16);
      ictx.lineTo(24, 23);
      ictx.lineTo(27, 21.5);
      ictx.lineTo(23.5, 15);
      ictx.lineTo(29, 14);
      ictx.closePath();
      ictx.fill();
    } else if (item.type === 'ground') {
      drawShape(ictx, 'ground', 22, 5, 22, 20, {});
    } else if (isMos(item.type)) {
      drawMosfet(ictx, item.type, 8, 13, 36, 3, 36, 23, {});
    } else {
      drawShape(ictx, item.type, 3, 13, 41, 13, { closed: false });
    }

    const label = document.createElement('span');
    label.textContent = item.name;
    btn.append(icon, label);
    btn.addEventListener('click', () => setTool(item.type));
    pal.appendChild(btn);
  }
}

function setTool(type) {
  editor.setTool(type);
  document.querySelectorAll('.pal-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
  setHint(defaultHint());
}

// ---------- inspector ----------

function buildInspector(c) {
  const box = $('inspector-body');
  box.innerHTML = '';
  if (!c) {
    box.innerHTML = '<p class="muted">Nothing selected.<br>Click a component to inspect and edit it, or pick a part from the palette and drag it onto the canvas.</p>';
    return;
  }
  const d = DEFS[c.type];

  const h = document.createElement('h3');
  h.textContent = d.name;
  box.appendChild(h);

  const addField = (labelText, getVal, setVal) => {
    const row = document.createElement('label');
    row.className = 'field';
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = getVal();
    input.spellcheck = false;
    const commit = () => {
      const v = parseValue(input.value);
      if (isFinite(v)) {
        editor.pushUndo();
        setVal(v);
        dirty = true;
        saveSoon();
      }
      input.value = getVal();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    row.append(span, input);
    box.appendChild(row);
  };

  if (c.value !== undefined && d.valueLabel) {
    addField(`${d.valueLabel} (${d.unit})`, () => formatValue(c.value, ''), v => { c.value = v; });
  }
  if (c.freq !== undefined) {
    addField('Frequency (Hz)', () => formatValue(c.freq, ''), v => { c.freq = Math.max(0, v); });
  }
  if (c.offset !== undefined) {
    addField('DC Offset (V)', () => formatValue(c.offset, ''), v => { c.offset = v; });
  }
  if (c.closed !== undefined) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    const sync = () => { btn.textContent = c.closed ? 'Closed — click to open' : 'Open — click to close'; };
    sync();
    btn.addEventListener('click', () => {
      editor.pushUndo();
      c.closed = !c.closed;
      sync();
      dirty = true;
      saveSoon();
    });
    box.appendChild(btn);
  }

  const live = document.createElement('div');
  live.className = 'live';
  live.id = 'live-readout';
  box.appendChild(live);

  const scope = document.createElement('canvas');
  scope.id = 'scope';
  scope.width = 248 * devicePixelRatio;
  scope.height = 110 * devicePixelRatio;
  scope.style.width = '248px';
  scope.style.height = '110px';
  box.appendChild(scope);

  const row = document.createElement('div');
  row.className = 'btn-row';
  const rot = document.createElement('button');
  rot.className = 'btn';
  rot.textContent = 'Rotate (R)';
  rot.addEventListener('click', () => editor.rotateSelection());
  const del = document.createElement('button');
  del.className = 'btn danger';
  del.textContent = 'Delete (Del)';
  del.addEventListener('click', () => editor.deleteSelection());
  row.append(rot, del);
  box.appendChild(row);
}

function updateLiveReadout() {
  const c = editor.selection;
  const el = $('live-readout');
  if (!c || !el) return;
  if (c._v1 === undefined) { el.textContent = ''; return; }
  if (isMos(c.type)) {
    const vgs = (c._v1 - c._v3) || 0;
    const vds = (c._v2 - c._v3) || 0;
    const id = c._i || 0;
    el.innerHTML =
      `<div><span>V<sub>GS</sub></span><b>${formatValue(vgs, 'V')}</b></div>` +
      `<div><span>V<sub>DS</sub></span><b>${formatValue(vds, 'V')}</b></div>` +
      `<div><span>I<sub>D</sub></span><b>${formatValue(id, 'A')}</b></div>` +
      `<div><span>Power</span><b>${formatValue(vds * id, 'W')}</b></div>`;
    return;
  }
  const v = (c._v1 - c._v2) || 0;
  const i = c._i || 0;
  el.innerHTML =
    `<div><span>Voltage</span><b>${formatValue(v, 'V')}</b></div>` +
    `<div><span>Current</span><b>${formatValue(i, 'A')}</b></div>` +
    `<div><span>Power</span><b>${formatValue(v * i, 'W')}</b></div>`;
}

function sampleScope() {
  const c = editor.selection;
  if (!c || c._v1 === undefined) return;
  const v = isMos(c.type) ? (c._v2 - c._v3) : (c._v1 - c._v2); // MOSFET scope traces Vds
  scopeHist.push({ v: v || 0, i: c._i || 0 });
  if (scopeHist.length > SCOPE_MAX) scopeHist.splice(0, scopeHist.length - SCOPE_MAX);
}

function drawScope() {
  const scope = $('scope');
  if (!scope) return;
  const ctx = scope.getContext('2d');
  const w = 248, hgt = 110;
  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, w, hgt);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(0, hgt / 2);
  ctx.lineTo(w, hgt / 2);
  ctx.stroke();

  const data = scopeHist.slice(-w);
  if (data.length > 1) {
    const vmax = Math.max(1e-3, ...data.map(s => Math.abs(s.v)));
    const imax = Math.max(1e-6, ...data.map(s => Math.abs(s.i)));
    const trace = (key, max, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      data.forEach((s, k) => {
        const x = w - data.length + k;
        const y = hgt / 2 - (s[key] / max) * (hgt / 2 - 8);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    trace('v', vmax, '#3ddc84');
    trace('i', imax, '#ffd24a');
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#3ddc84';
    ctx.fillText('V ±' + formatValue(vmax, 'V'), 6, 12);
    ctx.fillStyle = '#ffd24a';
    ctx.fillText('I ±' + formatValue(imax, 'A'), 6, 24);
  }
  ctx.restore();
}

// ---------- persistence ----------

const AUTOSAVE_KEY = 'circuit-simulator.autosave';
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, editor.serialize()); } catch { /* private mode */ }
  }, 300);
}

function resetStates() {
  simTime = 0;
  scopeHist.length = 0;
  for (const c of editor.components) {
    if (c.type === 'capacitor' || c.type === 'inductor') c.state = 0;
    delete c._vd;
    delete c._lvg; delete c._lvd; delete c._lvs;
    delete c._v1;
    delete c._v2;
    delete c._v3;
    delete c._i;
    c._dot = 0;
  }
  dirty = true;
  errorMsg = null;
}

// ---------- toolbar ----------

function stepsPerFrame() {
  return Math.round(Math.pow(10, $('speed').value / 33.34));
}

function wireToolbar() {
  $('runBtn').addEventListener('click', toggleRun);
  $('resetBtn').addEventListener('click', () => resetStates());

  $('dtInput').value = formatValue(dt, 's');
  $('dtInput').addEventListener('change', e => {
    const v = parseValue(e.target.value);
    if (isFinite(v) && v > 1e-9 && v < 1) { dt = v; dirty = true; }
    e.target.value = formatValue(dt, 's');
  });

  const sel = $('examples');
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = ex.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    editor.pushUndo();
    editor.load(EXAMPLES[sel.value]);
    resetStates();
    setTool('select');
  });

  $('undoBtn').addEventListener('click', () => editor.undo());
  $('redoBtn').addEventListener('click', () => editor.redo());

  $('clearBtn').addEventListener('click', () => {
    editor.pushUndo();
    editor.load({ components: [] });
    resetStates();
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([editor.serialize()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'circuit.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      editor.pushUndo();
      editor.load(text);
      resetStates();
    } catch {
      showError('Could not read that file as a circuit JSON.');
    }
    e.target.value = '';
  });

  $('helpBtn').addEventListener('click', () => $('help').classList.toggle('hidden'));
  $('help').addEventListener('click', e => {
    if (e.target === $('help')) $('help').classList.add('hidden');
  });
}

function toggleRun() {
  running = !running;
  $('runBtn').textContent = running ? '⏸ Pause' : '▶ Run';
  $('runBtn').classList.toggle('primary', !running);
}

function showError(msg) {
  errorMsg = msg;
  $('status-hint').textContent = '⚠ ' + msg;
  $('status-hint').classList.add('error');
}

function clearError() {
  errorMsg = null;
  $('status-hint').classList.remove('error');
}

// ---------- keyboard ----------

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Delete' || e.key === 'Backspace') { editor.deleteSelection(); e.preventDefault(); }
  else if (e.key === 'r' || e.key === 'R') editor.rotateSelection();
  else if (e.key === 'Escape') setTool('select');
  else if (e.key === ' ') { toggleRun(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { editor.undo(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { editor.redo(); e.preventDefault(); }
});

// ---------- simulation loop ----------

function vScale() {
  let s = 5;
  for (const c of editor.components) {
    if ((c.type === 'vsource' || c.type === 'acsource') && Math.abs(c.value) > s) s = Math.abs(c.value);
  }
  return s;
}

function frame(now) {
  const frameDt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (dirty) {
    try {
      sim = new Simulation(editor.components, dt);
      dirty = false;
      clearError();
      setHint(defaultHint());
    } catch (err) {
      sim = null;
      dirty = false;
      showError(err.message);
    }
  }

  if (running && sim && !errorMsg) {
    try {
      const steps = stepsPerFrame();
      for (let s = 0; s < steps; s++) {
        sim.step(simTime);
        simTime += dt;
      }
    } catch (err) {
      showError(err.message);
    }
    sampleScope();
  }

  editor.render(vScale(), running && !errorMsg, frameDt);
  updateLiveReadout();
  drawScope();
  $('status-time').textContent =
    `t = ${formatValue(simTime, 's')}  ·  ${formatValue(stepsPerFrame() * dt * 60, 's')}/s`;

  requestAnimationFrame(frame);
}

// ---------- boot ----------

buildPalette();
wireToolbar();
setTool('select');

let loaded = false;
try {
  const saved = localStorage.getItem(AUTOSAVE_KEY);
  if (saved) {
    const obj = JSON.parse(saved);
    if (obj.components && obj.components.length) {
      editor.load(obj);
      loaded = true;
    }
  }
} catch { /* corrupted save — fall through */ }
if (!loaded) {
  editor.load(EXAMPLES.rc);
  $('examples').value = 'rc';
}
resetStates();
requestAnimationFrame(frame);
