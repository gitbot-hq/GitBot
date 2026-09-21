# Animated alternate mascots

> **Note:** the `app/components/mascots/` component this document describes was
> removed from the app along with the design playgrounds that rendered it. The
> artwork and generator here are kept as design source; the component is in git history.

Self-contained animated SVGs (motion + art in one file, no dependencies).
Drop into any page as inline SVG. CSS animations play as-is in browsers.

> **Using them in the app (React)?** Use the `<Mascot>` component instead —
> `app/components/mascots/Mascot.tsx`. Same artwork, one SVG per mascot with
> all expressions stacked inside, so switches crossfade instead of popping.
> The standalone files below remain the handoff for non-React contexts.

## Files

`{name}-{idle,happy,sleepy,spin}.svg` — 5 mascots × 4 variants = 20 files.

| Name     | Source              | Character                          |
| -------- | ------------------- | ---------------------------------- |
| `spider` | `../Group 54.svg`   | White spider/flower, one big eye   |
| `ghost`  | `../Group 55.svg`   | White ghost, solid black eyes      |
| `bunny`  | `../Group 57.svg`   | Tall white bunny, skull nose       |
| `horned` | `../Group 58.svg`   | White horned blob, skull nose      |
| `spiky`  | `../Group 59.svg`   | White spiky sun blob, skull nose   |

(There is no Group 56.)

## Variants

- `idle` — neutral eyes + life: float 4.8s, eyes-only blink 6.8s (a blink is
  eyes closing — the mouth and nose stay put), gaze drift 6.8s.
- `happy` — closed happy arcs (`^ ^`), float + gaze only, **no blink**.
- `sleepy` — closed lid arcs, float + gaze only, **no blink**.
- `spin` — happy eyes, body fully static while the face travels:
  exits left, fades, slams back in from the right with a slight overshoot
  past center, settles home (2.4s loop).

Each file namespaces its classes/keyframes (`m-<name>-<variant>-*`), so files
can be inlined together on one page without their animations leaking into
each other. Only `--mascot-body` / `--mascot-ink` are shared globals.

Motion language matches the main mascot (`../../expressions/creature-expressions.svg`
and `../mascot-spec.md` §6). All motion stops under `prefers-reduced-motion`.

## Recolor

Each file honors two CSS variables (defaults = authored colors):

```css
.my-context { --mascot-body: #fea1cd; --mascot-ink: #24211f; }
```

`--mascot-body` recolors silhouette/petals/tufts; eyes/pupils/nose stay ink.
Body geometry is verbatim from the Group sources; only the blob's mirrored
eye/pupil reflections were baked into plain coordinates (identical rendering).
Pupils use `#24211f` to match the main mascot (sources use pure black).

## Notes

- White-bodied mascots need a non-white backdrop to be visible.
- `role="img"` + `aria-label` are baked in; set `aria-hidden="true"` if the
  mascot is purely decorative next to a text label.
- Regenerate: `python3 Design/Mascots/animated/build-mascot-variants.py`
  (geometry embedded in the script, verified against the Group sources).

## `<Mascot>` component API (app use)

```tsx
import Mascot from "./components/mascots/Mascot";

<Mascot name="ghost" expression="happy" motion="spin" />;
```

| Prop         | Type                                        | Default     | Notes                                                        |
| ------------ | ------------------------------------------- | ----------- | ------------------------------------------------------------ |
| `name`       | `spider` `ghost` `bunny` `horned` `spiky`   | —           | Required.                                                    |
| `expression` | `neutral` `happy` `sleepy`                  | `neutral`   | Crossfades (0.25s); ignored in spin, which is always happy.  |
| `motion`     | `idle` `spin` `still`                       | `idle`      | `idle` = float/blink/gaze; `spin` = face-travel turn, body parked; `still` = posed, no motion. |
| `color`      | CSS color                                   | per-mascot  | Body fill; eyes stay white, ink stays dark.                  |
| `ink`        | CSS color                                   | `#24211f`   | Pupils / nose / arcs.                                        |
| `size`       | number (px width)                           | native      | Height follows the viewBox.                                  |
| `label`      | string                                      | auto        | `"<Name> mascot, <expression>[, spinning]"`.                 |
| `className`  | string                                      | —           | Appended after `mascot`.                                     |

Behavior contract (do not reimplement per call site):

- Blink is eyes-only, neutral layer only. Happy/sleepy never blink.
- Expression switches crossfade via `.is-active` + CSS opacity — render all
  three layers always, toggle the class, never unmount/remount on switch.
- `prefers-reduced-motion` parks all motion; the crossfade stays.
- Styles live in `app/components/mascots/mascots.css`, every rule scoped
  under `.mascot` so component CSS and standalone-file CSS coexist.
- Artwork lives in `app/components/mascots/mascot-data.ts` (typed, mirrors
  the generator geometry). Live demo + usage spec: `/mascots`.
