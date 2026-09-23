# Mascot implementation spec

Handoff for implementing the GitBot mascot on a plain-HTML (non-React) website.
Source of truth is the Figma expression set; this spec tells you how to turn
those files into a working, recolorable, animated mascot. No build step needed.

## 1. Asset inventory

Copy these 11 files as-is (they live in `public/figma-expressions/`):

| Expression   | File            | Canvas (`viewBox`) | Pupils |
| ------------ | --------------- | ------------------ | ------ |
| Neutral      | `Neutral.svg`   | `0 0 217 159`      | 2      |
| Attentive    | `Attentive.svg` | `0 0 217 159`      | 2      |
| Angry        | `Angry.svg`     | `0 0 217 159`      | 2      |
| Confused     | `Confused.svg`  | `0 0 217 159`      | 2      |
| Excited      | `Excited.svg`   | `0 0 235 159`      | 0      |
| Sad          | `Sad.svg`       | `0 0 217 159`      | 2      |
| Shy          | `Shy.svg`       | `0 0 217 159`      | 2      |
| Sleepy       | `Sleepy.svg`    | `0 0 235 166`      | 0      |
| Surprised    | `Suprised.svg`  | `0 0 223 159`      | 2      |
| Suspicious   | `Sus.svg`       | `0 0 217 159`      | 2      |
| Unimpressed  | `Unimpressed.svg` | `0 0 217 159`    | 2      |

Notes:

- The character is a mouthless, long-eared creature. Expression is carried
  **only** by eye/pupil geometry (plus tuft shape on Excited / Sleepy /
  Surprised). Never add a mouth.
- `Design/Mascots/Group 53–59.svg` is an older, different art set — ignore it.
  This spec covers only the `figma-expressions` set (the one wired into the UI).
- `Suprised.svg` is missing an "r" in the filename (upstream typo). Either keep
  the filename or rename to `Surprised.svg` — but the expression name in UI and
  code is spelled **"surprised"**.

## 2. SVG structure contract

Every file follows the same layer pattern:

1. **Body group** — 1 silhouette path + 4 cheek-tuft paths, all `fill="black"`
   in the source. (Excited / Sleepy / Surprised have their own tuft shapes and
   a shifted body offset — see §5. Sleepy has 2 extra black paths: the "Z"
   sleep marks above the head. They are body-colored like the tufts.)
2. **Eyes** — white-filled paths (`fill="white"`), always exactly 2, always the
   only white-filled paths in the file.
3. **Pupils** — black `<ellipse>` elements, 0 or 2 (never 1). Excited and Sleepy
   have none (happy arcs / closed lids).

To make the files usable, convert each one to this shape (mechanical edit):

```html
<svg viewBox="..." role="img" aria-label="...">
  <g class="mascot-idle">
    <g class="mascot-ears"><!-- silhouette path --></g>
    <g class="mascot-tuft-left"><!-- 2 left tuft paths --></g>
    <g class="mascot-tuft-right"><!-- 2 right tuft paths --></g>
    <g class="mascot-eyes">
      <g><!-- left white eye path + left pupil ellipse --></g>
      <g><!-- right white eye path + right pupil ellipse --></g>
    </g>
  </g>
</svg>
```

- Order within a file is: silhouette, tufts, then eyes/pupils interleaved
  (left eye, left pupil, right eye, right pupil). "Left" = smaller x.
- Class names above match the motion CSS in §6. Keep them exactly.

## 3. Recolor contract

In the source everything structural is black. Recolor with two CSS rules —
one variable drives the whole mascot:

```css
.mascot { --mascot-body: #fece00; } /* per-bot brand color, see §7 */
.mascot-ears path,
.mascot-tuft-left path,
.mascot-tuft-right path { fill: var(--mascot-body); }
.mascot-eyes path { fill: #fff; }              /* eye whites always stay white */
.mascot-eyes ellipse { fill: #24211f; }        /* pupils always stay dark ink */
```

Rules (from `BRANDING.md`, non-negotiable):

- The mascot **body** carries the bot's brand color. Eyes stay white, pupils
  stay `#24211f` — in every theme, light and dark.
- No tile, box, or background shape behind the mascot. It floats free with a
  soft drop shadow for depth: `filter: drop-shadow(0 3px 8px rgb(0 0 0 / 0.3))`.
- Brand palette (identity colors, never change with theme):

| Token          | Hex     | Use                       |
| -------------- | ------- | ------------------------- |
| `--brand-sun`   | #FECE00 | Primary brand, highlights |
| `--brand-candy` | #FEA1CD | Playful accents           |
| `--brand-ember` | #FF7300 | Energy, active states     |
| `--brand-leaf`  | #31CC66 | Success, online           |
| `--brand-sky`   | #00A3FE | Links, info               |
| `--brand-honey` | #FEA501 | Warnings, pending         |

- Each bot keeps one stable color (assign by stable hash of its id, not
  randomly per render — color is identity and must not shift between loads).

## 4. Pupil geometry reference

`cx, cy, rx, ry`. Left pupil first. Transforms from the source files are
already baked in here (Shy and Unimpressed store the right pupil as an ellipse
plus a reflection matrix — the values below are the rendered positions, so you
can emit plain ellipses with no `transform`).

| Expression  | Left pupil                  | Right pupil                   |
| ----------- | --------------------------- | ----------------------------- |
| Neutral     | 77.5, 106, 7.5, 13.5        | 154.5, 103, 7.5, 13.5         |
| Attentive   | 77.5, 109.5, 7.5, 13.5      | 138.521, 109.5, 7.5, 13.5     |
| Angry       | 77.5, 109.5, 7.5, 13.5      | 138.521, 109.5, 7.5, 13.5     |
| Confused    | 78.5, 96, 7.5, 7            | 153.5, 95, 7.5, 7             |
| Excited     | — (no pupils)               | —                             |
| Sad         | 77.5, 118.5, 7.5, 13.5      | 138.521, 118.5, 7.5, 13.5     |
| Shy         | 79.5, 107.326, 7.5, 11      | 136.5, 106.326, 7.5, 11       |
| Sleepy      | — (no pupils)               | —                             |
| Surprised   | 72.5, 105, 5.5, 7           | 147.5, 105, 5.5, 7            |
| Suspicious  | 80, 112, 6, 9               | 156, 110, 6, 9                |
| Unimpressed | 77.5, 100.5, 7.5, 13.5      | 145.972, 100.5, 7.5, 13.5     |

Deliberate near-duplicates (do not "fix" — they are the Figma design):

- **Angry and Suspicious share identical eye whites**; the expressions differ
  only in pupils.
- **Attentive and Confused share identical eye whites**; they differ only in
  pupils (Confused pupils are small and high).
- Eye-white path data is **not** repeated here — read it from the files. Do
  not redraw the eyes; copy the `d` attributes verbatim.

## 5. Geometry gotchas

1. `Neutral.svg` line 2 contains a stray path with `stroke="black"` and no
   fill (a leftover duplicate of the left-eye outline). **Delete it.** The real
   left eye is the `fill="white"` path on line 8.
2. Only `fill="white"` paths are eyes. Only `<ellipse>` elements are pupils.
   Everything else black-filled is body (including Sleepy's "Z" marks).
3. Eight files share one body on canvas `0 0 217 159` (silhouette starts
   `M48.0002 18.5001`). Three files differ — keep each file's **native**
   viewBox and artwork untouched; do not rescale them onto the 217-wide
   canvas:
   - `Suprised.svg`: canvas `0 0 223 159`, artwork shifted **+2 x**.
   - `Excited.svg`: canvas `0 0 235 159`, artwork shifted **+10 x**, with its
     own spiky tuft shapes (part of the expression).
   - `Sleepy.svg`: canvas `0 0 235 166`, artwork shifted **+10 x, +7 y**, with
     its own tuft shapes plus 2 "Z" marks.
4. Right-tuft paths differ between files by sub-pixel export rounding only
   (e.g. `210.94` vs `210.942`). Interchangeable — when in doubt use Neutral's.
5. If you rebuild pupils from the table in §4, drop the `transform`
   attributes. If you copy elements verbatim from Shy / Unimpressed, keep
   their `transform` attributes — both render identically.

## 6. Motion

Reference implementation: `public/creature-expressions.svg` (animated Neutral).
Calm, deliberate timing: eased gaze shifts and one unified blink. Apply these
classes and keyframes to the converted markup from §2:

```css
.mascot-idle { transform-box: fill-box; transform-origin: center;
  animation: mascot-float 4.8s cubic-bezier(.37,0,.22,1) infinite; }
.mascot-ears { transform-box: fill-box; transform-origin: center bottom;
  animation: mascot-ears 4.8s cubic-bezier(.37,0,.22,1) infinite; }
.mascot-eyes { transform-box: fill-box; transform-origin: center;
  animation: mascot-blink 6.8s linear infinite; }
.mascot-eyes g:first-child ellipse,
.mascot-eyes g:last-child ellipse { transform-box: fill-box; transform-origin: center;
  animation: mascot-gaze 6.8s cubic-bezier(.37,0,.22,1) infinite; }
.mascot-tuft-left { transform-box: fill-box; transform-origin: right center;
  animation: mascot-tuft-left 4.8s ease-in-out infinite; }
.mascot-tuft-right { transform-box: fill-box; transform-origin: left center;
  animation: mascot-tuft-right 4.8s ease-in-out infinite; }
@keyframes mascot-float { 0%,100% { translate: 0 0; } 45%,55% { translate: 0 -4px; } }
@keyframes mascot-ears { 0%,100% { rotate: 0deg; } 34% { rotate: -1.1deg; } 61% { rotate: 1.1deg; } }
@keyframes mascot-blink { 0%,31%,34%,72%,75%,100% { scale: 1 1; } 32%,73% { scale: 1 .04; } }
@keyframes mascot-gaze { 0%,16%,100% { translate: 0 0; } 31%,48% { translate: 3px -1px; } 64%,80% { translate: -3px 1px; } }
@keyframes mascot-tuft-left { 0%,100% { rotate: 0deg; } 50% { rotate: -4deg; } }
@keyframes mascot-tuft-right { 0%,100% { rotate: 0deg; } 50% { rotate: 4deg; } }
@media (prefers-reduced-motion: reduce) {
  .mascot-idle, .mascot-ears, .mascot-eyes,
  .mascot-eyes ellipse, .mascot-tuft-left, .mascot-tuft-right { animation: none; }
}
```

Notes:

- Blink is one unified scale-Y on the whole eyes group (both eyes together),
  not per-eye. Gaze drifts both pupils together.
- `prefers-reduced-motion` must disable all of it — and must not hide the
  expression controls or the mascot itself.
- Expression switching is an instant still-pose swap (toggle `hidden` on the
  per-expression SVG). No morph transition required.

## 7. Recommended build (plain HTML)

1. Inline all 11 converted SVGs, each in its own container, 10 of them
   `hidden`. Toggle `hidden` to switch expressions — instant swap, no JS
   animation library.
2. Set `--mascot-body` per bot/context from the palette in §3.
3. Label each SVG's active expression accessibly (§8).

Do not use `<img src="...">` per expression unless the mascot never needs
recoloring — external images cannot be recolored with the CSS in §3.

## 8. Accessibility

- Decorative use (e.g. avatar next to a bot name): `aria-hidden="true"` on the
  `<svg>`, no label.
- Standalone use (expression picker, status display): `role="img"` plus an
  `aria-label` naming the active expression, e.g. `aria-label="GitBot mascot,
  suspicious expression"`. Update the label on every switch.

## 9. Acceptance checklist

- [ ] All 11 expressions render, each recognizably different.
- [ ] Setting `--mascot-body` recolors silhouette + tufts (+ Sleepy Z's); eyes
  stay white, pupils stay `#24211f`.
- [ ] No tile/box behind the mascot; drop shadow present.
- [ ] Float + unified blink + gaze drift run; all motion stops under
  `prefers-reduced-motion`.
- [ ] No mouth on any expression. No stray stroked outline on Neutral.
- [ ] Shy / Unimpressed right pupils sit inside their eye whites.
- [ ] Brand colors identical in light and dark mode.
