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

/** @type {any} */
const LWC = /** @type {any} */ (window).LightweightCharts;

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
const css = (/** @type {string} */ v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = {
  /** @type {any} */ status: null,
  /** @type {Record<string, string>} */ colors: {},
  /** @type {any[]} */ charts: [],
  showTwinsInFeed: load('showTwinsInFeed') === '1',
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
  const source = s.demo ? 'Demo data' : 'Live data';
  const when = ageSec === null ? 'waiting for first update' : `updated ${ageSec < 120 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`} ago`;
  const tip = healthy
    ? `Prices refresh every ${s.pollIntervalSec}s. ${s.ai.enabled ? `AI scoring on (${s.ai.model}).` : 'AI scoring off.'}`
    : 'No fresh prices for 3+ minutes. New trades pause until data comes back.';
  const el = /** @type {HTMLElement} */ (document.getElementById('health'));
  el.title = tip;
  el.innerHTML = `<span class="health ${healthy ? 'ok' : 'bad'}"></span>${source} · ${when}${s.lastCycle && !s.lastCycle.ok ? ' · <span class="neg">last update failed</span>' : ''}`;
  for (const a of document.querySelectorAll('.nav a')) {
    const r = route();
    const active = a.getAttribute('data-nav') === (r.page === 'coins' || r.page === 'coin' ? 'coins' : 'home');
    a.classList.toggle('active', active);
  }
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

/** @param {any} r  strategy result row */
function verdictPill(r) {
  const v = r.verdict;
  const bar =
    v.label === 'too_early'
      ? `<span class="progress" title="${r.all.closed} of 30 closed trades"><span style="width:${Math.min(100, (r.all.closed / 30) * 100)}%"></span></span>`
      : '';
  return `<span class="verdict ${v.label}" title="${esc(v.detail)}">${VERDICT_TEXT[v.label]}</span>${bar}`;
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
  const [res, trades] = await Promise.all([getJson('/api/results'), getJson('/api/trades?limit=300')]);
  const s = state.status;
  const t = s.trade;
  const rules = res.strategies.filter((/** @type {any} */ r) => r.strategy !== 'random');
  const rows = rules
    .map((/** @type {any} */ r) => {
      const tw = r.twin;
      return `<tr class="link" data-href="#/rule/${esc(r.strategy)}">
        <td><span class="rule-name">${dot(r.strategy)}${esc(ruleName(r.strategy))}</span></td>
        <td>${verdictPill(r)}</td>
        <td class="num">${r.all.closed}<span class="vs">${r.open + r.pending ? `+${r.open + r.pending} open` : ''}</span></td>
        <td class="num">${share(r.all.winRate)}<span class="vs">${share(tw.all.winRate)}</span></td>
        <td class="num"><span class="${tone(r.all.pnlUsd)}">${money(r.all.pnlUsd)}</span><span class="vs">${money(tw.all.pnlUsd)}</span></td>
        <td class="num ${tone(r.verdict.edgePct)}">${r.verdict.edgePct === null ? '–' : pct(r.verdict.edgePct)}</td>
      </tr>`;
    })
    .join('');

  view.innerHTML = `<div class="page">
    <div class="page-head"><h1>Is any rule beating random?</h1></div>
    <p class="sub">Every rule has a random twin that buys a random coin at the same moment, with the same rules: $${t.sizeUsd} per trade · sell at −${t.stopLossPct * 100}% or +${t.takeProfitPct * 100}% or after ${t.timeLimitMin} min · coins with $${Math.round(s.universe.minLiquidityUsd / 1000)}K+ liquidity.</p>
    <div class="scroll-x"><table class="t board"><thead><tr>
      <th>Rule</th><th>Verdict</th><th class="num">Trades</th>
      <th class="num">Win rate <span class="vs">twin</span></th><th class="num">Profit <span class="vs">twin</span></th>
      <th class="num" title="Average result per trade, minus the twin's">Edge / trade</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="legend-note"><b>Too early</b> under 30 closed trades · <b>No edge</b> not beating its twin · <b>Leaning</b> ahead, but could be luck · <b>Clear</b> ahead by more than luck explains</p>

    <div class="split">
      <section>
        <h2>Balance</h2>
        <div class="legend">${rules.map((/** @type {any} */ r) => `<span class="key"><span class="line" style="background:${colorOf(r.strategy)}"></span>${esc(ruleName(r.strategy))}</span>`).join('')}
          <span class="key"><span class="line dashed"></span>twin</span></div>
        <div class="chart-box"><div class="chart" id="balance"></div></div>
      </section>
      <section>
        <h2>Activity <label class="toggle"><input type="checkbox" id="twins" ${state.showTwinsInFeed ? 'checked' : ''}> show twins</label></h2>
        ${feed(trades)}
      </section>
    </div>
    ${calibrationBlock(res.calibration)}
  </div>`;

  /** @type {{id: string, curve: any[], dashed: boolean}[]} */
  const lines = [];
  for (const r of rules) {
    lines.push({ id: r.strategy, curve: r.equityCurve, dashed: false });
    lines.push({ id: r.strategy, curve: r.twin.equityCurve, dashed: true });
  }
  balanceChart(/** @type {HTMLElement} */ (document.getElementById('balance')), lines, res.startingBankrollUsd);
  document.getElementById('twins')?.addEventListener('change', (e) => {
    state.showTwinsInFeed = /** @type {HTMLInputElement} */ (e.target).checked;
    save('showTwinsInFeed', state.showTwinsInFeed ? '1' : '0');
    void render();
  });
}

/** Recent buys and sells, newest first. @param {any[]} trades */
function feed(trades) {
  /** @type {{t: number, html: string}[]} */
  const items = [];
  for (const t of trades) {
    if (t.strategy === 'random' && !state.showTwinsInFeed) continue;
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
  const meta = state.status.signals.find((/** @type {any} */ s) => s.id === id);
  if (!meta) {
    view.innerHTML = `<div class="page"><a class="back" href="#/">← Scoreboard</a><div class="empty">Unknown rule.</div></div>`;
    return;
  }
  const [{ trades, twinTrades, events }, res] = await Promise.all([getJson(`/api/strategies/${encodeURIComponent(id)}`), getJson('/api/results')]);
  const r = res.strategies.find((/** @type {any} */ x) => x.strategy === id);
  const tw = r.twin;
  const active = trades.filter((/** @type {any} */ t) => t.status === 'open' || t.status === 'pending');
  const closed = trades.filter((/** @type {any} */ t) => t.status === 'closed');
  const skipped = trades.filter((/** @type {any} */ t) => t.status === 'cancelled');
  const ci = r.all.winRateCi ? `could be ${share(r.all.winRateCi[0])}–${share(r.all.winRateCi[1])}` : 'no trades yet';
  const params = Object.entries(meta.params).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ');

  view.innerHTML = `<div class="page">
    <a class="back" href="#/">← Scoreboard</a>
    <div class="page-head"><h1 class="rule-name">${dot(id)}${esc(meta.name)}</h1>${verdictPill(r)}</div>
    <p class="sub">${esc(meta.description)} <span title="Settings">(${params})</span></p>

    <div class="strip">
      <div><div class="k">Balance</div><div class="v">$${r.equityUsd.toFixed(2)}</div><div class="s">twin $${tw.equityUsd.toFixed(2)}</div></div>
      <div><div class="k">Profit, closed</div><div class="v ${tone(r.all.pnlUsd)}">${money(r.all.pnlUsd)}</div><div class="s">${money(r.unrealizedPnlUsd)} open</div></div>
      <div><div class="k">Win rate</div><div class="v">${share(r.all.winRate)}</div><div class="s">${ci}</div></div>
      <div><div class="k">Avg per trade</div><div class="v ${tone(r.all.avgPnlPct)}">${pct(r.all.avgPnlPct)}</div><div class="s">twin ${pct(tw.all.avgPnlPct)}</div></div>
      <div><div class="k">Trades</div><div class="v">${r.all.closed}</div><div class="s">${active.length} open · ${skipped.length} skipped</div></div>
    </div>

    <h2>Balance vs twin</h2>
    <div class="chart-box"><div class="chart" id="balance"></div></div>

    <h2>Open (${active.length})</h2>${tradeRows(active, { showWhy: true })}
    <h2>Closed (${closed.length})</h2>${tradeRows(closed, { showWhy: true })}

    <details><summary>Random twin trades (${twinTrades.filter((/** @type {any} */ t) => t.status !== 'cancelled').length})</summary>${tradeRows(twinTrades.filter((/** @type {any} */ t) => t.status !== 'cancelled'))}</details>
    <details><summary>Skipped trades (${skipped.length})</summary>${tradeRows(skipped, { showWhy: true })}</details>
    <details><summary>Every time this rule fired (${events.length})</summary>${firesTable(events)}</details>
  </div>`;
  balanceChart(
    /** @type {HTMLElement} */ (document.getElementById('balance')),
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
        <td class="num ${t.marketCapUsd === null ? 'italic' : ''}">${usd(t.marketCapUsd ?? t.fdvUsd)}</td>
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
  const { snapshots, trades } = await getJson(`/api/pools/${encodeURIComponent(pool)}`);
  const s = snapshots[snapshots.length - 1];
  if (!s) {
    view.innerHTML = `<div class="page"><a class="back" href="#/coins">← Coins</a><div class="empty">No data for this coin.</div></div>`;
    return;
  }
  const cap = s.marketCapUsd ?? s.fdvUsd;
  const filled = trades.filter((/** @type {any} */ t) => t.status !== 'cancelled');
  view.innerHTML = `<div class="page">
    <a class="back" href="javascript:history.back()">← Back</a>
    <div class="page-head"><h1>${esc(s.symbol)}</h1><span class="muted">${esc(s.name)}</span>
      ${s.source === 'geckoterminal' ? `<a href="https://www.geckoterminal.com/solana/pools/${encodeURIComponent(s.poolAddress)}" target="_blank" rel="noopener" style="font-size:12px">GeckoTerminal ↗</a>` : ''}</div>
    <div class="strip">
      <div><div class="k">Price</div><div class="v">${price(s.priceUsd)}</div><div class="s">${s.priceChangeM5 === null ? '' : `${pct(s.priceChangeM5 / 100)} 5m`}</div></div>
      <div><div class="k">Liquidity</div><div class="v">${usd(s.liquidityUsd)}</div><div class="s">${cap ? `${Math.round((s.liquidityUsd / cap) * 100)}% of cap` : ''}</div></div>
      <div><div class="k">${s.marketCapUsd === null ? 'FDV' : 'Market cap'}</div><div class="v">${usd(cap)}</div><div class="s">age ${ago(s.poolCreatedAt)}</div></div>
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

document.getElementById('view')?.addEventListener('click', (e) => {
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
