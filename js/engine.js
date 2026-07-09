// engine.js — analog circuit simulation via Modified Nodal Analysis (MNA).
//
// Each distinct grid point touched by a component terminal is a node.
// Wires, closed switches, grounds and voltage sources are stamped as voltage
// sources (grounds are 0 V sources to the global reference node), which gives
// us an exact branch current for every one of them — used for the current
// animation. Capacitors and inductors use backward-Euler companion models.
// Nonlinear devices (diodes, MOSFETs, BJTs, op-amps) are solved with damped
// Newton-Raphson iteration.

const GMIN = 1e-9;        // leak from every node to ground; keeps the matrix nonsingular
const VT = 0.025852;      // thermal voltage at room temperature

const DIODE_PARAMS = {
  diode: { is: 1e-9, n: 1.5 },      // Vf ~ 0.65 V at 10 mA
  zener: { is: 1e-9, n: 1.5 },      // forward: like a normal diode
  schottky: { is: 1e-6, n: 1.2 },   // Vf ~ 0.3 V at 10 mA
  led: { is: 1e-18, n: 2.0 },       // Vf ~ 1.9 V at 10 mA
};
const ZENER_IS = 5e-6;               // reverse-breakdown knee current scale

const MOS_K = 0.02;                  // MOSFET transconductance parameter (A/V²)
const BJT_BF = 100, BJT_BR = 1, BJT_IS = 1e-14;
const OPAMP_GAIN = 1e5, OPAMP_RAIL = 15;

export const DIODE_TYPES = new Set(['diode', 'zener', 'schottky', 'led']);

export function isVoltageLike(c) {
  return c.type === 'vsource' || c.type === 'acsource' || c.type === 'ground' ||
    c.type === 'wire' || (c.type === 'switch' && c.closed);
}

export function isMosfet(c) {
  return c.type === 'nmos' || c.type === 'pmos';
}

export function isBJT(c) {
  return c.type === 'npn' || c.type === 'pnp';
}

// Components with a third terminal at (x3, y3).
export function isThreeTerminal(c) {
  return isMosfet(c) || isBJT(c) || c.type === 'opamp' || c.type === 'potentiometer';
}

// Diode current and small-signal conductance at voltage v (anode − cathode).
// Zeners add an exponential reverse-breakdown term at v ≈ −Vz.
export function diodeIV(c, v) {
  const p = DIODE_PARAMS[c.type];
  const nvt = p.n * VT;
  const e = Math.exp(Math.min(v / nvt, 60));
  let i = p.is * (e - 1);
  let g = p.is * e / nvt + 1e-12;
  if (c.type === 'zener') {
    const vz = Math.abs(c.value) || 5.1;
    const ez = Math.exp(Math.min((-v - vz) / VT, 60));
    i -= ZENER_IS * ez;
    g += ZENER_IS * ez / VT;
  }
  return { i, g };
}

// Square-law MOSFET operating point. Terminals: _a = gate, _b = drain, _c = source.
// Symmetric conduction: if the actual drain-source voltage is negative (for the
// device polarity), drain and source swap roles. PMOS is an NMOS with all
// voltages negated. Returns everything in the effective (swapped) frame, where
// the linearized drain current in terms of ACTUAL node voltages is:
//   Id ≈ gm·Vg + gds·Vd − (gm+gds)·Vs + Ieq
export function mosOP(c, Vg, Vd, Vs) {
  const pol = c.type === 'pmos' ? -1 : 1;
  const vth = typeof c.value === 'number' ? Math.abs(c.value) : 1.5;
  let d = c._b, s = c._c, reversed = false;
  if (pol * (Vd - Vs) < 0) {
    const tn = d; d = s; s = tn;
    const tv = Vd; Vd = Vs; Vs = tv;
    reversed = true;
  }
  const vgs = pol * (Vg - Vs);
  const vds = pol * (Vd - Vs);
  const ov = vgs - vth;
  let id, gm, gds;
  if (ov <= 0) {                 // cutoff
    id = 0; gm = 0; gds = 1e-9;
  } else if (vds < ov) {         // linear / triode
    id = MOS_K * (ov * vds - vds * vds / 2);
    gm = MOS_K * vds;
    gds = MOS_K * (ov - vds) + 1e-9;
  } else {                       // saturation
    id = MOS_K / 2 * ov * ov;
    gm = MOS_K * ov;
    gds = 1e-8;
  }
  return { d, s, reversed, idEff: pol * id, gm, gds, Vd, Vs };
}

// Ebers-Moll BJT evaluated at junction voltages vbe/vbc (polarity frame:
// PNP is an NPN with all voltages/currents negated). Terminals:
// _a = base, _b = collector, _c = emitter. Everything the Newton stamp needs
// depends only on the two junction voltages.
export function bjtJunction(vbe, vbc) {
  const ebe = Math.exp(Math.min(vbe / VT, 60));
  const ebc = Math.exp(Math.min(vbc / VT, 60));
  const ge = BJT_IS / VT * ebe + 1e-12;
  const gc = BJT_IS / VT * ebc + 1e-12;
  const ic = BJT_IS * ((ebe - ebc) - (ebc - 1) / BJT_BR);
  const ib = BJT_IS * ((ebe - 1) / BJT_BF + (ebc - 1) / BJT_BR);
  return { ib, ic, ge, gc };
}

// Terminal currents in the actual frame (for readouts).
export function bjtOP(c, Vb, Vc, Ve) {
  const pol = c.type === 'pnp' ? -1 : 1;
  const { ib, ic } = bjtJunction(pol * (Vb - Ve), pol * (Vb - Vc));
  return { ib: pol * ib, ic: pol * ic };
}

// SPICE-style pn-junction Newton limiting: prevents the exponential from
// overshooting and oscillating between iterations.
const BJT_VCRIT = VT * Math.log(VT / (Math.SQRT2 * BJT_IS));
function pnjlim(vnew, vold) {
  if (vnew > BJT_VCRIT && Math.abs(vnew - vold) > 2 * VT) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / VT;
      return arg > 0 ? vold + VT * Math.log(arg) : BJT_VCRIT;
    }
    return VT * Math.log(vnew / VT);
  }
  return vnew;
}

export function luFactor(A) {
  const n = A.length;
  const piv = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let p = k, max = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > max) { max = v; p = i; }
    }
    if (max < 1e-12) {
      throw new Error('Circuit is unsolvable — check for shorted voltage sources or a loop of wires/sources.');
    }
    if (p !== k) { const t = A[p]; A[p] = A[k]; A[k] = t; }
    piv[k] = p;
    const akk = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / akk;
      A[i][k] = f;
      if (f !== 0) {
        const Ai = A[i], Ak = A[k];
        for (let j = k + 1; j < n; j++) Ai[j] -= f * Ak[j];
      }
    }
  }
  return piv;
}

export function luSolve(A, piv, b) {
  const n = A.length;
  const x = Float64Array.from(b);
  // apply all row interchanges first, then forward-substitute (as in LAPACK dgetrs)
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) { const t = x[p]; x[p] = x[k]; x[k] = t; }
  }
  for (let k = 0; k < n; k++) {
    for (let i = k + 1; i < n; i++) x[i] -= A[i][k] * x[k];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    const Ai = A[i];
    for (let j = i + 1; j < n; j++) s -= Ai[j] * x[j];
    x[i] = s / Ai[i];
  }
  return x;
}

export class Simulation {
  constructor(components, dt) {
    this.comps = components;
    this.dt = dt;
    this.build();
  }

  build() {
    const comps = this.comps;
    this.nodeIndex = new Map(); // "gx,gy" -> node id (0 = reference)
    this.hasGround = comps.some(c => c.type === 'ground');
    let next = this.hasGround ? 1 : 0; // without an explicit ground, the first node becomes the reference
    const nodeOf = (x, y) => {
      const k = x + ',' + y;
      let id = this.nodeIndex.get(k);
      if (id === undefined) { id = next++; this.nodeIndex.set(k, id); }
      return id;
    };

    this.vsrcs = [];
    this.diodes = [];
    this.mosfets = [];
    this.bjts = [];
    this.opamps = [];
    for (const c of comps) {
      c._a = nodeOf(c.x1, c.y1);
      c._b = c.type === 'ground' ? 0 : nodeOf(c.x2, c.y2);
      c._c = isThreeTerminal(c) ? nodeOf(c.x3, c.y3) : -1;
      c._vs = -1;
      if (isVoltageLike(c) || c.type === 'opamp') { c._vs = this.vsrcs.length; this.vsrcs.push(c); }
      if (DIODE_TYPES.has(c.type)) {
        this.diodes.push(c);
        if (typeof c._vd !== 'number') c._vd = 0.6;
      }
      if (isMosfet(c)) this.mosfets.push(c);
      if (isBJT(c)) {
        this.bjts.push(c);
        if (typeof c._jbe !== 'number') { c._jbe = 0; c._jbc = 0; } // junction-voltage iterates
      }
      if (c.type === 'opamp') this.opamps.push(c);
      if ((isMosfet(c) || c.type === 'opamp') && !Array.isArray(c._it)) {
        c._it = [0, 0, 0]; // damped Newton iterate of the three terminal voltages
      }
      if (c.type === 'capacitor' && typeof c.state !== 'number') c.state = 0; // voltage across
      if (c.type === 'inductor' && typeof c.state !== 'number') c.state = 0; // current through
    }

    this.n = Math.max(0, next - 1); // non-reference node count
    this.m = this.vsrcs.length;
    this.size = this.n + this.m;
    this.nonlinear = this.diodes.length > 0 || this.mosfets.length > 0 ||
      this.bjts.length > 0 || this.opamps.length > 0;
    this.x = new Float64Array(this.size);

    this.buildBase();
    if (!this.nonlinear && this.size > 0) {
      const A = this.base.map(row => Float64Array.from(row));
      this.piv = luFactor(A);
      this.lu = A;
    } else {
      this.lu = null;
    }
  }

  buildBase() {
    const S = this.size;
    const A = this.base = [];
    for (let i = 0; i < S; i++) A.push(new Float64Array(S));
    const st = (i, j, v) => { if (i > 0 && j > 0) A[i - 1][j - 1] += v; };
    const stG = (a, b, g) => { st(a, a, g); st(b, b, g); st(a, b, -g); st(b, a, -g); };

    for (let i = 0; i < this.n; i++) A[i][i] += GMIN;

    for (const c of this.comps) {
      const a = c._a, b = c._b;
      switch (c.type) {
        case 'resistor': stG(a, b, 1 / Math.max(c.value, 1e-9)); break;
        case 'capacitor': stG(a, b, c.value / this.dt); break;
        case 'inductor': stG(a, b, this.dt / Math.max(c.value, 1e-12)); break;
        case 'potentiometer': {
          const R = Math.max(c.value, 1e-6);
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          stG(a, c._c, 1 / (R * pos));       // end 1 → wiper
          stG(c._c, b, 1 / (R * (1 - pos))); // wiper → end 2
          break;
        }
      }
      if (c._vs >= 0) {
        const r = this.n + c._vs;
        if (c.type === 'opamp') {
          // Only the output branch-current column; the constraint row is
          // stamped per Newton iteration (linear region vs. rail clamp).
          if (c._c > 0) { A[c._c - 1][r] += 1; }
        } else {
          // constraint row: va − vb = V ; branch current col
          if (a > 0) { A[r][a - 1] += 1; A[a - 1][r] += 1; }
          if (b > 0) { A[r][b - 1] -= 1; A[b - 1][r] -= 1; }
        }
      }
    }
  }

  sourceVoltage(c, t) {
    if (c.type === 'vsource') return c.value;
    if (c.type === 'acsource') {
      const off = c.offset || 0;
      const f = c.freq || 60;
      const ph = ((t * f) % 1 + 1) % 1;
      switch (c.wave) {
        case 'square': return off + (ph < 0.5 ? c.value : -c.value);
        case 'triangle':
          return off + c.value * (ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4);
        case 'sawtooth': return off + c.value * (2 * ph - 1);
        default: return off + c.value * Math.sin(2 * Math.PI * f * t);
      }
    }
    return 0; // ground, wire, closed switch
  }

  buildRHS(t) {
    const z = new Float64Array(this.size);
    const add = (i, v) => { if (i > 0) z[i - 1] += v; };
    for (const c of this.comps) {
      const a = c._a, b = c._b;
      if (c.type === 'capacitor') {
        const g = c.value / this.dt;
        add(a, g * c.state);
        add(b, -g * c.state);
      } else if (c.type === 'inductor') {
        add(a, -c.state);
        add(b, c.state);
      } else if (c.type === 'isource') {
        add(a, -c.value);
        add(b, c.value);
      }
      if (c._vs >= 0 && c.type !== 'opamp') z[this.n + c._vs] = this.sourceVoltage(c, t);
    }
    return z;
  }

  step(t) {
    if (this.size === 0) return;
    const z = this.buildRHS(t);
    const x = this.nonlinear ? this.newton(z) : luSolve(this.lu, this.piv, z);
    this.x = x;
    this.readResults();
  }

  newton(z) {
    let x = this.x;
    const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
    for (let iter = 0; iter < 120; iter++) {
      const A = this.base.map(row => Float64Array.from(row));
      const zz = Float64Array.from(z);
      const st = (i, j, v) => { if (i > 0 && j > 0) A[i - 1][j - 1] += v; };
      const inj = (i, v) => { if (i > 0) zz[i - 1] += v; };

      for (const c of this.diodes) {
        const { i: id, g: gd } = diodeIV(c, c._vd);
        const ieq = id - gd * c._vd;
        st(c._a, c._a, gd); st(c._b, c._b, gd);
        st(c._a, c._b, -gd); st(c._b, c._a, -gd);
        inj(c._a, -ieq);
        inj(c._b, ieq);
      }

      for (const c of this.mosfets) {
        const g = c._a;
        const { d, s, idEff, gm, gds, Vd, Vs } = mosOP(c, c._it[0], c._it[1], c._it[2]);
        const ieq = idEff - (gm * c._it[0] + gds * Vd - (gm + gds) * Vs);
        st(d, g, gm); st(d, d, gds); st(d, s, -(gm + gds));
        st(s, g, -gm); st(s, d, -gds); st(s, s, gm + gds);
        inj(d, -ieq);
        inj(s, ieq);
      }

      for (const c of this.bjts) {
        const pol = c.type === 'pnp' ? -1 : 1;
        const bn = c._a, cn = c._b, en = c._c;
        const { ib, ic, ge, gc } = bjtJunction(c._jbe, c._jbc);
        // conductance-matrix rows (identical for NPN/PNP; pol² = 1)
        const dIb = { b: ge / BJT_BF + gc / BJT_BR, c: -gc / BJT_BR, e: -ge / BJT_BF };
        const dIc = { b: ge - gc * (1 + 1 / BJT_BR), c: gc * (1 + 1 / BJT_BR), e: -ge };
        const ieqB = pol * (ib - (ge / BJT_BF * c._jbe + gc / BJT_BR * c._jbc));
        const ieqC = pol * (ic - (ge * c._jbe - gc * (1 + 1 / BJT_BR) * c._jbc));
        st(bn, bn, dIb.b); st(bn, cn, dIb.c); st(bn, en, dIb.e);
        st(cn, bn, dIc.b); st(cn, cn, dIc.c); st(cn, en, dIc.e);
        // emitter row is minus the sum (Ie leaving = −(Ib + Ic))
        st(en, bn, -(dIb.b + dIc.b)); st(en, cn, -(dIb.c + dIc.c)); st(en, en, -(dIb.e + dIc.e));
        inj(bn, -ieqB);
        inj(cn, -ieqC);
        inj(en, ieqB + ieqC);
      }

      for (const c of this.opamps) {
        const r = this.n + c._vs;
        const pred = OPAMP_GAIN * (c._it[0] - c._it[1]);
        const row = A[r];
        if (pred > OPAMP_RAIL) {
          if (c._c > 0) row[c._c - 1] += 1;
          zz[r] = OPAMP_RAIL;
        } else if (pred < -OPAMP_RAIL) {
          if (c._c > 0) row[c._c - 1] += 1;
          zz[r] = -OPAMP_RAIL;
        } else {
          // Vout/G − (v+ − v−) = 0, scaled by 1/G for conditioning
          if (c._c > 0) row[c._c - 1] += 1 / OPAMP_GAIN;
          if (c._a > 0) row[c._a - 1] -= 1;
          if (c._b > 0) row[c._b - 1] += 1;
          zz[r] = 0;
        }
      }

      const piv = luFactor(A);
      x = luSolve(A, piv, zz);
      const V = id => (id > 0 ? x[id - 1] : 0);
      let maxDelta = 0;
      for (const c of this.diodes) {
        const dv = V(c._a) - V(c._b) - c._vd;
        maxDelta = Math.max(maxDelta, Math.abs(dv));
        c._vd += clamp(dv, 0.6); // damping keeps exp() from blowing up
      }
      for (const c of this.mosfets) {
        const lim = 1;
        for (let k = 0; k < 3; k++) {
          const nv = V([c._a, c._b, c._c][k]);
          const dv = nv - c._it[k];
          maxDelta = Math.max(maxDelta, Math.abs(dv));
          c._it[k] += clamp(dv, lim);
        }
      }
      for (const c of this.bjts) {
        const pol = c.type === 'pnp' ? -1 : 1;
        const jbe = pnjlim(pol * (V(c._a) - V(c._c)), c._jbe);
        const jbc = pnjlim(pol * (V(c._a) - V(c._b)), c._jbc);
        maxDelta = Math.max(maxDelta, Math.abs(jbe - c._jbe), Math.abs(jbc - c._jbc));
        c._jbe = jbe;
        c._jbc = jbc;
      }
      for (const c of this.opamps) {
        for (let k = 0; k < 3; k++) {
          const nv = V([c._a, c._b, c._c][k]);
          const dv = nv - c._it[k];
          maxDelta = Math.max(maxDelta, Math.abs(dv));
          c._it[k] += clamp(dv, 30);
        }
      }
      if (maxDelta < 1e-6) break;
    }
    return x;
  }

  readResults() {
    const x = this.x;
    const V = id => (id > 0 ? x[id - 1] : 0);
    for (const c of this.comps) {
      c._v1 = V(c._a);
      c._v2 = V(c._b);
      if (c._c >= 0) c._v3 = V(c._c);
      const vd = c._v1 - c._v2;
      switch (c.type) {
        case 'resistor': c._i = vd / Math.max(c.value, 1e-9); break;
        case 'capacitor': {
          const g = c.value / this.dt;
          c._i = g * (vd - c.state);
          c.state = vd;
          break;
        }
        case 'inductor': {
          const g = this.dt / Math.max(c.value, 1e-12);
          c.state = c.state + g * vd;
          c._i = c.state;
          break;
        }
        case 'isource': c._i = c.value; break;
        case 'diode':
        case 'zener':
        case 'schottky':
        case 'led':
          c._i = diodeIV(c, vd).i;
          break;
        case 'nmos':
        case 'pmos': {
          const op = mosOP(c, c._v1, c._v2, c._v3);
          c._i = op.reversed ? -op.idEff : op.idEff; // actual drain → source
          break;
        }
        case 'npn':
        case 'pnp':
          c._i = bjtOP(c, c._v1, c._v2, c._v3).ic; // collector current
          break;
        case 'opamp':
          c._i = -x[this.n + c._vs]; // current sourced from the output
          break;
        case 'potentiometer': {
          const R = Math.max(c.value, 1e-6);
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          c._i = (c._v1 - c._v3) / (R * pos); // end 1 → wiper
          break;
        }
        case 'switch':
          c._i = c.closed ? x[this.n + c._vs] : 0;
          break;
        default:
          c._i = c._vs >= 0 ? x[this.n + c._vs] : 0;
      }
    }
  }

  nodeVoltageAt(gx, gy) {
    const id = this.nodeIndex.get(gx + ',' + gy);
    if (id === undefined) return null;
    return id > 0 ? this.x[id - 1] : 0;
  }
}
