// @ts-check
// Dashboard frontend. Plain ES module, no build step.
// Token names and symbols come from the market and are untrusted: everything
// interpolated into HTML goes through esc().
//
// Pages (hash routes, so the browser Back button works):
//   #/             Scoreboard: each rule vs its random twin
//   #/rule/<id>    One rule: its trades, its twin's trades, why it fired
//   #/coins        Trending coins
//   #/coin/<pool>  One coin: price chart with every trade marked
//
// Runs: each set of trading rules is its own run. Pages show the current run;
// the picker in the top bar switches to an earlier one (kept until reload).

/** @type {any} */
const LWC = /** @type {any} */ (window).LightweightCharts;

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
const css = (/** @type {string} */ v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = {
  /** @type {any} */ status: null,
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

/** @param {string} strategy */
const colorOf = (strategy) => state.colors[strategy] ?? css('--baseline');
/** @param {string} id */
const ruleName = (id) => state.status?.signals.find((/** @type {any} */ s) => s.id === id)?.name ?? id;
/** Who placed a trade, in words. @param {any} t */
const owner = (t) => (t.strategy === 'random' ? `${ruleName(String(t.book).split(':')[1] ?? '')} twin` : ruleName(t.strategy));
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

// ---------- top bar ----------

function renderTopbar() {
  const s = state.status;
  const lastOk = s.recentPolls.find((/** @type {any} */ p) => p.ok)?.ts ?? null;
  const ageSec = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
  const healthy = ageSec !== null && ageSec < 180;
  const when = ageSec === null ? 'waiting' : ageSec < 120 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;
  const tip = [
    `${s.demo ? 'Demo' : 'Live'} data, last price update ${ageSec === null ? 'not yet' : `${when} ago`}.`,
    healthy ? `Prices refresh every ${s.pollIntervalSec}s.` : 'No fresh prices for 3+ minutes. New trades pause until data comes back.',
    s.ai.enabled ? `AI scoring on (${s.ai.model}).` : '',
  ].join(' ');
  const el = /** @type {HTMLElement} */ (document.getElementById('health'));
  el.title = tip;
  const failed = s.lastCycle && !s.lastCycle.ok;
  el.innerHTML = `${s.demo ? '<span class="badge-demo">DEMO</span>' : ''}<span class="health ${healthy && !failed ? 'ok' : 'bad'}"></span><span class="${healthy ? 'muted' : 'neg'}">${when}</span>`;
  renderRunPicker();
  for (const a of document.querySelectorAll('.nav a')) {
    const r = route();
    const active = a.getAttribute('data-nav') === (r.page === 'coins' || r.page === 'coin' ? 'coins' : 'home');
    a.classList.toggle('active', active);
  }
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

function renderRunPicker() {
  const el = /** @type {HTMLSelectElement} */ (document.getElementById('run-pick'));
  const runs = runsInOrder();
  el.hidden = runs.length < 2;
  if (el.hidden) return;
  const current = state.status.runId;
  el.innerHTML = runs
    .slice()
    .reverse()
    .map((r) => {
      const label =
        r.id === current
          ? `Run ${r.n} · now`
          : `Run ${r.n} · ${dayTime(r.startedAt)} · ${r.trades} trade${r.trades === 1 ? '' : 's'}`;
      return `<option value="${r.id}">${esc(label)}</option>`;
    })
    .join('');
  el.value = String(state.viewRun ?? current);
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
  const p = (/** @type {number} */ x) => `${+(x * 100).toFixed(2)}%`;
  if (t.sizeUsd !== undefined && t.sizeUsd !== n.sizeUsd) out.push(`$${t.sizeUsd} per trade`);
  if (t.stopLossPct !== undefined && t.stopLossPct !== n.stopLossPct) out.push(`stop at −${p(t.stopLossPct)}`);
  if (t.takeProfitPct !== undefined && t.takeProfitPct !== n.takeProfitPct) out.push(`take profit at +${p(t.takeProfitPct)}`);
  if (t.timeLimitMin !== undefined && t.timeLimitMin !== n.timeLimitMin) out.push(`${t.timeLimitMin} min limit`);
  if (t.feeRate !== undefined && (t.feeRate !== n.feeRate || t.slippageRate !== n.slippageRate)) out.push(`costs ${p(t.feeRate)} fee + ${p(t.slippageRate)} slippage`);
  if (a.universe === null && now.universe) out.push('no liquidity floor');
  else if (a.universe && a.universe.minLiquidityUsd !== now.universe.minLiquidityUsd) out.push(`coins with ${usd(a.universe.minLiquidityUsd)}+ liquidity`);
  for (const [id, params] of Object.entries(a.signals ?? {})) {
    const cur = now.signals?.[id];
    if (cur && JSON.stringify(cur) !== JSON.stringify(params)) out.push(`different ${ruleName(id)} settings`);
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

/** Trade rules for the run being shown, falling back to today's for anything not recorded. */
function shownRules() {
  const run = shownRun();
  return {
    trade: { ...state.status.trade, ...(run?.settings.trade ?? {}) },
    universe: run ? run.settings.universe : state.status.universe,
  };
}

// ---------- charts ----------

function destroyCharts() {
  for (const c of state.charts) c.remove();
  state.charts = [];
}

/** @param {HTMLElement} el */
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
 * Balance over time: each rule solid, its twin dashed in the same color.
 * @param {HTMLElement} el
 * @param {{id: string, curve: any[], dashed: boolean}[]} lines
 * @param {number} start
 */
function balanceChart(el, lines, start) {
  if (!lines.some((l) => l.curve.length)) {
    el.innerHTML = `<div class="empty" style="padding:18px">No closed trades yet.</div>`;
    return;
  }
  const fmt = (/** @type {number} */ v) => `$${v.toFixed(0)}`;
  const chart = baseChart(el, fmt);
  for (const l of lines) {
    if (!l.curve.length) continue;
    const series = chart.addSeries(LWC.LineSeries, {
      color: colorOf(l.id),
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
    const color = colorOf(t.strategy);
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

const VERDICT_TEXT = /** @type {Record<string, string>} */ ({
  too_early: 'Too early',
  no_edge: 'No edge',
  leaning: 'Leaning',
  clear: 'Clear',
});

// The HUD reads top to bottom by importance: how far each rule is ahead of
// random (largest, brightest), the six go-live checks (pips), progress toward
// enough trades (thin bar), then everything else, quieter or folded away.

/** Profit minus its random twin's profit, closed trades. @param {any} r */
const edgeUsd = (r) => r.all.pnlUsd - r.twin.all.pnlUsd;

/** Verdict word, only once there are enough trades for it to mean something. @param {any} r */
function verdictTag(r) {
  const v = r.verdict;
  if (!v || v.label === 'too_early') return '';
  return `<span class="tag ${v.label}" title="${esc(v.detail)}">${VERDICT_TEXT[v.label]}</span>`;
}

/** The six go-live checks as pips; hover lists them. @param {any} r */
function pips(r) {
  const c = r.checks ?? [];
  const passed = c.filter((/** @type {any} */ x) => x.pass).length;
  const tip = ['Go-live checks', ...c.map((/** @type {any} */ x) => `${x.pass ? '✓' : '✗'} ${x.label} (${x.detail})`)].join('\n');
  return `<span class="pips" title="${esc(tip)}">${c.map((/** @type {any} */ x) => `<i class="${x.pass ? 'on' : ''}"></i>`).join('')}<b>${passed}/${c.length}</b></span>`;
}

/** Progress toward the closed trades a verdict needs, like an XP bar. @param {any} r */
function xpBar(r) {
  const need = 30;
  const p = Math.min(1, r.all.closed / need);
  return `<div class="xp ${p >= 1 ? 'full' : ''}" title="${r.all.closed} of ${need} closed trades"><span style="width:${(p * 100).toFixed(1)}%"></span></div>`;
}

/** Big number: how far ahead of random. @param {any} r */
function heroNumber(r) {
  const e = edgeUsd(r);
  const none = r.all.closed === 0 && r.twin.all.closed === 0;
  return `<div class="hero ${none ? 'muted' : tone(e)}" title="Profit minus its random twin's profit (closed trades)">${none ? '$0' : money(e)}<span class="hero-unit">vs random</span></div>`;
}

/** @param {any} r @param {boolean} lead */
function ruleCard(r, lead) {
  const open = r.open + r.pending;
  const bits = [r.all.closed ? `${share(r.all.winRate)} win` : '', `${r.all.closed} closed`, open ? `${open} open` : ''].filter(Boolean);
  return `<a class="card ${lead ? 'lead' : ''}" href="#/rule/${esc(r.strategy)}" style="--c:${colorOf(r.strategy)}">
    <div class="card-top"><span class="rule-name">${dot(r.strategy)}${esc(ruleName(r.strategy))}</span>${verdictTag(r)}</div>
    ${heroNumber(r)}
    <div class="card-row">${pips(r)}<span class="card-sub">${bits.join(' · ')}</span></div>
    ${xpBar(r)}
  </a>`;
}

/** The rule closest to going live: most checks passed, then furthest ahead. @param {any[]} rules */
function leaderOf(rules) {
  const score = (/** @type {any} */ r) => (r.checks ?? []).filter((/** @type {any} */ c) => c.pass).length * 1e6 + edgeUsd(r);
  const withTrades = rules.filter((r) => r.all.closed > 0);
  return withTrades.length ? withTrades.reduce((a, b) => (score(b) > score(a) ? b : a)).strategy : null;
}

const hm = (/** @type {number} */ ms) => `${Math.floor(ms / 3600_000)}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}`;

/** Paper-run clock toward the 3 hours the go-live rules ask for. @param {any} c */
function clockBar(c) {
  const { trade: t, universe } = shownRules();
  const p = Math.min(1, c.activeMs / c.targetMs);
  const tip = [
    `Paper run time: ${hm(c.activeMs)} of ${hm(c.targetMs)}. Stops longer than 5 minutes don't count. Changing a setting starts a new run.`,
    `Every rule and its random twin: $${t.sizeUsd} trades, sell at −${+(t.stopLossPct * 100).toFixed(2)}% or +${+(t.takeProfitPct * 100).toFixed(2)}% or after ${t.timeLimitMin} min${universe ? `, coins with $${Math.round(universe.minLiquidityUsd / 1000)}K+ liquidity` : ''}.`,
  ].join('\n');
  return `<div class="clock ${p >= 1 ? 'done' : ''}" title="${esc(tip)}"><span class="clock-t">${hm(c.activeMs)}<span class="muted"> / ${hm(c.targetMs)}</span></span><div class="clock-bar"><span style="width:${(p * 100).toFixed(1)}%"></span></div></div>`;
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

/** Open positions, best first. @param {any[]} trades */
function positions(trades) {
  const open = trades.filter((t) => t.status === 'open' || t.status === 'pending').sort((a, b) => (b.markPct ?? -1e9) - (a.markPct ?? -1e9));
  if (!open.length) return `<div class="empty">Nothing open.</div>`;
  return `<table class="t compact pos-list"><tbody>${open
    .map(
      (t) => `<tr class="link" data-href="#/coin/${encodeURIComponent(t.poolAddress)}">
        <td><span class="rule-name">${dot(t.strategy === 'random' ? String(t.book).split(':')[1] : t.strategy)}<b>${esc(t.symbol)}</b></span></td>
        <td class="num big ${tone(t.markPct)}">${t.status === 'pending' ? '<span class="muted">buying</span>' : pct(t.markPct)}</td>
        <td class="num muted">${t.openedAt ? duration(Date.now() - t.openedAt) : ''}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

/** One-line plain explanation of how a trade ended (or where it stands). @param {any} t */
function outcome(t) {
  if (t.status === 'pending') return '<span class="secondary">buying at next price check</span>';
  if (t.status === 'cancelled') {
    return `<span class="muted">skipped: ${esc(
      { chased: 'price jumped 5%+ before it could buy', no_data: 'no fresh price to buy at', twin_cancelled: 'its rule skipped too' }[
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
  const [res, trades] = await Promise.all([getJson(forRun('/api/results')), getJson(forRun('/api/trades?limit=300'))]);
  const rules = res.strategies.filter((/** @type {any} */ r) => r.strategy !== 'random');
  const lead = leaderOf(rules);
  const mine = trades.filter((/** @type {any} */ t) => t.strategy !== 'random');
  const openCount = mine.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending').length;

  view.innerHTML = `<div class="page">
    ${pastRunBanner()}
    ${clockBar(res.clock)}
    <div class="cards">${rules.map((/** @type {any} */ r) => ruleCard(r, r.strategy === lead)).join('')}</div>
    ${panel('balance', `Balance <span class="key-dash" title="Dashed lines are each rule's random twin"></span>`, '<div class="chart-box"><div class="chart" id="balance"></div></div>')}
    <div class="split">
      ${panel('positions', `Open <span class="count">${openCount}</span>`, positions(mine))}
      ${panel('activity', 'Activity', feed(mine), false)}
    </div>
    ${calibrationBlock(res.calibration)}
  </div>`;

  /** @type {{id: string, curve: any[], dashed: boolean}[]} */
  const lines = [];
  for (const r of rules) {
    lines.push({ id: r.strategy, curve: r.equityCurve, dashed: false });
    lines.push({ id: r.strategy, curve: r.twin.equityCurve, dashed: true });
  }
  const el = document.getElementById('balance');
  if (el && el.offsetWidth) balanceChart(el, lines, res.startingBankrollUsd);
}

/** Recent buys and sells, newest first. @param {any[]} trades */
function feed(trades) {
  /** @type {{t: number, html: string}[]} */
  const items = [];
  for (const t of trades) {
    const who = `<span class="rule-name">${dot(t.strategy === 'random' ? String(t.book).split(':')[1] : t.strategy)}${esc(owner(t))}</span>`;
    const coin = `<b>${esc(t.symbol)}</b>`;
    if (t.openedAt) items.push({ t: t.openedAt, html: `<td class="kind pos">BUY</td><td>${coin} <span class="muted">·</span> ${who}</td>` });
    if (t.status === 'closed') {
      items.push({ t: t.closedAt, html: `<td class="kind neg">SELL</td><td>${coin} ${outcome(t)}<br><span class="muted">${esc(owner(t))}</span></td>` });
    }
  }
  items.sort((a, b) => b.t - a.t);
  if (!items.length) return `<div class="empty">Waiting for the first trade.</div>`;
  return `<table class="feed" style="width:100%;border-collapse:collapse"><tbody>${items
    .slice(0, 14)
    .map((i) => `<tr><td class="when">${clock(i.t)}</td>${i.html}</tr>`)
    .join('')}</tbody></table>`;
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

/** @param {HTMLElement} view @param {string} id */
async function rulePage(view, id) {
  const [{ trades, twinTrades, events }, res] = await Promise.all([
    getJson(forRun(`/api/strategies/${encodeURIComponent(id)}`)),
    getJson(forRun('/api/results')),
  ]);
  const r = res.strategies.find((/** @type {any} */ x) => x.strategy === id);
  if (!r) {
    view.innerHTML = `<div class="page">${pastRunBanner()}<a class="back" href="#/">← Scoreboard</a><div class="empty">This rule has no trades in this run.</div></div>`;
    return;
  }
  // A past run may hold a rule that has since been removed, or used other settings.
  const known = state.status.signals.find((/** @type {any} */ s) => s.id === id);
  const runParams = shownRun()?.settings.signals?.[id];
  const meta = { name: known?.name ?? id, description: known?.description ?? '', params: runParams ?? known?.params ?? {} };
  const tw = r.twin;
  const active = trades.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending');
  const closed = trades.filter((/** @type {any} */ t) => t.status === 'closed');
  const skipped = trades.filter((/** @type {any} */ t) => t.status === 'cancelled');
  const ci = r.all.winRateCi ? `could be ${share(r.all.winRateCi[0])}–${share(r.all.winRateCi[1])}` : 'none closed yet';
  const params = Object.entries(meta.params).map(([k, v]) => `${k} ${v}`).join(' · ');
  const checks = `<table class="t compact checks"><tbody>${r.checks
    .map((/** @type {any} */ c) => `<tr><td class="${c.pass ? 'pos' : 'muted'}">${c.pass ? '✓' : '✗'}</td><td>${esc(c.label)}</td><td class="num muted">${esc(c.detail)}</td></tr>`)
    .join('')}</tbody></table>`;
  const twinFilled = twinTrades.filter((/** @type {any} */ t) => t.status !== 'cancelled');

  view.innerHTML = `<div class="page">
    ${pastRunBanner()}
    <a class="back" href="#/">← Scoreboard</a>
    <div class="rule-hero" style="--c:${colorOf(id)}">
      <div>
        <div class="card-top"><h1 class="rule-name" title="${esc(meta.description)}${params ? `\n${esc(params)}` : ''}">${dot(id)}${esc(meta.name)}</h1>${verdictTag(r)}</div>
        ${heroNumber(r)}
        <div class="card-row">${pips(r)}</div>
      </div>
      <div class="strip">
        <div><div class="k">Balance</div><div class="v">$${r.equityUsd.toFixed(0)}</div><div class="s">twin $${tw.equityUsd.toFixed(0)}</div></div>
        <div><div class="k">Win rate</div><div class="v">${share(r.all.winRate)}</div><div class="s">${ci}</div></div>
        <div><div class="k">Avg trade</div><div class="v ${tone(r.all.avgPnlPct)}">${pct(r.all.avgPnlPct)}</div><div class="s">twin ${pct(tw.all.avgPnlPct)}</div></div>
        <div><div class="k">Closed</div><div class="v">${r.all.closed}</div><div class="s">${active.length} open · ${skipped.length} skipped</div></div>
      </div>
      ${xpBar(r)}
    </div>

    ${panel('rule-checks', `Go-live checks <span class="count">${r.checks.filter((/** @type {any} */ c) => c.pass).length}/6</span>`, checks, false)}
    ${panel('rule-balance', `Balance <span class="key-dash" title="Dashed line is the random twin"></span>`, '<div class="chart-box"><div class="chart" id="balance"></div></div>')}
    ${panel('rule-open', `Open <span class="count">${active.length}</span>`, tradeRows(active, { showWhy: true }))}
    ${panel('rule-closed', `Closed <span class="count">${closed.length}</span>`, tradeRows(closed, { showWhy: true }))}
    ${panel('rule-twin', `Random twin <span class="count">${twinFilled.length}</span>`, tradeRows(twinFilled), false)}
    ${panel('rule-skipped', `Skipped <span class="count">${skipped.length}</span>`, tradeRows(skipped, { showWhy: true }), false)}
    ${panel('rule-fires', `Every fire <span class="count">${events.length}</span>`, firesTable(events), false)}
  </div>`;
  const el = document.getElementById('balance');
  if (el && el.offsetWidth) balanceChart(
    el,
    [
      { id, curve: r.equityCurve, dashed: false },
      { id, curve: tw.equityCurve, dashed: true },
    ],
    res.startingBankrollUsd,
  );
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
      const holders = [...new Set(t.openStrategies)].map((st) => dot(String(st))).join('');
      const r = ratio(t);
      return `<tr class="link" data-href="#/coin/${encodeURIComponent(t.poolAddress)}" style="${tradable ? '' : 'opacity:.5'}">
        <td class="num muted">${t.trendingRank ?? ''}</td>
        <td><b>${esc(t.symbol)}</b> <span style="display:inline-flex;gap:3px;margin-left:4px">${holders}</span></td>
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
    <p class="sub">Dimmed coins have under $${Math.round(min / 1000)}K liquidity, so no rule trades them. Dots show which rules hold a coin.</p>
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
    <h2>Price <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· ▲ buy ▼ sell, colored by rule</span></h2>
    <div class="chart-box"><div class="readout"></div><div class="chart tall" id="price"></div></div>
    <h2>Trades on this coin (${filled.length})</h2>
    ${filled.length ? `<table class="t compact"><tbody>${filled.map((/** @type {any} */ t) => `<tr><td class="muted mono">${clock(t.openedAt ?? t.signalAt)}</td><td><span class="rule-name">${dot(t.strategy === 'random' ? String(t.book).split(':')[1] : t.strategy)}${esc(owner(t))}</span></td><td class="wrap">${outcome(t)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No rule has traded this coin.</div>'}
  </div>`;
  priceChart(/** @type {HTMLElement} */ (document.getElementById('price')), snapshots, filled);
}

// ---------- routing & refresh ----------

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  if (page === 'rule' && arg) return { page: 'rule', arg: decodeURIComponent(arg) };
  if (page === 'coin' && arg) return { page: 'coin', arg: decodeURIComponent(arg) };
  if (page === 'coins') return { page: 'coins', arg: '' };
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
    if (r.page === 'rule') await rulePage(view, r.arg);
    else if (r.page === 'coins') await coinsPage(view);
    else if (r.page === 'coin') await coinPage(view, r.arg);
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

async function refresh() {
  try {
    state.status = await getJson('/api/status');
    state.status.signals.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      state.colors[s.id] = css(SERIES_VARS[i % SERIES_VARS.length]);
    });
    state.colors.random = css('--baseline');
    renderTopbar();
    await render();
  } catch {
    const el = document.getElementById('health');
    if (el) el.innerHTML = `<span class="health bad"></span><span class="neg">Can't reach Paper Lab. Is it still running?</span>`;
  }
}

document.getElementById('run-pick')?.addEventListener('change', (e) => {
  const id = Number(/** @type {HTMLSelectElement} */ (e.target).value);
  state.viewRun = id === state.status.runId ? null : id;
  if (route().page === 'coins') location.hash = '#/';
  void render();
});

document.getElementById('view')?.addEventListener(
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

document.getElementById('view')?.addEventListener('click', (e) => {
  if (/** @type {HTMLElement} */ (e.target).closest('[data-run="current"]')) {
    state.viewRun = null;
    renderRunPicker();
    void render();
    return;
  }
  const tr = /** @type {HTMLElement} */ (e.target).closest('[data-href]');
  if (tr && !/** @type {HTMLElement} */ (e.target).closest('a, input, label, summary')) location.hash = String(tr.getAttribute('data-href'));
});
window.addEventListener('hashchange', () => {
  if (state.status) renderTopbar();
  void render();
});

const events = new EventSource('/api/events');
events.addEventListener('cycle', () => void refresh());
setInterval(() => void refresh(), 30_000);
void refresh();
