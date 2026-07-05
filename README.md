# ⚡ Circuit Simulator

**🔗 Live demo: [https://geniussniper.github.io/Circuit_Simulator/](https://geniussniper.github.io/Circuit_Simulator/)**

An interactive analog circuit simulator with a schematic editor that runs entirely in the browser — no build step, no dependencies. Draw a circuit, watch voltages color the wires and current flow as animated dots, and probe any component with the built-in mini-oscilloscope.

## Features

- **Schematic editor** — drag-and-drop placement on a snapping grid, move/reshape/rotate parts, undo/redo, and JSON export/import (circuits also autosave to your browser). Filled dots mark connected junctions, red rings flag unconnected pins, and green rings preview connections while you drag.
- **Real circuit simulation** — a Modified Nodal Analysis (MNA) engine with backward-Euler integration for capacitors and inductors and damped Newton–Raphson iteration for diodes and MOSFETs. This is real transient simulation, not a lookup table.
- **Components** — wire, resistor, capacitor, inductor, DC & AC voltage sources, current source, NMOS & PMOS transistors (square-law model with editable threshold), diode, LED (it actually glows), switch (click to toggle), and ground.
- **Live visualization** — wire color shows node voltage (green +, red −), moving yellow dots show current magnitude and direction, and selecting a component shows its live voltage/current/power (V<sub>GS</sub>/V<sub>DS</sub>/I<sub>D</sub> for MOSFETs) plus a scrolling scope trace.
- **Example circuits** — voltage divider, RC charging, series RLC near resonance, half-wave rectifier, LED driver, CMOS inverter, NMOS common-source amplifier, and a full-wave bridge rectifier.

## Running locally

It's a static site. Either open `index.html` directly, or serve the folder (recommended, since ES modules prefer HTTP):

```sh
python -m http.server 8000
# or: npx serve
```

Then visit http://localhost:8000.

## How to use

| Action | How |
| --- | --- |
| Place a part | Pick it in the palette, then click or drag on the canvas |
| Connect parts | Endpoints that share a grid point are connected (filled dot = joined, red ring = open pin, green ring while dragging = will connect); use Wire for runs |
| Move / reshape | Select tool: drag the body, or drag the blue endpoint handles |
| MOSFETs | Three pins: Gate, Drain, Source (labeled when selected); drag while placing to orient, `R` rotates around the gate |
| Edit values | Select a part and edit in the Inspector (`4.7k`, `10µ`, `100n` all work) |
| Toggle a switch | Click it with the Select tool |
| Rotate / Delete | `R` / `Del` |
| Run / Pause | `Space` or the toolbar button |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |

Every circuit needs a **Ground** to define 0 V (a floating loop still simulates — the first node is auto-grounded).

## How the simulation works

Each grid point touched by a terminal becomes a node. Wires, closed switches, grounds, and voltage sources are stamped into the MNA matrix as ideal voltage sources (so each carries an exact branch current — that's what drives the dot animation). Capacitors and inductors are replaced each time step by their backward-Euler companion models, and nonlinear elements (diode, LED, NMOS/PMOS) are solved iteratively with a damped Newton–Raphson loop — MOSFETs use the square-law model (cutoff/triode/saturation, k = 20 mA/V²) with symmetric drain/source swapping. The resulting linear system is solved by LU decomposition with partial pivoting; purely linear circuits factor the matrix once and reuse it every step.
