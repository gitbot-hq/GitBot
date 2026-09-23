// Hidden SVG filter defs for mascot depth shading.
//
// Renders once (in the root layout) and stays out of the way: zero-size,
// aria-hidden, no motion. The shading itself is applied via
// mascot-depth.css, scoped under `.mascot` per the mascot contract — the
// provided motion system (Mascot.tsx, mascot-data.ts, mascots.css) is
// untouched.
//
// How it reads as 3D: the filter carves two thin bands just inside the
// body's own edge — a white sheen along the top, a dark shade along the
// bottom — and leaves the interior at 100% base color, so bot colors stay
// vivid. Because it works from rendered alpha — not from the base color —
// one filter flatters every mascot in every bot color, and the eye layers
// (siblings of the body group) stay crisp.
export function MascotDepthDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        <filter
          id="mascot-depth"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          {/* Shrunken core — subtracting it from the silhouette leaves a
              thin rim ring just inside the edge. */}
          <feMorphology in="SourceAlpha" operator="erode" radius="6" result="core" />
          {/* Top sheen: core shifted down vacates the top, so the ring
              shows only along the upper edge. Re-clipped to the silhouette
              so blur can't halo outside it. */}
          <feOffset in="core" dx="0" dy="5" result="coreDown" />
          <feComposite in="SourceAlpha" in2="coreDown" operator="out" result="topBand" />
          <feGaussianBlur in="topBand" stdDeviation="3.5" result="topSoft" />
          <feFlood floodColor="#ffffff" floodOpacity="0.4" result="white" />
          <feComposite in="white" in2="topSoft" operator="in" result="lightClip" />
          <feComposite in="lightClip" in2="SourceAlpha" operator="in" result="lightInner" />
          {/* Bottom shade: mirror image along the lower edge. */}
          <feOffset in="core" dx="0" dy="-5" result="coreUp" />
          <feComposite in="SourceAlpha" in2="coreUp" operator="out" result="botBand" />
          <feGaussianBlur in="botBand" stdDeviation="3.5" result="botSoft" />
          <feFlood floodColor="#000000" floodOpacity="0.18" result="black" />
          <feComposite in="black" in2="botSoft" operator="in" result="shadeClip" />
          <feComposite in="shadeClip" in2="SourceAlpha" operator="in" result="shadeInner" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="lightInner" />
            <feMergeNode in="shadeInner" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}
