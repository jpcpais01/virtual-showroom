# KHORA — Virtual Showroom

A 3D, in-browser KHORA store with a club twist: a high-end shop floor in royal blue,
a DJ booth with an LED wall, moving heads and lasers, and garments simulated as real
cloth that you can pull, pick up and turn in your hands.

Built with [three.js](https://threejs.org) and Vite. No backend; it deploys to Vercel as a
static site.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/
```

### Deploy on Vercel

Import the repo in Vercel. The framework is detected as **Vite** (`vercel.json` pins
`npm run build` → `dist`). No environment variables are needed.

## Using the showroom

| Action | Desktop | Touch |
| --- | --- | --- |
| Look around | drag | drag |
| Walk | WASD / arrows, or click the floor | tap the floor |
| Inspect a piece | click it | tap it |
| Pull the fabric | click-and-drag on the shirt | drag on the shirt |
| Pick up / put back | **Pick it up** button or `E` | button |
| Turn it in your hands | drag the background, **Turn around** | same |
| Bring it closer | mouse wheel | — |

Music is generated live in the browser (WebAudio, 126 BPM) and gets muffled as you
walk away from the booth. The lights follow the same clock even when muted.

Add `?low` to the URL to force the low-quality profile (the app also drops quality
automatically if the frame rate is poor).

## How the tee is made

* **Pattern, not a scan.** `src/garments/teeMesh.js` builds the shirt from a flat sewing
  pattern (front + back panels, dropped shoulder, boxy body, short wide sleeves). The
  panels are meshed in 2D and sewn together by sharing the seam particles, so the shirt is
  a real closed garment with openings at the neck, cuffs and hem.
* **Cloth physics.** `src/garments/cloth.js` is an XPBD solver with small substeps:
  stretch and bending constraints, self-collision via a spatial hash, aerodynamic drag on
  each face, friction against colliders. It runs on the CPU every frame. Garments that are
  hanging still fall asleep to save battery and wake up when you touch them.
* **Artwork from the product photos.** `tools/build_textures.py` lifts the back print,
  the embroidered monogram and the woven label out of the original product shots
  (colour keying, local background removal, de-skew), then composes the garment texture
  atlas with collar rib, cover-stitch hems and seams, plus height/roughness and a
  tileable cotton-jersey normal map. The outputs live in `public/textures/`.
* **Rendering.** Physically based cotton (sheen, knit normal map, embroidery/print
  bump and roughness), Phong-tessellated render mesh on top of the simulation mesh,
  rolled edges for real fabric thickness, double-sided with a plain inside.

To rebuild the textures from the photos:

```bash
pip install numpy opencv-python-headless pillow
python3 tools/build_textures.py /path/to/photos   # folder with the KHORA_*.jpg shots
```

## Adding the next piece

Each garment is a `Tee` instance hung from a hanger matrix (see `src/main.js` and the
anchors returned by `buildRoom` in `src/scene/room.js`). New garment types need a
pattern (like `tee-pattern.json`) and a texture atlas in the same layout.

## Project layout

```
index.html            UI shell (intro, HUD, product panel)
src/main.js           renderer, post-processing, interaction, game loop
src/controls.js       walk / look controls (mouse + touch)
src/audio.js          generative techno + show clock
src/scene/room.js     shop architecture, fixtures, lighting
src/scene/stage.js    DJ booth, LED wall, speakers, truss, moving heads, lasers, DJ
src/scene/reflection.js  blurred planar reflection for the polished floor
src/garments/         cloth solver, pattern mesher, tee object
tools/                texture builder + headless screenshot scripts
```
