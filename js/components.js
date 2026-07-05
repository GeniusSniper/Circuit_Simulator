// components.js — component catalog, value formatting, and canvas schematic drawing.

export const CELL = 16; // px per grid unit

let nextId = 1;

export const DEFS = {
  wire: { name: 'Wire' },
  resistor: { name: 'Resistor', value: 1000, unit: 'Ω', valueLabel: 'Resistance' },
  capacitor: { name: 'Capacitor', value: 10e-6, unit: 'F', valueLabel: 'Capacitance' },
  inductor: { name: 'Inductor', value: 0.1, unit: 'H', valueLabel: 'Inductance' },
  vsource: { name: 'Voltage Source (DC)', value: 5, unit: 'V', valueLabel: 'Voltage' },
  acsource: { name: 'Voltage Source (AC)', value: 5, unit: 'V', valueLabel: 'Amplitude', freq: 60, offset: 0 },
  isource: { name: 'Current Source', value: 0.01, unit: 'A', valueLabel: 'Current' },
  ground: { name: 'Ground' },
  switch: { name: 'Switch', closed: false },
  diode: { name: 'Diode' },
  led: { name: 'LED' },
  nmos: { name: 'NMOS Transistor', value: 1.5, unit: 'V', valueLabel: 'Threshold' },
  pmos: { name: 'PMOS Transistor', value: 1.5, unit: 'V', valueLabel: 'Threshold' },
};

export function isMos(type) {
  return type === 'nmos' || type === 'pmos';
}

// Rigid 3-terminal footprint: gate at (gx,gy), drain/source 3 cells along the
// axis and ±2 cells perpendicular. dir is the axis direction: e/s/w/n.
export function mosfetFootprint(gx, gy, dir = 'e') {
  const rot = {
    e: (x, y) => [x, y],
    s: (x, y) => [-y, x],
    w: (x, y) => [-x, -y],
    n: (x, y) => [y, -x],
  }[dir] || ((x, y) => [x, y]);
  const [dx, dy] = rot(3, -2);
  const [sx, sy] = rot(3, 2);
  return { x2: gx + dx, y2: gy + dy, x3: gx + sx, y3: gy + sy };
}

export const PALETTE = [
  { type: 'select', name: 'Select / Move' },
  { type: 'wire', name: 'Wire' },
  { type: 'resistor', name: 'Resistor' },
  { type: 'capacitor', name: 'Capacitor' },
  { type: 'inductor', name: 'Inductor' },
  { type: 'vsource', name: 'DC Source' },
  { type: 'acsource', name: 'AC Source' },
  { type: 'isource', name: 'Current Src' },
  { type: 'nmos', name: 'NMOS' },
  { type: 'pmos', name: 'PMOS' },
  { type: 'diode', name: 'Diode' },
  { type: 'led', name: 'LED' },
  { type: 'switch', name: 'Switch' },
  { type: 'ground', name: 'Ground' },
];

export function makeComponent(type, x1, y1, x2, y2) {
  const d = DEFS[type];
  const c = { id: nextId++, type, x1, y1, x2, y2 };
  if (d.value !== undefined) c.value = d.value;
  if (d.freq !== undefined) c.freq = d.freq;
  if (d.closed !== undefined) c.closed = d.closed;
  if (d.offset !== undefined) c.offset = d.offset;
  if (isMos(type)) Object.assign(c, mosfetFootprint(x1, y1, 'e'));
  return c;
}

// ---------- engineering notation ----------

const PREFIXES = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
  [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

export function formatValue(v, unit = '') {
  if (!isFinite(v) || Math.abs(v) < 1e-15) return '0 ' + unit;
  const av = Math.abs(v);
  for (const [scale, prefix] of PREFIXES) {
    if (av >= scale * 0.99999) {
      let s = (v / scale).toPrecision(3);
      if (s.includes('.')) s = s.replace(/\.?0+$/, '');
      return s + ' ' + prefix + unit;
    }
  }
  return v.toExponential(2) + ' ' + unit;
}

export function parseValue(str) {
  if (typeof str !== 'string') return NaN;
  const m = str.trim().match(/^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*([TGMkKmuµnp]?)/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  const mult = {
    T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
    m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, '': 1,
  }[m[2]];
  return num * mult;
}

// ---------- colors ----------

const NEUTRAL = [154, 163, 181];
const POS = [61, 220, 132];
const NEG = [255, 92, 92];

export function voltageColor(v, scale) {
  if (v === undefined || v === null || !isFinite(v)) return 'rgb(154,163,181)';
  let t = Math.max(-1, Math.min(1, v / scale));
  const target = t >= 0 ? POS : NEG;
  t = Math.abs(t);
  const r = Math.round(NEUTRAL[0] + (target[0] - NEUTRAL[0]) * t);
  const g = Math.round(NEUTRAL[1] + (target[1] - NEUTRAL[1]) * t);
  const b = Math.round(NEUTRAL[2] + (target[2] - NEUTRAL[2]) * t);
  return `rgb(${r},${g},${b})`;
}

// ---------- drawing ----------

const BODY = '#dfe5f0';
const LW = 2;

function arrowHead(ctx, x, y, ang, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.55);
  ctx.lineTo(-size, size * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Draws a component between two pixel points. opts:
//   c1, c2  — lead colors (voltage-tinted)
//   closed  — switch state
//   brightness — LED glow 0..1
export function drawShape(ctx, type, x1, y1, x2, y2, opts = {}) {
  const c1 = opts.c1 || BODY;
  const c2 = opts.c2 || BODY;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx);

  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(ang);
  ctx.lineWidth = LW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const half = len / 2;
  const bodyHalf = {
    resistor: 14, capacitor: 4, inductor: 14, vsource: 4, acsource: 10,
    isource: 10, diode: 8, led: 8, switch: 11, wire: 0, ground: 0,
  }[type] ?? 10;
  const bh = Math.min(bodyHalf, half);

  const lead = (xa, xb, color) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(xa, 0);
    ctx.lineTo(xb, 0);
    ctx.stroke();
  };

  if (type === 'wire') {
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (type === 'ground') {
    ctx.strokeStyle = c1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len * 0.45, 0);
    ctx.stroke();
    ctx.strokeStyle = BODY;
    const bx = len * 0.45;
    for (const [off, hw] of [[0, 9], [4, 5.5], [8, 2]]) {
      ctx.beginPath();
      ctx.moveTo(bx + off, -hw);
      ctx.lineTo(bx + off, hw);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (type !== 'capacitor' && type !== 'vsource') {
    lead(0, half - bh, c1);
    lead(half + bh, len, c2);
  }

  ctx.strokeStyle = BODY;
  ctx.fillStyle = BODY;

  switch (type) {
    case 'resistor': {
      ctx.beginPath();
      ctx.moveTo(half - bh, 0);
      const n = 6, w = (bh * 2) / n;
      for (let i = 0; i < n; i++) {
        ctx.lineTo(half - bh + w * (i + 0.5), i % 2 === 0 ? -6 : 6);
      }
      ctx.lineTo(half + bh, 0);
      ctx.stroke();
      break;
    }
    case 'capacitor': {
      lead(0, half - 4, c1);
      lead(half + 4, len, c2);
      ctx.strokeStyle = c1;
      ctx.beginPath(); ctx.moveTo(half - 4, -9); ctx.lineTo(half - 4, 9); ctx.stroke();
      ctx.strokeStyle = c2;
      ctx.beginPath(); ctx.moveTo(half + 4, -9); ctx.lineTo(half + 4, 9); ctx.stroke();
      break;
    }
    case 'inductor': {
      ctx.beginPath();
      const n = 4, r = bh / n;
      for (let i = 0; i < n; i++) {
        const cx = half - bh + r * (2 * i + 1);
        ctx.arc(cx, 0, r, Math.PI, 0, false);
      }
      ctx.stroke();
      break;
    }
    case 'vsource': {
      lead(0, half - 4, c1);
      lead(half + 4, len, c2);
      // long plate = + terminal (p1 side)
      ctx.strokeStyle = c1;
      ctx.beginPath(); ctx.moveTo(half - 4, -11); ctx.lineTo(half - 4, 11); ctx.stroke();
      ctx.strokeStyle = c2;
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(half + 4, -5); ctx.lineTo(half + 4, 5); ctx.stroke();
      ctx.lineWidth = LW;
      ctx.strokeStyle = BODY;
      ctx.beginPath();
      ctx.moveTo(half - 15, -10); ctx.lineTo(half - 9, -10);
      ctx.moveTo(half - 12, -13); ctx.lineTo(half - 12, -7);
      ctx.stroke();
      break;
    }
    case 'acsource': {
      ctx.beginPath();
      ctx.arc(half, 0, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(half - 6, 0);
      ctx.bezierCurveTo(half - 3, -8, half, -8, half, 0);
      ctx.bezierCurveTo(half, 8, half + 3, 8, half + 6, 0);
      ctx.stroke();
      break;
    }
    case 'isource': {
      ctx.beginPath();
      ctx.arc(half, 0, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(half - 5, 0); ctx.lineTo(half + 3, 0);
      ctx.stroke();
      arrowHead(ctx, half + 6, 0, 0, 6);
      break;
    }
    case 'diode':
    case 'led': {
      if (type === 'led' && opts.brightness > 0.02) {
        const b = Math.min(1, opts.brightness);
        const glow = ctx.createRadialGradient(half, 0, 2, half, 0, 22);
        glow.addColorStop(0, `rgba(255,80,60,${0.75 * b})`);
        glow.addColorStop(1, 'rgba(255,80,60,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(half, 0, 22, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = type === 'led'
        ? `rgb(${140 + Math.round(115 * Math.min(1, opts.brightness || 0))},60,50)`
        : '#20242e';
      ctx.beginPath();
      ctx.moveTo(half - 8, -8);
      ctx.lineTo(half - 8, 8);
      ctx.lineTo(half + 8, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(half + 8, -8);
      ctx.lineTo(half + 8, 8);
      ctx.stroke();
      if (type === 'led') {
        ctx.fillStyle = BODY;
        ctx.lineWidth = 1.5;
        for (const off of [0, 5]) {
          const sx = half - 2 + off, sy = -9;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + 5, sy - 5);
          ctx.stroke();
          arrowHead(ctx, sx + 6, sy - 6, -Math.PI / 4, 4);
        }
        ctx.lineWidth = LW;
      }
      break;
    }
    case 'switch': {
      const pivot = half - 10, contact = half + 10;
      ctx.strokeStyle = BODY;
      ctx.beginPath();
      ctx.moveTo(pivot, 0);
      if (opts.closed) ctx.lineTo(contact, 0);
      else ctx.lineTo(pivot + 17, -11);
      ctx.stroke();
      ctx.fillStyle = BODY;
      ctx.beginPath(); ctx.arc(pivot, 0, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(contact, 0, 2.6, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }

  ctx.restore();
}

// Draws a MOSFET symbol from its three pixel terminals: gate g, drain d, source s.
// The symbol is rigid: bars sit near the D/S midpoint, elbow leads reach the terminals.
export function drawMosfet(ctx, type, gx, gy, dx, dy, sx, sy, opts = {}) {
  const cg = opts.cg || BODY, cd = opts.cd || BODY, cs = opts.cs || BODY;
  const mx = (dx + sx) / 2, my = (dy + sy) / 2;
  const L = Math.hypot(mx - gx, my - gy) || 1;
  const H = Math.hypot(dx - mx, dy - my) || 1;
  const ang = Math.atan2(my - gy, mx - gx);

  ctx.save();
  ctx.translate(gx, gy);
  ctx.rotate(ang);
  ctx.lineWidth = LW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // which local side (±y) the drain sits on
  const ldy = -Math.sin(ang) * (dx - gx) + Math.cos(ang) * (dy - gy);
  const sd = ldy < 0 ? -1 : 1; // drain side
  const gateBarX = L - 17;
  const chX = L - 12;
  const pmos = type === 'pmos';

  // gate lead (+ inversion bubble for PMOS)
  ctx.strokeStyle = cg;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(gateBarX - (pmos ? 9 : 1), 0);
  ctx.stroke();
  if (pmos) {
    ctx.beginPath();
    ctx.arc(gateBarX - 5, 0, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  // gate bar
  ctx.beginPath();
  ctx.moveTo(gateBarX, -12);
  ctx.lineTo(gateBarX, 12);
  ctx.stroke();
  // channel bar
  ctx.strokeStyle = BODY;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(chX, -14);
  ctx.lineTo(chX, 14);
  ctx.stroke();
  ctx.lineWidth = LW;

  // drain lead: channel → elbow → terminal
  ctx.strokeStyle = cd;
  ctx.beginPath();
  ctx.moveTo(chX, sd * 10);
  ctx.lineTo(L, sd * 10);
  ctx.lineTo(L, sd * H);
  ctx.stroke();
  // source lead
  ctx.strokeStyle = cs;
  ctx.beginPath();
  ctx.moveTo(chX, -sd * 10);
  ctx.lineTo(L, -sd * 10);
  ctx.lineTo(L, -sd * H);
  ctx.stroke();
  // source arrow: NMOS points away from the channel, PMOS toward it
  ctx.fillStyle = cs;
  arrowHead(ctx, pmos ? chX + 4 : (chX + L) / 2 + 3, -sd * 10, pmos ? Math.PI : 0, 5.5);

  ctx.restore();
}

export function componentLabel(c) {
  const d = DEFS[c.type];
  if (c.value === undefined || !d.unit || isMos(c.type)) return null;
  let s = formatValue(c.value, d.unit);
  if (c.type === 'acsource') s += ' ' + formatValue(c.freq, 'Hz');
  return s;
}

// Full render of one component in world (pixel) space, with voltage-tinted leads and label.
export function renderComponent(ctx, c, vScale, selected) {
  const x1 = c.x1 * CELL, y1 = c.y1 * CELL;
  const x2 = c.x2 * CELL, y2 = c.y2 * CELL;

  if (isMos(c.type)) {
    const x3 = c.x3 * CELL, y3 = c.y3 * CELL;
    const mx = (x2 + x3) / 2, my = (y2 + y3) / 2;
    if (selected) {
      ctx.save();
      ctx.strokeStyle = 'rgba(87,157,255,0.30)';
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(mx, my);
      ctx.moveTo(x2, y2); ctx.lineTo(mx, my);
      ctx.moveTo(x3, y3); ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.restore();
    }
    drawMosfet(ctx, c.type, x1, y1, x2, y2, x3, y3, {
      cg: voltageColor(c._v1, vScale),
      cd: voltageColor(c._v2, vScale),
      cs: voltageColor(c._v3, vScale),
    });
    if (selected) {
      ctx.save();
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillStyle = '#8b95a9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cx = (x1 + x2 + x3) / 3, cy = (y1 + y2 + y3) / 3;
      for (const [px, py, letter] of [[x1, y1, 'G'], [x2, y2, 'D'], [x3, y3, 'S']]) {
        const dl = Math.hypot(px - cx, py - cy) || 1;
        ctx.fillText(letter, px + (px - cx) / dl * 9, py + (py - cy) / dl * 9);
      }
      ctx.restore();
    }
    return;
  }

  if (selected) {
    ctx.save();
    ctx.strokeStyle = 'rgba(87,157,255,0.30)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  drawShape(ctx, c.type, x1, y1, x2, y2, {
    c1: voltageColor(c._v1, vScale),
    c2: voltageColor(c._v2, vScale),
    closed: c.closed,
    brightness: c.type === 'led' ? Math.abs(c._i || 0) / 0.015 : 0,
  });

  const label = componentLabel(c);
  if (label) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let px = dy / len, py = -dx / len; // perpendicular
    if (py > 0.01 || (Math.abs(py) < 0.01 && px < 0)) { px = -px; py = -py; }
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#aeb7c9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const off = Math.abs(px) > 0.5 ? 17 + ctx.measureText(label).width / 2 : 17;
    ctx.fillText(label, mx + px * off, my + py * off);
    ctx.restore();
  }
}
