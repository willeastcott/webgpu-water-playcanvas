# WebGL Water — PlayCanvas port

A port of [Evan Wallace's WebGL Water](http://madebyevan.com/webgl-water/) (2011)
to the [PlayCanvas Engine](https://playcanvas.com/). It reproduces the original
demo's rendering and physics:

- GPU **heightfield water simulation** (ping-pong float render targets)
- Real-time **caustics** via the differential-area method
- **Raytraced reflection & refraction** with a Fresnel blend and sky cubemap
- A **draggable sphere** that displaces the water, with optional buoyancy physics
- **Analytic ambient occlusion** and soft caustic shadows

## Running

```bash
npm install
npm run dev      # start the Vite dev server
npm run build    # production build into dist/
```

Then open the printed local URL.

## Controls

- **Draw on the water** to make ripples
- **Drag the background** to rotate the camera
- **Drag the sphere** to move it around
- **SPACEBAR** to pause / unpause
- **G** to toggle gravity (sphere physics)
- **L** (hold) to point the light along the camera direction

## How it maps onto PlayCanvas

| Original (`lightgl.js`)            | This port                                                            |
| ---------------------------------- | -------------------------------------------------------------------- |
| `GL.Texture` float RTs + `drawTo`  | `pc.Texture` (RGBA32F/16F) + `pc.RenderTarget`, ping-pong swap       |
| Full-screen sim passes             | `pc.ShaderUtils.createShader` + `pc.drawQuadWithShader` in `update`  |
| Caustics into a 1024² texture      | dedicated camera + layer → double-buffered RTs (projected mesh)      |
| `GL.Shader` / inline GLSL          | `pc.ShaderMaterial` with custom GLSL **and** WGSL (no transpilation) |
| `GL.Mesh.plane/sphere/cube`        | hand-built `pc.Mesh` matching the original vertex layouts            |
| matrix stack + `GL.Raytracer`      | orbit camera entity + `camera.screenToWorld` ray picking            |

The shaders are ported almost verbatim (see `src/shaders/`). The only changes
are renaming engine-reserved identifiers and using PlayCanvas's built-in
attribute/uniform names (`aPosition`, `matrix_viewProjection`). Both cameras run
with `GAMMA_NONE` / `TONEMAP_NONE` so colors match the original's raw output.

## WebGPU and WebGL 2

Runs on **WebGPU** (preferred) and falls back to **WebGL 2**. Every shader is
written in both GLSL (`src/shaders/*.glsl.js`, used on WebGL 2) and WGSL
(`src/shaders/*.wgsl.js`, used directly on WebGPU) — so there is no runtime
GLSL→WGSL transpilation and no glslang/twgsl WASM dependency. Two
WebGPU-specific considerations are baked into the shaders and renderer (both
also valid on WebGL 2):

- **Explicit-LOD sampling** (`textureSampleLevel` in WGSL / `texture2DLod` in
  GLSL) for every texture fetch the ray tracer makes from non-uniform control
  flow — WGSL forbids implicit-derivative sampling there. The pool tiles
  therefore sample at LOD 0 (no mip filtering).
- **Double-buffered caustics**: the caustics map is written to one render target
  while the scene samples the previous frame's, avoiding a same-frame
  read/write of one texture (which WebGPU rejects). A one-frame-old caustics map
  is imperceptible.

## Credits

- Original WebGL Water and the caustics technique by
  [Evan Wallace](http://madebyevan.com/). MIT licensed — see `LICENSE`.
- Tile texture from [zooboing](http://www.flickr.com/photos/zooboing/3682834083/) on Flickr.
