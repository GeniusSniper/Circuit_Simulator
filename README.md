# ⚡ Circuit Simulator

**🔗 Live demo: [Circuit_Simulator](https://geniussniper.github.io/Circuit_Simulator/)**

An interactive analog circuit simulator with a schematic editor that runs entirely in the browser — no build step, no dependencies. Draw a circuit, watch voltages color the wires and current flow as animated dots, and probe any component with the built-in mini-oscilloscope.

## Features

- **Schematic editor** — drag parts straight out of the palette onto the canvas (or click a tool and draw), move/reshape/rotate, undo/redo, and JSON export/import (circuits also autosave to your browser). Filled dots mark connected junctions, red rings flag unconnected pins, and green rings preview connections while you drag.
- **Real circuit simulation** — a Modified Nodal Analysis (MNA) engine with backward-Euler integration for capacitors and inductors and damped Newton–Raphson iteration (with SPICE-style junction limiting) for the nonlinear devices. This is real transient simulation, not a lookup table.
- **Components** — wire, resistor, potentiometer, capacitor, inductor, DC source, AC source / function generator (sine, square, triangle, sawtooth + DC offset), current source, diodes (standard, Zener with editable breakdown, Schottky, LED — it actually glows), NMOS & PMOS transistors (square-law, editable threshold), NPN & PNP BJTs (Ebers-Moll), an ideal op-amp (±15 V rails), switch (click to toggle), and ground.
- **Live visualization** — wire color shows node voltage (green +, red −), moving yellow dots show current magnitude and direction, and selecting a component shows its live readouts (V/I/P, or V<sub>GS</sub>/V<sub>DS</sub>/I<sub>D</sub>, V<sub>BE</sub>/V<sub>CE</sub>/I<sub>C</sub>…) plus a scrolling scope trace.
- **Example circuits** — voltage divider, RC charging, series RLC, half-wave & full-wave rectifiers, LED driver, Zener regulator, CMOS inverter, NMOS common-source amplifier, BJT common-emitter amplifier, op-amp inverting amplifier, and a square-wave + RC demo.

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
| Select a group | Drag across empty canvas (rubber-band), Shift-click to add/remove, `Ctrl+A` for all; drag any selected part to move the group, `R`/`Del` act on the whole group |
| MOSFETs | Three pins: Gate, Drain, Source (labeled when selected); drag while placing to orient, `R` rotates around the gate |
| Edit values | Select a part and edit in the Inspector (`4.7k`, `10µ`, `100n` all work) |
| Toggle a switch | Click it with the Select tool |
| Rotate / Delete | `R` / `Del` |
| Run / Pause | `Space` or the toolbar button |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |

Every circuit needs a **Ground** to define 0 V (a floating loop still simulates — the first node is auto-grounded).

## How the simulation works

Each grid point touched by a terminal becomes a node. Wires, closed switches, grounds, and voltage sources are stamped into the MNA matrix as ideal voltage sources (so each carries an exact branch current — that's what drives the dot animation). Capacitors and inductors are replaced each time step by their backward-Euler companion models, and nonlinear elements (diode, LED, NMOS/PMOS) are solved iteratively with a damped Newton–Raphson loop — MOSFETs use the square-law model (cutoff/triode/saturation, k = 20 mA/V²) with symmetric drain/source swapping. The resulting linear system is solved by LU decomposition with partial pivoting; purely linear circuits factor the matrix once and reuse it every step.
