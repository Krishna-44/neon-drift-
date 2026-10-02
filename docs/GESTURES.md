# Gesture reference & tuning

How each control is detected, and how to make it feel right for *your* body and camera.

## The invisible steering wheel

Hold both hands up as if gripping a wheel. The system does **not** look for a specific hand shape for
steering — it uses the **geometry between your two hands**:

- It finds each palm centre (average of wrist + finger knuckles — stable even as fingers move).
- The **angle of the line** from your left hand to your right hand is the wheel angle.
- That angle, minus your calibrated neutral, divided by your calibrated full-lock, is the steer value
  (−1 … +1), after a dead-zone and sensitivity multiplier.

Because it's the *line between hands*, you can grip however is comfortable; tilting the line clockwise
(right hand down / left hand up) steers right, and vice-versa. Open *both* palms to let go of the
wheel (used for pausing).

## Driving gestures

| Control | Detection | Notes |
|---|---|---|
| **Throttle** | Fist (`fist`) | One fist = strong gas (85 %); **both** fists = full throttle. |
| **Reverse** | Closed hand, thumb pointing **up** (`thumbUp`) | Engages reverse gear when slow; at speed it acts as engine braking first. |
| **Brake** | Closed hand, thumb pointing **down** (`thumbDown`) | One thumb = strong brake; **both** thumbs = maximum brake. |
| **Nitro** | Peace / V sign (`peace`) | Index + middle extended, ring + pinky curled. Drains a regenerating tank. |
| **Drift** | Thumb down **while** the wheel is turned past ~45 % | Pulls the handbrake (rear-grip cut) for controlled slides. |
| **Pause** | Open palm held 2 s | A ring fills while you hold; releasing early cancels. |
| **Menu cursor** | Point (index only) moves a cursor; **pinch** (thumb ↔ index) clicks | Used on all menus/screens. |

Which hand reads the fist (gas) and thumb (brake/reverse) gestures is configurable (Settings → Controls → *Throttle Hand*:
Either / Right / Left).

## Calibration (do this first)

**Menu → Calibrate Hands.** Three quick steps captured from your own movement:

1. **Neutral** — hold the wheel relaxed and level for ~2.5 s. Captures your wheel-centre angle and
   grip width.
2. **Lock** — turn full-left then full-right as far as is comfortable. Captures your steering range
   (90 % of your reach maps to full lock, so you never have to strain).
3. **Throttle** — thumb-down and sweep from slightly-down to fully-down. Captures your thumb angle
   range so throttle uses your full motion.

Calibration is persisted; you only redo it if your seating/camera changes.

## Custom gestures (training mode)

**Menu → Gesture Training.** Pick an action (nitro / pause / camera), hold a distinctive pose for ~45
frames, and the trainer averages your hand's feature vector into a centroid with a similarity
threshold derived from your own consistency. At runtime a live pose matches by cosine similarity
(with hysteresis so it doesn't chatter). A custom binding overrides that action's default gesture.
Inconsistent recordings are rejected with a prompt to retry.

## Tuning for your setup (Settings → Controls)

| Setting | What it does | Try this if… |
|---|---|---|
| **Steering Sensitivity** | Scales how much wheel angle → steer | …you want less arm movement (raise) or finer control (lower) |
| **Steering Smoothing** | One-Euro strength on the steer signal | …steering feels jittery (raise) or laggy (lower) |
| **Dead Zone** | Degrees around centre that read as straight | …the car drifts when you hold straight (raise) |
| **Throttle Softness** | Expo curve on throttle | …throttle feels too on/off (raise for a softer centre) |
| **Throttle Hand** | Which hand's thumb gives gas | …you prefer your dominant hand |
| **Stability / Counter-Steer Assist** | Yaw damping + auto counter-steer | …the car spins too easily (enable) |
| **Adaptive Assists** | Auto-tunes the above from your driving | …you want the game to adjust to you |

## Conditions & robustness

- **Low light** — the camera layer detects low luma and applies a brightness/contrast boost before
  inference. Aim a light at your hands for best tracking.
- **Background clutter** — hands that are too small (far away) or low-confidence are rejected so
  background motion doesn't steer the car.
- **Brief occlusion** — if a hand vanishes for under ~0.6 s, its last state is held (with decaying
  confidence) and steering coasts rather than snapping; longer than that, it resets cleanly.
- **No camera at all** — the game runs a synthetic "ghost driver" demo and the full keyboard
  fallback, so it's always playable.
