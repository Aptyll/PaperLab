// @ts-check
// Dashboard frontend. Plain ES module, no build step.
// Token names and symbols come from the market and are untrusted: everything
// interpolated into HTML goes through esc().
//
// Pages (hash routes, so the browser Back button works):
//   #/             Scoreboard: each strategy vs its random picker
//   #/rule/<id>    One strategy: its trades, its random picker's trades, why it fired
//   #/coins        Trending coins
//   #/coin/<pool>  One coin: price chart with every trade marked
//   #/guide        How it all works, and past runs
//   #/notes        The research notebook (files in notes/), newest first
//
// A strategy is a code-name (Falcon, Hawk...) plus one rule and its exits.
// The home screen, its chart and the portfolio number cover active (not
// retired) strategies.

/** @type {any} */
const LWC = /** @type {any} */ (window).LightweightCharts;

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
const css = (/** @type {string} */ v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = {
  /** @type {any} */ status: null,
  /** @type {any} Results for the run being shown. */ results: null,
  /** @type {Record<string, string>} */ colors: {},
  /** @type {any[]} */ charts: [],
  /** @type {ResizeObserver[]} */ observers: [],
  /** @type {number|null} Past run being viewed; null means the current run. */ viewRun: null,
  /** Coins page: list every coin bought, not just the best 15. */ allCoins: false,
  /** Chart time view, a key of RANGES. */ range: load('range') ?? 'All',
};

/** @param {string} k */
function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
/** @param {string} k @param {string} v */
function save(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

// ---------- formatting ----------

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** @param {number|null|undefined} n */
function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** Signed dollars for P&L. @param {number|null|undefined} n */
function money(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
}

/** Whole dollars with thousands separators, e.g. $1,083. @param {number} n */
const dollars = (n) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

/** Memecoin prices span many orders of magnitude. @param {number|null|undefined} p */
function price(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '–';
  if (p >= 1) return p.toFixed(4);
  if (p === 0) return '0';
  const zeros = Math.floor(-Math.log10(p));
  return p.toFixed(Math.min(zeros + 4, 14));
}

/** @param {number|null|undefined} x  fraction, e.g. 0.12 */
function pct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
}

/** Round thousands, e.g. 100000 -> "$100K". @param {number} n */
const kUsd = (n) => (n >= 1000 ? `$${+(n / 1000).toFixed(1)}K` : `$${n}`);

/** A setting as a plain percent, e.g. 0.2 -> "20%". @param {number} x */
const p100 = (x) => `${+(x * 100).toFixed(2)}%`;

/** @param {number|null|undefined} x */
const share = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);

/** @param {number|null|undefined} x */
const tone = (x) => (x === null || x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

/** @param {number} ms */
function duration(ms) {
  const m = Math.max(0, ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)}h`;
  return `${Math.round(m / 1440)}d`;
}
/** @param {number|null|undefined} ms */
const ago = (ms) => (ms ? duration(Date.now() - ms) : '–');

/** @param {number|null|undefined} ms */
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');

/** Exits in a few characters, e.g. "−20% / +40% / 60 min". @param {any} t */
const exitsText = (t) => `−${p100(t.stopLossPct)} / +${p100(t.takeProfitPct)} / ${t.timeLimitMin} min`;

// ---------- strategies ----------

/** @param {string} id @returns {any} */
const strategyOf = (id) => state.status?.strategies.find((/** @type {any} */ s) => s.id === id) ?? null;
/** Code-name, e.g. "Falcon". @param {string} id */
const nameOf = (id) => strategyOf(id)?.codeName ?? id;
/** Plain rule name, e.g. "Buy rush". @param {string} ruleId */
const ruleName = (ruleId) => state.status?.signals.find((/** @type {any} */ s) => s.id === ruleId)?.name ?? ruleId;
/** The strategy a trade belongs to (a random picker's trade belongs to its strategy). @param {any} t */
const strategyOfTrade = (t) => (t.strategy === 'random' ? String(t.book).split(':')[1] ?? '' : t.strategy);
/** Who placed a trade, in words. @param {any} t */
const owner = (t) => (t.strategy === 'random' ? `${nameOf(strategyOfTrade(t))} random` : nameOf(t.strategy));

/** @param {string} strategy */
const colorOf = (strategy) => state.colors[strategy] ?? css('--baseline');
/** @param {string} id */
const dot = (id) => `<span class="dot" style="background:${colorOf(id)}"></span>`;

/** Add the viewed run to an API url. @param {string} url */
const forRun = (url) => (state.viewRun === null ? url : `${url}${url.includes('?') ? '&' : '?'}run=${state.viewRun}`);

/** Market cap, or fully diluted value when the source has none. 0 means "no figure". @param {any} s */
const capOf = (s) => (s.marketCapUsd > 0 ? s.marketCapUsd : s.fdvUsd > 0 ? s.fdvUsd : null);

/** @param {string} url */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------- status of one strategy ----------

/** Profit minus its random picker's profit, closed trades. @param {any} r */
const edgeUsd = (r) => r.all.pnlUsd - r.twin.all.pnlUsd;

/** Profit so far, open trades counted as if sold now. @param {any} r */
const pnlOf = (r) => r.equityUsd - (state.results?.startingBankrollUsd ?? 1000);

/**
 * Where a strategy stands on the go-live checks, in a few words. There is no
 * trade minimum: Noah decides when there are enough.
 * @param {any} r
 * @returns {{key: string, text: string, cls: string, fill: number}}
 */
function statusOf(r) {
  const checks = r.checks ?? [];
  const passed = checks.filter((/** @type {any} */ c) => c.pass).length;
  if (checks.length && passed === checks.length) {
    return r.verdict?.label === 'clear'
      ? { key: 'ready', text: 'Ready', cls: 'pos', fill: 1 }
      : { key: 'ready', text: 'Ready · could be luck', cls: 'warn', fill: 1 };
  }
  const fill = checks.length ? passed / checks.length : 0;
  if (r.verdict?.label === 'no_edge') return { key: 'behind', text: 'Behind random', cls: 'neg', fill };
  return { key: 'not-ready', text: `Not ready · ${passed}/${checks.length} checks`, cls: '', fill };
}

/** The go-live checks, for hover text. @param {any} r */
const checksTip = (r) =>
  ['Go-live checks', ...(r.checks ?? []).map((/** @type {any} */ x) => `${x.pass ? '✓' : '✗'} ${x.label} (${x.detail})`)].join('\n');

// ---------- which strategies show ----------

/** Results of the active (not retired) strategies, most profit first. @param {any[]} rows */
function shownStrategies(rows) {
  const keep = rows.filter((r) => r.strategy !== 'random' && !(strategyOf(r.strategy)?.retired ?? false));
  return keep.sort((a, b) => b.equityUsd - a.equityUsd);
}

// ---------- top bar ----------

function renderTopbar() {
  const s = state.status;
  const lastOk = s.recentPolls.find((/** @type {any} */ p) => p.ok)?.ts ?? null;
  const ageSec = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
  const healthy = ageSec !== null && ageSec < 180;
  const when = ageSec === null ? 'not yet' : ageSec < 120 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
  const failed = s.lastCycle && !s.lastCycle.ok;
  const btn = /** @type {HTMLElement} */ (document.getElementById('health'));
  const light = /** @type {HTMLElement} */ (btn.querySelector('.health'));
  if (!s.live) {
    // Off until asked: the desktop icon starts Paper Lab with live data off.
    btn.title = 'Live data is off. Nothing is fetched or traded until you turn it on.';
    light.className = 'health off';
  } else {
    btn.title = [
      `${s.demo ? 'Demo' : 'Live'} data, last price update ${when}.`,
      healthy ? `Prices refresh every ${s.pollIntervalSec}s.` : 'No fresh prices for 3+ minutes. New trades pause until data comes back.',
      s.ai.enabled ? `AI scoring on (${s.ai.model}).` : '',
    ].join(' ');
    light.className = `health ${healthy && !failed ? 'ok' : 'bad'}`;
  }
  // The bar hides until hovered, but stays out while data is stale so the red dot is seen.
  document.querySelector('.topbar')?.classList.toggle('pinned', s.live && !(healthy && !failed));
  renderMenu();
  const r = route();
  const here = r.page === 'coins' || r.page === 'coin' ? 'coins' : r.page === 'guide' || r.page === 'notes' ? r.page : 'home';
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.getAttribute('data-nav') === here);
}

function renderMenu() {
  const m = /** @type {HTMLElement} */ (document.getElementById('menu'));
  const live = state.status.live;
  m.innerHTML = `<button type="button" role="menuitem" data-live="${live ? 'off' : 'on'}">${live ? 'Turn off live data' : 'Turn on live data'}</button>
    <button type="button" role="menuitem" data-reset>Start over at ${dollars(state.status.startingBankrollUsd ?? 1000)}…</button>
    <button type="button" role="menuitem" data-quit>Quit Paper Lab</button>`;
}

/** Pretend $1,000 split across the active strategies: the average of their balances. @param {any[]} rows */
function portfolioTick(rows) {
  if (!rows.length) return '';
  const avg = rows.reduce((a, r) => a + r.equityUsd, 0) / rows.length;
  const tip = [
    `Average balance of the ${rows.length} active strateg${rows.length === 1 ? 'y' : 'ies'}, including open trades${state.viewRun === null ? '' : ' (past run)'}:`,
    ...rows.map((r) => `${nameOf(r.strategy)}  ${dollars(r.equityUsd)}`),
  ].join('\n');
  return `<div class="tick total" title="${esc(tip)}"><span class="tick-name">Portfolio</span><span class="tick-v">${dollars(avg)}</span></div>`;
}

// ---------- runs ----------

const dayTime = (/** @type {number|null} */ ms) =>
  ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';

/** Runs numbered in the order they started. @returns {any[]} */
function runsInOrder() {
  return (state.status?.runs ?? []).map((/** @type {any} */ r, /** @type {number} */ i) => ({ ...r, n: i + 1 }));
}

/** The run a page is showing. */
function shownRun() {
  const runs = runsInOrder();
  const id = state.viewRun ?? state.status.runId;
  return runs.find((r) => r.id === id) ?? null;
}

/** Per-strategy settings of a run, also for runs recorded before strategies existed. @param {any} settings */
function runStrategies(settings) {
  if (settings.strategies) return settings.strategies;
  return Object.fromEntries(Object.entries(settings.signals ?? {}).map(([id, params]) => [id, { signal: id, params, exits: settings.trade ?? {} }]));
}

/** What a past run did differently from the current one, in words. @param {any} run */
function runDifferences(run) {
  const now = runsInOrder().find((r) => r.id === state.status.runId)?.settings;
  const a = run.settings;
  if (!now) return [];
  /** @type {string[]} */
  const out = [];
  if (a.engine !== now.engine && a.engine === 1) out.push('instant fills, no price impact');
  else if (a.engine !== now.engine) out.push('older trade simulation');
  const t = a.trade ?? {};
  const n = now.trade;
  if (t.sizeUsd !== undefined && t.sizeUsd !== n.sizeUsd) out.push(`$${t.sizeUsd} per trade`);
  if (t.stopLossPct !== undefined && t.stopLossPct !== n.stopLossPct) out.push(`stop at −${p100(t.stopLossPct)}`);
  if (t.takeProfitPct !== undefined && t.takeProfitPct !== n.takeProfitPct) out.push(`take profit at +${p100(t.takeProfitPct)}`);
  if (t.timeLimitMin !== undefined && t.timeLimitMin !== n.timeLimitMin) out.push(`${t.timeLimitMin} min limit`);
  if (t.feeRate !== undefined && (t.feeRate !== n.feeRate || t.slippageRate !== n.slippageRate)) out.push(`costs ${p100(t.feeRate)} fee + ${p100(t.slippageRate)} slippage`);
  // null means "not recorded". Only the first version truly had no floor.
  if (a.universe === null && a.engine === 1 && now.universe) out.push('no liquidity floor');
  else if (a.universe && a.universe.minLiquidityUsd !== now.universe.minLiquidityUsd) out.push(`coins with ${usd(a.universe.minLiquidityUsd)}+ liquidity`);
  const was = runStrategies(a);
  const is = runStrategies(now);
  for (const [id, st] of Object.entries(was)) {
    if (is[id] && JSON.stringify(is[id].params) !== JSON.stringify(st.params)) out.push(`different ${nameOf(id)} settings`);
  }
  return out;
}

/** Banner on pages showing a past run. */
function pastRunBanner() {
  const run = shownRun();
  if (!run || state.viewRun === null || run.id === state.status.runId) return '';
  const diff = runDifferences(run);
  const span = `${dayTime(run.startedAt)} to ${dayTime(run.lastActivityAt)}`;
  return `<div class="past-run">
    <div><b>Run ${run.n}, a past run</b> <span class="muted">· ${esc(span)}</span>
      <div class="secondary">${diff.length ? `Different from now: ${esc(diff.join(' · '))}.` : 'Same rules as now.'}${run.note && run.settings.engine === runsInOrder().find((r) => r.id === state.status.runId)?.settings.engine ? ` <span class="muted">${esc(run.note)}</span>` : ''}</div></div>
    <button type="button" data-run="current">Back to now</button>
  </div>`;
}

/**
 * Trades left out of the results because they were bought or sold on a price
 * reading that looked wrong. Quiet, but always said: a big win that isn't real
 * must not pass as one.
 * @param {any[]} [excluded]
 */
function dataNote(excluded) {
  if (!excluded?.length) return '';
  const off = excluded.filter((t) => t.kind === 'off');
  const bad = excluded.filter((t) => t.kind !== 'off');
  return noteFor(bad, () => 'bought or sold on a price reading that looked wrong', 'bad-prices') + noteFor(off, (one) => `open while Paper Lab was off, so nothing checked ${one ? 'its' : 'their'} stop or target`, 'time-off');
}

/** One line under the strip for one reason trades were left out. @param {any[]} list @param {(one: boolean) => string} why @param {string} anchor */
function noteFor(list, why, anchor) {
  if (!list.length) return '';
  const coins = [...new Set(list.map((t) => t.symbol))];
  const sum = list.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const detail = list.map((t) => `${nameOf(t.strategy === 'random' ? t.book.split(':')[1] ?? t.strategy : t.strategy)}${t.strategy === 'random' ? ' (random)' : ''}: ${t.symbol} ${t.pnlUsd === null ? 'open' : money(t.pnlUsd)}. ${t.reason}`).join('\n');
  const one = list.length === 1;
  const where = coins.length > 4 ? `${coins.length} coins` : esc(coins.join(', '));
  return `<div class="data-note" title="${esc(detail)}"><span class="flag-dot"></span>${list.length} trade${one ? '' : 's'} on ${where} left out: ${one ? 'it was' : 'they were'} ${why(one)}${sum ? ` (${money(sum)} not counted)` : ''}. <a href="#/guide/${anchor}">Why</a></div>`;
}

/** Which run the scoreboard shows, and where the earlier ones are. Quiet, at the end of the strip. */
function runMark() {
  const runs = runsInOrder();
  const run = runs.find((r) => r.id === state.status.runId);
  if (state.viewRun !== null || runs.length < 2 || !run) return '';
  return `<a class="run-mark" href="#/guide/past-runs" title="Changing a trading setting starts a new run with fresh balances. Earlier runs keep all their trades.">Run ${run.n} · since ${esc(clock(run.startedAt))} · Past runs</a>`;
}

/** Exits a strategy used in the run being shown. @param {string} id */
function shownExits(id) {
  const run = shownRun();
  const rec = run ? runStrategies(run.settings)[id] : null;
  return { ...state.status.trade, ...(strategyOf(id)?.trade ?? {}), ...(rec?.exits ?? {}) };
}

/** Switch to a run (null = now) and show its scoreboard. @param {number|null} id */
function openRun(id) {
  state.viewRun = id === state.status.runId ? null : id;
  state.results = null;
  if (route().page === 'home') void refresh();
  else location.hash = '#/';
}

// ---------- charts ----------

function destroyCharts() {
  for (const o of state.observers) o.disconnect();
  state.observers = [];
  for (const c of state.charts) c.remove();
  state.charts = [];
}

/**
 * Axis labels in the computer's own time zone (the chart library would show UTC).
 * @param {number} t  seconds  @param {number} type  0 year, 1 month, 2 day, 3 time, 4 time with seconds
 */
function localTick(t, type) {
  const d = new Date(t * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return d.toLocaleDateString([], { month: 'short' });
  if (type === 2) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** @param {HTMLElement} el @param {(v: any) => string} [priceFormatter] */
function baseChart(el, priceFormatter = price) {
  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: css('--bg') },
      textColor: css('--text-muted'),
      fontFamily: css('--mono'),
      fontSize: 11,
      attributionLogo: true,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: '#1b1d21' } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTick },
    crosshair: { mode: 0 },
    localization: { priceFormatter, timeFormatter: (/** @type {number} */ t) => new Date(t * 1000).toLocaleString() },
  });
  state.charts.push(chart);
  // After the window changes size, show the whole range again: the chart
  // library keeps the old scroll position, which can leave the lines off-screen.
  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => state.charts.includes(chart) && chart.timeScale().fitContent());
  });
  ro.observe(el);
  state.observers.push(ro);
  return chart;
}

/** Lightweight Charts needs strictly increasing times in seconds. @param {{t: number, v: number}[]} pts  t in ms */
function toSeries(pts) {
  /** @type {{time: number, value: number}[]} */
  const out = [];
  for (const p of pts) {
    const time = Math.floor(p.t / 1000);
    if (out.length && out[out.length - 1].time >= time) out[out.length - 1] = { time: out[out.length - 1].time, value: p.v };
    else out.push({ time, value: p.v });
  }
  return out;
}

/**
 * The average of several balance curves: at each close, every book's latest
 * balance (the start for a book with nothing closed yet), averaged.
 * @param {any[][]} curves  each [{t, equity}], oldest first
 * @param {number} start
 */
function averageCurve(curves, start) {
  // Balance-over-time lines share their moments, so they average point by point.
  if (curves.length && curves.every((c) => c.length && c.length === curves[0].length && c[0].t === curves[0][0].t)) {
    return curves[0].map((/** @type {any} */ p, /** @type {number} */ i) => ({ t: p.t, equity: curves.reduce((a, c) => a + c[i].equity, 0) / curves.length }));
  }
  const events = curves.flatMap((c, i) => c.map((p) => ({ t: p.t, i, v: p.equity }))).sort((a, b) => a.t - b.t);
  const now = curves.map(() => start);
  return events.map((e) => {
    now[e.i] = e.v;
    return { t: e.t, equity: now.reduce((a, b) => a + b, 0) / now.length };
  });
}

/** A book's balance over time, open trades as if sold at each moment; older servers sent finished trades only. @param {any} book */
function curveOf(book) {
  return book.valueCurve?.length ? book.valueCurve : book.equityCurve;
}

/** A book's balance at a moment: its latest change at or before it. @param {{t: number, v: number}[]} pts @param {number} t */
function balanceAt(pts, t) {
  let v = pts[0].v;
  for (const p of pts) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

/** The chart's time span: from the run's start to now, or to the run's last activity for a past run. @param {any} res */
function chartSpan(res) {
  return {
    from: res.clock?.startedAt ?? null,
    to: state.viewRun === null ? Date.now() : shownRun()?.lastActivityAt ?? null,
    spans: res.clock?.spans,
    gapMs: res.clock?.gapMs,
    range: RANGES[state.range] ?? null,
  };
}

/**
 * @typedef {Object} ChartLine
 * @property {string} color
 * @property {any[]} curve        [{t, equity}] at each close, oldest first.
 * @property {boolean} dashed     The random pickers' line.
 * @property {string} label
 * @property {any[]} [trades]     This line's trades, for buy and sell marks.
 * @property {number} [now]       Balance now with open trades counted as if sold, the same number as the strip.
 */

/** A #rrggbb color at some opacity. @param {string} hex @param {number} alpha */
function fade(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Linear value of a curve at time t. @param {{t: number, v: number}[]} pts @param {number} t */
function interpolate(pts, t) {
  let lo = 0;
  let hi = pts.length - 1;
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[hi].t) return pts[hi].v;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * @typedef {Object} TradeMark
 * @property {number} time   Seconds.
 * @property {number} value  Where on the price scale.
 * @property {boolean} sell
 * @property {string} color
 * @property {{time: number, value: number}} [from]  Its buy, for a sell: joined by a dotted hairline.
 * @property {string} [label]  Small text beside a sell.
 */

/**
 * Buy and sell marks drawn on the line itself: a hollow ring where a coin was
 * bought, a solid dot where it was sold, a faint dotted hairline between the
 * two. Drawn in device pixels so they stay crisp, and never stacked off the
 * line the way the chart library's own markers are.
 */
class TradeMarks {
  /** @param {TradeMark[]} marks @param {number[]} times  The series' times, oldest first: marks snap to the nearest. */
  constructor(marks, times) {
    this.marks = marks;
    this.times = times;
    /** @type {any} */ this.chart = null;
    /** @type {any} */ this.series = null;
    this.views = [{ zOrder: () => 'top', renderer: () => ({ draw: (/** @type {any} */ target) => this.draw(target) }) }];
  }
  /** @param {any} p */
  attached(p) {
    this.chart = p.chart;
    this.series = p.series;
  }
  detached() {
    this.chart = null;
    this.series = null;
  }
  paneViews() {
    return this.views;
  }
  /** Nearest time the series has a point at. @param {number} t */
  snap(t) {
    const ts = this.times;
    let lo = 0;
    let hi = ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid;
    }
    return Math.abs(ts[hi] - t) < Math.abs(t - ts[lo]) ? ts[hi] : ts[lo];
  }
  /** Bitmap position of a point, or null when off the chart. @param {{time: number, value: number}} p @param {any} s */
  xy(p, s) {
    if (!this.chart || !this.series || !this.times.length) return null;
    const x = this.chart.timeScale().timeToCoordinate(this.snap(p.time));
    const y = this.series.priceToCoordinate(p.value);
    return x === null || y === null ? null : { x: x * s.horizontalPixelRatio, y: y * s.verticalPixelRatio };
  }
  /** @param {any} target */
  draw(target) {
    target.useBitmapCoordinateSpace((/** @type {any} */ s) => {
      const ctx = /** @type {CanvasRenderingContext2D} */ (s.context);
      const r = s.horizontalPixelRatio;
      const bg = css('--bg');
      ctx.lineWidth = Math.max(1, Math.round(r));
      ctx.setLineDash([2 * r, 2 * r]);
      for (const m of this.marks) {
        const to = this.xy(m, s);
        const from = m.from && this.xy(m.from, s);
        if (!to || !from) continue;
        ctx.strokeStyle = fade(m.color, 0.5);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Buys first, so a sell at the same moment draws on top.
      for (const m of [...this.marks].sort((a, b) => Number(a.sell) - Number(b.sell))) {
        const p = this.xy(m, s);
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (m.sell ? 3.5 : 4) * r, 0, Math.PI * 2);
        ctx.fillStyle = m.sell ? m.color : bg;
        ctx.fill();
        ctx.lineWidth = 1.5 * r;
        ctx.strokeStyle = m.sell ? bg : m.color;
        ctx.stroke();
        if (!m.sell) continue;
        // A thin outer ring in the line's color keeps the dot readable where it sits on the line.
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * r, 0, Math.PI * 2);
        ctx.lineWidth = r;
        ctx.strokeStyle = m.color;
        ctx.stroke();
        if (m.label) {
          ctx.font = `${10 * r}px ${css('--mono')}`;
          ctx.fillStyle = css('--text-secondary');
          ctx.textBaseline = 'middle';
          ctx.fillText(m.label, p.x + 7 * r, p.y);
        }
      }
    });
  }
}

/**
 * Where the chart skips time Paper Lab wasn't collecting: a faint dashed
 * line with how long, e.g. "off 6.2h". And at the right edge, how long it's
 * been off right now.
 */
class GapMarks {
  /** @param {{at: number, ms: number}[]} gaps @param {number} offFor @param {number[]} grid */
  constructor(gaps, offFor, grid) {
    this.gaps = gaps;
    this.offFor = offFor;
    this.grid = grid;
    /** @type {any} */ this.chart = null;
    this.views = [{ zOrder: () => 'bottom', renderer: () => ({ draw: (/** @type {any} */ target) => this.draw(target) }) }];
  }
  /** @param {any} p */
  attached(p) {
    this.chart = p.chart;
  }
  detached() {
    this.chart = null;
  }
  paneViews() {
    return this.views;
  }
  /** @param {any} target */
  draw(target) {
    target.useBitmapCoordinateSpace((/** @type {any} */ s) => {
      if (!this.chart) return;
      const ctx = /** @type {CanvasRenderingContext2D} */ (s.context);
      const r = s.horizontalPixelRatio;
      const ts = this.chart.timeScale();
      ctx.font = `${10 * r}px ${css('--mono')}`;
      ctx.textBaseline = 'top';
      const label = (/** @type {string} */ text, /** @type {number} */ x, /** @type {boolean} */ left) => {
        const w = ctx.measureText(text).width;
        ctx.fillStyle = css('--bg');
        const pad = 6 * r;
        // Kept inside the pane so a gap near either edge still reads.
        const lx = Math.max(pad, Math.min(s.bitmapSize.width - w - pad, left ? x - w - pad : x - w / 2));
        // Along the bottom edge, clear of the time view buttons and the corner feed.
        const y = s.bitmapSize.height - 20 * s.verticalPixelRatio;
        ctx.fillRect(lx - 3 * r, y - 2 * r, w + 6 * r, 14 * r);
        ctx.fillStyle = css('--text-muted');
        ctx.fillText(text, lx, y);
      };
      for (const g of this.gaps) {
        const a = ts.timeToCoordinate(this.grid[g.at]);
        const b = ts.timeToCoordinate(this.grid[g.at + 1]);
        if (a === null || b === null) continue;
        const x = Math.round(((a + b) / 2) * r) + 0.5;
        ctx.strokeStyle = css('--chart-start');
        ctx.lineWidth = r;
        ctx.setLineDash([3 * r, 3 * r]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, s.bitmapSize.height);
        ctx.stroke();
        ctx.setLineDash([]);
        label(`off ${duration(g.ms)}`, x, false);
      }
      if (this.offFor) {
        const x = ts.timeToCoordinate(this.grid[this.grid.length - 1]);
        if (x !== null) label(`off ${duration(this.offFor)}`, x * r, true);
      }
    });
  }
}

/** Chart time views: the latest stretch of collecting time of this length. null shows the whole run. */
const RANGES = /** @type {Record<string, number|null>} */ ({ '15m': 15 * 60_000, '1h': 3600_000, '4h': 4 * 3600_000, All: null });

/** The time view buttons, in the chart's top right. */
function rangePick() {
  return `<div class="range-pick" role="group" aria-label="Time view">${Object.keys(RANGES)
    .map((k) => `<button type="button" data-range="${k}" class="${state.range === k ? 'on' : ''}">${k}</button>`)
    .join('')}</div>`;
}

/** Only the latest buys and sells get a mark, so the chart stays readable; hovering shows any moment's. */
const CHART_MARKS = 12;
/** The latest few also scroll by in the chart's corner, with tickers, like a game's kill feed. */
const FEED_ITEMS = 5;

/**
 * Balance over time, one line per book. Every line starts at the bankroll when
 * the run starts and is carried flat to the end, so all lines share both edges.
 * The chart library spaces points evenly, so every line is sampled on one even
 * time grid: equal widths mean equal time.
 * @param {HTMLElement} el
 * @param {ChartLine[]} lines
 * @param {number} start  Bankroll every book starts with.
 * @param {{from?: number|null, to?: number|null, spans?: [number, number][], gapMs?: number, range?: number|null}} [span]
 *   Run start and end (ms), the stretches Paper Lab was collecting, and the time view.
 */
function balanceChart(el, lines, start, span = {}) {
  const moved = (/** @type {number|undefined} */ v) => v !== undefined && Math.abs(v - start) >= 0.005;
  if (!lines.some((l) => l.trades?.length || moved(l.now) || l.curve.some((p) => moved(p.equity)))) {
    const earlier = state.viewRun === null && runsInOrder().length > 1 ? ' Earlier results are under <a href="#/guide/past-runs">Past runs</a>.' : '';
    el.innerHTML = `<div class="empty chart-empty">No trades yet in this run.${earlier}</div>`;
    return;
  }
  const times = lines.flatMap((l) => l.curve.map((p) => p.t));
  const from = Math.min(span.from ?? Infinity, ...times, (span.to ?? Date.now()) - 60_000);
  const to = Math.max(span.to ?? -Infinity, ...times, from + 60_000);
  // Only time Paper Lab was collecting prices is drawn. Stretches it was off
  // (computer asleep, app closed) are skipped and marked, not drawn as flat lines.
  /** @type {[number, number][]} */
  let parts = (span.spans ?? []).map(([s, e]) => /** @type {[number, number]} */ ([Math.max(s, from), Math.min(e, to)])).filter(([s, e]) => e > s);
  if (!parts.length) parts = [[from, to]];
  // A time view shows the latest stretch of collecting time of that length.
  if (span.range) {
    let keep = span.range;
    /** @type {[number, number][]} */
    const recent = [];
    for (let i = parts.length - 1; i >= 0 && keep > 0; i--) {
      const [s, e] = parts[i];
      const s2 = Math.max(s, e - keep);
      recent.unshift([s2, e]);
      keep -= e - s2;
    }
    parts = recent;
  }
  const total = parts.reduce((a, [s, e]) => a + (e - s), 0);
  const steps = Math.min(800, Math.max(2, Math.ceil(total / 15_000)));
  const stepMs = total / steps;
  /** @type {number[]} Grid times in whole seconds, strictly increasing. */
  const grid = [];
  /** @type {{at: number, ms: number}[]} Skipped stretches: after which grid point, and how long. */
  const gaps = [];
  parts.forEach(([s, e], i) => {
    if (i > 0) gaps.push({ at: grid.length - 1, ms: s - parts[i - 1][1] });
    const k = Math.max(1, Math.round((steps * (e - s)) / total));
    for (let j = 0; j <= k; j++) {
      const sec = Math.floor((s + ((e - s) * j) / k) / 1000);
      if (!grid.length || sec > grid[grid.length - 1]) grid.push(sec);
    }
  });
  const windowFrom = parts[0][0];
  // Off right now (live data off, or the computer asleep): say since when.
  const offFor = to - parts[parts.length - 1][1] > (span.gapMs ?? 5 * 60_000) ? to - parts[parts.length - 1][1] : 0;
  /** A line's points from the run start to the end, finishing at its balance now. @param {ChartLine} l */
  const realPoints = (l) => {
    const last = l.curve.length ? l.curve[l.curve.length - 1].equity : start;
    const real = [{ t: from, v: start }, ...l.curve.map((/** @type {any} */ p) => ({ t: p.t, v: p.equity }))];
    // The last step is open trades as if sold now, so the line ends where the strip's number is.
    const end = grid[grid.length - 1] * 1000;
    if (l.now !== undefined && Math.abs(l.now - last) >= 0.005 && end > real[real.length - 1].t) {
      real.push({ t: Math.max(real[real.length - 1].t, end - stepMs), v: last }, { t: end, v: l.now });
    }
    real.push({ t: Math.max(to, end), v: real[real.length - 1].v });
    return real;
  };
  /** The grid point nearest a moment. @param {number} ms */
  const gridIndex = (ms) => {
    const sec = ms / 1000;
    let lo = 0;
    let hi = grid.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] <= sec) lo = mid;
      else hi = mid;
    }
    return Math.abs(grid[hi] - sec) < Math.abs(sec - grid[lo]) ? hi : lo;
  };

  const fmt = (/** @type {number} */ v) => dollars(v);
  const chart = baseChart(el, fmt);
  chart.applyOptions({
    grid: { vertLines: { visible: false }, horzLines: { color: css('--chart-grid') } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
    crosshair: {
      mode: 0,
      vertLine: { color: css('--text-muted'), width: 1, style: 3, labelVisible: false },
      horzLine: { visible: false, labelVisible: false },
    },
    handleScale: { axisPressedMouseMove: false },
  });

  // Buy and sell events, newest first.
  /** @type {{t: number, sell: boolean, line: ChartLine, trade: any}[]} */
  const events = [];
  for (const l of lines) {
    for (const t of l.trades ?? []) {
      if (t.dataFlag) continue;
      if (t.openedAt && t.openedAt >= windowFrom) events.push({ t: t.openedAt, sell: false, line: l, trade: t });
      if (t.closedAt && t.status === 'closed' && t.closedAt >= windowFrom) events.push({ t: t.closedAt, sell: true, line: l, trade: t });
    }
  }
  events.sort((a, b) => b.t - a.t);
  const marked = new Set(events.slice(0, CHART_MARKS));

  /** @type {{series: any, line: ChartLine, real: {t: number, v: number}[]}[]} */
  const drawn = [];
  // Random line first, so the strategies draw on top of it.
  const ordered = [...lines].sort((a, b) => Number(b.dashed) - Number(a.dashed));
  const sampled = ordered.map((l) => realPoints(l));
  // Strategies with the same entries (a fast and a slow variant of one rule) can
  // share a line until their exits differ. The one on top draws in long dashes,
  // so the line underneath shows through the gaps in its own color.
  const onTop = new Set();
  sampled.forEach((pts, i) => {
    if (ordered[i].dashed) return;
    for (let j = i + 1; j < ordered.length; j++) {
      // Only where at least one has moved off the start: every line is flat there before its first trade.
      let moved = 0;
      let same = 0;
      for (const sec of grid) {
        const a = interpolate(pts, sec * 1000);
        const b = interpolate(sampled[j], sec * 1000);
        if (Math.abs(a - start) < 0.5 && Math.abs(b - start) < 0.5) continue;
        moved++;
        if (Math.abs(a - b) < 0.5) same++;
      }
      if (same >= 2 && same > moved * 0.3) onTop.add(j);
    }
  });
  ordered.forEach((l, i) => {
    const real = sampled[i];
    const series = chart.addSeries(LWC.LineSeries, {
      color: l.dashed ? css('--chart-random') : l.color,
      lineWidth: 1,
      lineStyle: l.dashed ? 2 : onTop.has(i) ? 3 : 0,
      priceLineVisible: false,
      lastValueVisible: !l.dashed,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: fmt, minMove: 0.01 },
    });
    series.setData(grid.map((sec) => ({ time: sec, value: interpolate(real, sec * 1000) })));
    drawn.push({ series, line: l, real });
  });
  // Buys and sells sit on the line itself, at the balance at that moment.
  /** @param {typeof events[number]} e */
  const at = (e) => {
    const sec = grid[gridIndex(e.t)];
    const d = drawn.find((x) => x.line === e.line);
    return { time: sec, value: d ? interpolate(d.real, sec * 1000) : start };
  };
  /** @type {TradeMark[]} */
  const marks = [];
  for (const e of marked) {
    const buy = e.sell ? [...marked].find((b) => !b.sell && b.trade === e.trade) : undefined;
    marks.push({ ...at(e), sell: e.sell, color: e.line.color, from: buy ? at(buy) : undefined });
  }
  drawn[drawn.length - 1].series.attachPrimitive(new TradeMarks(marks, grid));
  if (gaps.length || offFor) drawn[0].series.attachPrimitive(new GapMarks(gaps, offFor, grid));
  // Where every book started: a faint reference line at the bankroll.
  drawn[0].series.createPriceLine({ price: start, color: css('--chart-start'), lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
  chart.timeScale().fitContent();

  /** @param {typeof events[number]} e */
  const eventRow = (e) =>
    `<div class="tip-row"><span class="rule-name"><span class="mk ${e.sell ? 'sell' : 'buy'}" style="--c:${e.line.color}"></span><b class="sym">${esc(e.trade.symbol)}</b><span class="muted">${esc(e.line.label)}</span></span>${
      e.sell ? `<b class="${tone(e.trade.pnlPct)}">${pct(e.trade.pnlPct, 0)}</b>` : '<span class="muted">buy</span>'
    }</div>`;
  const feed = document.createElement('div');
  feed.className = 'chart-feed';
  feed.innerHTML = events
    .slice(0, FEED_ITEMS)
    .map(eventRow)
    .join('');
  if (events.length) el.parentElement?.appendChild(feed);

  // Hover: one quiet panel with every line's balance at that moment, best
  // first, then the buys and sells right under the cursor.
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  el.parentElement?.appendChild(tip);
  chart.subscribeCrosshairMove((/** @type {any} */ p) => {
    if (!p?.time || !p.point || p.point.x < 0) {
      tip.hidden = true;
      feed.hidden = false;
      return;
    }
    feed.hidden = true;
    const ms = p.time * 1000;
    const rows = drawn
      .map((d) => ({ line: d.line, v: balanceAt(d.real, ms) }))
      .sort((a, b) => Number(a.line.dashed) - Number(b.line.dashed) || b.v - a.v);
    const ts = chart.timeScale();
    const near = (/** @type {number} */ dx) => ts.coordinateToTime(p.point.x + dx);
    const lo = (near(-6) ?? p.time) * 1000 - stepMs / 2;
    const hi = (near(6) ?? p.time) * 1000 + stepMs / 2;
    const here = events.filter((e) => e.t >= lo && e.t <= hi).slice(0, 6);
    tip.innerHTML = `<div class="tip-time">${esc(new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</div>${rows
      .map(
        (r) => `<div class="tip-row${r.line.dashed ? ' muted' : ''}"><span class="rule-name">${r.line.dashed ? '<span class="key-dash"></span>' : `<span class="dot" style="background:${r.line.color}"></span>`}${esc(r.line.label)}</span><b style="${r.line.dashed ? '' : `color:${r.line.color}`}">${dollars(r.v)}</b></div>`,
      )
      .join('')}${here.length ? `<div class="tip-trades">${here.map(eventRow).join('')}</div>` : ''}`;
    tip.hidden = false;
    // Keep the panel on the side away from the cursor.
    const left = p.point.x < el.clientWidth / 2;
    tip.style.left = left ? '' : '12px';
    tip.style.right = left ? '72px' : '';
  });
}

/**
 * @param {HTMLElement} el
 * @param {any[]} snapshots
 * @param {any[]} trades
 */
function priceChart(el, snapshots, trades) {
  const chart = baseChart(el);
  const series = chart.addSeries(LWC.LineSeries, {
    color: css('--text-primary'),
    lineWidth: 1,
    priceFormat: { type: 'custom', formatter: price, minMove: 1e-12 },
  });
  const data = toSeries(snapshots.map((s) => ({ t: s.ts, v: s.priceUsd })));
  series.setData(data);
  const first = data.length ? data[0].time : 0;
  /** @type {TradeMark[]} */
  const marks = [];
  for (const t of trades) {
    if (!t.openedAt || t.entryPrice === null || t.dataFlag) continue;
    const color = t.strategy === 'random' ? css('--baseline') : colorOf(t.strategy);
    const buy = { time: Math.floor(t.openedAt / 1000), value: t.entryPrice };
    if (buy.time >= first) marks.push({ ...buy, sell: false, color });
    if (t.closedAt && t.exitPrice !== null) {
      marks.push({ time: Math.floor(t.closedAt / 1000), value: t.exitPrice, sell: true, color, from: buy.time >= first ? buy : undefined, label: pct(t.pnlPct, 0) });
    }
  }
  series.attachPrimitive(new TradeMarks(marks, data.map((d) => d.time)));
  chart.timeScale().fitContent();
  const readout = /** @type {HTMLElement|null} */ (el.parentElement?.querySelector('.readout') ?? null);
  chart.subscribeCrosshairMove((/** @type {any} */ p) => {
    const v = p?.seriesData?.get(series);
    if (readout) readout.textContent = v ? `${new Date(p.time * 1000).toLocaleTimeString()}  ${price(v.value)}` : '';
  });
}

// ---------- shared pieces ----------

// The HUD reads left to right by importance: the portfolio, then each
// strategy's profit in its chart color, most first. Everything else is in the
// hover text; explanations live on the Guide.

/** Big number: how far ahead of random. Whole dollars on cards, cents on the strategy page. @param {any} r */
function heroNumber(r, cents = false) {
  const e = edgeUsd(r);
  const none = r.all.closed === 0 && r.twin.all.closed === 0;
  const shown = cents ? Math.round(e * 100) / 100 : Math.round(e);
  const n = shown === 0 ? '$0' : cents ? money(e) : `${e > 0 ? '+' : '−'}${dollars(Math.abs(e))}`;
  return `<div class="hero ${none ? 'muted' : tone(shown)}" title="Profit minus its random picker's profit (closed trades): ${money(e)}">${none ? '$0' : n}<span class="hero-unit">vs random</span></div>`;
}

/** Status line and its bar. @param {any} r */
function statusLine(r) {
  const st = statusOf(r);
  return `<div class="status ${st.cls}" title="${esc(checksTip(r))}">${esc(st.text)}</div>
    <div class="bar ${st.cls}"><span style="width:${(Math.min(1, st.fill) * 100).toFixed(1)}%"></span></div>`;
}

/** Whole signed dollars, e.g. "+$83", "−$12", "$0". @param {number} n */
const signedDollars = (n) => (Math.round(n) === 0 ? '$0' : `${n > 0 ? '+' : '−'}${dollars(Math.abs(n))}`);

/** Card details that would clutter the card, for its hover text. @param {any} r */
function cardTip(r) {
  const s = strategyOf(r.strategy);
  const open = r.open + r.pending;
  return [
    `${nameOf(r.strategy)}${s ? ` · ${ruleName(s.rule)} · ${exitsText(s.trade)}` : ''}`,
    `Balance ${dollars(r.equityUsd)} (open trades counted as if sold now)`,
    `${money(edgeUsd(r))} vs its random picker (finished trades)`,
    `${r.all.closed} finished${r.all.closed ? `, ${share(r.all.winRate)} won` : ''}${open ? ` · ${open} open` : ''}`,
    '',
    statusOf(r).text,
    ...(r.checks ?? []).map((/** @type {any} */ x) => `${x.pass ? '✓' : '✗'} ${x.label} (${x.detail})`),
  ].join('\n');
}

/** One strategy in the strip: code-name and profit, in its chart color. Details on hover. @param {any} r */
function strategyTick(r) {
  return `<a class="tick" href="#/rule/${esc(r.strategy)}" style="--c:${colorOf(r.strategy)}" title="${esc(cardTip(r))}">
    <span class="tick-name">${esc(nameOf(r.strategy))}</span><span class="tick-v">${signedDollars(pnlOf(r))}</span>
  </a>`;
}

/**
 * Collapsible panel that remembers whether it was open.
 * @param {string} key @param {string} title @param {string} body @param {boolean} [openByDefault]
 */
function panel(key, title, body, openByDefault = true) {
  const v = load(`panel:${key}`);
  const open = v === null ? openByDefault : v === '1';
  return `<details class="panel" data-panel="${esc(key)}" data-open="${open ? 1 : 0}" ${open ? 'open' : ''}><summary>${title}</summary><div class="panel-body">${body}</div></details>`;
}

/** One-line plain explanation of how a trade ended (or where it stands). @param {any} t */
function outcome(t) {
  const base = outcomeText(t);
  // Bought or sold on a price reading the sanity check doesn't trust, or open while Paper Lab was off: shown, but not counted.
  const why = t.dataFlagKind === 'off' ? 'open while off' : 'bad price reading';
  return t.dataFlag ? `<s class="muted">${base}</s> <span class="flag-note" title="${esc(t.dataFlag)}">left out: ${why}</span>` : base;
}

/** @param {any} t */
function outcomeText(t) {
  if (t.status === 'pending') return '<span class="secondary">buying at next price check</span>';
  if (t.status === 'cancelled') {
    return `<span class="muted">skipped: ${esc(
      { chased: 'price jumped 5%+ before it could buy', no_data: 'no fresh price to buy at', twin_cancelled: 'its strategy skipped too', bad_price: 'price reading looked wrong' }[
        /** @type {'chased'|'no_data'|'twin_cancelled'|'bad_price'} */ (t.cancelReason)
      ] ?? t.cancelReason,
    )}</span>`;
  }
  if (t.status === 'open' && shownRun()?.origin === 'imported') return '<span class="muted">still open when that version stopped</span>';
  if (t.status === 'open') {
    return `open ${duration(Date.now() - t.openedAt)}${t.markPct !== null && t.markPct !== undefined ? ` · now <span class="${tone(t.markPct)}">${pct(t.markPct)}</span>` : ''}`;
  }
  const how = { take_profit: 'take profit', stop_loss: 'stop loss', time_limit: 'time limit', no_data: 'no data', collapsed: 'coin collapsed' }[
    /** @type {'take_profit'|'stop_loss'|'time_limit'|'no_data'|'collapsed'} */ (t.exitReason)
  ];
  return `<span class="${tone(t.pnlUsd)}">${pct(t.pnlPct)} ${money(t.pnlUsd)}</span> <span class="muted">· ${esc(how ?? t.exitReason)} after ${duration(t.closedAt - t.openedAt)}</span>`;
}

/** @param {any[]} trades @param {{showWhy?: boolean}} [opts] */
function tradeRows(trades, opts = {}) {
  if (!trades.length) return `<div class="empty">None yet.</div>`;
  return `<table class="t compact"><tbody>${trades
    .map(
      (t) => `<tr class="link" data-href="#/coin/${encodeURIComponent(t.poolAddress)}">
        <td class="muted mono">${clock(t.openedAt ?? t.signalAt)}</td>
        <td><b>${esc(t.symbol)}</b></td>
        <td class="wrap">${outcome(t)}</td>
        ${opts.showWhy ? `<td class="wrap muted">${t.why ? esc(t.why) : ''}</td>` : ''}
      </tr>`,
    )
    .join('')}</tbody></table>`;
}


// ---------- pages ----------

/** @param {HTMLElement} view */
async function scoreboardPage(view) {
  const res = state.results;
  const rows = shownStrategies(res.strategies);
  const ids = new Set(rows.map((r) => r.strategy));
  const [trades, coins, hot] = await Promise.all([
    getJson(forRun('/api/trades?limit=5000')),
    getJson(forRun(`/api/coin-results?strategies=${encodeURIComponent([...ids].join(','))}`)),
    // "Hot now" is about this moment, so only for the current run.
    state.viewRun === null ? getJson('/api/hot') : Promise.resolve(null),
  ]);
  const mine = trades.filter((/** @type {any} */ t) => t.strategy !== 'random' && ids.has(t.strategy));
  const openCount = mine.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending').length;
  const offNow = !state.status.live && state.viewRun === null;

  // The first screen is the cards and the chart; the chart stretches to fill it, so Trades starts below the fold.
  view.innerHTML = `<div class="page wide">
    <div class="first-screen">
      ${pastRunBanner()}
      ${rows.length ? `<div class="ticks">${portfolioTick(rows)}${rows.map(strategyTick).join('')}${runMark()}</div>` : '<div class="empty">No active strategies.</div>'}
      ${dataNote(res.excluded)}
      <div class="chart-row">
        <div class="chart-box fill">
          <div class="chart" id="balance"></div>
          ${rangePick()}
          ${offNow ? '<div class="overlay"><button type="button" class="btn-live big" data-live="on">Turn On Live Data</button></div>' : ''}
        </div>
        ${coinSide(coins, hot, offNow)}
      </div>
    </div>
    ${panel('trades', `Trades <span class="count">${openCount ? `${openCount} open` : ''}</span>`, tradesList(mine), false)}
    ${calibrationBlock(res.calibration)}
  </div>`;

  const el = document.getElementById('balance');
  if (!el) return;
  /** @type {{color: string, curve: any[], dashed: boolean}[]} */
  /** @type {ChartLine[]} */
  const lines = rows.map((r) => ({
    color: colorOf(r.strategy),
    curve: curveOf(r),
    dashed: false,
    label: nameOf(r.strategy),
    trades: mine.filter((/** @type {any} */ t) => t.strategy === r.strategy),
    now: r.equityUsd,
  }));
  const randoms = rows.map((r) => curveOf(r.twin));
  const randomNow = rows.reduce((a, r) => a + r.twin.equityUsd, 0) / Math.max(1, rows.length);
  if (randoms.some((c) => c.length) || Math.abs(randomNow - res.startingBankrollUsd) >= 0.005) {
    lines.push({ color: '', curve: averageCurve(randoms, res.startingBankrollUsd), dashed: true, label: 'Random (average)', now: randomNow });
  }
  balanceChart(el, lines, res.startingBankrollUsd, chartSpan(res));
}

/** Different coins can share a ticker; tell them apart by the end of their pool address. @param {any[]} coins */
function coinNamer(coins) {
  const seen = new Map();
  for (const c of coins) seen.set(c.symbol.toLowerCase(), (seen.get(c.symbol.toLowerCase()) ?? 0) + 1);
  return (/** @type {any} */ c) =>
    `<b title="${esc(c.poolAddress)}">${esc(c.symbol)}</b>${seen.get(c.symbol.toLowerCase()) > 1 ? ` <span class="muted mono addr">…${esc(c.poolAddress.slice(-4))}</span>` : ''}`;
}

/** Below this many finished trades a hit rate says too little to show (MIN_TRADES_FOR_VERDICT in stats.js). */
const MIN_TRADES = 10;

/** How a strategy's measured odds read in one line. @param {any} o */
function oddsLine(o) {
  const tp = strategyOf(o.strategy)?.trade?.takeProfitPct;
  const h = o.hit;
  if (h.n < MIN_TRADES) return `<span class="muted">${esc(nameOf(o.strategy))}: too few trades to tell (${h.n})</span>`;
  return `${esc(nameOf(o.strategy))} hits ${tp ? `+${p100(tp)}` : 'take profit'}: <b>${share(h.rate)}</b> <span class="muted">of ${h.n}${o.random.n ? ` · random ${share(o.random.rate)}` : ''}</span>`;
}

/** The full story of one strategy's odds, for the hover text. @param {any} o */
function oddsDetail(o) {
  const t = strategyOf(o.strategy)?.trade;
  const h = o.hit;
  const r = o.random;
  const exits = t ? `reached +${p100(t.takeProfitPct)} before −${p100(t.stopLossPct)} or ${t.timeLimitMin} min` : 'reached take profit';
  const range = h.ci ? `, likely between ${share(h.ci[0])} and ${share(h.ci[1])}` : '';
  return `${nameOf(o.strategy)}: its buys ${exits} in ${h.hits} of ${h.n} finished trades${h.n ? ` (${share(h.rate)}${range})` : ''}. Its random picker: ${r.hits} of ${r.n}${r.n ? ` (${share(r.rate)})` : ''}.`;
}

/**
 * Coins the strategies are buying right now, with the measured odds of the
 * best strategy behind each: what a person checks before deciding by hand.
 * @param {{windowMin: number, coins: any[], more: number}} hot
 * @param {boolean} offNow
 */
function hotSection(hot, offNow) {
  const name = coinNamer(hot.coins);
  const rows = hot.coins
    .slice(0, 5)
    .map((c) => {
      const tip = [
        `${c.symbol}: ${c.rules > 1 ? `${c.rules} different rules agree` : 'one rule'} (${c.strategies.map(nameOf).join(', ')}).`,
        `First signal ${ago(c.firstAt)} ago at ${price(c.priceAtFirst)}${c.priceNow !== null ? `, now ${price(c.priceNow)} (${pct(c.movePct)})` : ''}.`,
        '',
        ...c.odds.map(oddsDetail),
        '',
        'Measured from past paper trades, not a promise. Check the chart before buying.',
      ].join('\n');
      return `<a class="hot-row" href="#/coin/${encodeURIComponent(c.poolAddress)}" title="${esc(tip)}">
        <span class="hot-top">${name(c)}<span class="holders">${c.strategies.map((/** @type {string} */ id) => dot(id)).join('')}</span>${c.rules > 1 ? `<span class="hot-agree">${c.rules} rules</span>` : ''}<span class="hot-ago">${ago(c.firstAt)}</span><b class="hot-move ${tone(c.movePct)}">${c.movePct === null ? '' : pct(c.movePct, 0)}</b></span>
        <span class="hot-odds">${oddsLine(c.odds[0])}</span>
      </a>`;
    })
    .join('');
  const empty = offNow ? 'Live data is off.' : `Nothing signaled in the last ${hot.windowMin} min.`;
  const more = hot.coins.length - 5 + hot.more;
  return `<section class="hot">
    <div class="side-head"><span>Hot now</span><span class="side-sub" title="Coins a strategy's rule fired on in the last ${hot.windowMin} minutes, most rules agreeing first, then the best measured odds. Odds are how often that strategy's past trades reached take profit.">last ${hot.windowMin} min</span></div>
    ${rows || `<div class="empty">${empty}</div>`}${more > 0 ? `<div class="hot-more muted">${more} more firing</div>` : ''}
  </section>`;
}

/**
 * Best coins beside the chart: what the strategies are buying and how it's
 * going, best first. Dots show which strategies bought it; the rest is on the Coins page.
 * @param {any[]} coins
 */
function coinSide(coins, /** @type {any} */ hot = null, offNow = false) {
  const name = coinNamer(coins);
  const rows = coins
    .slice(0, 30)
    .map(
      (c, i) => `<a class="side-row" href="#/coin/${encodeURIComponent(c.poolAddress)}" title="${c.trades} trade${c.trades === 1 ? '' : 's'}${c.closed ? `, ${c.wins} of ${c.closed} finished ones made money` : ''}${c.open ? `, ${c.open} open` : ''}. Profit counts open trades as if sold now, after costs.">
        <span class="side-n">${i + 1}</span>
        <span class="side-coin">${name(c)}<span class="holders">${c.strategies.map((/** @type {string} */ id) => dot(id)).join('')}</span></span>
        <span class="side-open">${c.open ? `${c.open} open` : ''}</span>
        <b class="side-pnl ${tone(Math.round(c.pnlUsd))}">${signedDollars(c.pnlUsd)}</b>
      </a>`,
    )
    .join('');
  return `<aside class="coin-side">
    ${hot ? hotSection(hot, offNow) : ''}
    <div class="side-head"><span>Best coins</span><a href="#/coins">All ${coins.length} →</a></div>
    <div class="side-list">${rows || '<div class="empty">No coins bought yet.</div>'}</div>
  </aside>`;
}

/**
 * The coins the strategies bought, best first: profit from closed trades plus
 * what open ones would make if sold now.
 * @param {any[]} coins @param {number} limit
 */
function coinTable(coins, limit) {
  if (!coins.length) return `<div class="empty">No coins bought yet.</div>`;
  const name = coinNamer(coins);
  return `<table class="t compact coin-rank"><thead><tr>
      <th class="num">#</th><th>Coin</th><th class="num">Trades</th><th class="num" title="Closed trades that made money">Won</th><th class="num">Open</th>
      <th class="num" title="Closed profit plus open trades if sold now, after costs">Profit</th><th class="num">Last</th>
    </tr></thead><tbody>${coins
      .slice(0, limit)
      .map(
        (c, i) => `<tr class="link" data-href="#/coin/${encodeURIComponent(c.poolAddress)}">
        <td class="num muted">${i + 1}</td>
        <td>${name(c)} <span class="holders">${c.strategies.map((/** @type {string} */ id) => `<span title="${esc(nameOf(id))}">${dot(id)}</span>`).join('')}</span></td>
        <td class="num">${c.trades}</td>
        <td class="num">${c.closed ? `${c.wins}/${c.closed}` : '–'}</td>
        <td class="num">${c.open || ''}</td>
        <td class="num big ${tone(Math.round(c.pnlUsd * 100))}">${money(c.pnlUsd)}</td>
        <td class="num muted">${clock(c.lastAt)}</td>
      </tr>`,
      )
      .join('')}</tbody></table>${coins.length > limit ? (route().page === 'coins' ? `<button type="button" class="btn-link more-btn" data-coins-all>Show all ${coins.length}</button>` : `<div class="muted more">${coins.length - limit} more on the Coins page</div>`) : ''}`;
}

/** Open trades first, best first, then the last 10 closed. Each trade once. @param {any[]} trades */
function tradesList(trades) {
  const open = trades.filter((t) => t.status === 'open' || t.status === 'pending').sort((a, b) => (b.markPct ?? -1e9) - (a.markPct ?? -1e9));
  const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => b.closedAt - a.closedAt).slice(0, 10);
  if (!open.length && !closed.length) return `<div class="empty">Waiting for the first trade.</div>`;
  const row = (/** @type {any} */ t, /** @type {string} */ right) => `<tr class="link" data-href="#/coin/${encodeURIComponent(t.poolAddress)}">
      <td><span class="rule-name">${dot(t.strategy)}<b>${esc(t.symbol)}</b><span class="muted">${esc(nameOf(t.strategy))}</span></span></td>
      ${right}
    </tr>`;
  return `<table class="t compact trades"><tbody>
    ${open
      .map((t) =>
        row(
          t,
          `<td class="num big ${tone(t.markPct)}">${t.status === 'pending' ? '<span class="muted">buying</span>' : pct(t.markPct)}</td><td class="num muted">${t.openedAt ? `open ${duration(Date.now() - t.openedAt)}` : ''}</td>`,
        ),
      )
      .join('')}
    ${closed.length && open.length ? '<tr class="gap"><td colspan="3"></td></tr>' : ''}
    ${closed
      .map((t) => row(t, `<td class="num ${tone(t.pnlUsd)}">${pct(t.pnlPct)} ${money(t.pnlUsd)}</td><td class="num muted">${clock(t.closedAt)}</td>`))
      .join('')}
  </tbody></table>`;
}

/** @param {any} cal */
function calibrationBlock(cal) {
  if (!state.status.ai.enabled && cal.n === 0) return '';
  if (cal.n === 0) return `<h2>AI estimates</h2><p class="muted">No scored trades have closed yet.</p>`;
  const better = cal.brier < cal.baselineBrier;
  return `<h2>AI estimates</h2>
    <p class="secondary">${cal.n} scored trades. The AI's guesses are <b class="${better ? 'pos' : 'neg'}">${better ? 'better' : 'not better'}</b> than always guessing the average (score ${cal.brier.toFixed(3)} vs ${cal.baselineBrier.toFixed(3)}, lower is better).</p>
    <table class="t compact" style="max-width:520px"><thead><tr><th>AI said</th><th class="num">Trades</th><th class="num">Actually won</th></tr></thead><tbody>
    ${cal.buckets
      .map((/** @type {any} */ b) => `<tr><td>${Math.round(b.range[0] * 100)}–${Math.round(b.range[1] * 100)}%</td><td class="num">${b.n}</td><td class="num">${share(b.actualWinRate)}</td></tr>`)
      .join('')}</tbody></table>`;
}

const VERDICT_TEXT = /** @type {Record<string, string>} */ ({
  too_early: 'Too early to tell',
  no_edge: 'Not ahead of random',
  leaning: 'Ahead, but could be luck',
  clear: 'Ahead by more than luck',
});

/** @param {HTMLElement} view @param {string} id */
async function rulePage(view, id) {
  const { trades, twinTrades, events } = await getJson(forRun(`/api/strategies/${encodeURIComponent(id)}`));
  const res = state.results;
  const r = res.strategies.find((/** @type {any} */ x) => x.strategy === id);
  if (!r) {
    view.innerHTML = `<div class="page">${pastRunBanner()}<a class="back" href="#/">← Scoreboard</a><div class="empty">This strategy has no trades in this run.</div></div>`;
    return;
  }
  const s = strategyOf(id);
  const rule = s ? state.status.signals.find((/** @type {any} */ x) => x.id === s.rule) : null;
  const run = shownRun();
  const params = (run ? runStrategies(run.settings)[id]?.params : null) ?? s?.params ?? {};
  const paramText = Object.entries(params).map(([k, v]) => `${k} ${v}`).join(' · ');
  const tw = r.twin;
  const active = trades.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending');
  const closed = trades.filter((/** @type {any} */ t) => t.status === 'closed');
  const skipped = trades.filter((/** @type {any} */ t) => t.status === 'cancelled');
  const ci = r.all.winRateCi ? `could be ${share(r.all.winRateCi[0])}–${share(r.all.winRateCi[1])}` : 'none closed yet';
  const checks = `<table class="t compact checks"><tbody>${r.checks
    .map((/** @type {any} */ c) => `<tr><td class="${c.pass ? 'pos' : 'muted'}">${c.pass ? '✓' : '✗'}</td><td>${esc(c.label)}</td><td class="num muted">${esc(c.detail)}</td></tr>`)
    .join('')}</tbody></table>`;
  const v = r.verdict;
  const verdictLine = v ? `<p class="secondary verdict-line"><b>${esc(VERDICT_TEXT[v.label] ?? v.label)}</b> <span class="muted">· ${esc(v.detail)}</span></p>` : '';
  const twinFilled = twinTrades.filter((/** @type {any} */ t) => t.status !== 'cancelled');

  view.innerHTML = `<div class="page">
    ${pastRunBanner()}
    <a class="back" href="#/">← Scoreboard</a>
    <div class="rule-hero" style="--c:${colorOf(id)}">
      <div>
        <h1 class="rule-name">${dot(id)}${esc(nameOf(id))}${s?.retired ? ' <span class="tag">Retired</span>' : ''}</h1>
        <div class="card-rule" title="${esc(rule?.description ?? '')}${paramText ? `\n${esc(paramText)}` : ''}">${esc(rule?.name ?? '')} · ${esc(exitsText(shownExits(id)))}</div>
        ${heroNumber(r, true)}
        ${statusLine(r)}
      </div>
      <div class="strip">
        <div><div class="k">Balance</div><div class="v">$${r.equityUsd.toFixed(0)}</div><div class="s">random $${tw.equityUsd.toFixed(0)}</div></div>
        <div><div class="k">Win rate</div><div class="v">${share(r.all.winRate)}</div><div class="s">${ci}</div></div>
        <div><div class="k">Avg trade</div><div class="v ${tone(r.all.avgPnlPct)}">${pct(r.all.avgPnlPct)}</div><div class="s">random ${pct(tw.all.avgPnlPct)}</div></div>
        <div><div class="k">Closed</div><div class="v">${r.all.closed}</div><div class="s">${active.length} open · ${skipped.length} skipped</div></div>
      </div>
    </div>
    ${dataNote((res.excluded ?? []).filter((/** @type {any} */ t) => t.book === id || t.book === `random:${id}`))}

    ${panel('rule-checks', `Go-live checks <span class="count">${r.checks.filter((/** @type {any} */ c) => c.pass).length}/${r.checks.length}</span>`, verdictLine + checks, false)}
    ${panel('rule-balance', `Balance <span class="key-dash" title="Dashed line: its random picker"></span>`, `<div class="chart-box"><div class="chart" id="balance"></div>${rangePick()}</div>`)}
    ${panel('rule-open', `Open <span class="count">${active.length}</span>`, tradeRows(active, { showWhy: true }))}
    ${panel('rule-closed', `Closed <span class="count">${closed.length}</span>`, tradeRows(closed, { showWhy: true }))}
    ${panel('rule-twin', `Random picker <span class="count">${twinFilled.length}</span>`, tradeRows(twinFilled), false)}
    ${panel('rule-skipped', `Skipped <span class="count">${skipped.length}</span>`, tradeRows(skipped, { showWhy: true }), false)}
    ${panel('rule-fires', `Every fire <span class="count">${events.length}</span>`, firesTable(events), false)}
  </div>`;
  const el = document.getElementById('balance');
  if (el) {
    balanceChart(
      el,
      [
        { color: colorOf(id), curve: curveOf(r), dashed: false, label: nameOf(id), trades, now: r.equityUsd },
        { color: '', curve: curveOf(tw), dashed: true, label: 'Random', now: tw.equityUsd },
      ],
      res.startingBankrollUsd,
      chartSpan(res),
    );
  }
}

/** @param {any[]} events */
function firesTable(events) {
  if (!events.length) return `<div class="empty">Hasn't fired yet.</div>`;
  const result = (/** @type {any} */ e) =>
    e.tradeId ? 'traded' : ({ already_open: 'already holding', cooldown: 'sold it recently', no_cash: 'out of cash' })[/** @type {'already_open'|'cooldown'|'no_cash'} */ (e.skipReason)] ?? e.skipReason;
  return `<table class="t compact"><tbody>${events
    .map((e) => `<tr><td class="muted mono">${clock(e.ts)}</td><td><b>${esc(e.symbol)}</b></td><td class="wrap muted">${esc(e.reason)}</td><td class="muted">${esc(result(e))}</td></tr>`)
    .join('')}</tbody></table>`;
}

/** Turnover labels in plain words: what Noah's reading says each one means. */
const TURNOVER_TEXT = /** @type {Record<string, [string, string]>} */ ({
  attention: ['Attention', 'Heavy trading, speeding up, price rising: new buyers absorbing sellers.'],
  distribution: ['Distribution', 'Heavy trading but the price is flat or falling: early holders may be selling into the hype.'],
  fading: ['Fading', 'Trading is slowing while the price holds: attention leaving, and price usually follows.'],
});

/** One coin's turnover reading: 1h volume as a share of its value, and its label. @param {any} r */
function turnoverCell(r) {
  if (!r || r.turnover === null) return '–';
  const pace = r.pace === null ? 'not enough history for a pace' : `the last hour traded ${r.pace.toFixed(1)}x its usual hourly pace`;
  const tip = `${share(r.turnover)} of the coin's value traded in the last hour; ${pace}.${r.label ? ` ${TURNOVER_TEXT[r.label][1]}` : ''}`;
  return `<span title="${esc(tip)}">${share(r.turnover)}${r.label ? ` <span class="t-label ${r.label}">${TURNOVER_TEXT[r.label][0]}</span>` : ''}</span>`;
}

/** What the turnover labels were followed by, from Paper Lab's own saved readings. @param {any} replay */
function turnoverReplay(replay) {
  const rows = replay.rows
    .map((/** @type {any} */ r) => {
      const name = r.label === 'all' ? 'Any reading' : TURNOVER_TEXT[r.label][0];
      const few = r.readings < MIN_TRADES;
      return `<tr${r.label === 'all' ? ' class="muted"' : ''}>
        <td>${r.label === 'all' ? name : `<span class="t-label ${r.label}">${name}</span>`}</td>
        <td class="num">${r.readings}</td><td class="num">${r.coins}</td>
        <td class="num">${few ? '<span class="muted">too few</span>' : share(r.up / r.readings)}</td>
        <td class="num ${few ? '' : tone(r.medianMove)}">${few || r.medianMove === null ? '–' : pct(r.medianMove)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="page-head trending-head"><h1>Turnover check</h1><span class="muted">what the price did ${replay.settings.afterMin} minutes after each label, from every reading saved so far</span></div>
    <table class="t compact replay-table"><thead><tr><th>Label</th><th class="num" title="Each coin counts at most once per label every ${replay.settings.spacingMin} minutes">Readings</th><th class="num">Coins</th><th class="num">Price higher</th><th class="num">Median move</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="legend-note">Compare each label with <b>Any reading</b>: a label only means something if it does clearly better or worse. Under ${MIN_TRADES} readings it says too few. <a href="#/guide/turnover">How it works</a></p>`;
}

/** @param {HTMLElement} view */
async function coinsPage(view) {
  const active = state.status.strategies.filter((/** @type {any} */ s) => !s.retired).map((/** @type {any} */ s) => s.id);
  const [tokens, coins, replay] = await Promise.all([getJson('/api/tokens'), getJson(`/api/coin-results?strategies=${encodeURIComponent(active.join(','))}`), getJson('/api/turnover-replay')]);
  const min = state.status.universe.minLiquidityUsd;
  const ratio = (/** @type {any} */ t) => {
    const b = t.buyersM5 ?? t.buysM5;
    const s = t.sellersM5 ?? t.sellsM5;
    return b === null || s === null ? null : b / Math.max(s, 1);
  };
  // The demo feed has no 5m price change; hide the column rather than show a row of dashes.
  const hasChange = tokens.some((/** @type {any} */ t) => t.priceChangeM5 !== null);
  const rows = tokens
    .map((/** @type {any} */ t) => {
      const tradable = (t.liquidityUsd ?? 0) >= min;
      const holders = [...new Set(t.openStrategies)]
        .filter((st) => st !== 'random')
        .map((st) => `<span title="${esc(nameOf(String(st)))}">${dot(String(st))}</span>`)
        .join('');
      const r = ratio(t);
      return `<tr class="link" data-href="#/coin/${encodeURIComponent(t.poolAddress)}" style="${tradable ? '' : 'opacity:.5'}">
        <td class="num muted">${t.trendingRank ?? ''}</td>
        <td><b>${esc(t.symbol)}</b> <span class="holders">${holders}</span></td>
        <td class="num">${price(t.priceUsd)}</td>
        ${hasChange ? `<td class="num ${tone(t.priceChangeM5)}">${t.priceChangeM5 === null ? '–' : pct(t.priceChangeM5 / 100)}</td>` : ''}
        <td class="num">${usd(t.liquidityUsd)}</td>
        <td class="num ${t.marketCapUsd > 0 ? '' : 'italic'}">${usd(capOf(t))}</td>
        <td class="num">${usd(t.volH1)}</td>
        <td class="num">${turnoverCell(t.turnover)}</td>
        <td class="num">${r === null ? '–' : r.toFixed(1)}</td>
        <td class="num muted">${ago(t.poolCreatedAt)}</td>
      </tr>`;
    })
    .join('');
  view.innerHTML = `<div class="page">
    <div class="page-head"><h1>Our coins</h1><span class="muted">bought by the strategies this run, best first</span></div>
    ${coinTable(coins, state.allCoins ? Infinity : 15)}
    <div class="page-head trending-head"><h1>Trending coins</h1></div>
    ${tokens.length ? `<div class="scroll-x"><table class="t"><thead><tr>
      <th class="num">#</th><th>Coin</th><th class="num">Price</th>${hasChange ? '<th class="num">5m</th>' : ''}<th class="num">Liquidity</th>
      <th class="num" title="Market cap (italic: fully diluted value, when market cap is missing)">Mkt cap</th><th class="num">Vol 1h</th>
      <th class="num" title="Turnover: the last hour's volume as a share of market cap. Hover a coin's number for its pace and label.">Turnover</th>
      <th class="num" title="Unique buyers per seller, last 5 minutes">Buyers/seller</th><th class="num">Age</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Waiting for the first update.</div>'}
    ${turnoverReplay(replay)}
  </div>`;
}

/** @param {HTMLElement} view @param {string} pool */
async function coinPage(view, pool) {
  const { snapshots, turnover, trades, heldBack } = await getJson(forRun(`/api/pools/${encodeURIComponent(pool)}`));
  const s = snapshots[snapshots.length - 1];
  if (!s) {
    view.innerHTML = `<div class="page"><a class="back" href="#/coins">← Coins</a><div class="empty">No data for this coin.</div></div>`;
    return;
  }
  const cap = capOf(s);
  const filled = trades.filter((/** @type {any} */ t) => t.status !== 'cancelled');
  view.innerHTML = `<div class="page">
    ${pastRunBanner()}
    <a class="back" href="javascript:history.back()">← Back</a>
    <div class="page-head"><h1>${esc(s.symbol)}</h1><span class="muted">${esc(s.name)}</span>
      ${s.source === 'geckoterminal' ? `<a href="https://www.geckoterminal.com/solana/pools/${encodeURIComponent(s.poolAddress)}" target="_blank" rel="noopener" style="font-size:12px">GeckoTerminal ↗</a>` : ''}</div>
    <div class="strip">
      <div><div class="k">Price</div><div class="v">${price(s.priceUsd)}</div><div class="s">${s.priceChangeM5 === null ? '' : `${pct(s.priceChangeM5 / 100)} 5m`}</div></div>
      <div><div class="k">Liquidity</div><div class="v">${usd(s.liquidityUsd)}</div><div class="s">${cap ? `${Math.round((s.liquidityUsd / cap) * 100)}% of cap` : ''}</div></div>
      <div><div class="k">${s.marketCapUsd > 0 ? 'Market cap' : 'FDV'}</div><div class="v">${usd(cap)}</div><div class="s">age ${ago(s.poolCreatedAt)}</div></div>
      <div><div class="k">Volume 5m / 1h</div><div class="v">${usd(s.volM5)}</div><div class="s">${usd(s.volH1)} 1h</div></div>
      <div><div class="k">Turnover 1h</div><div class="v">${turnoverCell(turnover[turnover.length - 1])}</div><div class="s">${turnover[turnover.length - 1]?.pace == null ? '' : `${turnover[turnover.length - 1].pace.toFixed(1)}x usual pace`}</div></div>
      <div><div class="k">Buyers / sellers 5m</div><div class="v">${s.buyersM5 ?? '–'} / ${s.sellersM5 ?? '–'}</div><div class="s">${s.buysM5 ?? '–'} / ${s.sellsM5 ?? '–'} trades</div></div>
    </div>
    <h2>Price <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· <span class="mk buy" style="--c:var(--text-secondary)"></span> buy <span class="mk sell" style="--c:var(--text-secondary)"></span> sell, colored by strategy, grey for random</span></h2>
    <div class="chart-box"><div class="readout"></div><div class="chart tall" id="price"></div></div>
    <h2>Turnover <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· last hour's volume as a share of market cap</span></h2>
    <div class="chart-box"><div class="readout"></div><div class="chart short" id="turnover"></div></div>
    ${heldBack?.length ? `<div class="data-note"><span class="flag-dot"></span>${heldBack.length} price reading${heldBack.length === 1 ? '' : 's'} held back as wrong and left off the chart: ${heldBack.slice(0, 3).map((/** @type {any} */ h) => `${esc(clock(h.ts))} ${esc(price(h.priceUsd))} (${esc(h.reason)})`).join('; ')}${heldBack.length > 3 ? `; and ${heldBack.length - 3} more` : ''}. <a href="#/guide/bad-prices">Why</a></div>` : ''}
    <h2>Trades on this coin (${filled.length})</h2>
    ${filled.length ? `<table class="t compact"><tbody>${filled.map((/** @type {any} */ t) => `<tr><td class="muted mono">${clock(t.openedAt ?? t.signalAt)}</td><td><span class="rule-name">${t.strategy === 'random' ? '<span class="dot random"></span>' : dot(t.strategy)}${esc(owner(t))}</span></td><td class="wrap">${outcome(t)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No strategy has traded this coin.</div>'}
  </div>`;
  priceChart(/** @type {HTMLElement} */ (document.getElementById('price')), snapshots, filled);
  turnoverChart(/** @type {HTMLElement} */ (document.getElementById('turnover')), turnover);
}

/**
 * The coin's turnover over time, with a faint line at the "high" mark.
 * @param {HTMLElement} el
 * @param {any[]} points
 */
function turnoverChart(el, points) {
  const chart = baseChart(el, share);
  const series = chart.addSeries(LWC.LineSeries, { color: css('--text-secondary'), lineWidth: 1, priceFormat: { type: 'custom', formatter: share, minMove: 0.001 } });
  series.setData(toSeries(points.filter((p) => p.turnover !== null).map((p) => ({ t: p.ts, v: p.turnover }))));
  series.createPriceLine({ price: state.status.turnover.high, color: css('--chart-start'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: 'high' });
  chart.timeScale().fitContent();
  const readout = /** @type {HTMLElement|null} */ (el.parentElement?.querySelector('.readout') ?? null);
  chart.subscribeCrosshairMove((/** @type {any} */ p) => {
    const v = p?.seriesData?.get(series);
    if (readout) readout.textContent = v ? `${new Date(p.time * 1000).toLocaleTimeString()}  ${share(v.value)}` : '';
  });
}

/** One rule in plain words, numbers from its settings. @param {any} s */
function ruleText(s) {
  const p = s.params;
  const idea = String(s.description).match(/The idea:.*$/)?.[0] ?? '';
  if (s.id === 'buyer-seller-ratio')
    return `buys when at least ${p.minRatio} times as many different wallets bought as sold in the last 5 minutes (and at least ${p.minBuyers} buyers). ${idea}`;
  if (s.id === 'liquidity-mcap-ratio') return `buys when the coin's liquidity is at least ${p100(p.minRatio)} of its total value. ${idea}`;
  if (s.id === 'volume-spike')
    return `buys when the last 5 minutes of trading is at least ${p.minMultiple} times the usual for that hour (and at least ${kUsd(p.minVolM5)}). ${idea}`;
  return s.description;
}

/** @param {HTMLElement} view */
function guidePage(view) {
  const st = state.status;
  const t = st.trade;
  const bank = dollars(st.startingBankrollUsd ?? 1000);
  const cost = p100(t.feeRate + t.slippageRate);
  const floor = kUsd(st.universe.minLiquidityUsd);
  const runs = runsInOrder().slice().reverse();
  const strategies = st.strategies
    .map(
      (/** @type {any} */ s) => `<tr class="link" data-href="#/rule/${esc(s.id)}">
        <td><span class="rule-name">${dot(s.id)}<b>${esc(s.codeName)}</b></span></td>
        <td>${esc(ruleName(s.rule))}</td>
        <td class="mono">${esc(exitsText(s.trade))}</td>
        <td class="muted">${s.retired ? 'retired' : ''}</td>
      </tr>`,
    )
    .join('');
  const runRows = runs
    .map((r) => {
      const now = r.id === st.runId;
      const viewing = r.id === (state.viewRun ?? st.runId);
      return `<tr class="link" data-open-run="${r.id}">
        <td><b>Run ${r.n}</b>${now ? ' <span class="muted">· now</span>' : ''}${viewing && !now ? ' <span class="muted">· viewing</span>' : ''}</td>
        <td class="muted">${esc(dayTime(r.startedAt))} to ${esc(dayTime(r.lastActivityAt))}</td>
        <td class="num">${r.trades} trade${r.trades === 1 ? '' : 's'}</td>
      </tr>`;
    })
    .join('');

  view.innerHTML = `<div class="page guide">
    <div class="page-head guide-head"><h1>Guide</h1><button type="button" class="btn-link" data-scroll="past-runs">Past runs (${runs.length}) ↓</button></div>
    <p><b>What this is.</b> A practice trading lab. It watches trending Solana memecoins and makes pretend trades. No wallet, no real money, no real orders.</p>
    <p><b>The question it answers.</b> Can a simple rule pick coins better than picking at random? Each strategy gets its own pretend ${bank}. Every time a strategy buys a coin, its own random picker buys a random coin at the same moment, with the same money and the same selling rules. If the strategy can't beat that, it's luck, not skill.</p>
    <p><b>How every trade works.</b> Spend $${t.sizeUsd}. Sell when the price is down ${p100(t.stopLossPct)}, up ${p100(t.takeProfitPct)}, or after ${t.timeLimitMin} minutes, whichever comes first (faster strategies use tighter numbers, listed below). Only coins with at least ${floor} of trading money behind them ("liquidity") are allowed. Each trade pays realistic costs: about ${cost} going in and again going out, more for smaller coins, and it buys at the next price check rather than instantly. If a coin's liquidity collapses, the trade counts as almost a total loss.</p>
    <p><b>The rules.</b></p>
    <ul>${st.signals.map((/** @type {any} */ s) => `<li><b>${esc(s.name)}:</b> ${esc(ruleText(s))}</li>`).join('')}</ul>
    <p><b>Strategies.</b> A strategy is a code-name, one rule, and its own selling numbers. Settings never change under a code-name; trying new numbers means a new code-name, and a retired one stops buying but keeps its history.</p>
    <table class="t compact guide-table"><thead><tr><th>Code-name</th><th>Rule</th><th>Stop / target / time</th><th></th></tr></thead><tbody>${strategies}</tbody></table>
    <p><b>The strip above the chart.</b> First your portfolio, then each strategy in its chart color, most profit first. A strategy's number is its profit so far, open trades counted as if sold now. Hover one for its rule, balance, how far it is ahead of its random picker, win rate and go-live checks. The menu bar hides at the top of the screen; move the mouse to the small handle at the top edge to bring it back.</p>
    <p><b>The five go-live checks.</b> Total profit above zero · more profit than its random picker · average trade +5% or better · still in profit without its single best trade · in profit in both the first and second half of the run. There is no minimum number of trades: you decide when there are enough.</p>
    <p><b>Could be luck.</b> The more strategies run, the more likely one looks good by chance, so the luck test gets stricter as strategies are added. Retired ones still count.</p>
    <p><b>The chart.</b> One solid line per strategy shown. The grey dashed line is the average of their random pickers. Each line is the balance over time with open trades counted as if sold at that moment's price, so it moves as prices move and ends at the strip's number. A new trade starts a few dollars down: selling it right away would cost the fee and slippage both ways, about ${p100(2 * (t.feeRate + t.slippageRate))} of the trade. When two strategies hold the same coins (a fast and a slow version of one rule), their lines match until their exits differ; the one on top is drawn in long dashes so the other shows through. Only the current run is drawn; the run marker at the end of the strip links to past runs.</p>
    <p><b>Time views.</b> The buttons in the chart's top corner show the last 15 minutes, hour or 4 hours, or the whole run. Paper Lab only collects prices while it's running, so time it was off (your computer asleep, the app closed) is skipped rather than drawn as a flat line: a faint dashed line marks the spot with how long it was off, like "off 6.2h". If it's off right now, the end of the chart says for how long.</p>
    <p id="time-off"><b>Trades open while it was off.</b> While Paper Lab is off, nobody watches open trades: a stop loss or target that should have fired doesn't, and the trade sells at whatever the price is when Paper Lab comes back, hours later. Real trading wouldn't work like that, so any trade that was waiting to buy or holding through an off period (5 minutes or more without a price check) is crossed out and left out of the results and the chart, with a note under the strip. Random pickers' trades follow the same rule. Nothing is deleted.</p>
    <p><b>Trades.</b> Scroll down on the home screen for open trades and the last 10 finished ones. Retired strategies stay in the table above but leave the home screen.</p>
    <p><b>Portfolio.</b> Your pretend ${bank} split evenly across the active strategies: the average of their balances, including open trades.</p>
    <p><b>The dot.</b> Top right of the menu bar: live data is green when fresh, red when stale, grey when off. Click it to turn live data off or quit. The bar stays visible while data is stale. The square icon beside the dot switches full screen on and off (Esc also leaves it).</p>
    <p><b>Buys and sells.</b> The chart marks the latest buys (hollow ring) and sells (solid dot) on each strategy's line, with a faint dotted line from each sell back to its buy, and lists the newest few with their tickers in its corner. Hover anywhere on the chart to see the balances and the trades at that moment.</p>
    <p><b>Hot now.</b> Top right: coins a strategy's rule fired on in the last 15 minutes, the ones the strategies are buying right now. Coins where more different rules agree come first (a fast and a slow version of one rule count once), then the best odds. The odds are measured, not guessed: how often that strategy's past paper trades reached its take profit before its stop loss or time limit, out of how many trades, next to its random picker's rate for comparison. Under 10 trades it says so instead of showing a rate. The percent on the right is how far the price has moved since the first signal, so you can see if you'd be late. Hover a coin for every strategy's numbers. It's there to point you at coins worth a look; you decide.</p>
    <p><b>Best coins.</b> Beside the chart and on the Coins page: every coin the strategies bought this run, ranked by profit (finished trades plus open ones as if sold now, after costs). Dots show which strategies bought it.</p>
    <p><b>Coins.</b> Dimmed trending coins have under ${floor} liquidity, so no strategy trades them. Dots show which strategies hold a coin right now.</p>
    <p id="turnover"><b>Turnover.</b> The last hour's trading volume as a share of the coin's market cap: 50% means half the coin's value changed hands in an hour. On the Coins page and each coin's page. Three labels follow a reading of how turnover and price move together. <b>Attention</b>: turnover at least ${share(st.turnover.high)}, trading at or above its usual pace, and price up ${share(st.turnover.flatPrice)} or more in the hour, meaning new buyers are absorbing sellers. <b>Distribution</b>: turnover at least ${share(st.turnover.high)} but price flat or down, meaning early holders may be selling into the hype. <b>Fading</b>: the last hour traded under ${st.turnover.falling}x the coin's usual hourly pace (its average over the last 6 hours) while the price holds, meaning attention is leaving. These cut-offs are first guesses. The Turnover check under the Coins page tests them: for every saved reading it looks at the price ${st.turnover.afterMin} minutes later, counting a coin at most once per label every ${st.turnover.spacingMin} minutes, and compares each label with all readings. Until a label clearly differs from "Any reading" over many coins, treat it as an idea, not as odds. No strategy trades on it.</p>
    <p id="bad-prices"><b>Bad prices.</b> Now and then the price source returns a reading that can't be right, like a coin jumping 4x in a minute while its pool's liquidity doesn't move. Every reading is checked: when the price moves 2x or more, the pool's liquidity and the coin's FDV have to move with it, the way they do when people really trade. A reading that fails is kept but held back: nothing buys, sells or values a trade on it, and the coin's price chart leaves it out. Trades made on such a reading before this check existed are crossed out and left out of the results, with a note under the strip. Nothing is deleted.</p>
    <p><b>Runs.</b> Changing a shared trading setting (costs, the coin filter) starts a new run with fresh balances, so old and new results never mix. Adding or retiring a strategy does not. To start over by hand, click the dot in the menu bar and pick "Start over at ${bank}": every strategy starts a new run at an even balance, and the old run stays under Past runs. Nothing is deleted.</p>
    <h2 id="past-runs">Past runs</h2>
    <p class="muted">Click a run to see its scoreboard as it ended. "Back to now" returns to the current run.</p>
    ${runs.length ? `<table class="t compact runs-table"><tbody>${runRows}</tbody></table>` : '<div class="empty">None yet.</div>'}
    <p class="muted credits">Data: <a href="https://www.geckoterminal.com" target="_blank" rel="noopener">GeckoTerminal</a>. Charts: <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a>.</p>
  </div>`;
}

// ---------- notes ----------

/**
 * Inline Markdown: code, bold, italics, links. Escapes first, so a note can never add HTML.
 * @param {string} text
 */
function inlineMd(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * The small part of Markdown notes use: ## and ### headings, paragraphs, - lists, > quotes.
 * @param {string} md
 */
function markdown(md) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {string[]} */
  let list = [];
  /** @type {string[]} */
  let quote = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inlineMd(l)}</li>`).join('')}</ul>`);
    if (quote.length) out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`);
    para = [];
    list = [];
    quote = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const h = line.match(/^(#{2,4}) +(.+)$/);
    if (!line) flush();
    else if (h) {
      flush();
      out.push(h[1].length === 2 ? `<h3>${inlineMd(h[2])}</h3>` : `<h4>${inlineMd(h[2])}</h4>`);
    } else if (/^[-*] +/.test(line)) {
      if (para.length || quote.length) flush();
      list.push(line.replace(/^[-*] +/, ''));
    } else if (line.startsWith('>')) {
      if (para.length || list.length) flush();
      quote.push(line.replace(/^> ?/, ''));
    } else if (list.length && /^\s{2,}/.test(raw)) list[list.length - 1] += ` ${line}`;
    else {
      if (list.length || quote.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('');
}

/** @param {string} ymd */
const noteDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/** @param {HTMLElement} view */
async function notesPage(view) {
  const notes = await getJson('/api/notes');
  const index =
    notes.length > 1
      ? `<ol class="note-index">${notes.map((/** @type {any} */ n) => `<li><a href="#/notes/${esc(n.id)}"><span class="mono muted">${esc(noteDate(n.date))}</span>${esc(n.title)}</a></li>`).join('')}</ol>`
      : '';
  view.innerHTML = `<div class="page notes">
    <div class="page-head"><h1>Notes</h1><span class="muted">${notes.length} entr${notes.length === 1 ? 'y' : 'ies'}, newest first</span></div>
    ${index}
    ${
      notes.length
        ? notes
            .map(
              (/** @type {any} */ n) => `<article class="note" id="${esc(n.id)}">
        <div class="note-date mono">${esc(noteDate(n.date))}</div>
        <h2 class="note-title">${esc(n.title)}</h2>
        ${markdown(n.body)}
      </article>`,
            )
            .join('')
        : '<div class="empty">No notes yet. Send one in the project chat and it lands here with the next update.</div>'
    }
  </div>`;
}

// ---------- routing & refresh ----------

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  if (page === 'rule' && arg) return { page: 'rule', arg: decodeURIComponent(arg) };
  if (page === 'coin' && arg) return { page: 'coin', arg: decodeURIComponent(arg) };
  if (page === 'coins') return { page: 'coins', arg: '' };
  if (page === 'guide') return { page: 'guide', arg: arg ?? '' };
  if (page === 'notes') return { page: 'notes', arg: arg ?? '' };
  return { page: 'home', arg: '' };
}

let rendering = false;
let lastRoute = '';
async function render() {
  if (rendering || !state.status) return;
  rendering = true;
  const view = /** @type {HTMLElement} */ (document.getElementById('view'));
  const r = route();
  const key = `${r.page}/${r.arg}`;
  const keepScroll = key === lastRoute ? view.scrollTop : 0;
  const openDetails = [...view.querySelectorAll('details')].map((d) => d.open);
  try {
    destroyCharts();
    if (!state.results && (r.page === 'home' || r.page === 'rule')) await loadResults();
    if (r.page === 'rule') await rulePage(view, r.arg);
    else if (r.page === 'coins') await coinsPage(view);
    else if (r.page === 'coin') await coinPage(view, r.arg);
    else if (r.page === 'guide') guidePage(view);
    else if (r.page === 'notes') await notesPage(view);
    else await scoreboardPage(view);
    if (key === lastRoute) view.querySelectorAll('details').forEach((d, i) => (d.open = openDetails[i] ?? false));
  } catch (err) {
    view.innerHTML = `<div class="page empty neg">Couldn't load this page: ${esc(err instanceof Error ? err.message : err)}</div>`;
  } finally {
    view.scrollTop = keepScroll;
    // A link like #/guide/past-runs lands on that section.
    if ((r.page === 'guide' || r.page === 'notes') && r.arg && key !== lastRoute) document.getElementById(r.arg)?.scrollIntoView();
    lastRoute = key;
    rendering = false;
  }
}

async function loadResults() {
  state.results = await getJson(forRun('/api/results'));
}

async function refresh() {
  try {
    const [status] = await Promise.all([getJson('/api/status'), loadResults()]);
    // Paper Lab restarted (an update, or the desktop icon again): load the new page and its new run.
    if (state.status && status.bootId !== state.status.bootId) return location.reload();
    state.status = status;
    // Colors follow the strategy list, so a strategy keeps its color on every page.
    state.status.strategies.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      state.colors[s.id] = css(SERIES_VARS[i % SERIES_VARS.length]);
    });
    renderTopbar();
    await render();
  } catch {
    if (quitting) return;
    const btn = document.getElementById('health');
    if (btn) {
      btn.title = "Can't reach Paper Lab. Is it still running?";
      /** @type {HTMLElement} */ (btn.querySelector('.health')).className = 'health bad';
    }
  }
}

const view = /** @type {HTMLElement} */ (document.getElementById('view'));

view.addEventListener(
  'toggle',
  (e) => {
    const d = /** @type {HTMLDetailsElement} */ (e.target);
    const key = d.getAttribute?.('data-panel');
    // Browsers also fire "toggle" when a panel is first drawn open; only react to real changes.
    if (!key || d.dataset.open === (d.open ? '1' : '0')) return;
    d.dataset.open = d.open ? '1' : '0';
    save(`panel:${key}`, d.dataset.open);
    if (d.open && d.querySelector('.chart')) void render();
  },
  true,
);

view.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('[data-run="current"]')) return openRun(null);
  const runRow = target.closest('[data-open-run]');
  if (runRow) return openRun(Number(runRow.getAttribute('data-open-run')));
  const range = target.closest('[data-range]');
  if (range) {
    state.range = String(range.getAttribute('data-range'));
    save('range', state.range);
    return void render();
  }
  if (target.closest('[data-coins-all]')) {
    state.allCoins = true;
    return void render();
  }
  const jump = target.closest('[data-scroll]');
  if (jump) return document.getElementById(String(jump.getAttribute('data-scroll')))?.scrollIntoView({ behavior: 'smooth' });
  const live = target.closest('[data-live]');
  if (live) return void setLive(/** @type {HTMLButtonElement} */ (live));
  const tr = target.closest('[data-href]');
  if (tr && !target.closest('a, input, label, summary, select')) location.hash = String(tr.getAttribute('data-href'));
});

window.addEventListener('hashchange', () => {
  if (state.status) renderTopbar();
  void render();
});


/** @param {string} url */
const post = (url) => fetch(url, { method: 'POST', headers: { 'x-paper-lab': '1' } });

/** Every strategy back to its bankroll in a new run; the current run stays under Past runs. */
async function startOver() {
  closeMenu();
  const run = runsInOrder().find((r) => r.id === state.status.runId);
  const bank = dollars(state.status.startingBankrollUsd ?? 1000);
  const ok = confirm(
    `Start every strategy over at ${bank}?\n\n` +
      `Run ${run?.n ?? ''} and all its trades are kept under Past runs on the Guide. ` +
      'Trades still open in it finish on their own but don\'t count in the new run.',
  );
  if (!ok) return;
  await post('/api/reset').catch(() => {});
  state.viewRun = null;
  state.results = null;
  location.hash = '#/';
  await refresh();
}

/** @param {HTMLButtonElement} b */
async function setLive(b) {
  b.disabled = true;
  closeMenu();
  await post(`/api/live/${b.getAttribute('data-live')}`).catch(() => {});
  await refresh();
}

// The dot in the top bar opens a tiny menu: live data on/off, and quit.
const menu = /** @type {HTMLElement} */ (document.getElementById('menu'));
const closeMenu = () => {
  menu.hidden = true;
  document.querySelector('.topbar')?.classList.remove('menu-open');
};
document.getElementById('health')?.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  document.querySelector('.topbar')?.classList.toggle('menu-open', !menu.hidden);
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target))) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
menu.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button');
  if (!b) return;
  if (b.hasAttribute('data-quit')) return void quit();
  if (b.hasAttribute('data-reset')) return void startOver();
  void setLive(/** @type {HTMLButtonElement} */ (b));
});

// Full screen: the browser's own, so Esc leaves it too. The icon follows the actual state.
const fsBtn = /** @type {HTMLButtonElement} */ (document.getElementById('fullscreen'));
const FS_ICON = {
  enter: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>',
  exit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>',
};
const showFullscreen = () => {
  const on = !!document.fullscreenElement;
  fsBtn.innerHTML = on ? FS_ICON.exit : FS_ICON.enter;
  fsBtn.title = fsBtn.ariaLabel = on ? 'Exit full screen' : 'Full screen';
};
fsBtn.hidden = !document.fullscreenEnabled;
fsBtn.addEventListener('click', () => {
  const go = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  go.catch(() => {});
});
document.addEventListener('fullscreenchange', showFullscreen);
showFullscreen();

let quitting = false;
async function quit() {
  closeMenu();
  if (!confirm('Quit Paper Lab? Live data stops and the helper shuts down. Your trades are saved.')) return;
  quitting = true;
  events.close();
  clearInterval(timer);
  await post('/api/quit').catch(() => {});
  document.body.innerHTML = `<div class="goodbye"><div class="brand">PAPER LAB</div><p>Paper Lab is off. Nothing is running.</p><p class="muted">Double-click the Paper Lab icon on your desktop to start it again. You can close this tab.</p></div>`;
}

// A page restored from the browser's back/forward memory may be an older version: load it fresh.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

const events = new EventSource('/api/events');
// The connection drops when Paper Lab restarts; when it comes back, check right away rather than at the next timer.
events.addEventListener('open', () => void refresh());
events.addEventListener('cycle', () => void refresh());
events.addEventListener('state', () => void refresh());
const timer = setInterval(() => void refresh(), 30_000);
void refresh();
