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
  /** @type {number|null} Past run being viewed; null means the current run. */ viewRun: null,
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

const NEED_TRADES = 30;

/** Profit minus its random picker's profit, closed trades. @param {any} r */
const edgeUsd = (r) => r.all.pnlUsd - r.twin.all.pnlUsd;

/**
 * One status instead of verdict, check pips and trade bar.
 * @param {any} r
 * @returns {{key: string, text: string, cls: string, fill: number, rank: number}}
 */
function statusOf(r) {
  const checks = r.checks ?? [];
  const passed = checks.filter((/** @type {any} */ c) => c.pass).length;
  if (r.all.closed < NEED_TRADES) {
    return { key: 'warming', text: `Warming up · ${r.all.closed}/${NEED_TRADES}`, cls: '', fill: r.all.closed / NEED_TRADES, rank: 3 };
  }
  if (checks.length && passed === checks.length) {
    return r.verdict?.label === 'clear'
      ? { key: 'ready', text: 'Ready', cls: 'pos', fill: 1, rank: 0 }
      : { key: 'ready', text: 'Ready · could be luck', cls: 'warn', fill: 1, rank: 1 };
  }
  const fill = checks.length ? passed / checks.length : 0;
  if (r.verdict?.label === 'no_edge') return { key: 'behind', text: 'Behind random', cls: 'neg', fill, rank: 4 };
  return { key: 'not-ready', text: `Not ready · ${passed}/${checks.length} checks`, cls: '', fill, rank: 2 };
}

/** The six checks, for hover text. @param {any} r */
const checksTip = (r) =>
  ['Go-live checks', ...(r.checks ?? []).map((/** @type {any} */ x) => `${x.pass ? '✓' : '✗'} ${x.label} (${x.detail})`)].join('\n');

// ---------- which strategies show ----------

/** Results of the active (not retired) strategies, best status first. @param {any[]} rows */
function shownStrategies(rows) {
  const keep = rows.filter((r) => r.strategy !== 'random' && !(strategyOf(r.strategy)?.retired ?? false));
  return keep.sort((a, b) => statusOf(a).rank - statusOf(b).rank || edgeUsd(b) - edgeUsd(a));
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
  renderMenu();
  renderPortfolio();
  const r = route();
  const here = r.page === 'coins' || r.page === 'coin' ? 'coins' : r.page === 'guide' ? 'guide' : 'home';
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.getAttribute('data-nav') === here);
}

function renderMenu() {
  const m = /** @type {HTMLElement} */ (document.getElementById('menu'));
  const live = state.status.live;
  m.innerHTML = `<button type="button" role="menuitem" data-live="${live ? 'off' : 'on'}">${live ? 'Turn off live data' : 'Turn on live data'}</button>
    <button type="button" role="menuitem" data-quit>Quit Paper Lab</button>`;
}

/** Pretend $1,000 split across the strategies on screen: the average of their balances. */
function renderPortfolio() {
  const el = /** @type {HTMLElement} */ (document.getElementById('portfolio'));
  const rows = state.results ? shownStrategies(state.results.strategies) : [];
  if (!rows.length) {
    el.textContent = '';
    el.title = '';
    return;
  }
  const start = state.results.startingBankrollUsd;
  const avg = rows.reduce((a, r) => a + r.equityUsd, 0) / rows.length;
  el.textContent = dollars(avg);
  el.className = `portfolio ${avg > start + 0.5 ? 'pos' : avg < start - 0.5 ? 'neg' : ''}`;
  el.title = [
    `Average balance of the ${rows.length} active strateg${rows.length === 1 ? 'y' : 'ies'}, including open trades${state.viewRun === null ? '' : ' (past run)'}:`,
    ...rows.map((r) => `${nameOf(r.strategy)}  ${dollars(r.equityUsd)}`),
  ].join('\n');
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
  for (const c of state.charts) c.remove();
  state.charts = [];
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
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: { priceFormatter, timeFormatter: (/** @type {number} */ t) => new Date(t * 1000).toLocaleString() },
  });
  state.charts.push(chart);
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
  const events = curves.flatMap((c, i) => c.map((p) => ({ t: p.t, i, v: p.equity }))).sort((a, b) => a.t - b.t);
  const now = curves.map(() => start);
  return events.map((e) => {
    now[e.i] = e.v;
    return { t: e.t, equity: now.reduce((a, b) => a + b, 0) / now.length };
  });
}

/**
 * Balance over time, one line per book.
 * @param {HTMLElement} el
 * @param {{color: string, curve: any[], dashed: boolean}[]} lines
 * @param {number} start
 */
function balanceChart(el, lines, start) {
  if (!lines.some((l) => l.curve.length)) {
    el.innerHTML = `<div class="empty chart-empty">No closed trades yet.</div>`;
    return;
  }
  const fmt = (/** @type {number} */ v) => `$${v.toFixed(0)}`;
  const chart = baseChart(el, fmt);
  for (const l of lines) {
    if (!l.curve.length) continue;
    const series = chart.addSeries(LWC.LineSeries, {
      color: l.color,
      lineWidth: 2,
      lineStyle: l.dashed ? 2 : 0,
      priceLineVisible: false,
      lastValueVisible: !l.dashed,
      priceFormat: { type: 'custom', formatter: fmt, minMove: 0.01 },
    });
    series.setData(toSeries([{ t: l.curve[0].t - 1000, v: start }, ...l.curve.map((p) => ({ t: p.t, v: p.equity }))]));
  }
  chart.timeScale().fitContent();
}

/** The home chart fills the rest of the window; the Trades panel sits below, out of sight until you scroll. */
function fitHomeChart() {
  const el = /** @type {HTMLElement|null} */ (document.querySelector('.chart.fill'));
  if (!el) return;
  const top = el.getBoundingClientRect().top + /** @type {HTMLElement} */ (document.getElementById('view')).scrollTop;
  el.style.height = `${Math.max(280, Math.round(window.innerHeight - top - 12))}px`;
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
    lineWidth: 2,
    priceFormat: { type: 'custom', formatter: price, minMove: 1e-12 },
  });
  const data = toSeries(snapshots.map((s) => ({ t: s.ts, v: s.priceUsd })));
  series.setData(data);
  const first = data.length ? data[0].time : 0;
  const markers = [];
  for (const t of trades) {
    if (!t.openedAt) continue;
    const color = t.strategy === 'random' ? css('--baseline') : colorOf(t.strategy);
    const open = Math.floor(t.openedAt / 1000);
    if (open >= first) markers.push({ time: open, position: 'belowBar', shape: 'arrowUp', color, size: 1 });
    if (t.closedAt) markers.push({ time: Math.floor(t.closedAt / 1000), position: 'aboveBar', shape: 'arrowDown', color, size: 1, text: pct(t.pnlPct, 0) });
  }
  markers.sort((a, b) => a.time - b.time);
  LWC.createSeriesMarkers(series, markers);
  chart.timeScale().fitContent();
  const readout = /** @type {HTMLElement|null} */ (el.parentElement?.querySelector('.readout') ?? null);
  chart.subscribeCrosshairMove((/** @type {any} */ p) => {
    const v = p?.seriesData?.get(series);
    if (readout) readout.textContent = v ? `${new Date(p.time * 1000).toLocaleTimeString()}  ${price(v.value)}` : '';
  });
}

// ---------- shared pieces ----------

// The HUD reads top to bottom by importance: how far each strategy is ahead
// of random (largest, brightest), one status with a thin bar, then everything
// else, quieter or folded away. Explanations live on the Guide page.

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

/** @param {any} r */
function strategyCard(r) {
  const s = strategyOf(r.strategy);
  return `<a class="card" href="#/rule/${esc(r.strategy)}" style="--c:${colorOf(r.strategy)}">
    <div class="card-name">${dot(r.strategy)}<b>${esc(nameOf(r.strategy))}</b></div>
    <div class="card-rule">${esc(s ? ruleName(s.rule) : '')}</div>
    ${heroNumber(r)}
    ${statusLine(r)}
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
  if (t.status === 'pending') return '<span class="secondary">buying at next price check</span>';
  if (t.status === 'cancelled') {
    return `<span class="muted">skipped: ${esc(
      { chased: 'price jumped 5%+ before it could buy', no_data: 'no fresh price to buy at', twin_cancelled: 'its strategy skipped too' }[
        /** @type {'chased'|'no_data'|'twin_cancelled'} */ (t.cancelReason)
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
  const trades = await getJson(forRun('/api/trades?limit=300'));
  const rows = shownStrategies(res.strategies);
  const ids = new Set(rows.map((r) => r.strategy));
  const mine = trades.filter((/** @type {any} */ t) => t.strategy !== 'random' && ids.has(t.strategy));
  const openCount = mine.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending').length;
  const offNow = !state.status.live && state.viewRun === null;

  view.innerHTML = `<div class="page wide">
    ${pastRunBanner()}
    ${rows.length ? `<div class="cards">${rows.map(strategyCard).join('')}</div>` : '<div class="empty">No active strategies.</div>'}
    <div class="chart-box">
      <div class="chart fill" id="balance"></div>
      ${offNow ? '<div class="overlay"><button type="button" class="btn-live big" data-live="on">Turn On Live Data</button></div>' : ''}
    </div>
    ${panel('trades', `Trades <span class="count">${openCount ? `${openCount} open` : ''}</span>`, tradesList(mine), false)}
    ${calibrationBlock(res.calibration)}
  </div>`;

  const el = document.getElementById('balance');
  if (!el) return;
  fitHomeChart();
  /** @type {{color: string, curve: any[], dashed: boolean}[]} */
  const lines = rows.map((r) => ({ color: colorOf(r.strategy), curve: r.equityCurve, dashed: false }));
  const randoms = rows.map((r) => r.twin.equityCurve);
  if (randoms.some((c) => c.length)) lines.push({ color: css('--baseline'), curve: averageCurve(randoms, res.startingBankrollUsd), dashed: true });
  balanceChart(el, lines, res.startingBankrollUsd);
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

    ${panel('rule-checks', `Go-live checks <span class="count">${r.checks.filter((/** @type {any} */ c) => c.pass).length}/6</span>`, verdictLine + checks, false)}
    ${panel('rule-balance', `Balance <span class="key-dash" title="Dashed line: its random picker"></span>`, '<div class="chart-box"><div class="chart" id="balance"></div></div>')}
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
        { color: colorOf(id), curve: r.equityCurve, dashed: false },
        { color: css('--baseline'), curve: tw.equityCurve, dashed: true },
      ],
      res.startingBankrollUsd,
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

/** @param {HTMLElement} view */
async function coinsPage(view) {
  const tokens = await getJson('/api/tokens');
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
        <td class="num">${r === null ? '–' : r.toFixed(1)}</td>
        <td class="num muted">${ago(t.poolCreatedAt)}</td>
      </tr>`;
    })
    .join('');
  view.innerHTML = `<div class="page">
    <div class="page-head"><h1>Trending coins</h1></div>
    ${tokens.length ? `<div class="scroll-x"><table class="t"><thead><tr>
      <th class="num">#</th><th>Coin</th><th class="num">Price</th>${hasChange ? '<th class="num">5m</th>' : ''}<th class="num">Liquidity</th>
      <th class="num" title="Market cap (italic: fully diluted value, when market cap is missing)">Mkt cap</th><th class="num">Vol 1h</th>
      <th class="num" title="Unique buyers per seller, last 5 minutes">Buyers/seller</th><th class="num">Age</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Waiting for the first update.</div>'}
  </div>`;
}

/** @param {HTMLElement} view @param {string} pool */
async function coinPage(view, pool) {
  const { snapshots, trades } = await getJson(forRun(`/api/pools/${encodeURIComponent(pool)}`));
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
      <div><div class="k">Buyers / sellers 5m</div><div class="v">${s.buyersM5 ?? '–'} / ${s.sellersM5 ?? '–'}</div><div class="s">${s.buysM5 ?? '–'} / ${s.sellsM5 ?? '–'} trades</div></div>
    </div>
    <h2>Price <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· ▲ buy ▼ sell, colored by strategy, grey for random</span></h2>
    <div class="chart-box"><div class="readout"></div><div class="chart tall" id="price"></div></div>
    <h2>Trades on this coin (${filled.length})</h2>
    ${filled.length ? `<table class="t compact"><tbody>${filled.map((/** @type {any} */ t) => `<tr><td class="muted mono">${clock(t.openedAt ?? t.signalAt)}</td><td><span class="rule-name">${t.strategy === 'random' ? '<span class="dot random"></span>' : dot(t.strategy)}${esc(owner(t))}</span></td><td class="wrap">${outcome(t)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No strategy has traded this coin.</div>'}
  </div>`;
  priceChart(/** @type {HTMLElement} */ (document.getElementById('price')), snapshots, filled);
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
    <p><b>Reading a card.</b> The big number is how many dollars the strategy is ahead of (or behind) its random picker. The status says where it is: Warming up (fewer than 30 finished trades, too early to judge), Not ready (some go-live checks fail), Behind random, Ready but could be luck, or Ready. Hover the status to see the checks.</p>
    <p><b>The six go-live checks.</b> At least 30 finished trades · total profit above zero · more profit than its random picker · average trade +5% or better · still in profit without its single best trade · in profit in both the first and second half of the run.</p>
    <p><b>Could be luck.</b> The more strategies run, the more likely one looks good by chance, so the luck test gets stricter as strategies are added. Retired ones still count.</p>
    <p><b>The chart.</b> One solid line per strategy shown. The grey dashed line is the average of their random pickers. Lines move when trades finish.</p>
    <p><b>Trades.</b> Scroll down on the home screen for open trades and the last 10 finished ones. Retired strategies stay in the table above but leave the home screen.</p>
    <p><b>The top-right number.</b> Your pretend ${bank} split evenly across the active strategies: the average of their balances, including open trades. The dot next to it is live data: green is fresh, red is stale, grey is off. Click it to turn live data off or quit.</p>
    <p><b>Coins.</b> Dimmed coins have under ${floor} liquidity, so no strategy trades them. Dots show which strategies hold a coin.</p>
    <p><b>Runs.</b> Changing a shared trading setting (costs, the coin filter) starts a new run with fresh balances, so old and new results never mix. Adding or retiring a strategy does not.</p>
    <h2 id="past-runs">Past runs</h2>
    <p class="muted">Click a run to see its scoreboard as it ended. "Back to now" returns to the current run.</p>
    ${runs.length ? `<table class="t compact runs-table"><tbody>${runRows}</tbody></table>` : '<div class="empty">None yet.</div>'}
    <p class="muted credits">Data: <a href="https://www.geckoterminal.com" target="_blank" rel="noopener">GeckoTerminal</a>. Charts: <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a>.</p>
  </div>`;
}

// ---------- routing & refresh ----------

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  if (page === 'rule' && arg) return { page: 'rule', arg: decodeURIComponent(arg) };
  if (page === 'coin' && arg) return { page: 'coin', arg: decodeURIComponent(arg) };
  if (page === 'coins') return { page: 'coins', arg: '' };
  if (page === 'guide') return { page: 'guide', arg: '' };
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
    else await scoreboardPage(view);
    if (key === lastRoute) view.querySelectorAll('details').forEach((d, i) => (d.open = openDetails[i] ?? false));
  } catch (err) {
    view.innerHTML = `<div class="page empty neg">Couldn't load this page: ${esc(err instanceof Error ? err.message : err)}</div>`;
  } finally {
    view.scrollTop = keepScroll;
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

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(fitHomeChart, 100);
});

/** @param {string} url */
const post = (url) => fetch(url, { method: 'POST', headers: { 'x-paper-lab': '1' } });

/** @param {HTMLButtonElement} b */
async function setLive(b) {
  b.disabled = true;
  closeMenu();
  await post(`/api/live/${b.getAttribute('data-live')}`).catch(() => {});
  await refresh();
}

// The dot in the top bar opens a tiny menu: live data on/off, and quit.
const menu = /** @type {HTMLElement} */ (document.getElementById('menu'));
const closeMenu = () => (menu.hidden = true);
document.getElementById('health')?.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
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
  void setLive(/** @type {HTMLButtonElement} */ (b));
});

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

const events = new EventSource('/api/events');
events.addEventListener('cycle', () => void refresh());
events.addEventListener('state', () => void refresh());
const timer = setInterval(() => void refresh(), 30_000);
void refresh();
