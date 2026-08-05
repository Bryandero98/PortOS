# Three.js Models

The Create → Three.js Models workspace turns one generated-gallery PNG into a
procedural Three.js scene with:

- an explicit AI provider/model choice per generation or refinement;
- a validated, bounded JSON scene spec rather than model-authored executable
  JavaScript;
- a live in-browser orbit/zoom preview using PortOS's existing Three.js stack,
  with explode-to-disassemble and click-to-identify part picking;
- deterministic download/copy of a standalone `THREE.Group` factory;
- gallery-image lineage, run attribution, detail inventory, and honest
  single-view limitations.

## Why this is native instead of an `img2threejs` dependency

[hoainho/img2threejs](https://github.com/hoainho/img2threejs) is an Apache-2.0
agent skill and staged workflow, not an npm runtime or hosted image-to-mesh API.
PortOS reimplements the useful product contract—detail-first inspection,
procedural construction, animation-ready hierarchy, and refinement—on top of
its own provider runner and existing Three.js dependencies. No upstream scripts
or package are installed or executed.

## Trust boundary

Providers return only the declarative `threejsSculptSpecSchema` contract.
PortOS validates geometry sizes, hierarchy depth, material references, custom
triangle indices, sockets, and detail-inventory references before persisting or
rendering it. The client maps that allowlist to Three.js primitives and bounded
`BufferGeometry`; it never evaluates provider-written JavaScript. Exported
source is produced deterministically from the validated spec.

## Disassembly and part picking

The preview's Explode slider separates the assembly and clicking any surface
names the part it belongs to, highlighting that whole component. This is the
only *structural* check that a model was actually built from parts rather than
fused into one shape — every other check scores pixels.

Separation is a layout **scale about the model centre** plus a base clearance,
never a uniform outward push: displacing every part the same distance slides the
arrangement without opening a gap between neighbours, so parts that touched
would still touch. The camera re-frames to the disassembly's measured size.

Explode and the picker share one definition of "a part"
(`client/src/lib/threejsExplode.js`) — if they disagreed, both would be wrong:

- `explodeWithParent: true` marks **surface relief** — serrations, stria, trim,
  engraving, port floors: detail that belongs *to* a part rather than being one.
  It rides its parent when the model comes apart, and a click on it selects the
  parent, so a disassembly does not shatter into a comb of loose slivers.
  Generation prompts instruct the provider to set it; it defaults to `false`.
- Every other part carrying geometry is both a movable unit and a selectable
  component. A part whose children carry the geometry is additionally descended
  through, so those children separate too; a part with geometry *and*
  geometry-bearing children moves its own shell while its children move freely.

The exported standalone factory carries the same information —
`buildThreejsFactorySource()` writes `partId` and `explodeWithParent` into each
node's `userData` — so a consumer outside PortOS can build the same disassembly.

## Geometry vocabulary

Alongside the primitives (box, sphere, cylinder, cone, torus, capsule, lathe)
and the bounded `custom` triangle mesh, the schema carries two constructive
forms so silhouette-defining shapes don't have to degrade into a coarse mesh:

- `extrude` — a closed 2D outline (3–160 points) with optional hole rings,
  swept to `depth` with optional bevel. Every ring must enclose real area and
  be simple (a self-crossing ring has no defined interior, and its lobes partly
  cancel so the area test alone does not catch it); each hole must lie strictly
  inside the outline (point-in-polygon on every vertex
  plus an edge sweep, since a concave outline's bounding box covers empty space
  its notch does not); and holes may not touch, cross, or nest. Each of those
  cases triangulates into an empty face, a disjoint face, or solid material
  inside a requested cutout rather than failing, so they are rejected up front.
- `tube` — a round profile of `radius` swept along a 2–96 point Catmull-Rom
  path. Consecutive points must differ and a `closed` path must not repeat its
  first point, because either produces NaN frames in the centripetal/chordal
  parameterizations. A `closed` path also needs three non-collinear points —
  fewer, or a straight line, closes into a curve that runs out and retraces
  itself, overlapping the tube with its own surface.

`type: "physical"` materials additionally carry bounded `ior`, `transmission`,
`thickness`, `sheen`, `iridescence`, and `anisotropy` for glass, cloth,
pearlescent, and brushed-metal finishes. Those channels are parsed for every
material type so a spec round-trips unchanged, but only forwarded to Three.js
for physical materials. `client/src/lib/threejsSculpt.js` mirrors the geometry
and material construction the exported factory emits, so the preview and the
downloaded source render the same scene.

## Provider behavior

API providers receive the gallery image as a multimodal image attachment. CLI
and TUI providers receive the gallery file path in the prompt so agents with
native image inspection can read it. A chosen provider/model still needs image
understanding; a text-only model will fail validation or produce a poor
reconstruction and can be replaced from the refinement controls.

Generation is always an explicit user action. Startup only marks a previously
in-flight run as interrupted and retryable; it never calls a provider.
