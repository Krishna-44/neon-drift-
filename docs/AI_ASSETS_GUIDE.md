# Getting Asphalt-tier graphics with AI — tools + prompts

**Reality:** "Graphics like Asphalt 9" = a game **engine** (Unreal Engine 5, or
our Three.js) rendering **artist/AI-made assets** (car models, PBR textures,
HDRI environments) with cinematic lighting + post-processing. No single AI
produces the whole thing. AI is best at making the *pieces*. The three pieces
that plug straight into THIS project's renderer (and give the biggest jump):

1. a **car model** as `.glb` → I load it with `GLTFLoader`
2. an **HDRI / 360 skybox** → becomes `scene.environment` (real reflections)
3. **PBR texture sets** (color/normal/roughness/metallic) → road & props

---

## Which AI does what (verify current free tiers/quality before paying)

| Asset you need | Best AI tools | Output we can use |
|---|---|---|
| **3D car / vehicle model** | **Meshy AI**, **Tripo3D**, **Rodin / Hyper3D** (Deemos), **Luma Genie**, **Kaedim** (image→3D, gamedev), **CSM.ai** | `.glb` / `.fbx` → GLTFLoader |
| **360 environment / HDRI** (neon city) | **Blockade Labs — Skybox AI** (best; exports HDRI), Luma (real-scene capture) | `.hdr`/`.exr` → scene.environment + background |
| **PBR materials/textures** (asphalt, walls) | **Adobe Substance 3D Sampler** (AI), **Poly (withpoly.com)**, **Dream Textures** (Blender+SD), **Materialize** | color/normal/rough/metal maps |
| **Concept art / key art / mood / car renders** | **Midjourney**, **Flux** (Black Forest Labs), **Leonardo.ai**, **Scenario.gg** (game-tuned), **Ideogram** (good text for HUD mockups) | reference images (not 3D) |
| **UI / front-end code** | **Lovable**, **v0 (Vercel)**, **Cursor** | React/r3f code (see LOVABLE_PROMPT.md) |
| **Trailer / cinematic video** (not playable) | **Runway**, **Kling**, **Google Veo**, **Sora** | marketing video only |
| **The actual AAA rendering** | **Unreal Engine 5** (Lumen/Nanite) — if you ever want a full rebuild | a separate engine project |

**Fastest path to a great car without AI cleanup hassle:** a ready-made PBR car
model from **Sketchfab** (filter: downloadable, CC / royalty-free), **Quaternius**
(free low-poly), or **TurboSquid/Kenney**. Combined with the lighting we already
have, a good GLB often beats raw AI-gen for hero cars. I can wire any `.glb` in.

---

## PROMPT A — AI 3D car model (Meshy / Tripo / Rodin, text-to-3D)

> A sleek futuristic cyberpunk hypercar, low and wide aggressive stance, sharp
> angular aerodynamic body, smooth panels with crisp character lines, large rear
> wing, sporty alloy wheels, glowing neon under-rim accents, dark metallic paint
> with cyan emissive trim. Clean game-ready topology, single vehicle centered,
> neutral pose, PBR textures, studio lighting. Style: AAA arcade racing game
> (Asphalt 9 / Need for Speed). Export GLB, real-world scale ~4.3m long.

Tips: generate, then in the tool pick **"game-ready / quad remesh"** + bake PBR;
download **GLB**. Keep it under ~100k tris. Send me the file and I'll load it.

## PROMPT B — HDRI / 360 skybox (Blockade Labs Skybox AI)

> A neon cyberpunk megacity at night, rain-slicked streets, towering skyscrapers
> covered in glowing holographic billboards and kanji signage, dense volumetric
> fog, cyan and magenta light pollution, reflective wet asphalt, cinematic, ultra
> detailed, high dynamic range. (style: "Digital Painting" or "Realistic")

Then **export the HDRI** (Skybox AI offers HDRI/depth export). Drop the `.hdr`
in `public/hdri/` and I'll use it for `scene.environment` + background — instant
realistic neon reflections on cars and wet road.

## PROMPT C — PBR road material (Substance Sampler / Poly / Dream Textures)

> Seamless tileable wet asphalt road texture, fine aggregate, faint tyre-wear
> lanes, subtle cracks and tar patches, rain-damp sheen, neutral dark grey,
> top-down, PBR, 2K, with normal / roughness / ambient-occlusion maps.

## PROMPT D — Concept art / key art for reference (Midjourney / Flux)

> NEONDRIFT GP — cyberpunk arcade racing game key art: a glowing supercar
> drifting through a rain-soaked neon Tokyo street at night, sparks and light
> trails, dramatic low camera angle, volumetric haze, cyan/magenta/violet palette,
> cinematic, hyper-detailed, 16:9 --ar 16:9 --style raw

(Use these as a visual target / for menus — they're 2D, not 3D assets.)

---

## What to send me and I'll wire it into the engine
- **A `.glb` car** → I add `GLTFLoader`, replace the procedural car, keep the
  clearcoat + neon-environment lighting so it gleams.
- **An `.hdr` skybox** → I swap the procedural PMREM probe for it (richer, real
  reflections) and use it as the sky.
- **PBR map sets** → I apply them to the road / walls for photoreal surfaces.

That combination — real GLB car + AI HDRI + PBR textures on the lighting rig we
already built — is the realistic route to an Asphalt-class look in this engine.
