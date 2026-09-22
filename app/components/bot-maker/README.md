# Bot maker

Preview at `/bot-maker`. Uses the original Mascots2 artwork, with 18 named bodies from `Bodyv2`, 18 SVG expressions plus a Looking around behavior and eight selectable gaze directions derived from two authored faces in `LookAround`. `Vector 111.svg` and `Vector 112.svg` are small separate pieces, excluded from body choices. Original files are unchanged.

## App integration

```tsx
import BotMascot from './components/bot-maker/BotMascot';

<BotMascot body="ghost" color="#FECE00" activity="thinking" size={80} />
```

Activities: `idle`, `listening`, `thinking`, `working`, `success`, `error`, `sleeping`. Connect these to your app's state in the parent; the mascot does not fetch or contact the server. `activityExpressions` in `registry.ts` defines each cycle. Activity changes start with the first expression immediately.

Pass `expression="wink"` for direct control; this overrides activity. `motion={false}` disables ambient movement and makes expression changes immediate. `duration={420}` sets the geometry morph duration in milliseconds (clamped to 120–2000). An unknown body or expression falls back to ghost or neutral. `label` overrides the accessible image description.

Transitions morph the left eye, right eye, and mouth independently in one fixed SVG coordinate system. The importer samples authored curves and converts round-capped strokes to filled outlines with 128 corresponding perimeter points. Matching contour direction and starting points prevents twisting when filled eyes become outlined eyes. Alignment checks edge crossings throughout the transition and selects the nearest untwisted correspondence, including for thin curved lids. Repeated correspondences are cached. Identical eyes remain stationary across mouth-only changes; differing SVG crop sizes no longer resize the face. The tongue grows into the mouth and is clipped to its animated outline.

Interrupted transitions continue from the currently visible geometry. No face crossfade or forced blink is used to disguise transitions. The body reacts independently with expression-specific squash, stretch, and small tilts, capped at 3.5% scaling. Every reaction returns to the original shape before repeating. Ambient blinking affects only open-eye expressions and pauses while morphing. Sleeping, winking, calm, excited, and playful closed-eye faces never blink. Sleepy uses slow breathing with a four-second mouth expansion (14% wider, 28% taller) and contraction (8% narrower, 15% shorter); excited uses a quicker squash and rebound. Reduced-motion preferences disable transforms and make expression changes immediate.

The maker exports appearance/configuration JSON and displays component usage. It does not automatically replace existing app avatars or persist changes to the backend.

## Add expressions or bodies

1. Add a named SVG to `Design/Mascots2/Expressions` or `Design/Mascots2/Bodyv2`.
2. Run `node scripts/import-mascots.mjs` from the project root.
3. The picker and manual cycle include the new artwork automatically. Add its ID to `activityExpressions` if it should appear in an activity cycle.
4. For a new body with ears or an unusual silhouette, adjust `facePlacement` in `registry.ts`: `[centerXPercent, centerYPercent, widthPercent]`.

IDs are lowercase filenames with spaces replaced by hyphens. The source typo `Surpised.svg` becomes `surprised`. SVGs need a viewBox and inert path/ellipse/circle/rect/group elements; the importer rejects active/external content. Body black and neutral gray base fills become the chosen color; other original fills (belly, beak, tongue) stay intact. Keep generated `artwork.json` and `morphs.json` with the component. Expression imports currently expect three black features (two eyes and the lowest feature as mouth), plus an optional colored tongue; the importer identifies these regardless of element order. Paths and ellipses are supported for morphing.


## Verification

Run `node --test scripts/mascot-look-around.test.mjs` to check two-direction bouts, neutral rests, and timer cleanup.

Run `node --test scripts/mascot-morph.test.mjs`. It checks stationary eyes across crop changes, every expression pair (including the internal curious gaze variants) at 41 interpolation points for finite geometry and contour intersections, and interruption continuity.

`expression="looking-around"` (also the default idle activity) uses `LookAroundFace` to direct eight glances: top-left, top, top-right, left, right, bottom-left, bottom, and bottom-right. It uses the two unchanged SVGs in `Design/Mascots2/LookAround`. The importer derives fixed gaze poses with stronger eye travel, gentle mouth follow, and a small perspective squeeze of the far eye.

The gaze director rests in the original neutral face for 5–10 seconds, then looks in two distinct directions for 1.2–2.2 seconds each before returning to neutral. Directions shuffle without immediate repeats. The supplied short-eye smile and occasional small open-mouth variant appear only during glances. There is no timed idle emotion cycle. Each instance schedules independently. Motion-off and reduced-motion preferences park the face in neutral and stop gaze timers. Hover reactions interrupt the same mounted morph renderer, then the bot settles back into looking around.

For a fixed direction, pass `expression="look-top-left"`, `"look-top"`, `"look-top-right"`, `"look-left"`, `"look-right"`, `"look-bottom-left"`, `"look-bottom"`, or `"look-bottom-right"`. These are also selectable in the maker. Belly and Birdy 3 use a lower 60% face anchor.

## Positive expressions

The added faces are `calm`, `excited-wink`, `playful`, `playful-2`, `sassy`, and `starry`. The supplied star-eyed `Excited.svg` is stored as `Starry.svg` to preserve the existing curved-eye `excited` expression. Source geometry is unchanged.

All six remain available in the maker and the success activity via `positiveExpressions` in `registry.ts`. Workspace idle behavior now looks around; smiles respond to interaction. Marketplace cards/details also look around at rest and smile on pointer hover, independently of live task status. Each new expression has its own small body reaction; reduced-motion settings still disable animation.

Starry eyes ease into a slow 24-second revolution in opposite directions after the face morph settles. Switching expressions morphs from the currently rotated geometry. Rotation stops with `motion={false}` or reduced motion.
