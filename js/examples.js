// examples.js — preset circuits (coordinates in grid units).

function c(type, x1, y1, x2, y2, props = {}) {
  return { type, x1, y1, x2, y2, ...props };
}

export const EXAMPLES = {
  divider: {
    name: 'Voltage Divider',
    components: [
      c('vsource', 6, 6, 6, 14, { value: 10 }),
      c('wire', 6, 6, 16, 6),
      c('resistor', 16, 6, 16, 10, { value: 1000 }),
      c('resistor', 16, 10, 16, 14, { value: 1000 }),
      c('wire', 16, 14, 6, 14),
      c('ground', 6, 14, 6, 15),
    ],
  },
  rc: {
    name: 'RC Charging (click the switch!)',
    components: [
      c('vsource', 6, 6, 6, 14, { value: 5 }),
      c('wire', 6, 6, 10, 6),
      c('switch', 10, 6, 16, 6, { closed: false }),
      c('resistor', 16, 6, 22, 6, { value: 1000 }),
      c('wire', 22, 6, 26, 6),
      c('capacitor', 26, 6, 26, 14, { value: 10e-6 }),
      c('wire', 26, 14, 16, 14),
      c('wire', 16, 14, 6, 14),
      c('ground', 16, 14, 16, 15),
    ],
  },
  rlc: {
    name: 'Series RLC (near resonance)',
    components: [
      c('acsource', 6, 6, 6, 16, { value: 5, freq: 160 }),
      c('wire', 6, 6, 10, 6),
      c('resistor', 10, 6, 16, 6, { value: 100 }),
      c('inductor', 16, 6, 22, 6, { value: 0.1 }),
      c('capacitor', 22, 6, 28, 6, { value: 10e-6 }),
      c('wire', 28, 6, 32, 6),
      c('wire', 32, 6, 32, 16),
      c('wire', 32, 16, 6, 16),
      c('ground', 6, 16, 6, 17),
    ],
  },
  rectifier: {
    name: 'Half-Wave Rectifier',
    components: [
      c('acsource', 6, 6, 6, 16, { value: 10, freq: 60 }),
      c('wire', 6, 6, 12, 6),
      c('diode', 12, 6, 18, 6),
      c('wire', 18, 6, 24, 6),
      c('wire', 24, 6, 30, 6),
      c('capacitor', 24, 6, 24, 16, { value: 100e-6 }),
      c('resistor', 30, 6, 30, 16, { value: 1000 }),
      c('wire', 30, 16, 24, 16),
      c('wire', 24, 16, 6, 16),
      c('ground', 24, 16, 24, 17),
    ],
  },
  led: {
    name: 'LED + Resistor',
    components: [
      c('vsource', 6, 6, 6, 14, { value: 5 }),
      c('wire', 6, 6, 10, 6),
      c('resistor', 10, 6, 16, 6, { value: 220 }),
      c('wire', 16, 6, 20, 6),
      c('led', 20, 6, 20, 14),
      c('wire', 20, 14, 6, 14),
      c('ground', 6, 14, 6, 15),
    ],
  },
};
