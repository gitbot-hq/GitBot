# GitBot branding

Single source of truth for brand color. Check this file before adding
any color to the UI.

## Palette

| Token          | Hex     | Use                                    |
| -------------- | ------- | -------------------------------------- |
| `--brand-sun`   | #FECE00 | Primary brand, highlights              |
| `--brand-candy` | #FEA1CD | Playful accents                        |
| `--brand-ember` | #FF7300 | Energy, active states                  |
| `--brand-leaf`  | #31CC66 | Success, online                        |
| `--brand-sky`   | #00A3FE | Links, info                            |
| `--brand-honey` | #FEA501 | Warnings, pending                      |

## Surfaces (pure grayscale neutrals)

| Token        | Light   | Dark    |
| ------------ | ------- | ------- |
| `--bg`        | #F7F7F7 | #121211 |
| `--surface`   | #FFFFFF | #181818 |
| `--surface-2` | #F0F0F0 | #202020 |
| `--surface-active` | #FFFFFF | #242424 |
| `--text`      | #161616 | #ECECEC |
| `--muted`     | #717171 | #949494 |
| `--faint`     | #A1A1A1 | #6B6B6B |
| `--border`    | #E4E4E4 | #292929 |

Hover containers use `--surface-2`, active/selected containers use
`--surface` — no borders or rings on either. Accent (`--accent`),
`--danger`, and `--ok` keep their hues as semantic colors.

## User avatar

- `--user-avatar-bg: #FEEEA6` — light tint of `--brand-sun` for Sunny's
  avatar, with dark `#16161a` initials. Fixed in both modes (the bar is
  always dark).

## Logo

- Source: `Design/GitBot Logo.svg` (full lockup) and
  `Design/GitBot LogoMark.svg` (mark only). Component:
  `app/components/logo.tsx`.
- Theme-aware via vars: `--logo-ink` (body/wordmark), `--logo-eye`,
  `--logo-pupil`. Light = near-black ink, white eyes; dark = inverted.
- The red annotation path in the source files is a design guide —
  intentionally dropped, not artwork.
- The face is live: rotates between neutral and excited only, rotating every 6s with a
  flubber morph. The logo mascot is Neutral at 333/217 scale, so
  expression paths map with one scale transform. Motion (float/blink/
  gaze) is amplified ~2.5x vs the mascot files so it reads at 30px.

## Bot avatars

- Each bot gets one palette color, assigned by stable hash of its id
  (see `botTile()` in `app/components/bot-avatar.tsx`). Stable, not
  random per render — color is identity, it must not shift.
- The mascot body itself carries the bot's brand color. Artwork is
  traced from the design files (`app/components/mascot-art.tsx`,
  extracted from `Design/expressions/figma-expressions/`): shared silhouette,
  per-expression eye whites (stay white) and pupils (stay `#24211f`).
- No tile or box behind the mascot — it floats free with a soft drop
  shadow for depth: `drop-shadow(0 3px 8px rgb(0 0 0 / 0.3))`.
- Brand colors stay identical in light and dark mode — identity colors
  never change with theme.
