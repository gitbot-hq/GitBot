# Theme

## Compact token summary

- Background: `#f7fcfc`; foreground: `#1a1a1a`; muted: `#73726f`; primary: `#31898c`.
- Font: Arial / Helvetica / sans-serif.
- No established radius, shadow, or spacing scale. Tailwind 4 is available through `@import "tailwindcss"`.

## Raw source

`app/globals.css`

```css
@import "tailwindcss";
:root { --color-background: #f7fcfc; --color-foreground: #1a1a1a; --color-muted-foreground: #73726f; --color-primary: #31898c; }
@theme inline { --color-background: var(--color-background); --color-foreground: var(--color-foreground); --color-muted-foreground: var(--color-muted-foreground); --color-primary: var(--color-primary); }
* { box-sizing: border-box; } html { background: var(--color-background); }
body { margin: 0; min-height: 100vh; background: var(--color-background); color: var(--color-foreground); font-family: Arial, Helvetica, sans-serif; }
.canvas { display: grid; min-height: 100vh; place-content: center; gap: .55rem; padding: 2rem; text-align: center; }
.wordmark { margin: 0; color: var(--color-primary); font-size: clamp(2.4rem, 8vw, 5rem); font-weight: 750; letter-spacing: -.075em; }
.status { margin: 0; color: var(--color-muted-foreground); font-size: .875rem; }
```
