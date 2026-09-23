'use client';

import { useEffect, useState } from 'react';
import { IconArrowLeft, IconCheck, IconCode, IconDownload, IconPlayerPause, IconPlayerPlay, IconSparkles } from '@tabler/icons-react';
import BotMascot, { Artwork } from '../components/bot-maker/BotMascot';
import { bodies, expressions, palette, activityExpressions, type BotActivity } from '../components/bot-maker/registry';
import './bot-maker.css';

export default function BotMaker() {
  const [body, setBody] = useState('ghost');
  const [color, setColor] = useState(palette[0]);
  const [expression, setExpression] = useState('neutral');
  const [activity, setActivity] = useState<BotActivity>('idle');
  const [mode, setMode] = useState<'expression' | 'activity'>('expression');
  const [motion, setMotion] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(420);
  const [showCode, setShowCode] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setExpression(prev => expressions[(expressions.findIndex(e => e.id === prev) + 1) % expressions.length].id), expression === 'looking-around' ? 6800 : Math.max(1800, duration + 1000));
    return () => clearTimeout(timer);
  }, [playing, duration, expression]);
  const config = { body, color, ...(mode === 'expression' ? { expression } : { activity }), motion, duration };
  const code = `<BotMascot\n  body="${body}"\n  color="${color}"\n  ${mode === 'expression' ? `expression="${expression}"` : `activity="${activity}"`}\n  motion={${motion}}\n  duration={${duration}}\n/>`;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'my-bot.json'; link.click(); URL.revokeObjectURL(url);
    setNotice('Configuration downloaded');
  }
  return <main className="maker">
    <header className="maker-header"><a href="/" className="maker-back"><IconArrowLeft size={18} /> GitBot</a><span className="maker-header-label">THE CHARACTER STUDIO</span><button className="maker-export" onClick={download}><IconDownload size={16} /> Export bot</button></header>
    <div className="maker-heading"><div><p className="maker-kicker">A LITTLE CHARACTER. A LOT OF PERSONALITY.</p><h1>Make it your bot<span>.</span></h1><p>Choose a shape. Find a mood. Bring your sidekick to life.</p></div><span className="maker-count">{bodies.length} bodies <span>×</span> {expressions.length} expressions</span></div>
    <div className="maker-workspace">
      <aside className="maker-bodies"><div className="maker-section-heading"><h2>01 <span>The shape</span></h2><span>{bodies.length}</span></div><div className="maker-body-grid">
        {bodies.map(b => <button key={b.id} aria-pressed={body === b.id} className={body === b.id ? 'selected' : ''} onClick={() => setBody(b.id)}><span style={{ color: body === b.id ? color : 'var(--muted)' }}><Artwork art={b} /></span><span>{b.label}</span>{body === b.id && <IconCheck className="maker-tick" size={13} />}</button>)}
      </div></aside>
      <section className="maker-preview" aria-label="Live bot preview"><div className="maker-stage-top"><span><i /> LIVE PREVIEW</span><span>{motion ? 'A little life, always' : 'Holding still'}</span></div><div className="maker-stage"><BotMascot {...config} size={310} /><div className="maker-ground" /></div><div className="maker-stage-caption"><h2>{bodies.find(b => b.id === body)?.label}</h2><p>{mode === 'expression' ? expressions.find(e => e.id === expression)?.label : `${activity} · automatic expressions`}</p></div><div className="maker-playbar"><button onClick={() => { setMode('expression'); setPlaying(!playing); }} aria-pressed={playing}>{playing ? <IconPlayerPause size={17} /> : <IconPlayerPlay size={17} />}{playing ? 'Pause cycle' : 'Cycle expressions'}</button><span>Soft transitions. Same little bot.</span></div></section>
      <aside className="maker-settings"><div className="maker-section-heading"><h2>02 <span>The personality</span></h2><IconSparkles size={17} /></div><fieldset><legend>Body color</legend><div className="maker-swatches">{palette.map(c => <button key={c} style={{ background: c }} aria-label={`Body color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)}>{color === c && <IconCheck size={17} />}</button>)}</div></fieldset><div className="maker-divider" /><label className="maker-switch"><span><strong>Keep it alive</strong><small>Breathing, blinks & curious glances</small></span><input type="checkbox" checked={motion} onChange={e => setMotion(e.target.checked)} /></label><label className="maker-speed"><span>Transition time <output>{duration} ms</output></span><input type="range" min="180" max="1000" step="20" value={duration} onChange={e => setDuration(Number(e.target.value))} /><span><small>Snappy</small><small>Dreamy</small></span></label><div className="maker-divider" /><label className="maker-activity">Try an app activity<select value={mode === 'activity' ? activity : 'manual'} onChange={e => { setPlaying(false); if (e.target.value === 'manual') setMode('expression'); else { setMode('activity'); setActivity(e.target.value as BotActivity); } }}><option value="manual">Choose expressions manually</option>{Object.keys(activityExpressions).map(a => <option key={a} value={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</option>)}</select></label><p className="maker-hint">Your bot’s mood follows what it’s doing. Try thinking, working, or celebrating a success.</p><button className="maker-code-toggle" onClick={() => setShowCode(!showCode)} aria-expanded={showCode}><IconCode size={17} />{showCode ? 'Hide component code' : 'Get component code'}</button></aside>
    </div>
    <section className="maker-expressions"><div className="maker-expression-heading"><div className="maker-section-heading"><h2>03 <span>The expression</span></h2></div><p>A whole range of feelings. Click one to see the transition.</p></div><div className="maker-expression-grid">{expressions.map(e => <button key={e.id} aria-pressed={mode === 'expression' && expression === e.id} className={mode === 'expression' && expression === e.id ? 'selected' : ''} onClick={() => { setMode('expression'); setPlaying(false); setExpression(e.id); }}><span className="maker-face-thumbnail"><Artwork art={e} /></span><span>{e.label}</span></button>)}</div></section>
    {showCode && <section className="maker-code"><div><h2>Ready for your app</h2><p>Import BotMascot from app/components/bot-maker/BotMascot. Pass activity from your app state, or choose an expression directly.</p></div><pre><code>{code}</code></pre></section>}
    <footer className="maker-footer"><span>Made from your original SVGs. Built to keep growing.</span><span role="status">{notice || 'Small movements. Big personality.'}</span></footer>
  </main>;
}
