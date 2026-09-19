# Recolor

Deterministic, per-region clothing recolor using classical CV. No model, no API
calls, no backend — everything runs in the browser and images never leave the
device. See [prd.md](prd.md) for the full spec.

## Running it

Static files with no build step and no dependencies, but ES modules need to be
served over HTTP (opening `index.html` from disk won't work):

```bash
python -m http.server 5173
```

Then open http://localhost:5173. Deploying is just uploading the directory to
any static host.

## Layout

| File | What's in it |
|---|---|
| `index.html` | The three screens: upload, edit, result |
| `styles.css` | All styling |
| `src/color.js` | sRGB ↔ CIE Lab (D65) and hex helpers |
| `src/pipeline.js` | The CV pipeline — isolation, clustering, cleanup, recolor |
| `src/feather.js` | Edge-aware alpha for the garment mask, and edge foreground colour |
| `src/store.js` | Central store: state, reducer, `subscribe`/`dispatch`, `watch` |
| `src/cv-service.js` | CV observers (analysis, recolor) and the worker client |
| `src/cv.worker.js` | Web Worker that runs the pipeline off the main thread |
| `src/cv-session.js` | Keeps one photo's analysis between analyze and recolor calls |
| `src/color-editor.js` | Swatch rows; every edit dispatches `UPDATE_TARGET` |
| `src/canvas-renderer.js` | Paints `renderBuffer` to the preview canvas |
| `src/app.js` | Bootstrapping, screens, upload, legend rendering, PNG export |

## State and data flow

The UI and the CV math never call each other. All state lives in one store
(`src/store.js`); components subscribe to the slice they care about and
dispatch results back:

| Observer | Watches | Does | Dispatches |
|---|---|---|---|
| CV analysis | `rawImage` | Forward Lab, isolation, clustering (in the worker) | `ANALYSIS_COMPLETE` |
| CV recolor | `targets` | Pixel swap + inverse Lab over the existing mask (in the worker) | `RENDER_BUFFER_READY` |
| Color editor | `sourceSwatches` | Builds a row per detected colour | `UPDATE_TARGET` |
| Canvas renderer | `renderBuffer` | `putImageData` to the preview canvas | — |

State: `rawImage`, `maskData` (feathered garment alpha), `sourceSwatches`,
`targetHex` (the most recent pick) and `renderBuffer`, plus:

- `targets` — one pick per swatch. Regions recolor independently, so a single
  `targetHex` isn't enough to render from; `UPDATE_TARGET` takes
  `{ index, hex }` and sets both. Recolor watches `targets` rather than
  `targetHex`, since the same hex picked for a second region must still render.
- `settings` (`{ k, onModel }`, via `SET_OPTIONS`), `analysisMeta` (per-swatch
  share and the isolation warning), `status` and `error` (`PIPELINE_ERROR`).

The label map and per-region anchors that recolor needs stay inside the worker
(`cv-session.js`) — the store only ever holds what the UI renders. Each new
photo bumps a generation counter, so results for a replaced photo are dropped,
and recolor keeps at most one request in flight, coalescing a colour-picker
drag into a single rerun with the latest picks. If a module worker can't be
started, the same session runs on the main thread.

## How the pipeline works

`analyze(imageData, k)` → `recolor(imageData, analysis, hexes)`.

1. **Isolation** (PRD 6.2) — median Lab of a border band estimates the
   background, then a flood fill inward from the frame edge marks everything
   close to it. Flood filling rather than plain thresholding means dark areas
   *inside* the garment aren't mistaken for background. Otsu picks the
   threshold; if the fill leaks through a garment colour close to the
   background, tighter thresholds are retried. Then open/close and keep the
   largest component.

   In **on-model** mode the result of that is the *person*, and the model is
   then cut away. Skin classification does the removing — hue in the Lab a/b
   plane (permissive on lightness, since across skin tones melanin moves L and
   chroma far more than hue) combined with smoothness, because beige and camel
   garments sit in the skin gamut and only texture tells knit from arm. The
   person's skin tone is estimated from large connected skin areas only, and
   small patches are dropped from the final skin mask: real skin forms a few
   big regions (face, neck, hands), while skin-toned false positives on fabric
   are scattered, and letting them into the estimate drags it toward the
   garment. Sobel edges are the supporting cue: they make the cut land on the
   real neckline/cuff/hem and stop the garment bleeding into hair or trousers.
   A knit's own stitch gradients can dice it into confetti, though, so if the
   largest piece left after the edge cut is under 40% of what the cut kept, the
   cut is dropped and the garment is separated on skin alone. The largest
   surviving component is the garment. If that comes out under 10% of the
   person, it falls back to the largest non-skin component — never the whole
   subject, which would recolor the model — and returns a `warning`.

2. **Identification** (PRD 6.3) — k-means with `k = X` on chrominance `(a, b)`
   only, which is lighting-invariant. Seeding is k-means++ with a fixed seed,
   so the same photo and X always give the same regions.

   The clusterer also accepts a third feature, `λ·hp` with
   `hp = L − localMeanL` (`HP_WEIGHT` in `src/pipeline.js`), meant to separate
   tone-on-tone colours — gold yarn against a brown pattern, grey against
   charcoal — that differ almost entirely in lightness. It is set to `λ = 0`:
   at 0.8 it pulled skin into the garment's main cluster on real photos, so
   faces and necks got recolored, and pattern separation got worse rather than
   better. Raise it only with a side-by-side render showing it helps.

3. **Cleanup** (PRD 6.4) — a majority filter over the label map (the
   multi-label equivalent of morphological opening/closing; unlike per-mask
   morphology it can't leave gaps or overlaps), then components below a minimum
   area are absorbed into whichever label surrounds them, decided by a single
   vote of each component's boundary neighbours. Growing a fill front instead
   biases toward whichever direction it scans first and leaves rectilinear
   staircase edges. Both the window and the area floor are kept deliberately
   small: anything coarser erases fine patterns such as lace holes rather than
   cleaning them.

4. **Edge feathering** — the binary garment mask is turned into a soft alpha
   that follows the photo's colour edge instead of the mask's pixel staircase,
   and the garment's own colour is estimated at partially covered edge pixels.
   Labels are extended outward to every pixel the alpha reaches. See
   [Edge feathering](#edge-feathering) for how the method was chosen.

5. **Recolor** (PRD 6.6) — the a/b channels are replaced with the target colour,
   scaled by how saturated that pixel was relative to its region so it isn't a
   flat fill. Lightness is **rescaled, not shifted**: diffuse shading is
   reflectance × illumination, so preserving each pixel's luminance *ratio* to
   the region anchor swaps the dye and leaves the lighting alone. Folds, shadows
   and stitching survive, and the shading spread scales with the pick — narrow
   for a dark colour, wide for a pale one. Edge pixels are recolored from their
   estimated garment colour and blended over the photo by alpha, so the
   background doesn't tint the new colour. Regions the user didn't change stay
   bit-identical.

Everything runs at a working resolution capped at 1600px on the long edge
(`MAX_EDGE` in `src/pipeline.js`), which is also the output size. Analysis and
pixels therefore share one coordinate space — no label upsampling, no blocky
region edges.

### One deliberate deviation from the PRD

PRD 6.6 says to leave each pixel's L "unchanged." Taken literally, recoloring a
black garment to yellow keeps it black, which contradicts the headline promise
of returning *those exact values*. So lightness is remapped — but which pixel
should come out as exactly the picked colour, and how the rest should follow,
both matter:

- **Anchor.** The pick is matched at the region's `SURFACE_PERCENTILE` (75th) of
  lightness, not its median. Lightness constancy means people read a surface's
  colour from its lit areas and discount shadow, so anchoring on the median made
  every pick land visibly lighter than asked for. The same statistic drives the
  detected swatch, so the round trip stays exact.
- **Shape.** `newY = Y(target) × (Y(pixel) / Y(anchor))`, i.e. proportional in
  luminance rather than an additive shift of L\*. An additive shift held the
  spread constant no matter how dark the pick was, leaving highlights ~14 L\*
  above a dark pick.

Measured on the sample photo: the lit surface reproduces the pick to within
0.33 L\* across picks from `#1C2A52` to `#E8E2D5`, and highlight overshoot fell
from a flat +13.8 L\* to +2.7 (dark picks) through +8.3 (near-white).

Known gap: specular highlights are physically *additive*, so scaling luminance
compresses them too — satin and sequins lose some sparkle, and very pale picks
can hit the L\*=100 rail (7.3% of pixels for `#E8E2D5`). A highlight roll-off
would fix both.

## Edge feathering

Issue #4. The garment mask used to be feathered with a 3×3 box blur, which left
a staircase edge and a pale rim of the original colour along the outline, and —
because `recolor` skipped every pixel outside the binary mask — threw away the
outer half of the feather entirely. Six standard filters and a set of
combinations were benchmarked to replace it; the winner is in `src/feather.js`.

### How it was measured

Real photos have no ground-truth alpha, so the benchmark used synthetic garment
photos with a known one: real knit and gold/brown pattern crops from the sample
photo, composited with edges rendered at 4× and box-downsampled (true coverage
fractions, including sub-pixel stray fibres). Nine scenes: clean edge, fuzzy
fibres, pattern (X=2), soft defocused edge, drop shadow, beige on a pale wall,
on-model with skin at the neckline and sleeves, the fuzzy scene at 1600×1600,
and a deliberately wrong mask (bites out of the edge and bulges into the
background, some deeper than any filter's reach).

The real pipeline produced each mask; each filter feathered it; the result was
recolored to two palettes and compared against recoloring the true foreground
with the true alpha. The headline metric is the mean ΔE of that composite in a
10 px band around the edge — the halo a user actually sees — relative to the
old 3×3 blur and averaged over scenes (lower is better; 1.0 = old behaviour).
Alpha error and gradient error (jaggedness) were tracked alongside, and every
candidate was also checked by eye on the sample photo.

### The six filters, best setting of each

Scored over the first eight scenes (the wrong-mask scene was added later).

| Rank | Filter | Halo vs old | Time at 1600² | Notes |
|---|---|---|---|---|
| 1 | Bilateral (joint, r=5, σs=2.5, σr=5 ΔE) | 0.723 | 5.1 s | Best by a hair; far too slow brute-force |
| 2 | Guided filter (Lab colour guide, r=4, ε=1e-4) | 0.727 | 0.55 s | Best practical single filter. A grey (L only) guide scored 0.956 — chroma matters |
| 3 | Kuwahara (quadrant chosen by photo variance, r=2) | 0.803 | 0.40 s | Plain Kuwahara on a 0/1 mask returns the mask |
| 4 | Anisotropic diffusion (Perona–Malik, 15 it, K=5) | 0.806 | 0.30 s | Very sensitive to K; K=20 was worse than the old blur |
| 5 | Domain transform (recursive, σs=3, σr=10) | 0.821 | 0.90 s | Barely beats no filter |
| 6 | Median (r=1) | 0.842 | 0.04 s | On a 0/1 mask it's a majority vote: no feathering at all |

For reference, the unfeathered binary mask — once labels extend outward —
scores 0.826: the old blur was worse than doing nothing, largely because its
outer half was discarded. Timings are for straightforward implementations, not
tuned ones.

### Combinations

Same eight scenes as above, so the numbers compare directly; the wrong-mask
scene is covered in the per-scene table below.

| Candidate | Halo vs old | Verdict |
|---|---|---|
| **Trimap guided + R² gate + inside median + decontamination** | **0.362** | Shipped. Improves every scene |
| Same, without the gate | 0.359 | Marginally better score, but smears where the mask is wrong (below) |
| Perfect binary mask (oracle) | 0.505 | Beaten by the shipped method |
| Trimap guided alone (no decontamination) | 0.645 | |
| Guided filter limited to a band around the outline | 0.642 | Band-limiting helps every filter |
| Domain transform → guided filter | 0.771 | No gain over guided alone |
| Side-window guided (Kuwahara's window choice on guided coefficients) | 0.825 | Collapses to binary: one-sided windows fit a 0/1 mask perfectly |
| Signed-distance anti-aliasing → guided filter | 0.872 | Pre-blurring the mask gives the regression wrong labels to fit |
| Confidence-weighted guided filter (alone) | 0.853 | Only pays off inside the trimap version |
| Local colour-line matting (alone) | 0.867 | Per-pixel, too noisy on knit texture |
| Two-sided 3×3 median after feathering | 0.504 | Erases real fibres along with the speckle |

Per scene, the shipped method against the old blur (mean halo ΔE in the band):

| Scene | Old | Shipped | Change |
|---|---|---|---|
| Clean knit edge | 1.35 | 0.46 | −66% |
| Fuzzy fibres | 2.38 | 0.56 | −77% |
| Pattern, X=2 | 1.68 | 0.68 | −60% |
| Soft defocused edge | 2.00 | 0.45 | −78% |
| Drop shadow | 4.47 | 3.75 | −16% |
| Beige on pale wall | 2.05 | 0.46 | −78% |
| On-model (skin) | 2.43 | 0.86 | −65% |
| Fuzzy, 1600×1600 | 2.87 | 0.78 | −73% |
| Wrong mask | 8.84 | 8.00 | −9% |

Gradient error (jaggedness) fell 66%, and the unrecolored rim along the edge
roughly halved in every scene. Drop shadow and wrong mask barely move because
their error is in the mask itself — several pixels off — which no edge filter
can reach.

### What the shipped method does

Each piece comes from a different family:

- **Trimap guided filter** (guided filter + matting's trimap). The guided
  filter fits a local linear colour → alpha model per window, but fits it to
  the *mask's* labels — which are wrong exactly on the outline. Here each window
  learns only from confident pixels (more than 2 px from the outline) and then
  applies the model to the uncertain ones. On a test edge it recovers the exact
  coverage even with the mask a pixel off either way, where the plain guided
  filter leaves a 9–34% smear.
- **Explained-variance weighting** (Kuwahara's "trust the informative window",
  made soft). Windows are averaged in proportion to how much of the mask their
  colour model explains, so windows straddling a real colour edge dominate.
  Worth 0.879 → 0.712 inside the trimap filter.
- **R² gate.** Where no window's colour model explains the outline — the mask
  stopped short inside the garment, say — alpha falls back to the mask. Without
  it, the sample photo's sleeve (where the mask ends ~20 px short) gets a
  translucent blue-grey smear. The metric slightly prefers no gate, since a
  half-recolored smear is numerically closer to "fully recolored" than an
  untouched patch, but it looks clearly worse.
- **Inside-only 3×3 median.** Bright stitch highlights resemble skin and put
  speckle just inside the edge; a median that only raises alpha, and only
  inside the mask, removes it while leaving fibres outside intact.
- **Foreground decontamination.** Even a perfect alpha leaves a floor (0.33)
  because a 40%-wall pixel was recolored from its washed-out mixed colour.
  Solving `I = αF + (1−α)B` for F, with B the local background mean, removes
  that floor. It's the single largest gain, and only works on top of an
  accurate alpha: on the old blur it's worth 0.98 → 0.88, on the binary mask
  nothing.

The fit runs at half resolution (the coefficient maps are smooth; this scored
the same as full resolution) and alpha is only re-evaluated within 6 px of the
outline. That took the method from 1.6 s to ~0.3–0.4 s at 1600×1600.

### Costs and limits

- Analysis is roughly 30–50% slower: ~110–150 ms more on the sample photo and
  ~380 ms more at 1600×1600. It runs in the Web Worker, so the page doesn't
  block. The next step would be computing the foreground estimate only for edge
  pixels inside `recolor`, and skipping regions far from the outline.
- It fixes the edge, not the mask. A mask that swallows a drop shadow, or stops
  well short of the true edge, is an isolation problem.
- Region boundaries *inside* the garment, between two detected colours, are
  untouched — that's issue #6.

## Known limits (PRD 10)

- On model, only the largest clothing item is recolored; skin-toned garments
  (beige, camel) are the hard case — texture carries the discrimination, but a
  *smooth* fabric in a skin tone stays genuinely ambiguous to a non-AI method.
  Long hair over the shoulders against a similar-toned top can also merge, and
  skin visible through an open-knit neckline will partly survive.
- Tone-on-tone colours (same hue, different lightness) won't separate, since
  clustering is chrominance-only — see `HP_WEIGHT` above.
- Busy prints, florals and gradients won't reduce to K flat regions.
- A garment colour very close to the background is the hardest case for
  isolation; the threshold retry helps but isn't a guarantee.
- Edge feathering refines an outline that's already close. A drop shadow
  swallowed into the mask, or a mask that stops well short of the garment's
  edge, stays as it is (feathering falls back to the hard mask there).
- Asking for more colors than the garment has will split one dye into near
  identical swatches. The per-swatch "% of garment" figures make that visible —
  re-run with a lower X.

## Performance

Measured in-browser on a striped test garment, analysis + recolor end to end,
**before** on-model support was added:

| Working size | X | Total |
|---|---|---|
| 990k px | 2 | ~640 ms |
| 2.1M px | 4 | ~1.3 s |
| 2.6M px (square worst case) | 4 | ~1.6 s |

On-model mode adds a Sobel pass, a box mean, extra morphology and component
labeling, so it will be slower than the above and needs re-measuring against the
PRD's 2 s budget. If it overruns, lower `MAX_EDGE` for the on-model path only.
The majority filter and the flood fill dominate; both are already
separable/linear. Edge feathering adds roughly 30–50% on top (see
[Edge feathering](#edge-feathering)). Analysis and recolor run in a Web Worker,
so these times no longer block the UI, though they still bound how quickly
results arrive.
