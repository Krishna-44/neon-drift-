# NEONDRIFT GP — Lovable prompt pack (AAA neon racing visuals)

Lovable builds **React + Vite + Tailwind + shadcn** apps and supports 3D via
**@react-three/fiber + @react-three/drei + @react-three/postprocessing**.
Paste **Prompt 1** first, then refine with the follow-ups. Build one screen at a
time — Lovable does better with focused, iterative prompts than one giant wall.

---

## PROMPT 1 — Project + art direction + 3D garage hero (paste this first)

> Build a **AAA-grade cyberpunk racing game front-end** called **NEONDRIFT GP**, styled like *Asphalt 9* meets *Need for Speed: Heat* meets *Blade Runner*. Use **React + Vite + TypeScript + Tailwind**, and **@react-three/fiber, @react-three/drei, @react-three/postprocessing** for 3D.
>
> **Art direction (this is the priority — make it look expensive):**
> - Rain-slicked, **reflective** night street in a neon Tokyo/Shibuya megacity. Towering holographic billboards, glowing kanji signage, volumetric fog, light trails.
> - Palette: deep blue-black background `#04060d`, neon **cyan `#00f0ff`**, **magenta `#ff2bd6`**, **violet `#7a5cff`**, accent **amber `#ffb648`**. Everything glows.
> - Cinematic post-processing: **strong Bloom**, subtle **Chromatic Aberration**, **Vignette**, light **Depth of Field** on the background, **SMAA**, ACES tone mapping, faint film grain.
>
> **3D garage hero scene (centerpiece):**
> - A sleek low-poly-but-sexy **supercar** on a circular **glowing podium** with two neon torus rings (cyan + magenta) that slowly rotate. Car paint uses a **clearcoat PBR material** with metalness and a colored emissive rim; rims and underglow emit light.
> - Ground is a **MeshReflectorMaterial** (drei) — wet, mirror-like, blurred reflections of the car and neon.
> - Use a drei **Environment** (preset "night" or a custom Lightformer rig) so the car body shows crisp HDR reflections. Add **ContactShadows** under the car and **Sparkles** drifting in the air.
> - The camera slowly orbits the car (auto-rotate, smooth ease), with a gentle bob. On scroll/hover, parallax the billboards behind it.
>
> **Layout:** full-bleed 3D canvas as the background; over it, a glassmorphic UI with a huge gradient title **NEONDRIFT GP** (cyan→magenta→violet, glow, subtle glitch), a subtitle "Gesture-Controlled Racing Simulator", and a vertical neon button stack (RACE, GARAGE, SETTINGS, HOW TO PLAY) with hover lift + glow + a left accent bar. Use **framer-motion** for staggered entrance animations.
>
> Make it 60fps-smooth, responsive, and genuinely premium. No placeholder lorem — use the real labels above.

---

## PROMPT 2 — Garage / car carousel

> Add a **GARAGE** screen: a flick/arrow **car carousel** on the reflective podium. 8 cars, each a different neon accent color (cyan, magenta, amber, violet, mint, ember-orange, lime, rose). Selecting a car spins the podium 180° and swaps the car with a scale-pop; the podium rings and rim-light lerp to the car's color. Beside it, animated **stat bars** (Acceleration / Grip / Top Speed) that fill with a spring ease when the car changes, plus the car name in its accent color. Glassmorphic panel, framer-motion transitions.

---

## PROMPT 3 — In-race HUD (overlay, no gameplay needed)

> Build an **in-race HUD overlay** (can sit over a looping video or the 3D scene). Asphalt-9 style:
> - **Bottom-center**: a large speed readout (big bold number + "KM/H") inside a sweeping **SVG dual-arc gauge** — outer cyan→magenta speed arc, inner magenta RPM arc, with tick marks and a neon glow.
> - **Segmented NITRO gauge** (14 segments) below it that fills left→right, turns magenta past 80%, and **flares/pulses** when active.
> - **Top-left**: glassy POSITION pill (amber glow when P1) + LAP counter. **Top-center**: lap timer with a green/red delta. **Top-right**: a stylized **minimap** (glowing track outline + car blips).
> - Speed-reactive FX: faint **motion lines** and an edge **vignette** that intensify at high speed; a violet **nitro screen flash**. Lap-complete shows a big animated delta popup. All glassmorphic, monospace numerals, neon glow, framer-motion.

---

## PROMPT 4 — Track select + results

> Add a **TRACK SELECT** screen: a responsive grid of track cards (NEON DISTRICT / DUNE RUSH / MIDNIGHT RUN / SAKURA PASS), each with a stylized SVG circuit map preview that draws itself with an animated dashed racing line, a difficulty rating (◆), and a per-track accent glow + 3D tilt-on-hover. And a **RESULTS** screen: a glassy standings table with gold/silver/bronze position badges, rows that sweep in with a stagger, and a confetti/speed-line burst behind the winner.

---

## Tips to get the most out of Lovable
- Build **screen by screen** (run the prompts in order); refine each with small follow-ups ("make the bloom stronger", "slower camera orbit", "more reflection blur", "add rain streaks on a glass layer").
- Ask it to **install** the 3D libs explicitly if it doesn't: `@react-three/fiber @react-three/drei @react-three/postprocessing three framer-motion`.
- For the car, if you have a `.glb` model, upload it and say "load this GLB with useGLTF and apply a clearcoat material"; otherwise tell it to build the car from primitives.
- Connect Lovable to **GitHub** so you can pull the generated code locally.
- Performance: tell it to cap `dpr={[1, 2]}`, use `<AdaptiveDpr>` and `<Preload all />` from drei.

## Reality check (integration)
The Lovable output is a **separate React/r3f app**. To bring its *look* into THIS
game you'd port the materials/post-processing/lighting recipe into our
`src/track/TrackBuilder.ts`, `src/vehicle/CarFactory.ts`, `src/fx/PostFX.ts` —
the concepts (MeshReflector wet ground, HDR Environment reflections, clearcoat
paint, stronger bloom + DOF + chromatic aberration) map directly onto our
existing Three.js renderer. Tell me when you have something you like and I can
fold those exact techniques into the engine.
