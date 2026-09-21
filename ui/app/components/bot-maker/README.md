# Bot maker

Preview at `/bot-maker`. Uses the original Mascots2 artwork, with 18 named bodies from `Bodyv2`, 12 SVG expressions, and a procedural Looking around state. `Vector 111.svg` and `Vector 112.svg` are small separate pieces, excluded from body choices. Original files are unchanged.

## App integration

```tsx
import BotMascot from './components/bot-maker/BotMascot';

<BotMascot body="ghost" color="#FECE00" activity="thinking" size={80} />
```

Activities: `idle`, `listening`, `thinking`, `working`, `success`, `error`, `sleeping`. Connect these to your app's state in the parent; the mascot does not fetch or contact the server. `activityExpressions` in `registry.ts` defines each cycle. Activity changes start with the first expression immediately.

Pass `expression="wink"` for direct control; this overrides activity. `motion={false}` disables ambient movement and makes expression changes immediate. `duration={420}` sets the geometry morph duration in milliseconds (clamped to 120–2000). An unknown body or expression falls back to ghost or neutral. `label` overrides the accessible image description.

Transitions morph the left eye, right eye, and mouth independently in one fixed SVG coordinate system. The importer samples authored curves and converts round-capped strokes to filled outlines with 128 corresponding perimeter points. Matching contour direction and starting points prevents twisting when filled eyes become outlined eyes. Identical eyes remain stationary across mouth-only changes; differing SVG crop sizes no longer resize the face. The tongue grows into the mouth and is clipped to its animated outline.

Interrupted transitions continue from the currently visible geometry. No face crossfade or forced blink is used to disguise transitions. The body reacts independently with expression-specific squash, stretch, and small tilts, capped at 3.5% scaling. Every reaction returns to the original shape before repeating. Ambient blinking affects only the eyes and pauses while morphing. Sleepy uses slow breathing; excited uses a quicker squash and rebound. Reduced-motion preferences disable transforms and make expression changes immediate.

The maker exports appearance/configuration JSON and displays component usage. It does not automatically replace existing app avatars or persist changes to the backend.

## Add expressions or bodies

1. Add a named SVG to `Design/Mascots2/Expressions` or `Design/Mascots2/Bodyv2`.
2. Run `node scripts/import-mascots.mjs` from the project root.
3. The picker and manual cycle include the new artwork automatically. Add its ID to `activityExpressions` if it should appear in an activity cycle.
4. For a new body with ears or an unusual silhouette, adjust `facePlacement` in `registry.ts`: `[centerXPercent, centerYPercent, widthPercent]`.

IDs are lowercase filenames with spaces replaced by hyphens. The source typo `Surpised.svg` becomes `surprised`. SVGs need a viewBox and inert path/ellipse/circle/rect/group elements; the importer rejects active/external content. Body black and neutral gray base fills become the chosen color; other original fills (belly, beak, tongue) stay intact. Keep generated `artwork.json` and `morphs.json` with the component. Expression imports currently expect three black features (two eyes and the lowest feature as mouth), plus an optional colored tongue; the importer identifies these regardless of element order. Paths and ellipses are supported for morphing.


## Verification

Run `node --test scripts/mascot-morph.test.mjs`. It checks stationary eyes across crop changes, all 169 expression pairs at seven interpolation points for finite geometry and contour intersections, and interruption continuity.

`expression="looking-around"` uses the neutral face with a 6.4-second left/right/up glance sequence and a gentle body lean. It is selectable in the maker and included in the idle activity sequence. Cycles hold it for 6.8 seconds so the full sequence can finish. Belly and Birdy 3 use a lower 60% face anchor.
