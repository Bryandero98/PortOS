# Three.js Visual Work Skill Template

## Routing
**Use when**: The task explicitly names Three.js, React Three Fiber, R3F, or a WebGL scene.
**Don't use when**: A task merely mentions WebGL availability, browser capabilities, or a non-scene graphics API.

## Task-Specific Guidelines

You are working on a visual scene or model surface. Build the clearest reliable result before adding effects.

### 1. Inspect Before Choosing an API
- Identify the installed renderer, framework version, and the existing component or scene ownership boundary.
- Reuse the app's established scene, asset-loading, controls, and quality-control paths instead of introducing a second renderer or render loop.
- Confirm whether the surface is declarative React Three Fiber, imperative Three.js, or an existing preview pipeline before changing lifecycle code.

### 2. Establish Visual Evidence
- Define the intended silhouette, readable geometry, material response, camera framing, and lighting before optional post-processing or image effects.
- Prefer simple primitives and legible composition while validating the model; add texture, particles, bloom, or other polish only when they support the intended read.
- Make the default camera view communicate the result without requiring hidden controls or an ideal viewport size.

### 3. Preserve Render Ownership and Budget
- Keep one owner for each render loop, canvas lifecycle, and output conversion path. Do not add competing animation loops, render targets, or image-export pipelines.
- Measure or reason about scene cost using the existing render budget and preview-quality controls where they apply; keep mobile and reduced-quality paths functional.
- Dispose or reuse renderer-owned resources according to the surrounding code's lifecycle pattern.

### 4. Verify the Delivered Surface
- Test the narrow scene behavior and its non-visual integration points.
- Where the project has an existing visual-preview or render-budget check, use it and record the observable result (silhouette, framing, material, and performance behavior).
- Keep fallbacks and existing non-WebGL behavior intact when the renderer is unavailable.
