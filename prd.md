# PRD: Clothing Recolor Tool (working title)



**Author:** Tanya Nair

**Status:** Draft v1

**Last updated:** July 25, 2026



---



## 1. Problem & Opportunity



Every existing clothing-recolor tool (Photoroom Recolor, Pixelcut, Claid.ai, iFoto, YouCam Perfect/Makeup) is AI-generative. They work by prompting a diffusion model to reimagine the garment in a new color, which means:



- Non-deterministic output (same input can yield different results run to run)

- No user control over exact target colors, only text prompts ("make it navy")

- API/inference cost per generation, which limits free usage and adds latency

- No structured output like exact hex codes per region



There is no productized tool that takes a garment photo plus a set of user-specified hex codes and returns a deterministic, per-region recolor with those exact values, using classical computer vision instead of a model. That's the gap this product fills.



## 2. Goals



- Deterministically identify up to X distinct color/pattern regions in a garment photo

- Let the user assign a new color to each region via a color picker

- Recolor the garment while preserving fabric texture, folds, and shading

- Output an edited image with hex codes labeled in the corner, downloadable

- Do all of this with classical CV (no neural networks, no external API calls, no inference cost)

- Keep the UI minimal: upload, pick colors, download. Nothing else.



## 3. Non-Goals



- Not attempting to handle complex photographic patterns (florals, tie-dye, photo-realistic prints) in v1

- Not attempting on-model (worn) photos with complex backgrounds in v1

- Not building a mobile app in v1 (web only)

- Not attempting to add new patterns or textures, only recoloring what's already there

- Not a general-purpose photo editor



## 4. Target User & Use Case



Primary use case: a designer, small apparel brand, or hobbyist wants to preview colorway variants of a garment they already photographed, without a reshoot and without paying per-generation AI credits. Secondary use case: personal styling (e.g., "what would this shirt look like in green instead of black").



## 5. Core User Flow



1. User uploads a photo of a piece of clothing (flat-lay or product shot recommended)

2. User specifies X, the number of distinct colors/regions to identify

3. App processes the image and identifies X color regions, returning their hex codes

4. App displays a color picker per identified region, pre-filled with the detected hex code

5. User adjusts one or more colors using the picker

6. User confirms; app shows a brief "Remaking file..." processing state

7. App displays the edited image, with new hex codes labeled in a corner

8. User downloads the result



## 6. Functional Requirements



### 6.1 Input handling

- Accept JPG/PNG upload (drag-and-drop and file picker)

- Basic validation: file type, max size (recommend 10MB cap for v1), minimum resolution warning

- Numeric input for X (number of colors), capped at 4 for v1



### 6.2 Garment isolation (background removal)

- Assume flat-lay or product-style photo on a relatively uniform background (this constraint should be stated to the user up front, e.g. "for best results, photograph on a plain background")

- Sample border/corner pixels to estimate background color

- Isolate garment via GrabCut seeded with an auto-generated bounding box (inner ~80% of frame), or a simpler color-distance threshold from the sampled background color for cleaner cases

- Output: a binary garment mask separating foreground (clothing) from background



### 6.3 Color/pattern identification

- Convert garment pixels to Lab color space (perceptually uniform, better clustering behavior than RGB)

- **Cluster on chrominance only (a, b), excluding L (lightness) from the distance metric.** This is the key decision for making pattern recognition lighting-invariant: a shadowed fold and a lit fold of the same physical color have very different L values but nearly identical a/b, so dropping L from clustering prevents shadows and highlights from being misread as separate colors or splitting a single true color into extra clusters. Run K-means with k = X on the (a, b) pairs within the garment mask.

- Cluster centroids (in a/b) become the identified hex codes, using each cluster's median L (not lightness-clustered, just used to render a representative, presentable hex value)

- Per-pixel cluster assignment becomes the per-region mask (this is how a striped or checked pattern naturally separates into distinct masks, no explicit pattern-type detection needed)

- Note: this only affects *identification*. The recolor engine in 6.6 still uses each pixel's own original L value to preserve texture and shading, that's a separate, intentional use of lightness and isn't affected by this change.



### 6.4 Mask cleanup

- Apply morphological opening/closing to remove speckle noise from clustering artifacts (fabric shading fragments naive per-pixel clusters)

- Apply connected-component filtering to drop tiny, likely-noise regions below a minimum area threshold



### 6.5 Color picker & editing UI

- Display X swatches, each showing the detected hex code

- Standard color picker per swatch (hex input + visual picker)

- Live preview optional for v2; v1 can apply on confirm



### 6.6 Recolor engine

- For each region mask, preserve the original L (lightness) channel per pixel unchanged, this retains folds, shadows, highlights, and stitching detail

  > **Amended after v1 user testing.** Taken literally this makes the picked colour a no-op on dark garments. Lightness is instead rescaled proportionally in luminance (`newY = Y(target) × Y(pixel) / Y(anchor)`), anchored at the 75th lightness percentile rather than the median. Users reported picks rendering lighter than chosen: an additive shift held the shading spread constant regardless of how dark the pick was, and anchoring on the median put the pick below the lit areas that people actually read as the garment's colour. See README, "One deliberate deviation from the PRD."

- Replace a/b channels with the target hex's Lab a/b values (scaled to preserve local lightness variation ratio rather than flat-filling)

- Convert back to RGB and composite into the full image



### 6.7 Processing state UI

- Show a short "Remaking file..." message during processing

- Given the compute is classical CV on a single image (not a model inference call), actual processing should take well under 2 seconds; the message is a UX pacing choice, not a technical necessity, and should be brief



### 6.8 Output & export

- Display the final edited image

- Hex codes are shown as an in-image legend (not per-region corner labels), since a legend stays readable regardless of region size or count

- Checkbox toggle, "Show hex legend," on by default, lets the user turn the legend on/off before download

- Export format: PNG only for v1



## 7. Non-Functional Requirements



- **Privacy**: images should never need to leave the user's device. This is achievable because all processing described above can run client-side.

- **Performance**: full pipeline (segmentation + clustering + recolor + composite) should complete in under 2 seconds on a typical garment photo (under ~3000px on the long edge).

- **Simplicity**: no account creation, no onboarding flow, no settings beyond what's needed for the core flow. Three screens: upload, edit, result.

- **Elegance**: minimal color palette, generous whitespace, no visual clutter. The app's own UI should not compete visually with the garment photo being edited.



## 8. Technical Architecture & Framework Choice



**Recommendation: fully client-side web app, no backend required for v1.**



| Layer | Choice | Why |

|---|---|---|

| UI framework | Svelte | Compiles away at build time, near-zero runtime overhead, small bundle. Matches the "simplicity" design goal both visually and architecturally. Vanilla JS is an option if you want to skip a framework entirely; Svelte is recommended mainly for maintainability as the app grows past three screens. |

| Image processing | OpenCV.js (WASM build of OpenCV) | Gives you `cv.kmeans`, `cv.grabCut`, `cv.cvtColor` (RGB↔Lab), and morphology ops, all running in-browser. This is the classical-CV equivalent of what the AI competitors do with a model, without server cost or latency. |

| Rendering/compositing | HTML5 Canvas | Native, fast, no dependency needed for pixel manipulation and text overlay |

| Hosting | Static site (no backend) | Since processing is client-side, hosting is just static files. Removes server cost and infra complexity entirely. |



**If performance becomes a bottleneck later** (very large images, high X values, or a future batch-processing feature): consider a Rust-to-WASM module for the clustering step specifically, since that's the most compute-heavy part. Not needed for v1.



## 9. Conditions for Best Results (communicate to user)



- Plain or simple background (flat-lay or product-style photo)

- Reasonably even lighting helps background isolation (6.2) find a clean edge; it's no longer required for color identification (6.3), since that step is designed to be lighting-invariant

- Garment fills most of the frame

- Block colors, stripes, or checks work best; busy photographic prints (florals, gradients, tie-dye) will not cluster cleanly into flat regions



## 10. Edge Cases & Known Limitations



- **On-model photos**: skin will need to be excluded from candidate garment colors. A simple heuristic (excluding a skin-tone hue/saturation range from clustering) can help but won't be fully robust in v1; flagging this as a v2 item rather than solving it now is reasonable.

- **Complex patterns**: photographic prints, gradients, and multi-tone dye effects won't reduce cleanly to K flat clusters. The tool should communicate this limitation rather than silently producing a poor result.

- **Low-contrast garment/background**: if the garment color is close to the background color, GrabCut/threshold-based isolation will struggle. Consider a manual "trim" tool as a v2 fallback.

- **Shadows misread as a color region**: strong directional shadows can sometimes form their own cluster. Lab space and lightness-preserving recolor reduce this risk but don't eliminate it.



## 11. Success Metrics



- Segmentation accuracy: garment cleanly isolated from background on ≥90% of test photos meeting the "best results" conditions above

- Color identification accuracy: detected hex codes within a reasonable Delta-E (perceptual color difference) of ground truth on solid/striped test garments

- Processing time: under 2 seconds end-to-end on a standard photo

- Zero server-side image storage (privacy goal met by architecture, not policy)



## 12. Phased Roadmap



**MVP (v1)**

- Upload → detect X colors → edit via picker → recolor → download

- Flat-lay/product photos only

- Client-side only, no backend



**v2**

- On-model photo support with skin-tone exclusion heuristic

- Manual mask correction/trim tool for edge cases

- Live preview while adjusting colors (not just on-confirm)

- Batch processing (multiple photos at once)



**v3 (exploratory)**

- Pattern-type awareness beyond flat color clustering (e.g., handling gradients) while still staying non-AI, likely via frequency-domain/FFT-based periodic pattern detection rather than deep learning



## 13. Decisions Log (v1 scope, locked)



- **X is capped at 4** for v1

- **Color identification clusters on chrominance (a, b) only**, excluding lightness, so shadows/highlights from lighting don't get misread as separate colors

- **Hex codes display as an in-image legend**, toggleable via a "Show hex legend" checkbox (on by default)

- **Export is PNG only** for v1; vector/SVG output for hard-edged regions is a candidate for a later phase, not v1



No open questions remain for v1 scope.