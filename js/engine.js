// engine.js — analog circuit simulation via Modified Nodal Analysis (MNA).
//
// Each distinct grid point touched by a component terminal is a node.
// Wires, closed switches, grounds and voltage sources are stamped as voltage
// sources (grounds are 0 V sources to the global reference node), which gives
// us an exact branch current for every one of them — used for the current
// animation. Capacitors and inductors use backward-Euler companion models.
// Diodes/LEDs are solved with damped Newton-Raphson iteration.

const GMIN = 1e-9;        // leak from every node to ground; keeps the matrix nonsingular
const VT = 0.025852;      // thermal voltage at room temperature

const DIODE_PARAMS = { is: 1e-9, n: 1.5 };   // Vf ~ 0.65 V at 10 mA
const LED_PARAMS = { is: 1e-18, n: 2.0 };    // Vf ~ 1.9 V at 10 mA

export function isVoltageLike(c) {
  return c.type === 'vsource' || c.type === 'acsource' || c.type === 'ground' ||
    c.type === 'wire' || (c.type === 'switch' && c.closed);
}

function isNonlinear(c) {
  return c.type === 'diode' || c.type === 'led';
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
    for (const c of comps) {
      c._a = nodeOf(c.x1, c.y1);
      c._b = c.type === 'ground' ? 0 : nodeOf(c.x2, c.y2);
      c._vs = -1;
      if (isVoltageLike(c)) { c._vs = this.vsrcs.length; this.vsrcs.push(c); }
      if (isNonlinear(c)) this.diodes.push(c);
      if (c.type === 'capacitor' && typeof c.state !== 'number') c.state = 0; // voltage across
      if (c.type === 'inductor' && typeof c.state !== 'number') c.state = 0; // current through
      if (isNonlinear(c) && typeof c._vd !== 'number') c._vd = 0.6;
    }

    this.n = Math.max(0, next - 1); // non-reference node count
    this.m = this.vsrcs.length;
    this.size = this.n + this.m;
    this.nonlinear = this.diodes.length > 0;
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
      }
      if (c._vs >= 0) {
        const r = this.n + c._vs;
        if (a > 0) { A[r][a - 1] += 1; A[a - 1][r] += 1; }
        if (b > 0) { A[r][b - 1] -= 1; A[b - 1][r] -= 1; }
      }
    }
  }

  sourceVoltage(c, t) {
    if (c.type === 'vsource') return c.value;
    if (c.type === 'acsource') return c.value * Math.sin(2 * Math.PI * (c.freq || 60) * t);
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
      if (c._vs >= 0) z[this.n + c._vs] = this.sourceVoltage(c, t);
    }
    return z;
  }

  diodeParams(c) {
    return c.type === 'led' ? LED_PARAMS : DIODE_PARAMS;
  }

  step(t) {
    if (this.size === 0) return;
    const z = this.buildRHS(t);
    let x;
    if (!this.nonlinear) {
      x = luSolve(this.lu, this.piv, z);
    } else {
      x = this.newton(z);
    }
    this.x = x;
    this.readResults();
  }

  newton(z) {
    let x = this.x;
    for (let iter = 0; iter < 80; iter++) {
      const A = this.base.map(row => Float64Array.from(row));
      const zz = Float64Array.from(z);
      const st = (i, j, v) => { if (i > 0 && j > 0) A[i - 1][j - 1] += v; };
      for (const c of this.diodes) {
        const { is, n } = this.diodeParams(c);
        const nvt = n * VT;
        const e = Math.exp(Math.min(c._vd / nvt, 60));
        const gd = is * e / nvt + 1e-12;
        const id = is * (e - 1);
        const ieq = id - gd * c._vd;
        st(c._a, c._a, gd); st(c._b, c._b, gd);
        st(c._a, c._b, -gd); st(c._b, c._a, -gd);
        if (c._a > 0) zz[c._a - 1] -= ieq;
        if (c._b > 0) zz[c._b - 1] += ieq;
      }
      const piv = luFactor(A);
      x = luSolve(A, piv, zz);
      const V = id => (id > 0 ? x[id - 1] : 0);
      let maxDelta = 0;
      for (const c of this.diodes) {
        const vNew = V(c._a) - V(c._b);
        const d = vNew - c._vd;
        maxDelta = Math.max(maxDelta, Math.abs(d));
        c._vd += Math.max(-0.6, Math.min(0.6, d)); // damping keeps exp() from blowing up
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
        case 'led': {
          const { is, n } = this.diodeParams(c);
          c._i = is * (Math.exp(Math.min(vd / (n * VT), 60)) - 1);
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
