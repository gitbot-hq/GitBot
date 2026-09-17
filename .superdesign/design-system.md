# Mascot State Lab

## Product context

An internal-facing playground for previewing one original black-and-white long-eared mascot. It needs two concise state controls: a 16-expression picker and a 14-animation picker. The canvas should make the selected state immediately legible.

## Visual direction

- Quiet studio canvas with warm off-white paper (`#f7fcfc` as project background) and charcoal ink (`#1a1a1a`).
- Use the existing teal `#31898c` only for selected controls and timing/status details.
- Arial/Helvetica only. Flat, carefully spaced panels; no gradients, decorative illustrations, heavy shadows, or extra mascot faces.
- Character remains mouthless. Expression is communicated only through eye/pupil geometry, ears, and body posture.

## Layout and interaction

- Desktop: a large centered mascot stage with a slim inspector panel below or alongside it.
- Mobile: stage first, then stacked state controls.
- The active expression and animation display as a readable label. State choices are compact pill buttons with clear selected state.
- Respect `prefers-reduced-motion`; do not hide controls when motion is reduced.

## Motion

- Calm, deliberate timing: eased gaze shifts and one unified blink rather than independent eye effects.
- Expression is an immediately-applied still pose; animation controls set the movement cycle.
