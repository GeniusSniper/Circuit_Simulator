// editor.js — interactive schematic editor on a <canvas>.
// Handles grid snapping, component placement, selection, moving,
// endpoint reshaping, switch toggling, undo/redo, and rendering
// (including junction dots and drag-to-connect highlights).

import {
  CELL, DEFS, makeComponent, renderComponent, drawShape, drawThreeTerm,
  voltageColor, is3Term, footprint3,
} from './components.js';

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

// Cardinal direction of a drag vector (for MOSFET orientation).
function cardinalDir(x0, y0, gx, gy) {
  const dx = gx - x0, dy = gy - y0;
  if (dx === 0 && dy === 0) return 'e';
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : (dy >= 0 ? 's' : 'n');
}

// Grid-space terminal points of a component, paired with their solved voltages.
export function terminalsOf(c) {
  if (c.type === 'ground') return [[c.x1, c.y1, c._v1]];
  if (is3Term(c.type)) return [[c.x1, c.y1, c._v1], [c.x2, c.y2, c._v2], [c.x3, c.y3, c._v3]];
  return [[c.x1, c.y1, c._v1], [c.x2, c.y2, c._v2]];
}

const PERSISTED = ['value', 'freq', 'closed', 'offset', 'wave', 'pos', 'x3', 'y3'];

function makeFromObj(o) {
  const c = makeComponent(o.type, o.x1, o.y1, o.x2, o.y2);
  for (const k of PERSISTED) if (o[k] !== undefined) c[k] = o[k];
  return c;
}

export class Editor {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.components = [];
    this.tool = 'select';
    this.selected = new Set(); // multi-selection; `selection` is the single-item view
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
        for (const k of PERSISTED) if (c[k] !== undefined) o[k] = c[k];
        return o;
      }),
    });
  }

  load(data) {
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    this.components = (obj.components || []).map(makeFromObj);
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
    this.components = JSON.parse(json).components.map(makeFromObj);
    this.select(null);
    this.changed();
  }

  changed() {
    this.cb.onChange?.();
  }

  // Single-item view of the selection (what the inspector edits).
  get selection() {
    return this.selected.size === 1 ? this.selected.values().next().value : null;
  }

  notifySelect() {
    this.cb.onSelect?.(this.selection, this.selected.size);
  }

  select(c) {
    this.selected.clear();
    if (c) this.selected.add(c);
    this.notifySelect();
  }

  selectMany(comps) {
    this.selected = new Set(comps);
    this.notifySelect();
  }

  toggleSelect(c) {
    if (this.selected.has(c)) this.selected.delete(c);
    else this.selected.add(c);
    this.notifySelect();
  }

  setTool(t) {
    this.tool = t;
    this.drag = null;
    if (t !== 'select') this.select(null);
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  }

  deleteSelection() {
    if (!this.selected.size) return;
    this.pushUndo();
    this.components = this.components.filter(c => !this.selected.has(c));
    this.select(null);
    this.changed();
  }

  rotateSelection() {
    if (!this.selected.size) return;
    this.pushUndo();
    if (this.selected.size > 1) {
      // rotate the whole group 90° clockwise around its (snapped) centroid
      let sx = 0, sy = 0, n = 0;
      for (const c of this.selected) {
        for (const [gx, gy] of terminalsOf(c)) { sx += gx; sy += gy; n++; }
      }
      const cx = Math.round(sx / n), cy = Math.round(sy / n);
      const rot = (x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) });
      for (const c of this.selected) {
        const p1 = rot(c.x1, c.y1), p2 = rot(c.x2, c.y2);
        c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y;
        if (is3Term(c.type)) {
          const p3 = rot(c.x3, c.y3);
          c.x3 = p3.x; c.y3 = p3.y;
        }
      }
      this.changed();
      return;
    }
    const c = this.selection;
    if (is3Term(c.type)) {
      // rotate terminals 2 and 3 90° clockwise around the anchor terminal
      const rot = (x, y) => ({ x: c.x1 - (y - c.y1), y: c.y1 + (x - c.x1) });
      const d = rot(c.x2, c.y2), s = rot(c.x3, c.y3);
      c.x2 = d.x; c.y2 = d.y; c.x3 = s.x; c.y3 = s.y;
    } else {
      const mx = (c.x1 + c.x2) / 2, my = (c.y1 + c.y2) / 2;
      const rot = (x, y) => ({ x: Math.round(mx + (my - y)), y: Math.round(my + (x - mx)) });
      const p1 = rot(c.x1, c.y1), p2 = rot(c.x2, c.y2);
      c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y;
    }
    this.changed();
  }

  selectAll() {
    this.selectMany(this.components);
  }

  // ---------- hit testing ----------

  hitTest(mx, my) {
    for (let i = this.components.length - 1; i >= 0; i--) {
      const c = this.components[i];
      if (is3Term(c.type)) {
        const cx = (c.x1 + c.x2 + c.x3) / 3 * CELL, cy = (c.y1 + c.y2 + c.y3) / 3 * CELL;
        if (segDist(mx, my, c.x1 * CELL, c.y1 * CELL, cx, cy) < HIT_DIST ||
            segDist(mx, my, c.x2 * CELL, c.y2 * CELL, cx, cy) < HIT_DIST ||
            segDist(mx, my, c.x3 * CELL, c.y3 * CELL, cx, cy) < HIT_DIST) return c;
      } else if (segDist(mx, my, c.x1 * CELL, c.y1 * CELL, c.x2 * CELL, c.y2 * CELL) < HIT_DIST) {
        return c;
      }
    }
    return null;
  }

  hitEndpoint(mx, my, c) {
    if (!c || is3Term(c.type)) return 0; // 3-terminal footprints are rigid — move/rotate only
    if (Math.hypot(mx - c.x1 * CELL, my - c.y1 * CELL) < HIT_DIST + 2) return 1;
    if (c.type !== 'ground' && Math.hypot(mx - c.x2 * CELL, my - c.y2 * CELL) < HIT_DIST + 2) return 2;
    return 0;
  }

  // ---------- palette drag-and-drop ----------

  clientToGrid(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((cx - r.left) / CELL),
      y: Math.round((cy - r.top) / CELL),
      inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom,
    };
  }

  beginPaletteDrag(type) {
    this.drag = { kind: 'place', type, g1: null, g2: null, external: true, inside: false };
  }

  movePaletteDrag(cx, cy) {
    const d = this.drag;
    if (!d || !d.external) return;
    const g = this.clientToGrid(cx, cy);
    d.inside = g.inside;
    if (d.type === 'ground') {
      d.g1 = { x: g.x, y: g.y };
      d.g2 = { x: g.x, y: g.y + 1 };
    } else if (is3Term(d.type)) {
      d.g1 = { x: g.x - 2, y: g.y }; // anchor sits left so the cursor rides near the body
      d.g2 = d.g1;
    } else {
      d.g1 = { x: g.x - 2, y: g.y };
      d.g2 = { x: g.x + 2, y: g.y };
    }
  }

  dropPaletteDrag(cx, cy) {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.external || !d.g1) return false;
    if (!this.clientToGrid(cx, cy).inside) return false;
    this.pushUndo();
    let comp;
    if (is3Term(d.type)) {
      comp = makeComponent(d.type, d.g1.x, d.g1.y, 0, 0);
      Object.assign(comp, footprint3(d.type, d.g1.x, d.g1.y, 'e'));
    } else {
      comp = makeComponent(d.type, d.g1.x, d.g1.y, d.g2.x, d.g2.y);
    }
    this.components.push(comp);
    this.select(comp);
    this.changed();
    return true;
  }

  cancelPaletteDrag() {
    if (this.drag?.external) this.drag = null;
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
      if (c) {
        if (e.shiftKey) {
          this.toggleSelect(c);
          return;
        }
        if (!this.selected.has(c)) this.select(c);
        this.pushUndo();
        this.drag = {
          kind: 'move', c, start: g, moved: false,
          origs: [...this.selected].map(m => ({
            c: m, x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, x3: m.x3, y3: m.y3,
          })),
        };
      } else {
        // empty canvas: start a rubber-band selection
        if (!e.shiftKey) this.select(null);
        this.drag = { kind: 'marquee', x0: mx, y0: my, x1: mx, y1: my, additive: e.shiftKey };
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
      d.g2 = (d.type === 'ground' || is3Term(d.type))
        ? g
        : snapDir(d.g1.x, d.g1.y, g.x, g.y);
    } else if (d.kind === 'move') {
      const ddx = g.x - d.start.x, ddy = g.y - d.start.y;
      if (ddx || ddy) d.moved = true;
      for (const o of d.origs) {
        const c = o.c;
        c.x1 = o.x1 + ddx; c.y1 = o.y1 + ddy;
        c.x2 = o.x2 + ddx; c.y2 = o.y2 + ddy;
        if (is3Term(c.type)) { c.x3 = o.x3 + ddx; c.y3 = o.y3 + ddy; }
      }
    } else if (d.kind === 'marquee') {
      d.x1 = mx; d.y1 = my;
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
      this.pushUndo();
      if (d.type === 'ground') {
        if (g1.x === g2.x && g1.y === g2.y) g2 = { x: g1.x, y: g1.y + 1 };
        this.components.push(makeComponent('ground', g1.x, g1.y, g2.x, g2.y));
      } else if (is3Term(d.type)) {
        const c = makeComponent(d.type, g1.x, g1.y, 0, 0);
        Object.assign(c, footprint3(d.type, g1.x, g1.y, cardinalDir(g1.x, g1.y, g2.x, g2.y)));
        this.components.push(c);
      } else {
        if (g1.x === g2.x && g1.y === g2.y) g2 = { x: g1.x + 4, y: g1.y }; // plain click → default footprint
        this.components.push(makeComponent(d.type, g1.x, g1.y, g2.x, g2.y));
      }
      this.changed();
    } else if (d.kind === 'move' && !d.moved) {
      // A clean click: undo snapshot wasn't needed for a move,
      // but keep it if this click toggles a switch.
      if (d.c.type === 'switch') {
        d.c.closed = !d.c.closed;
        this.changed();
      } else {
        this.undoStack.pop();
        // clicking one part of a group without dragging collapses to just it
        if (this.selected.size > 1) this.select(d.c);
      }
    } else if (d.kind === 'endpoint' && !d.moved) {
      this.undoStack.pop();
    } else if (d.kind === 'marquee') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const inside = this.components.filter(c =>
          terminalsOf(c).every(([gx, gy]) =>
            gx * CELL >= x0 && gx * CELL <= x1 && gy * CELL >= y0 && gy * CELL <= y1));
        this.selectMany(d.additive ? [...this.selected, ...inside] : inside);
      }
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
      renderComponent(ctx, c, vScale, this.selected.has(c));
    }

    this.drawJunctions(ctx, vScale);

    // current dots
    if (running) this.advanceDots(frameDt);
    ctx.fillStyle = '#ffd24a';
    for (const c of this.components) {
      if (c.type === 'ground' || c.type === 'opamp' || !c._i || Math.abs(c._i) < 1e-7) continue;
      // transistor channel current flows terminal 2 → terminal 3 (D→S / C→E)
      const [ax, ay, bx, by] = (is3Term(c.type) && c.type !== 'potentiometer')
        ? [c.x2, c.y2, c.x3, c.y3]
        : [c.x1, c.y1, c.x2, c.y2];
      const x1 = ax * CELL, y1 = ay * CELL, x2 = bx * CELL, y2 = by * CELL;
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
      ctx.fillStyle = '#579dff';
      for (const [gx, gy] of terminalsOf(this.selection)) {
        ctx.fillRect(gx * CELL - 3.5, gy * CELL - 3.5, 7, 7);
      }
    }

    this.drawConnectHints(ctx);

    // rubber-band selection rectangle
    if (this.drag && this.drag.kind === 'marquee') {
      const m = this.drag;
      ctx.fillStyle = 'rgba(87,157,255,0.10)';
      ctx.strokeStyle = 'rgba(87,157,255,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.strokeRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.setLineDash([]);
    }

    // placement ghost
    const d = this.drag;
    if (d && d.kind === 'place' && d.g1 && (!d.external || d.inside)) {
      ctx.globalAlpha = 0.55;
      if (is3Term(d.type)) {
        const f = footprint3(d.type, d.g1.x, d.g1.y, cardinalDir(d.g1.x, d.g1.y, d.g2.x, d.g2.y));
        drawThreeTerm(ctx, d.type, d.g1.x * CELL, d.g1.y * CELL,
          f.x2 * CELL, f.y2 * CELL, f.x3 * CELL, f.y3 * CELL, {});
      } else {
        drawShape(ctx, d.type, d.g1.x * CELL, d.g1.y * CELL,
          (d.g1.x === d.g2.x && d.g1.y === d.g2.y && d.type !== 'ground' ? d.g1.x + 4 : d.g2.x) * CELL,
          (d.type === 'ground' && d.g1.x === d.g2.x && d.g1.y === d.g2.y ? d.g1.y + 1 : d.g2.y) * CELL,
          {});
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // Filled dots where 2+ terminals join (colored by node voltage);
  // faint red rings on unconnected terminals.
  drawJunctions(ctx, vScale) {
    const points = new Map(); // "x,y" -> { x, y, count, v }
    for (const c of this.components) {
      for (const [gx, gy, v] of terminalsOf(c)) {
        const k = gx + ',' + gy;
        const p = points.get(k);
        if (p) { p.count++; if (p.v === undefined) p.v = v; }
        else points.set(k, { x: gx, y: gy, count: 1, v });
      }
    }
    for (const p of points.values()) {
      if (p.count >= 2) {
        ctx.fillStyle = voltageColor(p.v, vScale);
        ctx.beginPath();
        ctx.arc(p.x * CELL, p.y * CELL, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255,110,110,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x * CELL, p.y * CELL, 3.2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // While dragging, ring the points where the dragged terminals will connect.
  drawConnectHints(ctx) {
    const d = this.drag;
    if (!d) return;
    let active = [];
    let exclude = null;
    if (d.kind === 'move') {
      active = d.origs.flatMap(o => terminalsOf(o.c).map(([x, y]) => [x, y]));
      exclude = this.selected;
    } else if (d.kind === 'endpoint') {
      const c = d.c;
      active = [d.end === 1 ? [c.x1, c.y1] : [c.x2, c.y2]];
      exclude = c;
    } else if (d.kind === 'place') {
      if (!d.g1 || (d.external && !d.inside)) return;
      if (is3Term(d.type)) {
        const f = footprint3(d.type, d.g1.x, d.g1.y, cardinalDir(d.g1.x, d.g1.y, d.g2.x, d.g2.y));
        active = [[d.g1.x, d.g1.y], [f.x2, f.y2], [f.x3, f.y3]];
      } else if (d.type === 'ground') {
        active = [[d.g1.x, d.g1.y]];
      } else {
        active = [[d.g1.x, d.g1.y], [d.g2.x, d.g2.y]];
      }
    }
    if (!active.length) return;
    const others = new Set();
    for (const c of this.components) {
      if (exclude && (exclude === c || (exclude instanceof Set && exclude.has(c)))) continue;
      for (const [gx, gy] of terminalsOf(c)) others.add(gx + ',' + gy);
    }
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = 2;
    for (const [gx, gy] of active) {
      if (!others.has(gx + ',' + gy)) continue;
      ctx.beginPath();
      ctx.arc(gx * CELL, gy * CELL, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  advanceDots(frameDt) {
    for (const c of this.components) {
      if (!c._i) continue;
      const speed = Math.max(-160, Math.min(160, c._i * 25000)); // px/s
      c._dot = (c._dot || 0) + speed * frameDt;
    }
  }
}
