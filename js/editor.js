// editor.js — interactive schematic editor on a <canvas>.
// Handles grid snapping, component placement, selection, moving,
// endpoint reshaping, switch toggling, undo/redo, and rendering.

import { CELL, DEFS, makeComponent, renderComponent, drawShape, voltageColor, formatValue } from './components.js';

const HIT_DIST = 6;
const DOT_SPACING = 14;

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Snap a drag direction to the nearest of 8 compass directions.
function snapDir(x0, y0, gx, gy) {
  const dx = gx - x0, dy = gy - y0;
  if (dx === 0 && dy === 0) return { x: gx, y: gy };
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx >= 2 * ady) return { x: gx, y: y0 };
  if (ady >= 2 * adx) return { x: x0, y: gy };
  const m = Math.max(1, Math.round((adx + ady) / 2));
  return { x: x0 + Math.sign(dx) * m, y: y0 + Math.sign(dy) * m };
}

export class Editor {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.components = [];
    this.tool = 'select';
    this.selection = null;
    this.hover = null;
    this.drag = null;
    this.undoStack = [];
    this.redoStack = [];
    this.cb = callbacks; // { onChange, onSelect, onHover, onEdit }

    canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    canvas.addEventListener('pointermove', e => this.pointerMove(e));
    canvas.addEventListener('pointerup', e => this.pointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.cb.onHover?.(null, null);
    });
    canvas.addEventListener('dblclick', e => {
      const c = this.hitTest(...this.toPx(e));
      if (c) {
        this.select(c);
        this.cb.onEdit?.(c);
      }
    });
  }

  // ---------- coordinates ----------

  toPx(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  toGrid(e) {
    const [mx, my] = this.toPx(e);
    return { x: Math.round(mx / CELL), y: Math.round(my / CELL) };
  }

  // ---------- state ----------

  serialize() {
    return JSON.stringify({
      version: 1,
      components: this.components.map(c => {
        const o = { type: c.type, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 };
        if (c.value !== undefined) o.value = c.value;
        if (c.freq !== undefined) o.freq = c.freq;
        if (c.closed !== undefined) o.closed = c.closed;
        return o;
      }),
    });
  }

  load(data) {
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    this.components = (obj.components || []).map(o =>
      Object.assign(makeComponent(o.type, o.x1, o.y1, o.x2, o.y2),
        o.value !== undefined ? { value: o.value } : null,
        o.freq !== undefined ? { freq: o.freq } : null,
        o.closed !== undefined ? { closed: o.closed } : null));
    this.select(null);
    this.changed();
  }

  pushUndo() {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.serialize());
    this.loadSnapshot(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.serialize());
    this.loadSnapshot(this.redoStack.pop());
  }

  loadSnapshot(json) {
    const obj = JSON.parse(json);
    this.components = obj.components.map(o =>
      Object.assign(makeComponent(o.type, o.x1, o.y1, o.x2, o.y2),
        o.value !== undefined ? { value: o.value } : null,
        o.freq !== undefined ? { freq: o.freq } : null,
        o.closed !== undefined ? { closed: o.closed } : null));
    this.select(null);
    this.changed();
  }

  changed() {
    this.cb.onChange?.();
  }

  select(c) {
    this.selection = c;
    this.cb.onSelect?.(c);
  }

  setTool(t) {
    this.tool = t;
    this.drag = null;
    if (t !== 'select') this.select(null);
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  }

  deleteSelection() {
    if (!this.selection) return;
    this.pushUndo();
    this.components = this.components.filter(c => c !== this.selection);
    this.select(null);
    this.changed();
  }

  rotateSelection() {
    const c = this.selection;
    if (!c) return;
    this.pushUndo();
    const mx = (c.x1 + c.x2) / 2, my = (c.y1 + c.y2) / 2;
    const r = (x, y) => ({ x: Math.round(mx + (my - y)), y: Math.round(my + (x - mx)) });
    const p1 = r(c.x1, c.y1), p2 = r(c.x2, c.y2);
    c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y;
    this.changed();
  }

  // ---------- hit testing ----------

  hitTest(mx, my) {
    for (let i = this.components.length - 1; i >= 0; i--) {
      const c = this.components[i];
      if (segDist(mx, my, c.x1 * CELL, c.y1 * CELL, c.x2 * CELL, c.y2 * CELL) < HIT_DIST) return c;
    }
    return null;
  }

  hitEndpoint(mx, my, c) {
    if (!c) return 0;
    if (Math.hypot(mx - c.x1 * CELL, my - c.y1 * CELL) < HIT_DIST + 2) return 1;
    if (c.type !== 'ground' && Math.hypot(mx - c.x2 * CELL, my - c.y2 * CELL) < HIT_DIST + 2) return 2;
    return 0;
  }

  // ---------- pointer handling ----------

  pointerDown(e) {
    if (e.button !== 0) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const [mx, my] = this.toPx(e);
    const g = this.toGrid(e);

    if (this.tool === 'select') {
      const end = this.hitEndpoint(mx, my, this.selection);
      if (end) {
        this.pushUndo();
        this.drag = { kind: 'endpoint', c: this.selection, end, moved: false };
        return;
      }
      const c = this.hitTest(mx, my);
      this.select(c);
      if (c) {
        this.pushUndo();
        this.drag = {
          kind: 'move', c, start: g, moved: false,
          orig: { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 },
        };
      }
    } else {
      this.drag = { kind: 'place', type: this.tool, g1: g, g2: g };
    }
  }

  pointerMove(e) {
    const [mx, my] = this.toPx(e);
    const g = this.toGrid(e);
    const d = this.drag;

    if (!d) {
      const c = this.hitTest(mx, my);
      this.hover = c;
      this.cb.onHover?.(c, g);
      return;
    }

    if (d.kind === 'place') {
      d.g2 = d.type === 'ground'
        ? g
        : snapDir(d.g1.x, d.g1.y, g.x, g.y);
    } else if (d.kind === 'move') {
      const ddx = g.x - d.start.x, ddy = g.y - d.start.y;
      if (ddx || ddy) d.moved = true;
      d.c.x1 = d.orig.x1 + ddx; d.c.y1 = d.orig.y1 + ddy;
      d.c.x2 = d.orig.x2 + ddx; d.c.y2 = d.orig.y2 + ddy;
    } else if (d.kind === 'endpoint') {
      const c = d.c;
      const fx = d.end === 1 ? c.x2 : c.x1;
      const fy = d.end === 1 ? c.y2 : c.y1;
      const p = c.type === 'ground' ? g : snapDir(fx, fy, g.x, g.y);
      if (d.end === 1) { c.x1 = p.x; c.y1 = p.y; } else { c.x2 = p.x; c.y2 = p.y; }
      d.moved = true;
    }
  }

  pointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;

    if (d.kind === 'place') {
      let { g1, g2 } = d;
      if (d.type === 'ground') {
        if (g1.x === g2.x && g1.y === g2.y) g2 = { x: g1.x, y: g1.y + 1 };
        this.pushUndo();
        this.components.push(makeComponent('ground', g1.x, g1.y, g2.x, g2.y));
        this.changed();
        return;
      }
      if (g1.x === g2.x && g1.y === g2.y) g2 = { x: g1.x + 4, y: g1.y }; // plain click → default footprint
      this.pushUndo();
      const c = makeComponent(d.type, g1.x, g1.y, g2.x, g2.y);
      this.components.push(c);
      this.changed();
    } else if (d.kind === 'move' && !d.moved) {
      // A clean click: undo snapshot wasn't needed for a move,
      // but keep it if this click toggles a switch.
      if (d.c.type === 'switch') {
        d.c.closed = !d.c.closed;
        this.changed();
      } else {
        this.undoStack.pop();
      }
    } else if (d.kind === 'endpoint' && !d.moved) {
      this.undoStack.pop();
    } else {
      this.changed();
    }
  }

  // ---------- rendering ----------

  resize() {
    const wrap = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  render(vScale, running, frameDt) {
    this.resize();
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    // grid dots
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let gx = 0; gx * CELL < this.w; gx++) {
      for (let gy = 0; gy * CELL < this.h; gy++) {
        ctx.fillRect(gx * CELL - 0.5, gy * CELL - 0.5, 1.5, 1.5);
      }
    }

    for (const c of this.components) {
      renderComponent(ctx, c, vScale, c === this.selection);
    }

    // current dots
    if (running) this.advanceDots(frameDt);
    ctx.fillStyle = '#ffd24a';
    for (const c of this.components) {
      if (c.type === 'ground' || !c._i || Math.abs(c._i) < 1e-7) continue;
      const x1 = c.x1 * CELL, y1 = c.y1 * CELL;
      const x2 = c.x2 * CELL, y2 = c.y2 * CELL;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 2) continue;
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const off = ((c._dot || 0) % DOT_SPACING + DOT_SPACING) % DOT_SPACING;
      for (let dpos = off; dpos <= len; dpos += DOT_SPACING) {
        ctx.beginPath();
        ctx.arc(x1 + ux * dpos, y1 + uy * dpos, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // selection endpoint handles
    if (this.selection) {
      const c = this.selection;
      ctx.fillStyle = '#579dff';
      const pts = c.type === 'ground' ? [[c.x1, c.y1]] : [[c.x1, c.y1], [c.x2, c.y2]];
      for (const [gx, gy] of pts) {
        ctx.fillRect(gx * CELL - 3.5, gy * CELL - 3.5, 7, 7);
      }
    }

    // placement ghost
    const d = this.drag;
    if (d && d.kind === 'place') {
      ctx.globalAlpha = 0.55;
      drawShape(ctx, d.type, d.g1.x * CELL, d.g1.y * CELL,
        (d.g1.x === d.g2.x && d.g1.y === d.g2.y && d.type !== 'ground' ? d.g1.x + 4 : d.g2.x) * CELL,
        (d.type === 'ground' && d.g1.x === d.g2.x && d.g1.y === d.g2.y ? d.g1.y + 1 : d.g2.y) * CELL,
        {});
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  advanceDots(frameDt) {
    for (const c of this.components) {
      if (!c._i) continue;
      const speed = Math.max(-160, Math.min(160, c._i * 25000)); // px/s
      c._dot = (c._dot || 0) + speed * frameDt;
    }
  }
}
