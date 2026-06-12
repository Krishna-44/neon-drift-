# Extensibility roadmap

The architecture was built so the headline "future" features are incremental, not rewrites. Each
section notes the seam that already exists in the codebase.

## Multiplayer (online racing)

**Already in place:** every physics step emits a compact `TelemetryFrame` (`game/Telemetry.ts`); the
`net/TelemetryTransport.ts` layer abstracts BroadcastChannel (same machine) and WebSocket (remote via
`scripts/relay.mjs`); `net/SpectatorApp.ts` already reconstructs a full visual race from nothing but
that frame stream. Vehicle dynamics are deterministic and engine-agnostic.

**To get to authoritative multiplayer:**
1. Promote the relay into an authoritative server that runs `VehicleDynamics` for all cars (the model
   already runs headless — see the integration test).
2. Send player `CarInputs` (already the canonical input struct) upstream instead of telemetry.
3. Reconcile with client-side prediction using the same fixed-step loop (rewind/replay from the last
   acked state — the simulation is deterministic, so this is well-defined).
4. Spectators keep consuming `TelemetryFrame` unchanged.

The input contract (`CarInputs`), the simulation (`VehicleDynamics`), and the wire format
(`TelemetryFrame`) are the three things netcode needs, and all three already exist and are tested.

## VR

**Already in place:** the `CameraRig` abstracts the view; rendering goes through a single
`PostFX.render(scene, camera)` call; hand tracking already produces 3D-capable landmarks.

**To get to VR:**
1. Add a `WebXRCameraRig` that drives the stereo camera from the XR pose instead of the chase rig.
2. Swap MediaPipe webcam hands for the headset's hand-tracking joints (the `HandsState` shape is the
   integration point — feed XR joints through the same feature extractor).
3. Render through `renderer.xr` (Three.js has first-class WebXR). The bloom pass would move to a
   per-eye target.

The gesture → `CarInputs` mapping is unchanged: you'd literally hold a wheel in VR.

## AI driving assistant

**Already in place:** `game/AdaptiveProfile.ts` observes the player (steering smoothness, throttle
aggression, off-tracks, lap consistency) and maintains a persistent skill profile that already tunes
AI difficulty and driver assists.

**To extend into a coach:**
1. Log per-corner deltas vs. the AI racing line (the line is already computed in `AIDriver`).
2. Surface "brake later into T3 / you're lifting mid-corner" hints in the HUD.
3. Optionally blend a fraction of the AI's Stanley steering into the player's input as a
   teaching aid (the controller is already there and runs on the player's car model).

## Telemetry & analytics

**Already in place:** the `Profiler` tracks FPS / CV inference / input latency; `TelemetryPublisher`
streams race state. A dashboard is just another `?spectate`-style consumer subscribing to the same
transport — point it at the relay and aggregate.

## More content

Tracks are **data** (`track/TrackData.ts`): control points + theme + height function. A new circuit
is ~15 lines and the procedural builder + AI racing line + minimap all derive from it automatically.
New car classes are spec objects (`physics/VehicleDynamics.ts` `CarSpec`). New gestures are pure
additions to the classifier cascade plus a HUD chip.
