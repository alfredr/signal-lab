# Signal Lab

Signal Lab is a browser-based editor and simulator for radios and other signal
chains. Connect blocks, run the simulation, and inspect or listen to signals at
any point in the circuit.

[Open Signal Lab](https://www.alfredrossi.com/gadgets/signal-lab/)

The app runs locally in your browser. A Web Worker processes the signals, and the
page displays plots, measurements, controls, and audio playback. The production
build is a static site with its scripts, fonts, and data included.

## Run locally

Use Node.js 23.6 or later. The project pins Node 24 in `mise.toml`.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. The development server rebuilds when files change;
set `PORT` to use a different port. Installation also enables the pre-commit
checks through Husky.

To build for a static host:

```sh
npm run build
```

Serve the contents of `dist/` over HTTP. No application server is required.

## Build a signal chain

Start with an example or choose **New**. Examples cover AM, speech transmission,
multiple stations, DSB-SC, phasing SSB, FT8, feedback, and filter responses.

1. Add blocks from the palette by clicking or dragging them onto the diagram.
   The filter searches block names and categories.
2. Connect an output to an input by dragging between ports. Select a block to
   edit its settings in the inspector. Numeric fields accept units and SI
   prefixes, such as `100 kHz` or `20 us`.
3. Add a **Plot** or **Speaker** to inspect a signal. The context menu on an
   output or wire provides shortcuts for both.
4. Press **Run** or Space. **Pause** holds the playhead; **Reset** restarts at
   time zero. Speed controls range from ⅛× to 8× and also affect audio pitch.

The simulation streams continuously. Settings changes affect subsequent samples,
and plots and readings follow the playhead. If processing cannot keep up with the
selected speed, simulation time advances more slowly.

### Instruments and panels

Instruments appear on the diagram and on the panel face:

| Instrument | Purpose |
| --- | --- |
| Plot | Time trace, spectrum, or waterfall |
| Speaker | Audio monitoring of a connected signal |
| Control | Knob, slider, switch, or text field for a parameter or block setting |
| Readout | A block's reported value or message |
| Button | A trigger pulse for blocks such as Recording and Speech |
| Note | Markdown text, optionally shown on the panel face |
| Bits to tones | FT8 symbols, bit groups, tones, and associated signal traces |

Panel instruments are organized into panes, and panes into panels. Use
**Arrange** to move, resize, and rename them. Panels can be stacked, tiled, or
shown as tabs. The layout adapts to the available space.

On panel plots, scroll to zoom, drag to pan, and double-click to reset the view.
Double-click a knob to type a value. Clicking an instrument outside its controls
selects its block on the diagram.

### Parameters and subsystems

A diagram can declare named numeric parameters. Use the **ƒ** menu beside a
setting to bind it to an expression, such as `carrier`, `-3 - snr`, or
`1 / (2 * pi * sqrt(L * C))`.

Group selected blocks to create a subsystem. Wires crossing the selection become
input and output terminals. Double-click the subsystem to edit its contents;
**Ungroup** restores the contained blocks to the parent diagram. Parameters inside
a subsystem are exposed as settings on its block. The library includes reusable
subsystems such as envelope and product detectors.

Antennas exchange signals through a shared simulated channel without explicit
wires between them. Each receiver hears the other antennas plus its configured
band noise.

### Speech, recordings, and FT8

**Speech** synthesizes typed text as a signal that can pass through the circuit.
**Recording** accepts an audio file or microphone capture, up to 30 seconds. Both
support looping and triggered playback.

The FT8 examples expose message packing, CRC, LDPC encoding, symbol mapping,
Gaussian filtering, and audio generation as separate stages. The decoder reports
uncorrected received text during reception and checks a complete decode at the end
of each slot. These stages can be plotted and inspected individually.

### Save your work

The current document is saved automatically in the browser. **Save** exports a
JSON file; **Open** imports one. Exports include the document's parameters, panel
organization, and recordings. Recordings are stored in IndexedDB while editing.
Workspace layout and theme preferences are stored separately in the browser.

Undo and redo cover document edits. Notes support Markdown and TeX math, using
`$...$` for inline expressions and `$$...$$` for display math.

## Development

| Command | Purpose |
| --- | --- |
| `npm test` | Run the test suites |
| `npm run check` | Check lint, formatting, types, unused code, and tests |
| `npm run fmt` | Apply lint fixes and formatting |
| `npm run typecheck` | Check application, test, and build-script types |
| `npm run build` | Produce the static site in `dist/` |

Equivalent tasks are defined in `mise.toml`. The pre-commit hook runs
`npm run check`.

The build compiles TypeScript to native ES modules and rewrites `.ts` import
extensions to `.js`. There is no bundler. It copies static assets and vendor files
into `dist/`, then adds module preload links to the page. The development server
uses the same Content Security Policy as the blog host.

`npm run gadget` builds and copies the site into
`../blog/content/gadgets/signal-lab`. Set `BLOG_DIR` to choose another blog
checkout. Existing preview images are preserved.

### Code map

| Directory | Contents |
| --- | --- |
| `src/engine/` | Stream scheduling, block contracts, signals, and parameters |
| `src/dsp/` | Filters, resampling, transforms, measurements, FT8, and speech synthesis |
| `src/blocks/` | Block definitions and processors |
| `src/model/` | Documents, expressions, subsystems, reference handling, panel layouts, and examples |
| `src/sim/` | Worker protocol, simulation worker, and browser client |
| `src/ui/` | Diagram editor, inspector, panels, plots, audio, and controls |
| `public/` | Page, stylesheet, and fonts |
| `scripts/` | Build, development server, and gadget installation |
| `test/` | Engine, DSP, model, and related unit tests |
| `licenses/` | Third-party notices and licenses |

### Simulation model

Wires carry real-valued samples at explicit sample rates. Sources establish rates;
connected inputs must agree unless a block performs rate conversion. Unconnected
inputs read as silence.

Processors retain state between chunks. The scheduler runs upstream components
first. Feedback loops must contain a delay and use a single sample rate; the
scheduler advances them in spans no longer than the shortest delay. Processing
contracts are defined in `src/engine/block.ts`.

Before simulation, the model resolves parameter bindings and flattens subsystems
and antenna connections into an engine circuit. Display-only instruments are
excluded; Buttons remain as signal sources. Compatible processors retain their
state when settings change. Noise uses stable seeds for repeatable runs.

### Add a block

Define a block with `defineBlock` in `src/blocks/` and register it in
`src/blocks/index.ts`. Its parameter specifications generate the inspector
controls. The processor's `process` method writes output samples for the requested
`[start, end)` span.

Use `rates` for rate conversion, `readings` for measurements, and `update` when a
processor can accept new settings without resetting its state. A processor that
breaks a feedback cycle must implement the `DelayProcessor` contract. Add
behavioral tests alongside the existing suites. Reusable subsystem diagrams belong
in `src/model/library.ts`.

## License and credits

Signal Lab is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses:

- Temml renders TeX as MathML and is distributed under the MIT License.
- Archivo, JetBrains Mono, and Source Serif 4 use the SIL Open Font License 1.1.
- The CMU Pronouncing Dictionary uses a BSD-style license; its npm package uses
  ISC. The worker loads the dictionary only when a document uses Speech.
- Speech synthesis and timing code are ported from klattsch, and the NRL
  letter-to-sound rules use the HeadTTS transcription. Both projects use MIT.

Notices are kept in `licenses/` and copied into `dist/vendor/licenses/`. The build
also includes Temml's license in `dist/vendor/`.
