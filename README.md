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
| `src/app.js` | UI wiring, legend rendering, PNG export |

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
   garments sit in the skin gamut and only texture tells knit from arm. Sobel
   edges are the supporting cue: they make the cut land on the real
   neckline/cuff/hem and stop the garment bleeding into hair or trousers. The
   largest surviving component is the garment. If that comes out under 10% of
   the person, the detector has eaten a skin-toned garment, so it falls back to
   the whole subject and returns a `warning`.

2. **Identification** (PRD 6.3) — k-means with `k = X` on `(a, b, λ·hp)`, where
   `hp = L − localMeanL`. Chrominance alone is lighting-invariant but cannot
   separate tone-on-tone colours — gold yarn against a brown pattern, grey
   against charcoal — which differ almost entirely in lightness. Subtracting a
   *local* mean strips the smooth lighting gradient while keeping
   high-frequency pattern contrast, so both properties hold at once. `λ = 0`
   (`HP_WEIGHT`) reduces to chrominance-only, and on a solid-colour garment
   `hp ≈ 0` everywhere. Seeding is k-means++ with a fixed seed, so the same
   photo and X always give the same regions.

3. **Cleanup** (PRD 6.4) — a majority filter over the label map (the
   multi-label equivalent of morphological opening/closing; unlike per-mask
   morphology it can't leave gaps or overlaps), then components below a minimum
   area are absorbed into whichever label surrounds them, decided by a single
   vote of each component's boundary neighbours. Growing a fill front instead
   biases toward whichever direction it scans first and leaves rectilinear
   staircase edges. Both the window and the area floor are kept deliberately
   small: anything coarser erases fine patterns such as lace holes rather than
   cleaning them.

4. **Recolor** (PRD 6.6) — the a/b channels are replaced with the target colour,
   scaled by how saturated that pixel was relative to its region so it isn't a
   flat fill. Lightness is **rescaled, not shifted**: diffuse shading is
   reflectance × illumination, so preserving each pixel's luminance *ratio* to
   the region anchor swaps the dye and leaves the lighting alone. Folds, shadows
   and stitching survive, and the shading spread scales with the pick — narrow
   for a dark colour, wide for a pale one. Regions the user didn't change stay
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

## Known limits (PRD 10)

- On model, only the largest clothing item is recolored; skin-toned garments
  (beige, camel) are the hard case — texture carries the discrimination, but a
  *smooth* fabric in a skin tone stays genuinely ambiguous to a non-AI method.
  Long hair over the shoulders against a similar-toned top can also merge, and
  skin visible through an open-knit neckline will partly survive.
- Busy prints, florals and gradients won't reduce to K flat regions.
- A garment colour very close to the background is the hardest case for
  isolation; the threshold retry helps but isn't a guarantee.
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
separable/linear, so the step after that would be moving analysis to a Worker.
