# Architecture

This document explains how NEONDRIFT GP is put together and *why*. The guiding principle is a hard
split between **engine-agnostic logic** (pure TypeScript, deterministic, unit-tested) and
**presentation** (Three.js / DOM / WebAudio). Everything in `core/`, `vision/` (minus the worker),
`input/`, `physics/`, `track/Spline`, `ai/`, and `game/Telemetry|ReplayPlayer|AdaptiveProfile` is
pure logic with no DOM or WebGL imports — which is exactly why it can be exhaustively tested headless.

## Data flow (one frame)

```
                       ┌──────────────────────── CV THREAD (Web Worker) ──────────────────────┐
 webcam ──► CameraManager ──► ImageBitmap (transfer) ──► MediaPipe HandLandmarker ──► landmarks │
   ▲          │ pacing, dynamic res, low-light boost                                   (transfer)│
   │          └───────────────────────────────────────────────────────────────────────────────┘
   │                                                                                    │
   │                                                              ┌─────────────────────▼─────────┐
   │                                                              │ HandTracker (main thread)      │
   │                                                              │  • role association (L/R)      │
   │                                                              │  • One-Euro landmark smoothing │
   │                                                              │  • feature extraction          │
   │                                                              │  • pose classify + hysteresis  │
   │                                                              │  • occlusion coast / prediction│
   │                                                              └─────────────────────┬─────────┘
   │                                                                          HandsState │
   │                                       ┌────────────────────────────────────────────▼─────────┐
   │   keyboard ─► KeyboardInput ─────────►│ GestureMapper: wheel angle, deadzone, expo, slew,     │
   │                                       │ velocity prediction, custom-gesture match, pause-hold │
   │                                       └────────────────────────────────────────────┬─────────┘
   │                                                                            CarInputs │
   │   ┌──────────────────────────── GameLoop (fixed 120 Hz) ───────────────────────────▼─────────┐
   │   │ GameSession.simulate(dt):                                                                 │
   │   │   player + AIDriver inputs → VehicleDynamics.step → TrackPhysics (surface, walls,        │
   │   │   car-vs-car) → RaceDirector (laps/standings) → Telemetry frame → ReplayBuffer + publish  │
   │   └───────────────────────────────────────────────────────────────────────────────┬─────────┘
   │                                                                                     │
   │   ┌──────────────────────────── GameLoop (per rAF, interpolated) ──────────────────▼─────────┐
   └───┤ GameSession.renderFrame: CarVisual binding, CameraRig, ParticleManager, AudioEngine,     │
       │ PerfGovernor, PostFX bloom → Three.js draw    +    HUD / WebcamOverlay DOM update         │
       └───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why these choices

### Fixed-timestep simulation (`core/GameLoop`)
Physics steps at a constant 120 Hz regardless of display refresh, with the renderer interpolating
between the last two states. This makes the simulation **deterministic** (same inputs → same result,
which is what lets the physics and AI be unit-tested), **stable** (no blow-ups at low FPS), and
**frame-rate independent**. A catch-up cap (max 8 sub-steps) prevents the "spiral of death" on a slow
frame — it sheds time debt instead of cascading.

### CV on its own thread (`vision/visionWorker`)
Hand inference is the single most expensive per-frame cost (up to ~25 ms on CPU). Running it in a
Web Worker means it never blocks a draw call. ImageBitmaps and landmark buffers are *transferred*
(zero-copy). There are three layers of fallback: GPU delegate → CPU delegate → inline main-thread
inference (if workers/WASM module-workers are unavailable), plus a watchdog that tears down and
re-inits inline if the worker goes silent for 4 s.

### One-Euro filtering + prediction (`vision/OneEuro`, `input/GestureMapper`)
The One-Euro filter is the standard for low-latency interactive signals: it smooths hard when the
signal is slow (kills jitter) and tracks tightly when it moves fast (kills lag), via a velocity-
adaptive cutoff. On top, the mapper extrapolates palm positions ~30 ms ahead using measured velocity
to compensate for end-to-end camera latency. Steering is additionally slew-limited so the virtual
wheel can never teleport.

### Temporal gesture stabilisation (`vision/GestureClassifier`)
`classifyPose` is a stateless geometric cascade; `GestureStabilizer` adds the temporal layer:
activation requires N consecutive agreeing frames, release requires M frames of disagreement
(hysteresis), and a confidence score comes from a sliding vote window. Per-pose activation thresholds
trade latency vs. stability (throttle is snappy at 2 frames; brake is stricter at 4 to avoid
loose-grip false positives). This is what makes the controls feel solid rather than twitchy.

### Slip-angle vehicle model (`physics/VehicleDynamics`)
A planar rigid body with a bicycle tyre model: per-axle slip angles, saturating lateral forces
(tanh ≈ simplified Pacejka), longitudinal weight transfer that modulates available grip, a
traction-limited drive force, handbrake rear-grip reduction for drifting, aero drag, rolling
resistance and slope gravity. It blends to kinematic steering at crawl speed so parking feels right.
Tuned for confident arcade handling, but it is *real* physics — the 60-second random-input fuzz test
asserts it never produces NaN or explodes.

### Stanley AI (`ai/AIDriver`)
Opponents use a Stanley path-tracking controller (crosstrack + heading error + curvature
feedforward + yaw-rate-error damping) over a precomputed curvature-apex racing line, with a
corner-speed planner that derives braking points from upcoming curvature, plus a small reverse-out
state machine for getting unstuck. Difficulty scales *target speed and grip budget*, never the
physics — every AI car runs the identical `VehicleDynamics` the player does. This is verified by
integration tests that run a full AI lap on each of the four tracks with zero off-track time.

### Telemetry as the netcode seam (`game/Telemetry`, `net/`)
Every physics step emits a compact `TelemetryFrame`. It feeds (a) a bounded replay ring buffer,
(b) the HUD, and (c) the telemetry publisher. Spectating is just another consumer of that frame —
locally via `BroadcastChannel`, remotely via WebSocket through the bundled relay. Because the frame
already *is* the wire format, an authoritative multiplayer server is an incremental step rather than
a rewrite (see `docs/ROADMAP.md`).

## Module dependency rules

- `core/` imports nothing else in the project.
- `vision/` (except `visionWorker`), `input/`, `physics/`, `track/Spline`, `ai/` import only `core/`
  and each other's pure modules — **no Three.js, no DOM**.
- `track/TrackBuilder`, `vehicle/`, `camera/`, `fx/` are the Three.js presentation layer.
- `ui/` is the DOM layer.
- `game/GameSession` and `game/App` are the only modules allowed to wire logic ↔ presentation.

Keeping these rules is what keeps the test suite able to exercise the real gameplay code headlessly.
