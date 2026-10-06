# Contributing

Thanks for your interest in NEONDRIFT GP! Bug reports, ideas and pull requests are welcome.

## Development setup

```bash
npm install          # also copies the MediaPipe WASM runtime into public/
npm run dev          # http://localhost:5173
```

No webcam? The game falls back to a synthetic "ghost driver" plus keyboard controls, so everything
is runnable without a camera.

## Before opening a pull request

```bash
npm run typecheck    # strict TypeScript
npm test             # unit + integration tests (vitest)
npm run bench        # optional: check hot paths didn't regress
```

CI runs the typecheck, the test suite and a production build on every pull request.

## Code layout and conventions

- **Logic vs. presentation.** The simulation, gesture and AI logic (`physics/`, `ai/`,
  `input/GestureMapper`, `vision/HandFeatures`, `vision/GestureClassifier`, `track/Spline`,
  `track/TrackData`) is pure TypeScript with no DOM or WebGL access, so it can be unit tested
  headlessly. Keep it that way — put rendering, DOM and audio code in the presentation layers.
- **Determinism.** The simulation runs at a fixed 120 Hz step. Don't read wall-clock time or
  `Math.random()` inside physics/AI; use the seeded RNG in `core/MathUtils`.
- **Tests with behaviour changes.** New gestures, physics changes and AI behaviour should come with
  a test in `tests/`. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the layers fit
  together.

## Reporting bugs

Please use the bug report template and include your browser, OS, GPU and webcam model — hand
tracking behaviour depends heavily on camera and lighting.
