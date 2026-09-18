export const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>gitbot — bot hub</title>
<style>
  :root {
    --bg: #f7f7f9;
    --surface: #fff;
    --surface-2: #f0f0f4;
    --text: #16161a;
    --muted: #71717f;
    --faint: #a1a1b0;
    --border: #e4e4ec;
    --accent: #2f6fed;
    --accent-text: #fff;
    --danger: #cf3b2f;
    --ok: #1f9d55;
    --radius: 16px;
    --shadow-sm: 0 1px 2px rgba(16,16,24,.05);
    --shadow-md: 0 2px 6px rgba(16,16,24,.06), 0 12px 28px rgba(16,16,24,.08);
    --tint-l: 94%;
    --tint-s: 70%;
    --ink-l: 34%;
  }
  @media (prefers-color-scheme: dark) {
    :root:not(.light) {
      --bg: #101013;
      --surface: #18181d;
      --surface-2: #202027;
      --text: #ececf2;
      --muted: #9494a4;
      --faint: #6b6b7c;
      --border: #292932;
      --accent: #5f8dff;
      --accent-text: #0c0c10;
      --danger: #f0685c;
      --ok: #45c07d;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
      --shadow-md: 0 2px 6px rgba(0,0,0,.4), 0 12px 28px rgba(0,0,0,.35);
      --tint-l: 24%;
      --tint-s: 38%;
      --ink-l: 76%;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  button { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; }
  input, textarea, select { font: inherit; color: inherit; }
  h1, h2, h3 { margin: 0; letter-spacing: -.02em; }

  /* Every screen owns the full window; we navigate by depth, not by columns. */
  .view { display: none; flex-direction: column; height: 100vh; height: 100dvh; }
  .view.active { display: flex; }
  .scroll { flex: 1; overflow-y: auto; }
  .wrap { width: 100%; max-width: 940px; margin: 0 auto; padding: 0 24px; }
  .wrap.narrow { max-width: 760px; }

  /* --- Top bars --- */
  .bar { border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 5; }
  .bar-inner { display: flex; align-items: center; gap: 14px; min-height: 68px; padding-top: 12px; padding-bottom: 12px; }
  .bar-inner h1 { font-size: 22px; flex: 1; }
  .bar-title { flex: 1; min-width: 0; }
  .bar-title h2 { font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-title .sub { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .back {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    color: var(--muted); padding: 6px 10px 6px 6px; margin-left: -6px; border-radius: 9px;
    font-size: 13.5px; font-weight: 550;
  }
  .back:hover { background: var(--surface-2); color: var(--text); }
  .back .chev { font-size: 17px; line-height: 1; }

  .btn {
    display: inline-flex; align-items: center; gap: 7px; flex: none;
    padding: 9px 15px; border-radius: 11px; font-size: 14px; font-weight: 550;
    border: 1px solid var(--border); background: var(--surface); box-shadow: var(--shadow-sm);
  }
  .btn:hover { border-color: var(--faint); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .btn.primary:hover { filter: brightness(1.06); }
  .btn.ghost { box-shadow: none; background: none; border-color: transparent; color: var(--muted); }
  .btn.ghost:hover { background: var(--surface-2); color: var(--text); }
  .btn.danger { color: var(--danger); border-color: transparent; background: none; box-shadow: none; }
  .btn.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }

  /* --- Bot identity ---
     Each bot gets a stable hue from its name, so colour carries identity
     rather than decoration. --bot-hue is set inline per element. */
  .avatar {
    display: grid; place-items: center; flex: none;
    width: 44px; height: 44px; border-radius: 13px;
    background: hsl(var(--bot-hue) var(--tint-s) var(--tint-l));
    font-size: 21px; line-height: 1;
  }
  .avatar.lg { width: 56px; height: 56px; border-radius: 16px; font-size: 27px; }
  .avatar.sm { width: 30px; height: 30px; border-radius: 9px; font-size: 15px; }

  /* --- Home: the roster --- */
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
    gap: 16px; padding: 24px 0 60px;
  }
  .card {
    position: relative; overflow: hidden; text-align: left;
    display: flex; flex-direction: column; gap: 10px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 18px; min-height: 178px; box-shadow: var(--shadow-sm);
    transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease;
  }
  .card::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 3px;
    background: hsl(var(--bot-hue) 65% 55%);
  }
  .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: hsl(var(--bot-hue) 50% 62%); }
  .card h3 { font-size: 16px; }
  .card .desc {
    color: var(--muted); font-size: 13.5px; flex: 1;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card .foot {
    display: flex; align-items: center; gap: 8px;
    color: var(--faint); font-size: 12px; padding-top: 2px;
  }
  .card .foot .dot { margin-left: auto; }
  /* A card is a button, so its share affordance is a span acting as one. */
  .card .share {
    position: absolute; top: 12px; right: 12px; z-index: 1;
    display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px;
    color: var(--faint); font-size: 14px; line-height: 1; cursor: pointer;
    opacity: 0; transition: opacity .14s ease, background .14s ease, color .14s ease;
  }
  .card:hover .share, .card .share:focus-visible { opacity: 1; }
  .card .share:hover { background: var(--surface-2); color: var(--text); }
  @media (hover: none) { .card .share { opacity: 1; } }

  .new-card {
    display: grid; place-items: center; gap: 8px; min-height: 178px;
    border: 1.5px dashed var(--border); border-radius: var(--radius); color: var(--muted);
    font-size: 14px; font-weight: 550;
  }
  .new-card:hover { border-color: var(--accent); color: var(--accent); background: var(--surface); }
  .new-card .plus { font-size: 24px; line-height: 1; }

  .dot { display: inline-flex; align-items: center; gap: 5px; }
  .dot::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
  .dot.live { color: var(--ok); }
  .dot.live::before { background: var(--ok); box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); animation: pulse 1.8s ease-out infinite; }
  @keyframes pulse { to { box-shadow: 0 0 0 7px transparent; } }
  @media (prefers-reduced-motion: reduce) { .dot.live::before { animation: none; } }

  /* --- Bot page --- */

  /* Identity lives in the bar: name, a status dot, and the instructions as one
     clamped line. The page below belongs to the threads. */
  .name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name-row h2 { min-width: 0; }
  .ready { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
  .ready.pending { background: var(--accent); }
  .ready.failed { background: var(--danger); }

  .brief-line {
    display: flex; align-items: center; gap: 6px; max-width: 100%;
    background: none; border: 0; padding: 0; cursor: pointer; text-align: left;
    color: var(--muted); font-size: 12.5px;
  }
  .brief-line > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .brief-line:hover { color: var(--text); }
  .brief-line .chev-d { flex: none; font-size: 10px; transition: transform .15s ease; }
  .brief-line.open .chev-d { transform: rotate(180deg); }

  .btn.icon { padding: 6px 9px; font-size: 16px; line-height: 1; }

  .menu {
    position: fixed; z-index: 30; min-width: 170px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 11px;
    box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.14)); padding: 5px;
  }
  .menu button {
    display: block; width: 100%; text-align: left; background: none; border: 0;
    padding: 8px 10px; border-radius: 7px; font: inherit; color: var(--text); cursor: pointer;
  }
  .menu button:hover { background: var(--surface-2); }

  .brief {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin: 18px 0 0; box-shadow: var(--shadow-sm);
    border-left: 3px solid hsl(var(--bot-hue) 60% 55%);
  }
  .brief .label { font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); font-weight: 650; margin-bottom: 6px; }
  .brief p { margin: 0; color: var(--text); white-space: pre-wrap; }
  .brief p.none { color: var(--faint); font-style: italic; }

  /* The setup notice sits above the brief: until it clears, it is the page. */
  .setup {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; margin: 22px 0 0; box-shadow: var(--shadow-sm);
    border-left: 3px solid var(--accent);
    display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap;
  }
  .setup.failed { border-left-color: var(--danger); }
  .setup.done { border-left-color: var(--ok); }
  .setup .txt { flex: 1; min-width: 220px; }
  .setup .hd { font-weight: 650; margin-bottom: 4px; }
  .setup.failed .hd { color: var(--danger); }
  .setup p { margin: 0; color: var(--muted); font-size: 13.5px; white-space: pre-wrap; }
  .setup .acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .tag {
    font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; font-weight: 650;
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 999px; padding: 1px 7px; margin-left: 8px; vertical-align: 1px;
  }
  .tag.done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
  .tag.failed { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }

  .section-head { display: flex; align-items: center; gap: 12px; margin: 22px 0 10px; }
  .section-head h3 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
  .section-path {
    flex: 1; min-width: 0; font-size: 11.5px; color: var(--faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr;
  }

  /* Rows read as one list: shared border, hairline dividers, no per-row card. */
  .threads {
    display: flex; flex-direction: column; margin-bottom: 60px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-sm); overflow: hidden;
  }
  .threads:empty { display: none; }
  .thread {
    position: relative; display: flex; align-items: center; gap: 14px; text-align: left; width: 100%;
    background: none; border: 0; border-top: 1px solid var(--border);
    padding: 13px 16px; transition: background .12s ease;
  }
  .thread:first-child { border-top: 0; }
  .thread:hover { background: var(--surface-2); }
  .thread .body { flex: 1; min-width: 0; }
  .thread .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thread .prev { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
  .thread .path {
    display: inline-block; max-width: 100%; margin-top: 5px; font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--faint);
    background: var(--surface-2); border-radius: 6px; padding: 1px 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr;
  }
  .thread .meta { color: var(--faint); font-size: 12px; flex: none; text-align: right; }
  .thread .kill { opacity: 0; color: var(--faint); font-size: 17px; padding: 4px 6px; border-radius: 8px; flex: none; }
  .thread:hover .kill { opacity: 1; }
  .thread .kill:hover { color: var(--danger); background: var(--surface-2); }

  .empty { text-align: center; padding: 64px 20px; color: var(--muted); }
  .empty .big { font-size: 40px; margin-bottom: 12px; }
  .empty h3 { font-size: 17px; margin-bottom: 6px; }
  .empty p { margin: 0 auto 18px; max-width: 380px; font-size: 14px; }

  /* --- Conversation --- */
  .messages { flex: 1; overflow-y: auto; }
  .messages .wrap { padding-top: 26px; padding-bottom: 20px; display: flex; flex-direction: column; gap: 18px; }
  .msg { display: flex; gap: 12px; max-width: 100%; }
  .msg.user { flex-direction: row-reverse; }
  .msg .content { min-width: 0; max-width: 86%; }
  .bubble { padding: 11px 15px; border-radius: 15px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user .bubble { background: var(--accent); color: var(--accent-text); border-bottom-right-radius: 5px; }
  .msg.assistant .bubble { background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 5px; box-shadow: var(--shadow-sm); }
  .msg.assistant .bubble:empty { display: none; }
  .bubble + .bubble, .tool + .bubble { margin-top: 7px; }
  .msg.error .bubble { background: var(--surface); border: 1px solid var(--danger); color: var(--danger); font-size: 13.5px; }

  /* Markdown, as rendered by marked into assistant bubbles. Margins collapse at
     the bubble edges so a one-paragraph answer still looks like a chat line. */
  .bubble.md { white-space: normal; }
  .bubble.md > :first-child { margin-top: 0; }
  .bubble.md > :last-child { margin-bottom: 0; }
  .bubble.md p, .bubble.md ul, .bubble.md ol, .bubble.md pre, .bubble.md blockquote, .bubble.md table { margin: 0 0 10px; }
  .bubble.md h1, .bubble.md h2, .bubble.md h3, .bubble.md h4 { margin: 16px 0 8px; line-height: 1.3; }
  .bubble.md h1 { font-size: 18px; }
  .bubble.md h2 { font-size: 16px; }
  .bubble.md h3, .bubble.md h4 { font-size: 14.5px; }
  .bubble.md ul, .bubble.md ol { padding-left: 22px; }
  .bubble.md li { margin: 3px 0; }
  .bubble.md li > ul, .bubble.md li > ol { margin: 3px 0; }
  .bubble.md a { color: var(--accent); }
  .bubble.md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: var(--surface-2); border-radius: 5px; padding: 1px 5px;
  }
  .bubble.md pre {
    background: var(--surface-2); border-radius: 10px; padding: 10px 12px;
    overflow-x: auto; white-space: pre; -webkit-overflow-scrolling: touch;
  }
  .bubble.md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
  .bubble.md blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--muted); }
  .bubble.md hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
  .bubble.md table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 13px; }
  .bubble.md th, .bubble.md td { border: 1px solid var(--border); padding: 5px 9px; text-align: left; }
  .bubble.md th { background: var(--surface-2); }
  .bubble.md img { max-width: 100%; border-radius: 10px; }
  .who { font-size: 12px; color: var(--faint); margin: 0 4px 4px; }
  .msg.user .who { text-align: right; }

  .tool {
    display: flex; align-items: center; gap: 9px; margin-top: 7px;
    background: var(--surface-2); border-radius: 10px; padding: 7px 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted);
  }
  .tool b { color: var(--text); font-weight: 600; flex: none; }
  .tool span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { color: var(--faint); font-size: 12.5px; text-align: center; font-style: italic; }

  .perm {
    background: var(--surface); border: 1px solid var(--accent); border-radius: 14px;
    padding: 14px 16px; box-shadow: var(--shadow-md);
  }
  .perm .head { font-weight: 600; margin-bottom: 8px; }
  .perm pre {
    margin: 0 0 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 150px; overflow: auto;
  }
  .perm .acts { display: flex; gap: 8px; }

  /* --- Composer --- */
  .composer { border-top: 1px solid var(--border); background: var(--bg); }
  .composer .wrap { padding-top: 12px; padding-bottom: 18px; }
  .activity { display: flex; align-items: center; gap: 8px; height: 22px; padding-left: 4px; color: var(--muted); font-size: 12.5px; }
  .activity:empty { display: none; }
  .spinner {
    width: 11px; height: 11px; flex: none; border-radius: 50%;
    border: 1.5px solid var(--border); border-top-color: var(--accent); animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .box {
    display: flex; gap: 10px; align-items: flex-end;
    background: var(--surface); border: 1px solid var(--border); border-radius: 17px;
    padding: 9px 9px 9px 16px; box-shadow: var(--shadow-sm);
  }
  .box:focus-within { border-color: var(--accent); }
  .box textarea { flex: 1; border: 0; background: none; resize: none; outline: none; max-height: 200px; padding: 6px 0; }
  .send {
    width: 36px; height: 36px; border-radius: 11px; flex: none;
    background: var(--accent); color: var(--accent-text); font-size: 17px;
    display: flex; align-items: center; justify-content: center;
  }
  .send:disabled { opacity: .35; cursor: default; }
  .btn:disabled { opacity: .45; cursor: default; }
  .send.stop { background: var(--danger); }
  .send.stop::before { content: ""; width: 11px; height: 11px; border-radius: 2px; background: currentColor; }

  /* --- Modal --- */
  .backdrop {
    position: fixed; inset: 0; background: rgba(10,10,14,.5); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 30;
  }
  .modal {
    background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: var(--shadow-md); width: min(580px, 100%); max-height: 90vh; overflow-y: auto; padding: 26px;
  }
  .modal h2 { font-size: 19px; }
  .modal-head { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .modal-head h2 { flex: 1; margin: 0; }
  .modal-x {
    flex: none; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--bg); color: var(--faint); font-size: 16px; line-height: 1; cursor: pointer;
  }
  .modal-x:hover { color: var(--text); border-color: var(--faint); }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
  .field .hint { font-weight: 400; color: var(--faint); }
  .field input, .field textarea, .field select {
    width: 100%; padding: 10px 12px; border-radius: 11px;
    border: 1px solid var(--border); background: var(--bg); outline: none;
  }
  .field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); }
  .field textarea { resize: vertical; min-height: 110px; }
  .row2 { display: grid; grid-template-columns: 92px 1fr; gap: 10px; }
  .acts { display: flex; gap: 9px; justify-content: flex-end; align-items: center; margin-top: 22px; }
  .acts .spacer { flex: 1; }

  /* --- Folder picker --- */
  .pathbar {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    color: var(--muted); background: var(--surface-2); border-radius: 10px;
    padding: 9px 12px; margin-bottom: 10px; overflow-wrap: anywhere;
  }
  .jumps { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
  .chip {
    padding: 5px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 550;
    border: 1px solid var(--border); background: var(--surface); color: var(--muted);
  }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .picker {
    border: 1px solid var(--border); border-radius: 12px; background: var(--bg);
    max-height: 46vh; overflow-y: auto;
  }
  .picker-row {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 10px 13px; border-bottom: 1px solid var(--border); font-size: 14px;
  }
  .picker-row:last-child { border-bottom: 0; }
  .picker-row:hover { background: var(--surface-2); }
  .picker-row .ic { flex: none; font-size: 15px; line-height: 1; }
  .picker-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-note { padding: 20px 13px; text-align: center; color: var(--faint); font-size: 13.5px; }

  /* --- Sharing --- */
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    width: 100%; min-height: 96px; resize: vertical; overflow-wrap: anywhere;
    padding: 10px 12px; border-radius: 11px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--muted); outline: none;
  }
  .preview {
    display: flex; align-items: center; gap: 12px; margin: 4px 0 16px;
    background: var(--surface-2); border-radius: 12px; padding: 12px 14px;
  }
  .preview .nm { font-weight: 600; }
  .preview .ds { color: var(--muted); font-size: 13px; }
  .preview .bad { color: var(--danger); font-size: 13.5px; }

  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    z-index: 40; padding: 10px 18px; border-radius: 999px;
    background: var(--text); color: var(--bg); font-size: 13.5px; font-weight: 550;
    box-shadow: var(--shadow-md); animation: rise .18s ease;
  }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }

  @media (max-width: 640px) {
    .wrap { padding: 0 16px; }
    .grid { grid-template-columns: 1fr 1fr; gap: 12px; }
    .bar-inner { min-height: 60px; }
  }
</style>
<!--vendor-->
</head>
<body>

<!-- Home: the roster -->
<section class="view active" id="view-home">
  <div class="bar"><div class="wrap bar-inner">
    <h1>Your bots</h1>
    <button class="btn ghost" id="import-bot">Import</button>
    <button class="btn primary" id="new-bot"><span>+</span> New bot</button>
  </div></div>
  <div class="scroll"><div class="wrap"><div class="grid" id="grid"></div></div></div>
</section>

<!-- One bot: its brief and its threads -->
<section class="view" id="view-bot">
  <div class="bar"><div class="wrap bar-inner">
    <button class="back" id="to-home"><span class="chev">&lsaquo;</span> Bots</button>
    <div class="avatar sm" id="bot-avatar"></div>
    <div class="bar-title">
      <div class="name-row">
        <h2 id="bot-name"></h2>
        <span class="ready" id="bot-ready" hidden></span>
      </div>
      <button class="brief-line" id="brief-line" type="button" hidden>
        <span id="brief-line-text"></span><span class="chev-d">&#9662;</span>
      </button>
    </div>
    <button class="btn ghost" id="share-bot">Share</button>
    <button class="btn ghost" id="edit-bot">Edit</button>
    <button class="btn ghost icon" id="bot-more" title="More" aria-label="More">&#8943;</button>
  </div></div>
  <div class="scroll"><div class="wrap">
    <div class="brief" id="brief" hidden><p id="brief-text"></p></div>
    <div id="setup-banner"></div>
    <div class="section-head">
      <h3>Threads</h3>
      <span class="section-path" id="threads-path"></span>
      <button class="btn primary" id="new-thread">+ New thread</button>
    </div>
    <div class="threads" id="threads"></div>
  </div></div>
  <div class="menu" id="bot-menu" hidden></div>
</section>

<!-- One thread -->
<section class="view" id="view-thread">
  <div class="bar"><div class="wrap narrow bar-inner">
    <button class="back" id="to-bot"><span class="chev">&lsaquo;</span> <span id="to-bot-label">Back</span></button>
    <div class="avatar sm" id="thread-avatar"></div>
    <div class="bar-title">
      <h2 id="thread-title"></h2>
      <div class="sub" id="thread-sub"></div>
    </div>
  </div></div>
  <div class="messages" id="messages"><div class="wrap narrow" id="messages-inner"></div></div>
  <div class="composer"><div class="wrap narrow">
    <div class="activity" id="activity"></div>
    <div class="box">
      <textarea id="input" rows="1" placeholder="Message…"></textarea>
      <button class="send" id="send" title="Send" aria-label="Send">&uarr;</button>
    </div>
  </div></div>
</section>

<script>
(function () {
  "use strict";

  // --- State ---
  var bots = [];
  var allThreads = [];        // every thread, for roster counts
  var threads = [];           // threads of the open bot
  var activeBot = null;
  var activeThread = null;
  var view = "home";          // home | bot | thread

  var sessionId = null;
  var stream = null;
  var liveBubble = null;
  // Turns that are still running server-side, keyed by thread. A turn outlives
  // the screen it was started from, so this is what lets us rejoin one.
  var live = {};              // threadId -> sessionId
  var streamThreadId = null;  // thread the open EventSource belongs to

  // Turn lifecycle. "idle" is the only state in which the button sends;
  // otherwise it stops. "aborting" waits for the agent to confirm.
  var state = "idle";         // idle | starting | running | aborting
  var pendingPerms = 0;
  var pendingFilter = null;   // during catch-up: tool requests still unanswered

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /** Modal title row with the "x" close button; modals never close on an outside click. */
  function modalHead(modal, title, close) {
    var head = el("div", "modal-head");
    head.appendChild(el("h2", null, title));
    var x = el("button", "modal-x", "\u00D7");
    x.title = "Close";
    x.setAttribute("aria-label", "Close");
    x.onclick = close;
    head.appendChild(x);
    modal.appendChild(head);
    return head;
  }

  // --- API ---
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var err = new Error(d.error || ("Request failed: " + r.status));
          err.data = d;   // some errors are acted on, not just shown
          throw err;
        }
        return d;
      });
    });
  }

  /** A stable hue per bot, so colour means identity rather than decoration. */
  function hueOf(bot) {
    var seed = String(bot && (bot.id || bot.name) || "");
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return h;
  }
  function tint(node, bot) { node.style.setProperty("--bot-hue", hueOf(bot)); return node; }

  function avatar(bot, size) {
    var n = tint(el("div", "avatar" + (size ? " " + size : "")), bot);
    n.textContent = bot.emoji || "\\u{1F916}";
    return n;
  }

  function relTime(iso) {
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    if (d < 604800) return Math.floor(d / 86400) + "d ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /**
   * A working directory is only recognisable by its tail, so show the last
   * whole segments that fit and mark the elision with a leading ellipsis.
   */
  function shortPath(p, max) {
    if (!p) return "";
    max = max || 22;
    // Empty segments from a leading or trailing slash fall out with the filter.
    var parts = p.split("/").filter(Boolean);
    if (!parts.length) return p;
    var out = parts[parts.length - 1];
    if (out.length > max) out = "\u2026" + out.slice(out.length - max + 1);
    for (var i = parts.length - 2; i >= 0; i--) {
      var next = parts[i] + "/" + out;
      if (next.length > max) return "\u2026/" + out;
      out = next;
    }
    return (p.charAt(0) === "/" ? "/" : "") + out;
  }

  // --- Navigation: depth, not columns ---
  function setView(next, push) {
    view = next;
    ["home", "bot", "thread"].forEach(function (v) {
      $("view-" + v).classList.toggle("active", v === next);
    });
    if (push !== false) {
      try { history.pushState({ view: next }, ""); } catch (e) {}
    }
  }

  window.addEventListener("popstate", function () {
    if (view === "thread") goBotView(false);
    else if (view === "bot") goHome(false);
  });

  function goHome(push) {
    activeBot = null;
    activeThread = null;
    detach();
    setView("home", push);
    return loadRoster();
  }

  function goBotView(push) {
    detach();
    activeThread = null;
    setView("bot", push);
    renderThreads();
    // Refresh in the background so a turn that ended while we were inside the
    // thread stops showing as running, and titles pick up the latest turn.
    loadThreads().catch(function () {});
  }

  // --- Home ---
  function loadRoster() {
    return pruneLive().then(function () {
      return Promise.all([api("/bots"), api("/threads")]);
    }).then(function (r) {
      bots = r[0].bots || [];
      allThreads = r[1].threads || [];
      renderRoster();
    });
  }

  function renderRoster() {
    var grid = $("grid");
    grid.innerHTML = "";

    if (!bots.length) {
      var e = el("div", "empty");
      e.appendChild(el("div", "big", "\\u{1F916}"));
      e.appendChild(el("h3", null, "No bots yet"));
      e.appendChild(el("p", null, "A bot is a standing set of instructions with a job to do \\u2014 keep the docs in sync, review every PR, cut a release. Give it a name and a brief, then talk to it in threads."));
      var cta = el("button", "btn primary", "Create your first bot");
      cta.onclick = function () { openBotModal(null); };
      e.appendChild(cta);
      grid.style.display = "block";
      grid.appendChild(e);
      return;
    }
    grid.style.display = "";

    bots.forEach(function (bot) {
      var mine = allThreads.filter(function (t) { return t.botId === bot.id; });
      var card = tint(el("button", "card"), bot);
      card.appendChild(avatar(bot));
      card.appendChild(el("h3", null, bot.name));
      card.appendChild(el("div", "desc", bot.description || "No description yet."));

      var foot = el("div", "foot");
      foot.appendChild(el("span", null, mine.length ? mine.length + (mine.length === 1 ? " thread" : " threads") : "No threads"));
      var anyLive = mine.some(function (t) { return !!live[t.id]; });
      if (anyLive) foot.appendChild(el("span", "dot live", "running"));
      else if (mine.length) foot.appendChild(el("span", "dot", relTime(mine[0].updatedAt)));
      card.appendChild(foot);

      var share = el("span", "share", "\u2934");
      share.setAttribute("role", "button");
      share.setAttribute("tabindex", "0");
      share.title = "Copy a share code for " + bot.name;
      share.setAttribute("aria-label", "Share " + bot.name);
      share.onclick = function (ev) { ev.stopPropagation(); shareBot(bot); };
      share.onkeydown = function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); shareBot(bot); }
      };
      card.appendChild(share);

      card.onclick = function () { openBot(bot); };
      grid.appendChild(card);
    });

    var add = el("button", "new-card");
    add.appendChild(el("div", "plus", "+"));
    add.appendChild(el("div", null, "New bot"));
    add.onclick = function () { openBotModal(null); };
    grid.appendChild(add);
  }

  // --- Bot page ---
  function openBot(bot) {
    activeBot = bot;
    activeThread = null;
    detach();
    $("bot-name").textContent = bot.name;
    var av = $("bot-avatar");
    av.textContent = bot.emoji || "\\u{1F916}";
    tint(av, bot);
    tint($("brief"), bot);
    var text = bot.instructions || "No instructions \\u2014 this bot behaves like plain Claude Code.";
    var brief = $("brief-text");
    brief.textContent = text;
    brief.className = bot.instructions ? "" : "none";
    // The instructions are the bot's identity, not the page's content: one line
    // under the name, opened only when someone asks for the rest.
    $("brief-line-text").textContent = text.split("\\n")[0];
    $("brief-line").hidden = false;
    setBriefOpen(false);
    renderSetup();
    setView("bot");
    return loadThreads();
  }

  function loadThreads() {
    if (!activeBot) return Promise.resolve();
    return pruneLive().then(function () {
      return api("/threads?botId=" + encodeURIComponent(activeBot.id));
    }).then(function (d) {
      threads = d.threads || [];
      // Keep the roster's counts honest without a second round trip.
      allThreads = allThreads.filter(function (t) { return t.botId !== activeBot.id; }).concat(threads);
      // A thread can be renamed by the turn that just ran, so keep the open
      // thread's header in step with the list.
      if (activeThread) {
        for (var i = 0; i < threads.length; i++) {
          if (threads[i].id !== activeThread.id) continue;
          activeThread = threads[i];
          $("thread-title").textContent = threads[i].title;
          break;
        }
      }
      renderThreads();
      renderSetup();
      // A setup run reports its verdict on the bot, not the thread, so pick the
      // bot up again while the machine is still unprepared.
      if (needsSetup(activeBot)) {
        var id = activeBot.id;
        var was = activeBot.setupStatus;
        return api("/bots/" + id).then(function (r) {
          if (!activeBot || activeBot.id !== id) return;
          replaceBot(r.bot);
          renderSetup();
          renderThreads();
          // The run says how it went in the thread; say it once out here too,
          // since the verdict is what unblocks the rest of the bot.
          var now = r.bot.setupStatus;
          if (now !== was && now === "complete") toast(r.bot.name + " is set up on this machine");
          else if (now !== was && now === "failed") toast("Setup did not finish \u2014 open the setup thread");
        }).catch(function () {});
      }
    });
  }

  // --- Setup ---
  // A bot may declare what it needs from a machine. Until this machine has it,
  // the bot has exactly one thread it is allowed to run: the setup thread.

  var SETUP_PROMPT = "Start setup.";

  function needsSetup(bot) {
    return !!(bot && bot.setupInstructions && bot.setupStatus !== "complete");
  }

  function setupThreadOf() {
    for (var i = 0; i < threads.length; i++) if (threads[i].kind === "setup") return threads[i];
    return null;
  }

  /** Keeps the roster's copy of a bot in step with one the server just returned. */
  function replaceBot(bot) {
    if (!bot) return;
    if (activeBot && activeBot.id === bot.id) activeBot = bot;
    for (var i = 0; i < bots.length; i++) if (bots[i].id === bot.id) { bots[i] = bot; break; }
  }

  function renderSetup() {
    var box = $("setup-banner");
    box.innerHTML = "";
    var bot = activeBot;
    $("new-thread").disabled = needsSetup(bot);
    $("bot-more").hidden = !(bot && bot.setupInstructions);
    if (!bot || !bot.setupInstructions) { $("bot-ready").hidden = true; return; }

    var status = bot.setupStatus || "pending";
    // A ready machine is the steady state, so it says so with a dot in the bar
    // and gets out of the way. Only pending and failed earn a banner.
    var dot = $("bot-ready");
    dot.hidden = false;
    dot.className = "ready" + (status === "complete" ? "" : status === "failed" ? " failed" : " pending");
    dot.title = status === "complete" ? "Ready on this machine"
      : status === "failed" ? "Setup did not finish" : "Setup needed on this machine";
    if (status === "complete") return;

    var wrap = el("div", "setup" + (status === "failed" ? " failed" : ""));
    var txt = el("div", "txt");
    if (status === "failed") {
      txt.appendChild(el("div", "hd", "Setup did not finish"));
      txt.appendChild(el("p", null, "Open the setup thread to see what stopped it \u2014 it is an ordinary conversation, so you can answer it and carry on."));
    } else {
      txt.appendChild(el("div", "hd", "Setup needed on this machine"));
      txt.appendChild(el("p", null, bot.name + " needs this machine prepared before it can take work. New threads open once setup is done."));
    }
    wrap.appendChild(txt);

    var acts = el("div", "acts");
    var t = setupThreadOf();
    var open = el("button", "btn primary", t && t.messageCount ? "Open setup" : "Run setup");
    open.onclick = function () { openSetup(); };
    acts.appendChild(open);
    var mark = el("button", "btn", "Mark as done");
    mark.title = "Use this if you sorted it out yourself";
    mark.onclick = function () { setupAction("complete"); };
    acts.appendChild(mark);
    wrap.appendChild(acts);
    box.appendChild(wrap);
  }

  function setupAction(action) {
    if (!activeBot) return Promise.resolve();
    return api("/bots/" + activeBot.id + "/setup", { method: "POST", body: { action: action } })
      .then(function (d) { replaceBot(d.bot); return loadThreads(); })
      .catch(function (err) { toast(err && err.message ? err.message : String(err)); });
  }

  /** Opens the setup thread, making one first if it is missing. */
  function openSetup() {
    if (!activeBot || !activeBot.setupInstructions) return Promise.resolve();
    var t = setupThreadOf();
    if (t) return openThread(t).then(function () { autoStartSetup(t); });
    return setupAction("reset").then(function () {
      var fresh = setupThreadOf();
      if (!fresh) return;
      return openThread(fresh).then(function () { autoStartSetup(fresh); });
    });
  }

  /**
   * The opening message of a setup run is written and sent for the user: the
   * bot's author already said what has to happen, so there is nothing to type.
   * Everything after it is an ordinary conversation.
   */
  function autoStartSetup(thread) {
    if (!thread || thread.messageCount || live[thread.id] || state !== "idle") return;
    sendText(SETUP_PROMPT);
  }

  /** Called right after a bot lands here, whether it was created or imported. */
  function afterBotAdded(bot) {
    return openBot(bot).then(function () {
      if (needsSetup(bot)) return openSetup();
    });
  }

  function renderThreads() {
    var list = $("threads");
    list.innerHTML = "";
    $("threads-path").textContent = "";
    if (!activeBot) return;

    if (!threads.length) {
      var e = el("div", "empty");
      e.appendChild(el("h3", null, "No threads yet"));
      e.appendChild(el("p", null, "Every conversation with " + activeBot.name + " lives in its own thread, and each one keeps its history."));
      var blocked = needsSetup(activeBot);
      var cta = el("button", "btn primary", blocked ? "Run setup first" : "Start the first thread");
      cta.onclick = blocked ? function () { openSetup(); } : newThread;
      e.appendChild(cta);
      list.appendChild(e);
      return;
    }

    // Nearly every thread runs in the same folder, so the path is stated once
    // above the list; a row only carries a chip when it broke from the pack.
    var base = commonPath();
    $("threads-path").textContent = base ? shortPath(base, 40) : "";
    $("threads-path").title = base || "";

    threads.forEach(function (t) {
      var row = tint(el("div", "thread"), activeBot);
      var body = el("div", "body");
      var title = el("div", "title", t.title);
      if (t.kind === "setup") {
        var st = activeBot.setupStatus || "pending";
        title.appendChild(el("span", "tag" + (st === "complete" ? " done" : st === "failed" ? " failed" : ""), "setup"));
      }
      body.appendChild(title);
      body.appendChild(el("div", "prev", t.preview || "No messages yet"));
      if ((t.repoPath || "") !== base) {
        var where = el("div", "path", shortPath(t.repoPath));
        where.title = t.repoPath || "";
        body.appendChild(where);
      }
      row.appendChild(body);

      var meta = el("div", "meta");
      if (live[t.id]) meta.appendChild(el("span", "dot live", "running"));
      else meta.appendChild(el("div", null, relTime(t.updatedAt)));
      row.appendChild(meta);

      var kill = el("button", "kill", "\\u00D7");
      kill.title = "Delete thread";
      kill.onclick = function (ev) {
        ev.stopPropagation();
        if (!confirm("Delete this thread? The Claude Code transcript stays on disk.")) return;
        api("/threads/" + t.id, { method: "DELETE" }).then(loadThreads).catch(showError);
      };
      row.appendChild(kill);

      row.onclick = function () { openThread(t); };
      list.appendChild(row);
    });
  }

  /** The folder most of this bot's threads run in \u2014 the list's implied home. */
  function commonPath() {
    var counts = {}, best = null, bestN = 0;
    threads.forEach(function (t) {
      var key = t.repoPath || "";
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestN) { bestN = counts[key]; best = key; }
    });
    return best;
  }

  function setBriefOpen(open) {
    $("brief").hidden = !open;
    $("brief-line").classList.toggle("open", open);
  }

  /** The rare, machine-level actions live behind the bar's overflow, not in it. */
  function openBotMenu() {
    var menu = $("bot-menu");
    menu.innerHTML = "";
    if (!activeBot) return;
    var again = el("button", null, "Run setup again");
    again.onclick = function () { closeBotMenu(); setupAction("reset").then(openSetup); };
    menu.appendChild(again);
    var r = $("bot-more").getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
  }

  function closeBotMenu() { $("bot-menu").hidden = true; }

  function newThread() {
    if (!activeBot) return;
    if (needsSetup(activeBot)) {
      toast("Set up " + activeBot.name + " on this machine first");
      openSetup();
      return;
    }
    // A thread is pinned to a folder for its whole life, so the folder is
    // chosen up front rather than argued about later.
    openFolderPicker(activeBot.repoPath || null, function (repoPath) {
      api("/threads", { method: "POST", body: { botId: activeBot.id, repoPath: repoPath || undefined } })
        .then(function (d) { return loadThreads().then(function () { openThread(d.thread); }); })
        .catch(function (err) {
          // The server has the last word on whether setup is done.
          if (err && err.data && err.data.setupRequired) {
            toast(err.message);
            loadThreads().then(function () { openSetup(); });
            return;
          }
          toast(err && err.message ? err.message : String(err));
        });
    });
  }

  /**
   * Pick the directory a thread runs in. Browsing is confined to the directory
   * the CLI was started in and roams from there; "Use default" skips the choice,
   * which leaves the server to fall back to the bot's directory or its own.
   */
  function openFolderPicker(startPath, onPick) {
    var backdrop = el("div", "backdrop");
    var modal = el("div", "modal");
    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", esc);
    }
    function esc(ev) { if (ev.key === "Escape") close(); }
    modalHead(modal, "Where should this thread run?", close);

    var jumps = el("div", "jumps");
    var pathbar = el("div", "pathbar", "\u2026");
    var list = el("div", "picker");
    modal.appendChild(jumps);
    modal.appendChild(pathbar);
    modal.appendChild(list);

    var current = null;

    function jump(label, path) {
      var b = el("button", "chip", label);
      b.title = path;
      b.onclick = function () { load(path); };
      jumps.appendChild(b);
    }

    function row(icon, name, onClick) {
      var r = el("button", "picker-row");
      r.appendChild(el("span", "ic", icon));
      r.appendChild(el("span", "nm", name));
      r.onclick = onClick;
      list.appendChild(r);
      return r;
    }

    function load(path) {
      return api("/browse" + (path ? "?path=" + encodeURIComponent(path) : ""))
        .then(function (d) {
          current = d.path;
          pathbar.textContent = d.path;
          jumps.innerHTML = "";
          jump("Workspace", d.workspace);
          jump("Home", d.home);
          jump("/", "/");
          list.innerHTML = "";
          if (d.parent) row("\u2191", "..", function () { load(d.parent); });
          (d.dirs || []).forEach(function (dir) {
            row("\u{1F4C1}", dir.name, function () { load(dir.path); });
          });
          if (!d.dirs.length && !d.parent) {
            list.appendChild(el("div", "picker-note", "No subfolders here."));
          }
        })
        .catch(function (err) {
          // A remembered folder can be gone or unreadable; the workspace is
          // always browsable, so fall back to it.
          if (path) return load(null);
          showError(err);
        });
    }

    var acts = el("div", "acts");
    var def = el("button", "btn ghost", "Use default");
    def.title = "Run where the CLI was started (or the bot's directory)";
    def.onclick = function () { close(); onPick(null); };
    acts.appendChild(def);
    acts.appendChild(el("div", "spacer"));
    var cancel = el("button", "btn", "Cancel");
    cancel.onclick = close;
    var pick = el("button", "btn primary", "Run here");
    pick.onclick = function () {
      if (!current) return;
      close();
      onPick(current);
    };
    acts.appendChild(cancel);
    acts.appendChild(pick);
    modal.appendChild(acts);

    backdrop.appendChild(modal);
    document.addEventListener("keydown", esc);
    document.body.appendChild(backdrop);
    load(startPath);
  }

  // --- Thread ---
  function openThread(thread) {
    activeThread = thread;
    detach();
    $("thread-title").textContent = thread.title;
    $("thread-sub").textContent = shortPath(thread.repoPath, 30);
    $("thread-sub").title = thread.repoPath || "";
    $("to-bot-label").textContent = activeBot ? activeBot.name : "Back";
    var av = $("thread-avatar");
    av.textContent = activeBot ? (activeBot.emoji || "\\u{1F916}") : "\\u{1F916}";
    tint(av, activeBot || {});
    $("input").placeholder = "Message " + (activeBot ? activeBot.name : "bot") + "\\u2026";
    setState("idle");
    setActivity("");
    setView("thread");

    // If this thread's turn is still running, rejoin it rather than rendering a
    // transcript that stops short of what the agent is doing right now.
    var sid = live[thread.id];
    if (sid) return rejoin(thread, sid);
    return loadMessages();
  }

  function loadMessages() {
    var box = $("messages-inner");
    box.innerHTML = "";
    if (!activeThread) return Promise.resolve();
    return api("/threads/" + activeThread.id + "/messages").then(function (d) {
      renderTranscript(d.messages || []);
    });
  }

  function renderTranscript(msgs) {
    var box = $("messages-inner");
    box.innerHTML = "";
    if (!msgs.length) {
      var e = el("div", "empty");
      e.appendChild(el("h3", null, "Say the first thing"));
      e.appendChild(el("p", null, activeBot ? activeBot.name + " already knows its job \\u2014 tell it what to do this time." : "Send a message to start."));
      box.appendChild(e);
      return;
    }
    msgs.forEach(function (m) {
      var content = startMessage(m.role === "user" ? "user" : "assistant");
      (m.content || []).forEach(function (b) {
        if (b.type === "text") appendText(content, b.text);
        else if (b.type === "tool_use") appendTool(content, b.tool_name, b.tool_input);
        else if (b.type === "image_url") {
          var img = document.createElement("img");
          img.src = b.url; img.style.maxWidth = "100%"; img.style.borderRadius = "12px";
          content.appendChild(img);
        }
      });
    });
    scrollDown();
  }

  /** Opens a message row and returns its content column, ready for blocks. */
  function startMessage(kind) {
    var box = $("messages-inner");
    var placeholder = box.querySelector(".empty");
    if (placeholder) placeholder.remove();

    var row = el("div", "msg " + kind);
    if (kind === "assistant" && activeBot) row.appendChild(avatar(activeBot, "sm"));
    var content = el("div", "content");
    if (kind === "assistant" && activeBot) content.appendChild(el("div", "who", activeBot.name));
    row.appendChild(content);
    box.appendChild(row);
    scrollDown();
    return content;
  }

  /** The bubble text should flow into: the trailing one when the last block is
   *  already text, a fresh one when a tool chip closed it off. Keeps text and
   *  tools interleaved in arrival order instead of piling tools at the bottom. */
  function bubbleOf(content, md) {
    var last = content.lastElementChild;
    if (last && last.classList && last.classList.contains("bubble")) return last;
    var b = el("div", md ? "bubble md" : "bubble");
    content.appendChild(b);
    return b;
  }

  /** Assistant text is markdown: agents write lists, code fences and tables.
   *  marked renders it, DOMPurify strips anything unsafe the model may have
   *  echoed back. User and error text stays literal \u2014 nobody wants their
   *  asterisks eaten. Falls back to plain text if the libs failed to load. */
  var MD = (function () {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return null;
    marked.setOptions({ gfm: true, breaks: true });
    return function (src) {
      try { return DOMPurify.sanitize(marked.parse(src)); }
      catch (e) { return null; }   // malformed input falls back to plain text
    };
  })();

  function isAssistant(content) {
    var row = content.parentNode;
    return !!(row && row.classList && row.classList.contains("assistant"));
  }

  function appendText(content, text) {
    if (!text) return;
    var md = !!MD && isAssistant(content);
    var b = bubbleOf(content, md);
    // The raw source is kept so streamed chunks re-render as one document
    // rather than each being parsed on its own (a fence can span chunks).
    b.__md = b.__md ? b.__md + "\\n\\n" + text : text;
    var out = md ? MD(b.__md) : null;
    if (out === null) { b.className = "bubble"; b.textContent = b.__md; return; }
    b.innerHTML = out;
    var links = b.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      links[i].target = "_blank";
      links[i].rel = "noopener noreferrer";
    }
  }

  function appendTool(content, name, input) {
    var chip = el("div", "tool");
    chip.appendChild(el("b", null, name));
    var summary = typeof input === "string" ? input : JSON.stringify(input || {});
    chip.appendChild(el("span", null, summary.slice(0, 200)));
    content.appendChild(chip);
    scrollDown();
  }

  function scrollDown() {
    var m = $("messages");
    m.scrollTop = m.scrollHeight;
  }

  function showError(err) {
    var content = startMessage("error");
    appendText(content, err && err.message ? err.message : String(err));
  }

  // --- Sending ---
  function send() {
    var input = $("input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    sendText(text);
  }

  /** Sends a turn on the open thread. The setup run uses this with a written prompt. */
  function sendText(text) {
    if (!text || !activeThread || state !== "idle") return;
    appendText(startMessage("user"), text);
    setState("starting");
    setActivity("Sending\u2026");

    var threadId = activeThread.id;
    api("/chat", { method: "POST", body: { threadId: threadId, prompt: text } })
      .then(function (d) {
        sessionId = d.sessionId;
        live[threadId] = d.sessionId;
        streamThreadId = threadId;
        setState("running");
        setActivity("Thinking\u2026");
        attachStream(d.sessionId, function (type, data, ev) { handleEvent(type, data, ev, false); });
        loadThreads();
      })
      .catch(function (err) { showError(err); finishTurn(); });
  }

  /** Asks the server to abort. The agent's "aborted" event is what actually
   *  returns the button to Send. */
  function abort() {
    if (!sessionId || state === "idle" || state === "aborting") return;
    setState("aborting");
    setActivity("Stopping\u2026");
    api("/sessions/" + encodeURIComponent(sessionId) + "/abort", { method: "POST" })
      .catch(function (err) { showError(err); finishTurn(); });
  }

  /**
   * Rejoins a turn that is still running after we navigated away. /events
   * replays the whole turn before going live, so the catch-up is free — but the
   * transcript on disk may already hold part of that same turn. So: buffer the
   * replay, use its prompt to trim the overlap off the transcript, paint the
   * history, then let the buffered events through.
   */
  function rejoin(thread, sid) {
    sessionId = sid;
    streamThreadId = thread.id;
    setState("running");
    setActivity("Catching up\u2026");

    var buffer = [];
    var flushed = false;
    var prompt = null;
    var promptSeen = false;
    pendingFilter = null;

    attachStream(sid, function (type, data, ev) {
      if (flushed) { handleEvent(type, data, ev, false); return; }
      if (type === "user_prompt") { prompt = data.prompt || ""; promptSeen = true; }
      buffer.push([type, data, ev]);
    });

    var transcript = api("/threads/" + thread.id + "/messages").catch(function () { return { messages: [] }; });

    // Approvals resolved while we were away must not be offered again.
    var pending = api("/sessions/" + encodeURIComponent(sid) + "/permissions")
      .then(function (d) { pendingFilter = d.pending || []; })
      .catch(function () { pendingFilter = []; });

    // Give the replay a moment to arrive; it is written the instant we connect,
    // but don't hang the screen on it if the turn produced nothing yet.
    var settled = new Promise(function (resolve) {
      var waited = 0;
      (function tick() {
        if (promptSeen || waited >= 600) return resolve();
        waited += 50;
        setTimeout(tick, 50);
      })();
    });

    return Promise.all([transcript, settled, pending]).then(function (r) {
      if (activeThread !== thread) return;   // navigated away again
      renderTranscript(trimInFlight(r[0].messages || [], prompt));
      flushed = true;
      buffer.forEach(function (item) { handleEvent(item[0], item[1], item[2], true); });
      buffer = [];
      pendingFilter = null;
      scrollDown();
    });
  }

  /** Drops the tail of the transcript belonging to the turn still in flight,
   *  identified by the prompt that started it. */
  function trimInFlight(messages, prompt) {
    if (!prompt) return messages;
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (m.role !== "user") continue;
      var text = (m.content || []).filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; }).join("\\n\\n");
      if (text.trim() === prompt.trim()) return messages.slice(0, i);
    }
    return messages;
  }

  // Every event type the agent emits on the turn stream.
  var STREAM_EVENTS = ["user_prompt", "assistant", "tool_use", "status", "permission_request", "aborted", "done", "result", "error"];

  function attachStream(sid, onEvent) {
    closeStream();
    liveBubble = null;
    stream = new EventSource("/events?sessionId=" + encodeURIComponent(sid));
    STREAM_EVENTS.forEach(function (type) {
      stream.addEventListener(type, function (ev) {
        var data = {};
        if (ev.data) { try { data = JSON.parse(ev.data); } catch (e) {} }
        onEvent(type, data, ev);
      });
    });
  }

  /** Renders one stream event. In catch-up mode the prompt that started the
   *  turn still needs painting; on the live path we already showed it. */
  function handleEvent(type, data, ev, replay) {
    switch (type) {
      case "user_prompt":
        if (replay && data.prompt) appendText(startMessage("user"), data.prompt);
        break;

      case "assistant":
        if (!liveBubble) liveBubble = startMessage("assistant");
        appendText(liveBubble, data.content);
        scrollDown();
        break;

      case "tool_use":
        if (!liveBubble) liveBubble = startMessage("assistant");
        appendTool(liveBubble, data.tool_name, data.tool_input);
        break;

      case "status":
        if (state === "aborting") break;
        if (data.status === "thinking") setActivity("Thinking\u2026");
        else if (data.status === "tool") setActivity("Running " + (data.tool_name || "tool") + "\u2026");
        else if (data.status === "tool_summary" && data.summary) setActivity(data.summary);
        break;

      case "permission_request":
        if (replay && pendingFilter && pendingFilter.indexOf(data.toolUseID) === -1) break;
        pendingPerms++;
        setActivity("Waiting for your approval\u2026");
        renderPermission(data);
        break;

      case "aborted":
        $("messages-inner").appendChild(el("div", "note", "Stopped."));
        scrollDown();
        finishTurn();
        break;

      case "done":
        finishTurn();
        break;

      case "error":
        // Fires for an agent error (has data) and for a transport drop (none).
        // EventSource retries drops itself, so only give up once it is closed.
        if (ev && ev.data) {
          showError(new Error(data.message || "Stream error"));
          finishTurn();
        } else if (!stream || stream.readyState === 2) {
          setActivity("Connection lost");
          finishTurn();
        } else {
          setActivity("Reconnecting\u2026");
        }
        break;
    }
  }

  function renderPermission(data) {
    var card = el("div", "perm");
    card.appendChild(el("div", "head", "Allow " + data.toolName + "?"));
    card.appendChild(el("pre", null, JSON.stringify(data.input, null, 2)));
    var acts = el("div", "acts");
    var allow = el("button", "btn primary", "Allow");
    var deny = el("button", "btn", "Deny");
    function respond(ok) {
      allow.disabled = deny.disabled = true;
      api("/sessions/" + encodeURIComponent(sessionId) + "/permission", { method: "POST", body: { toolUseID: data.toolUseID, approved: ok } })
        .then(function () {
          card.replaceWith(el("div", "note", (ok ? "Allowed " : "Denied ") + data.toolName));
          pendingPerms = Math.max(0, pendingPerms - 1);
          if (!pendingPerms && state === "running") setActivity("Thinking\u2026");
        })
        .catch(showError);
    }
    allow.onclick = function () { respond(true); };
    deny.onclick = function () { respond(false); };
    acts.appendChild(allow);
    acts.appendChild(deny);
    card.appendChild(acts);
    $("messages-inner").appendChild(card);
    scrollDown();
  }

  function finishTurn() {
    closeStream();
    liveBubble = null;
    pendingPerms = 0;
    if (streamThreadId) delete live[streamThreadId];
    streamThreadId = null;
    var keep = $("activity").textContent === "Connection lost";
    setState("idle");
    if (!keep) setActivity("");
    loadThreads();
  }

  function closeStream() { if (stream) { stream.close(); stream = null; } }

  /** Drops turns that finished while we were not watching, so a thread does not
   *  keep claiming to be running forever. */
  function pruneLive() {
    var ids = Object.keys(live);
    if (!ids.length) return Promise.resolve();
    return Promise.all(ids.map(function (threadId) {
      return api("/sessions/" + encodeURIComponent(live[threadId]) + "/status")
        .then(function (d) { if (!d.streaming) delete live[threadId]; })
        .catch(function () { delete live[threadId]; });
    }));
  }

  /** Leaves a running turn alone server-side, but stops following it here. */
  function detach() {
    closeStream();
    liveBubble = null;
    pendingPerms = 0;
    setState("idle");
    setActivity("");
  }

  /** The one place that decides what the composer looks like. */
  function setState(next) {
    state = next;
    var running = next !== "idle";
    var send = $("send");
    send.classList.toggle("stop", running);
    send.textContent = running ? "" : "\\u2191";   // stop glyph is drawn by CSS
    send.title = running ? "Stop" : "Send";
    send.setAttribute("aria-label", running ? "Stop" : "Send");
    send.disabled = next === "aborting" || (!running && !activeThread);
  }

  function setActivity(text) {
    var box = $("activity");
    box.textContent = "";
    if (!text) return;
    if (state !== "idle" && text.indexOf("Waiting for your approval") === -1 && text !== "Connection lost") {
      box.appendChild(el("div", "spinner"));
    }
    box.appendChild(el("span", null, text));
  }

  // --- Sharing ---
  // A bot is portable: everything that defines its behaviour travels, and
  // nothing that is local to one machine does. repoPath is deliberately left
  // behind — the folder a bot works in is the receiver's to choose.
  var SHARE_PREFIX = "gitbot:v1:";
  // "grassbot:v1:" is the pre-rename prefix. Codes already in circulation carry
  // it, so import still accepts it; export only ever writes the current one.
  var LEGACY_SHARE_PREFIXES = ["grassbot:v1:"];
  // setupStatus and setupThreadId stay behind with repoPath: they describe this
  // machine, not the bot. The receiving machine works out its own.
  var SHARE_FIELDS = ["name", "emoji", "description", "instructions", "setupInstructions",
                      "model", "permissionMode", "allowedTools", "disallowedTools"];

  function toB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var out = btoa(bin).split("+").join("-").split("/").join("_");
    while (out.charAt(out.length - 1) === "=") out = out.slice(0, -1);
    return out;
  }

  function fromB64(str) {
    var b = str.split("-").join("+").split("_").join("/");
    while (b.length % 4) b += "=";
    var bin = atob(b);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function shareCode(bot) {
    var payload = {};
    SHARE_FIELDS.forEach(function (k) {
      if (bot[k] !== undefined && bot[k] !== null && bot[k] !== "") payload[k] = bot[k];
    });
    return SHARE_PREFIX + toB64(JSON.stringify(payload));
  }

  /** Accepts a share code or the bare JSON inside one. Returns null if neither. */
  function parseShare(text) {
    var raw = String(text || "").trim();
    if (!raw) return null;
    var json = raw;
    var prefixes = [SHARE_PREFIX].concat(LEGACY_SHARE_PREFIXES);
    for (var p = 0; p < prefixes.length; p++) {
      var at = raw.indexOf(prefixes[p]);
      if (at === -1) continue;
      // Tolerate a code that picked up quotes or a wrapping sentence in transit.
      var code = raw.slice(at + prefixes[p].length).split(/[^A-Za-z0-9_-]/)[0];
      try { json = fromB64(code); } catch (e) { return null; }
      break;
    }
    var obj;
    try { obj = JSON.parse(json); } catch (e) { return null; }
    if (!obj || typeof obj !== "object" || typeof obj.name !== "string" || !obj.name.trim()) return null;

    // Only known fields cross the boundary, each checked for its own shape.
    var bot = { name: obj.name.trim() };
    ["emoji", "description", "instructions", "setupInstructions", "model"].forEach(function (k) {
      if (typeof obj[k] === "string") bot[k] = obj[k];
    });
    if (["ask-permissions", "auto-approve", "plan"].indexOf(obj.permissionMode) !== -1) {
      bot.permissionMode = obj.permissionMode;
    }
    ["allowedTools", "disallowedTools"].forEach(function (k) {
      if (Array.isArray(obj[k])) {
        var tools = obj[k].filter(function (t) { return typeof t === "string" && t.trim(); });
        if (tools.length) bot[k] = tools;
      }
    });
    return bot;
  }

  function toast(text) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var t = el("div", "toast", text);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // execCommand is the only route on a plain-http origin, which is the
    // common case when the CLI is reached over a LAN address.
    return new Promise(function (resolve, reject) {
      var ta = el("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      ok ? resolve() : reject(new Error("copy blocked"));
    });
  }

  function shareBot(bot) {
    var code = shareCode(bot);
    copyText(code)
      .then(function () { toast("Copied " + bot.name + " to the clipboard"); })
      .catch(function () { openShareModal(bot, code); });
  }

  /** Shown only when the clipboard is unavailable: the code, ready to copy by hand. */
  function openShareModal(bot, code) {
    var parts = modalShell("Share " + bot.name);
    parts.modal.appendChild(el("p", "picker-note", "Copying was blocked by the browser. Copy this code and paste it into another gitbot."));
    var box = el("textarea", "code");
    box.value = code;
    box.readOnly = true;
    parts.modal.appendChild(box);
    var acts = el("div", "acts");
    acts.appendChild(el("div", "spacer"));
    var done = el("button", "btn primary", "Done");
    done.onclick = parts.close;
    acts.appendChild(done);
    parts.modal.appendChild(acts);
    parts.open();
    box.focus();
    box.select();
  }

  function openImportModal() {
    var parts = modalShell("Import a bot");
    var field = el("div", "field");
    var lab = el("label", null, "Share code");
    lab.appendChild(el("span", "hint", "  paste what someone shared with you"));
    field.appendChild(lab);
    var box = el("textarea", "code");
    box.placeholder = SHARE_PREFIX + "…";
    field.appendChild(box);
    parts.modal.appendChild(field);

    var preview = el("div", "preview");
    preview.style.display = "none";
    parts.modal.appendChild(preview);

    var add = el("button", "btn primary", "Add bot");
    add.disabled = true;
    var parsed = null;

    function review() {
      parsed = parseShare(box.value);
      preview.innerHTML = "";
      if (!box.value.trim()) {
        preview.style.display = "none";
        add.disabled = true;
        return;
      }
      preview.style.display = "";
      if (!parsed) {
        preview.appendChild(el("div", "bad", "That does not look like a bot share code."));
        add.disabled = true;
        return;
      }
      preview.appendChild(avatar(parsed));
      var body = el("div");
      body.appendChild(el("div", "nm", parsed.name));
      body.appendChild(el("div", "ds", parsed.description || "No description."));
      if (parsed.setupInstructions) {
        body.appendChild(el("div", "ds", "Needs setup on this machine \u2014 a setup thread starts when you add it."));
      }
      preview.appendChild(body);
      add.disabled = false;
    }

    box.addEventListener("input", review);
    box.addEventListener("paste", function () { setTimeout(review, 0); });

    add.onclick = function () {
      if (!parsed) return;
      add.disabled = true;
      api("/bots", { method: "POST", body: parsed })
        .then(function (d) {
          parts.close();
          return loadRoster().then(function () { return afterBotAdded(d.bot); });
        })
        .catch(function (err) {
          add.disabled = false;
          preview.innerHTML = "";
          preview.style.display = "";
          preview.appendChild(el("div", "bad", err && err.message ? err.message : String(err)));
        });
    };

    var acts = el("div", "acts");
    acts.appendChild(el("div", "spacer"));
    var cancel = el("button", "btn", "Cancel");
    cancel.onclick = parts.close;
    acts.appendChild(cancel);
    acts.appendChild(add);
    parts.modal.appendChild(acts);
    parts.open();
    box.focus();
  }

  /** Backdrop, escape key and dismissal, shared by the small modals. */
  function modalShell(title) {
    var backdrop = el("div", "backdrop");
    var modal = el("div", "modal");
    backdrop.appendChild(modal);
    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", esc);
    }
    function esc(ev) { if (ev.key === "Escape") close(); }
    modalHead(modal, title, close);
    return {
      modal: modal,
      close: close,
      open: function () {
        document.addEventListener("keydown", esc);
        document.body.appendChild(backdrop);
      }
    };
  }

  // --- Bot editor ---
  function openBotModal(bot) {
    var editing = !!bot;
    var backdrop = el("div", "backdrop");
    var modal = el("div", "modal");
    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", esc);
    }
    function esc(ev) { if (ev.key === "Escape") close(); }
    modalHead(modal, editing ? "Edit bot" : "New bot", close);

    function field(label, hint, control) {
      var wrap = el("div", "field");
      var lab = el("label", null, label);
      if (hint) lab.appendChild(el("span", "hint", "  " + hint));
      wrap.appendChild(lab);
      wrap.appendChild(control);
      modal.appendChild(wrap);
      return control;
    }

    var emoji = el("input");
    emoji.value = bot ? bot.emoji : "\\u{1F916}";
    var name = el("input");
    name.value = bot ? bot.name : "";
    name.placeholder = "Doc Spot";
    var row = el("div", "row2");
    row.appendChild(emoji);
    row.appendChild(name);
    field("Name", null, row);

    var description = field("Description", "one line, shown on the card", el("input"));
    description.value = bot ? bot.description : "";
    description.placeholder = "Keeps documentation in sync with the code";

    var instructions = field("Instructions", "appended to Claude Code's system prompt", el("textarea"));
    instructions.value = bot ? bot.instructions : "";
    instructions.placeholder = "You keep documentation in sync with the code. On each run, read the latest commit and update the docs it affects.";

    var setupInstructions = field("Setup instructions", "run once per machine \u2014 blank means no setup", el("textarea"));
    setupInstructions.value = bot ? (bot.setupInstructions || "") : "";
    setupInstructions.placeholder = "This bot needs ffmpeg on PATH. Check for it and install it with the machine's package manager if it is missing.";

    var repoPath = field("Working directory", "default for new threads", el("input"));
    repoPath.value = bot ? (bot.repoPath || "") : "";
    repoPath.placeholder = "blank uses the server's directory";

    var model = field("Model", "optional", el("input"));
    model.value = bot ? (bot.model || "") : "";
    model.placeholder = "claude-sonnet-4-6";

    var permissionMode = field("Permissions", null, el("select"));
    [["ask-permissions", "Ask before each tool"], ["auto-approve", "Auto-approve tools"], ["plan", "Plan only (no edits)"]]
      .forEach(function (o) {
        var opt = el("option", null, o[1]);
        opt.value = o[0];
        permissionMode.appendChild(opt);
      });
    permissionMode.value = bot ? bot.permissionMode : "ask-permissions";

    var allowedTools = field("Allowed tools", "comma-separated; blank means all", el("input"));
    allowedTools.value = bot && bot.allowedTools ? bot.allowedTools.join(", ") : "";
    allowedTools.placeholder = "Read, Grep, Edit, Bash";

    var acts = el("div", "acts");
    if (editing) {
      var del = el("button", "btn danger", "Delete");
      del.onclick = function () {
        if (!confirm("Delete " + bot.name + " and all of its threads?")) return;
        api("/bots/" + bot.id, { method: "DELETE" })
          .then(function () { close(); return goHome(); })
          .catch(showError);
      };
      acts.appendChild(del);
    }
    acts.appendChild(el("div", "spacer"));
    var cancel = el("button", "btn", "Cancel");
    cancel.onclick = close;
    var save = el("button", "btn primary", editing ? "Save" : "Create bot");
    save.onclick = function () {
      if (!name.value.trim()) { name.focus(); return; }
      var tools = allowedTools.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
      var body = {
        name: name.value.trim(),
        emoji: emoji.value.trim() || "\\u{1F916}",
        description: description.value.trim(),
        instructions: instructions.value,
        setupInstructions: setupInstructions.value.trim() || undefined,
        repoPath: repoPath.value.trim() || undefined,
        model: model.value.trim() || undefined,
        permissionMode: permissionMode.value,
        allowedTools: tools.length ? tools : undefined
      };
      var req = editing
        ? api("/bots/" + bot.id, { method: "PATCH", body: body })
        : api("/bots", { method: "POST", body: body });
      req.then(function (d) {
        close();
        return api("/threads").then(function (r) {
          allThreads = r.threads || [];
          return api("/bots");
        }).then(function (r) {
          bots = r.bots || [];
          // A new bot may owe this machine a setup run; an edit just goes back
          // to the bot's page.
          if (editing) return openBot(d.bot);
          renderRoster();
          return afterBotAdded(d.bot);
        });
      }).catch(showError);
    };
    acts.appendChild(cancel);
    acts.appendChild(save);
    modal.appendChild(acts);

    backdrop.appendChild(modal);
    document.addEventListener("keydown", esc);
    document.body.appendChild(backdrop);
    name.focus();
  }

  // --- Wiring ---
  $("new-bot").onclick = function () { openBotModal(null); };
  $("import-bot").onclick = openImportModal;
  $("brief-line").onclick = function () { setBriefOpen($("brief").hidden); };
  $("bot-more").onclick = function (ev) {
    ev.stopPropagation();
    if ($("bot-menu").hidden) openBotMenu(); else closeBotMenu();
  };
  document.addEventListener("click", function () { closeBotMenu(); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeBotMenu(); });
  $("share-bot").onclick = function () { if (activeBot) shareBot(activeBot); };
  $("edit-bot").onclick = function () { if (activeBot) openBotModal(activeBot); };
  $("new-thread").onclick = newThread;
  $("to-home").onclick = function () { goHome(); };
  $("to-bot").onclick = function () { goBotView(); };
  $("send").onclick = function () { if (state === "idle") send(); else abort(); };

  var input = $("input");
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); if (state === "idle") send(); }
  });

  setView("home", false);
  loadRoster().catch(function (err) { console.error(err); });
})();
</script>
</body>
</html>`;
