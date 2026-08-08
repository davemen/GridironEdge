/**
 * Build audit-report.html from audit/history.json.
 *
 * The history file is the record; this file only draws it. Every round appends
 * one entry, so re-running this after each audit produces the trend without
 * anyone having to keep a second copy of the numbers in the page.
 *
 * Run: node audit/build-report.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
// The app's escaper, not a second one. This file had its own three-character
// copy that did not escape ' or `, which is the exact drift `js/escape.js`
// exists to stop -- and history.json is written by five agents a round.
import { esc, int } from '../js/escape.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const history = JSON.parse(readFileSync(join(ROOT, 'audit/history.json'), 'utf8'));

const CATS = [
  ['security', 'Security'],
  ['tests', 'Test coverage'],
  ['performance', 'Performance'],
  ['documentation', 'Documentation'],
  ['readability', 'Readability'],
];
const TARGET = 90;
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/** Score to status role. The threshold IS the state, so status colors apply. */
function statusOf(score) {
  if (score === null || score === undefined) return 'pending';
  if (score >= TARGET) return 'good';
  if (score >= 75) return 'warning';
  if (score >= 55) return 'serious';
  return 'critical';
}
const STATUS_LABEL = { good: 'At target', warning: 'Below target', serious: 'Well below',
                       critical: 'Critical', pending: 'Audit still running' };
// Icon as well as color: a status must never be carried by hue alone.
const STATUS_ICON = { good: '✓', warning: '▲', serious: '▲', critical: '✕', pending: '…' };

/**
 * One sparkline per category — small multiples rather than five lines on one
 * chart. A single series needs no legend and no categorical hue, so the
 * colour can carry status instead, which is what the reader actually wants to
 * know: is this above 90 yet.
 */
function sparkline(scores, status) {
  const W = 260, H = 72, PAD_X = 10, PAD_T = 10, PAD_B = 18;
  const x = (i) => (scores.length < 2 ? W / 2
    : PAD_X + (i * (W - PAD_X * 2)) / (scores.length - 1));
  const y = (v) => PAD_T + ((100 - v) / 100) * (H - PAD_T - PAD_B);
  const target = y(TARGET);

  const pts = scores.map((v, i) => [x(i), y(v)]);
  const line = pts.length > 1
    ? `<path d="${pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')}"
         fill="none" stroke="var(--status)" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round"/>` : '';
  // Markers sit on a surface-coloured ring so a point on the target line stays
  // legible where the two overlap.
  const dots = pts.map(([px, py], i) => `
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5"
            fill="var(--status)" stroke="var(--surface-1)" stroke-width="2">
      <title>Round ${i + 1}: ${int(scores[i])}/100</title>
    </circle>`).join('');

  return `
  <svg class="spark" viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Score by round: ${scores.map((v) => int(v)).join(', ')} out of 100. Target ${TARGET}.">
    <line x1="${PAD_X}" y1="${target.toFixed(1)}" x2="${W - PAD_X}" y2="${target.toFixed(1)}"
          stroke="var(--grid)" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="${W - PAD_X}" y="${(target - 4).toFixed(1)}" class="spark-note"
          text-anchor="end">target ${TARGET}</text>
    ${line}${dots}
    ${scores.map((_, i) => `<text x="${x(i).toFixed(1)}" y="${H - 4}" class="spark-axis"
       text-anchor="${i === 0 && scores.length > 1 ? 'start' : i === scores.length - 1 && scores.length > 1 ? 'end' : 'middle'}">R${i + 1}</text>`).join('')}
  </svg>`;
}

function findingsHtml(findings) {
  if (!findings || !findings.length) {
    return '<p class="none">No findings. Nothing outstanding in this category.</p>';
  }
  const sorted = [...findings].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
  );
  return `<ul class="findings">${sorted.map((f) => `
    <li class="finding ${esc(f.severity)}${f.fixed ? ' done' : ''}">
      <div class="f-head">
        <span class="sev sev-${esc(f.severity)}">${esc(f.severity)}</span>
        <span class="f-title">${esc(f.title)}</span>
        ${f.fixed ? '<span class="fixed-tag">fixed</span>' : ''}
      </div>
      ${f.where ? `<div class="f-where">${esc(f.where)}</div>` : ''}
      ${f.evidence ? `<div class="f-body"><span class="lbl">Evidence</span> ${esc(f.evidence)}</div>` : ''}
      ${f.fix ? `<div class="f-body"><span class="lbl">Fix</span> ${esc(f.fix)}</div>` : ''}
    </li>`).join('')}</ul>`;
}

const rounds = history.rounds;
const latest = rounds[rounds.length - 1];
const scoresFor = (key) => rounds.map((r) => r.categories[key]?.score ?? null);
const allPass = CATS.every(([k]) => (latest.categories[k]?.score ?? 0) >= TARGET);
const stillRunning = CATS.filter(([k]) => latest.categories[k]?.score === undefined
  || latest.categories[k]?.score === null).map(([, l]) => l);

const cards = CATS.map(([key, label]) => {
  const cat = latest.categories[key] || {};
  const pending = cat.score === undefined || cat.score === null;
  const series = scoresFor(key).filter((v) => v !== null && v !== undefined);
  const status = pending ? 'pending' : statusOf(cat.score);
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const delta = prev === null ? null : cat.score - prev;
  const open = (cat.findings || []).filter((f) => !f.fixed).length;
  return `
  <section class="card" data-status="${status}">
    <div class="card-top">
      <h2>${label}</h2>
      <div class="score-row">
        <span class="score">${pending ? '—' : int(cat.score)}</span><span class="of">/100</span>
        ${delta === null ? '' : `<span class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${delta > 0 ? '+' : ''}${int(delta)}</span>`}
      </div>
    </div>
    <div class="status-line"><span class="dot">${STATUS_ICON[status]}</span> ${STATUS_LABEL[status]}
      · ${open} open finding${open === 1 ? '' : 's'}</div>
    ${pending ? '<p class="pending-note">Waiting on this agent.</p>' : sparkline(series, status)}
  </section>`;
}).join('');

const detail = CATS.map(([key, label]) => {
  const cat = latest.categories[key] || {};
  return `
  <details class="cat-detail" ${(cat.findings || []).some((f) => !f.fixed) ? 'open' : ''}>
    <summary><span class="sum-name">${label}</span>
      <span class="sum-score" data-status="${statusOf(cat.score)}">${int(cat.score)}/100</span></summary>
    ${cat.justification ? `<p class="just">${esc(cat.justification)}</p>` : ''}
    ${findingsHtml(cat.findings)}
    ${cat.verified ? `<p class="meta"><span class="lbl">Verified</span> ${esc(cat.verified)}</p>` : ''}
    ${cat.notChecked ? `<p class="meta"><span class="lbl">Not checked</span> ${esc(cat.notChecked)}</p>` : ''}
  </details>`;
}).join('');

const tableRows = CATS.map(([key, label]) => `
  <tr><th scope="row">${label}</th>${rounds.map((r) => {
    const v = r.categories[key]?.score;
    return `<td>${int(v)}</td>`;
  }).join('')}</tr>`).join('');

const priorRounds = rounds.length < 2 ? '' : `
<details class="history">
  <summary>Previous rounds (${int(rounds.length - 1)})</summary>
  ${rounds.slice(0, -1).reverse().map((r) => `
    <div class="prior">
      <h3>Round ${int(r.round)} — ${esc(r.date)}${r.commit ? ` · <code>${esc(r.commit)}</code>` : ''}</h3>
      <div class="prior-scores">${CATS.map(([k, l]) =>
        `<span class="chip" data-status="${statusOf(r.categories[k]?.score ?? 0)}">${l} ${int(r.categories[k]?.score)}</span>`).join('')}</div>
    </div>`).join('')}
</details>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gridiron Edge — 5-point audit</title>
<style>
  :root {
    color-scheme: light dark;
    --surface-0: #f4f4f2;
    --surface-1: #fcfcfb;
    --border:    #dcdcd7;
    --grid:      #b8b8b0;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #6f6e6a;
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface-0: #111110;
      --surface-1: #1a1a19;
      --border:    #33332f;
      --grid:      #55554e;
      --text-primary:   #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted:     #97968d;
    }
  }
  :root[data-theme="dark"] {
    --surface-0: #111110;
    --surface-1: #1a1a19;
    --border:    #33332f;
    --grid:      #55554e;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted:     #97968d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem;
    background: var(--surface-0); color: var(--text-primary);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header.top { margin-bottom: 1.75rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .35rem; letter-spacing: -0.01em; }
  .sub { color: var(--text-secondary); font-size: .9rem; margin: 0; }
  .verdict {
    display: inline-flex; align-items: center; gap: .5rem; margin-top: .9rem;
    padding: .45rem .8rem; border-radius: 6px; font-weight: 650; font-size: .88rem;
    border: 1px solid var(--border); background: var(--surface-1);
  }
  .verdict[data-pass="yes"] { color: var(--good); border-color: var(--good); }
  .verdict[data-pass="no"]  { color: var(--serious); border-color: var(--serious); }

  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 1rem 1rem .5rem;
  }
  .card[data-status="good"]     { --status: var(--good); }
  .card[data-status="warning"]  { --status: var(--warning); }
  .card[data-status="serious"]  { --status: var(--serious); }
  .card[data-status="critical"] { --status: var(--critical); }
  .card[data-status="pending"]  { --status: var(--text-muted); }
  .pending-note { font-size: .8rem; color: var(--text-muted); margin: 1rem 0 1.4rem; }
  .card-top { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
  .card h2 { font-size: .82rem; margin: 0; text-transform: uppercase;
             letter-spacing: .06em; color: var(--text-secondary); font-weight: 700; }
  .score-row { display: flex; align-items: baseline; gap: .3rem; }
  .score { font-size: 1.9rem; font-weight: 750; line-height: 1;
           font-variant-numeric: tabular-nums; }
  .of { color: var(--text-muted); font-size: .8rem; }
  .delta { font-size: .78rem; font-weight: 700; font-variant-numeric: tabular-nums;
           padding: .05rem .3rem; border-radius: 4px; }
  .delta.up { color: var(--good); } .delta.down { color: var(--critical); }
  .delta.flat { color: var(--text-muted); }
  .status-line { font-size: .8rem; color: var(--text-secondary); margin-top: .45rem; }
  .status-line .dot { color: var(--status); font-weight: 800; }
  .spark { width: 100%; height: auto; display: block; margin-top: .35rem; overflow: visible; }
  .spark-axis, .spark-note { font-size: 9px; fill: var(--text-muted); }

  h2.section { font-size: 1.05rem; margin: 2.25rem 0 .75rem; }
  .cat-detail, .history {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: .7rem; padding: .2rem .95rem;
  }
  summary { cursor: pointer; padding: .7rem 0; font-weight: 650;
            display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .sum-score { font-variant-numeric: tabular-nums; font-size: .85rem; }
  .sum-score[data-status="good"] { color: var(--good); }
  .sum-score[data-status="warning"] { color: var(--warning); }
  .sum-score[data-status="serious"] { color: var(--serious); }
  .sum-score[data-status="critical"] { color: var(--critical); }
  .sum-score[data-status="pending"] { color: var(--text-muted); }
  .just { color: var(--text-secondary); font-size: .9rem; margin: 0 0 .8rem; }
  .findings { list-style: none; margin: 0 0 .8rem; padding: 0; }
  .finding { border-left: 3px solid var(--border); padding: .55rem 0 .55rem .75rem;
             margin-bottom: .55rem; }
  .finding.critical { border-left-color: var(--critical); }
  .finding.high     { border-left-color: var(--serious); }
  .finding.medium   { border-left-color: var(--warning); }
  .finding.low      { border-left-color: var(--grid); }
  .finding.done { opacity: .55; }
  .f-head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .sev { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em;
         font-weight: 800; padding: .1rem .35rem; border-radius: 3px;
         border: 1px solid currentColor; }
  .sev-critical { color: var(--critical); } .sev-high { color: var(--serious); }
  .sev-medium { color: var(--warning); } .sev-low { color: var(--text-muted); }
  .f-title { font-weight: 620; }
  .fixed-tag { font-size: .66rem; font-weight: 800; color: var(--good);
               border: 1px solid var(--good); border-radius: 3px; padding: .1rem .35rem; }
  .f-where { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
             font-size: .76rem; color: var(--text-muted); margin-top: .15rem;
             overflow-wrap: anywhere; }
  .f-body { font-size: .86rem; color: var(--text-secondary); margin-top: .3rem; }
  .lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
         font-weight: 700; color: var(--text-muted); margin-right: .3rem; }
  .meta { font-size: .8rem; color: var(--text-muted); margin: .5rem 0; }
  .none { color: var(--text-muted); font-size: .88rem; margin: .2rem 0 .8rem; }
  .prior { padding: .3rem 0 .8rem; }
  .prior h3 { font-size: .9rem; margin: .4rem 0 .5rem; font-weight: 650; }
  .prior-scores { display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { font-size: .76rem; padding: .18rem .5rem; border-radius: 4px;
          border: 1px solid var(--border); color: var(--text-secondary); }
  .chip[data-status="good"] { color: var(--good); border-color: var(--good); }
  .chip[data-status="warning"] { color: var(--warning); }
  .chip[data-status="serious"] { color: var(--serious); }
  .chip[data-status="critical"] { color: var(--critical); }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: .85rem; min-width: 380px; }
  th, td { text-align: right; padding: .35rem .7rem; border-bottom: 1px solid var(--border);
           font-variant-numeric: tabular-nums; }
  th[scope="row"] { text-align: left; font-weight: 600; color: var(--text-secondary); }
  thead th { color: var(--text-muted); font-weight: 700; font-size: .72rem;
             text-transform: uppercase; letter-spacing: .05em; }
  footer { margin-top: 2.5rem; color: var(--text-muted); font-size: .78rem; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Gridiron Edge — 5-point audit</h1>
    <p class="sub">Round ${int(latest.round)} · ${esc(latest.date)}${latest.commit ? ` · commit <code>${esc(latest.commit)}</code>` : ''}
      · five independent agents, one per dimension</p>
    <div class="verdict" data-pass="${allPass ? 'yes' : 'no'}">
      ${stillRunning.length
        ? `◐ Partial — still auditing: ${stillRunning.join(', ')}`
        : allPass ? '✓ Every category at or above 90'
        : `✕ ${CATS.filter(([k]) => (latest.categories[k]?.score ?? 0) < TARGET).length} of 5 categories below 90`}
    </div>
  </header>

  <div class="grid">${cards}</div>

  <h2 class="section">Findings — round ${int(latest.round)}</h2>
  ${detail}

  ${priorRounds}

  <h2 class="section">Scores by round</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th scope="col">Category</th>${rounds.map((r) => `<th scope="col">R${int(r.round)}</th>`).join('')}</tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  <footer>
    Generated by <code>audit/build-report.mjs</code> from <code>audit/history.json</code>.
    Each round is audited by fresh agents with no memory of writing the fixes, so
    a repaired finding is re-verified rather than self-reported.
  </footer>
</div>
</body>
</html>`;

writeFileSync(join(ROOT, 'audit-report.html'), html);
console.log(`Wrote audit-report.html — round ${latest.round}, `
  + CATS.map(([k, l]) => `${l} ${latest.categories[k]?.score ?? '—'}`).join(', '));
