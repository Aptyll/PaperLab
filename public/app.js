// @ts-check
// Dashboard frontend. Plain ES module, no build step.
// Token names and symbols come from the market and are untrusted: everything
// interpolated into HTML goes through esc().

/* global LightweightCharts */
/** @type {any} */
const LWC = /** @type {any} */ (window).LightweightCharts;

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
const css = (/** @type {string} */ v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = {
  /** @type {any} */ status: null,
  /** @type {any[]} */ tokens: [],
  /** @type {string|null} */ selectedPool: null,
  tab: 'market',
  /** @type {Record<string, string>} */ colors: {},
  /** @type {any[]} */ charts: [],
};

// ---------- formatting ----------

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** @param {number|null|undefined} n */
function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Exact dollars for P&L. @param {number|null|undefined} n */
function pnlUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
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
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
}

/** @param {number|null|undefined} x */
const signClass = (x) => (x === null || x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

/** @param {number|null|undefined} ms */
function age(ms) {
  if (!ms) return '–';
  const m = Math.max(0, (Date.now() - ms) / 60000);
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** @param {number|null|undefined} ms */
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
/** @param {number|null|undefined} ms */
const stamp = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

/** @param {string} strategy */
const colorOf = (strategy) => state.colors[strategy] ?? css('--baseline');
/** @param {string} strategy */
function strategyName(strategy) {
  if (strategy === 'random') return 'Random baseline';
  return state.status?.signals.find((/** @type {any} */ s) => s.id === strategy)?.name ?? strategy;
}

/** @param {string} url */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------- top bar & token list ----------

function renderTopbar() {
  const s = state.status;
  const src = /** @type {HTMLElement} */ (document.getElementById('source-badge'));
  src.textContent = s.demo ? 'DEMO DATA (simulated)' : 'LIVE: GeckoTerminal';
  src.className = `badge ${s.demo ? 'badge-demo' : 'badge-live'}`;
  const c = s.lastCycle;
  const ps = /** @type {HTMLElement} */ (document.getElementById('poll-status'));
  if (!c) ps.textContent = 'waiting for first poll…';
  else if (c.ok) ps.innerHTML = `last poll ${esc(clock(c.ts))} · ${c.snapshots} pools · every ${s.pollIntervalSec}s`;
  else ps.innerHTML = `<span class="neg">poll failed ${esc(clock(c.ts))}: ${esc(c.error)}</span>`;
  /** @type {HTMLElement} */ (document.getElementById('calls')).textContent = s.demo ? '' : `${s.callsInLastMinute}/30 API calls/min`;
  const ai = /** @type {HTMLElement} */ (document.getElementById('ai-badge'));
  ai.textContent = s.ai.enabled ? `AI: ${s.ai.model}` : 'AI scoring off';
}

/** @param {any} t */
const bsRatio = (t) => {
  const b = t.buyersM5 ?? t.buysM5;
  const s = t.sellersM5 ?? t.sellsM5;
  if (b === null || s === null) return null;
  return b / Math.max(s, 1);
};

function renderTokens() {
  /** @type {HTMLElement} */ (document.getElementById('token-count')).textContent = `${state.tokens.length} pools`;
  const tbody = /** @type {HTMLElement} */ (document.querySelector('#token-table tbody'));
  if (!state.tokens.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No data yet. The first poll runs at startup.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.tokens
    .map((t) => {
      const mc = t.marketCapUsd ?? t.fdvUsd;
      const ratio = bsRatio(t);
      const dots = [...new Set(t.openStrategies)]
        .map((st) => `<span class="dot" style="background:${colorOf(String(st))}" title="Open: ${esc(strategyName(String(st)))}"></span>`)
        .join('');
      return `<tr data-pool="${esc(t.poolAddress)}" class="${t.poolAddress === state.selectedPool ? 'selected' : ''}">
        <td class="num muted">${t.trendingRank ?? '·'}</td>
        <td title="${esc(t.name)}">${esc(t.symbol)}${dots ? `<span class="dots">${dots}</span>` : ''}</td>
        <td class="num">${price(t.priceUsd)}</td>
        <td class="num ${signClass(t.priceChangeM5)}">${t.priceChangeM5 === null ? '–' : pct(t.priceChangeM5 / 100)}</td>
        <td class="num">${usd(t.liquidityUsd)}</td>
        <td class="num ${t.marketCapUsd === null ? 'italic secondary' : ''}">${usd(mc)}</td>
        <td class="num">${age(t.poolCreatedAt)}</td>
        <td class="num">${ratio === null ? '–' : ratio.toFixed(2)}</td>
      </tr>`;
    })
    .join('');
}

document.querySelector('#token-table tbody')?.addEventListener('click', (e) => {
  const tr = /** @type {HTMLElement} */ (e.target).closest('tr[data-pool]');
  if (!tr) return;
  state.selectedPool = tr.getAttribute('data-pool');
  state.tab = 'market';
  renderTabs();
  renderTokens();
  void renderView();
});

// ---------- tabs ----------

function tabList() {
  return [
    { id: 'market', label: 'Market' },
    ...state.status.signals.map((/** @type {any} */ s) => ({ id: `strategy:${s.id}`, label: s.name, color: colorOf(s.id) })),
    { id: 'strategy:random', label: 'Random', color: colorOf('random') },
    { id: 'results', label: 'Results' },
  ];
}

function renderTabs() {
  const nav = /** @type {HTMLElement} */ (document.getElementById('tabs'));
  nav.innerHTML = tabList()
    .map(
      (t) =>
        `<button role="tab" data-tab="${esc(t.id)}" aria-selected="${t.id === state.tab}">` +
        `${t.color ? `<span class="swatch" style="background:${t.color}"></span>` : ''}${esc(t.label)}</button>`,
    )
    .join('');
}

document.getElementById('tabs')?.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button[data-tab]');
  if (!b) return;
  state.tab = String(b.getAttribute('data-tab'));
  try { localStorage.setItem('tab', state.tab); } catch {}
  renderTabs();
  void renderView();
});

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
      background: { type: 'solid', color: css('--surface-1') },
      textColor: css('--text-secondary'),
      fontFamily: css('--mono'),
      fontSize: 11,
      attributionLogo: true,
    },
    grid: { vertLines: { color: '#1d1f23' }, horzLines: { color: '#1d1f23' } },
    rightPriceScale: { borderColor: css('--border') },
    timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: {
      priceFormatter,
      timeFormatter: (/** @type {number} */ t) => new Date(t * 1000).toLocaleString(),
    },
  });
  state.charts.push(chart);
  return chart;
}

/**
 * Lightweight Charts needs strictly increasing times in seconds.
 * @param {{t: number, v: number}[]} pts  t in ms
 */
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
    const color = colorOf(t.strategy);
    const openTime = Math.floor(t.openedAt / 1000);
    if (openTime >= first) {
      markers.push({ time: openTime, position: 'belowBar', shape: 'arrowUp', color, size: 1, text: '' });
    }
    if (t.closedAt) {
      markers.push({
        time: Math.floor(t.closedAt / 1000),
        position: 'aboveBar',
        shape: 'arrowDown',
        color,
        size: 1,
        text: pct(t.pnlPct, 0),
      });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  LWC.createSeriesMarkers(series, markers);
  chart.timeScale().fitContent();

  const readout = /** @type {HTMLElement} */ (el.parentElement?.querySelector('.readout'));
  chart.subscribeCrosshairMove((/** @type {any} */ p) => {
    if (!readout) return;
    const v = p?.seriesData?.get(series);
    readout.textContent = v ? `${new Date(p.time * 1000).toLocaleTimeString()}  ${price(v.value)}` : '';
  });
}

/**
 * @param {HTMLElement} el
 * @param {any[]} strategies
 * @param {number} start
 */
function equityChart(el, strategies, start) {
  const chart = baseChart(el, (/** @type {number} */ v) => `$${v.toFixed(2)}`);
  let any = false;
  const lines = [];
  for (const s of strategies) {
    if (s.strategy === 'random') continue;
    lines.push({ color: colorOf(s.strategy), dashed: false, curve: s.equityCurve });
    if (s.twin) lines.push({ color: colorOf(s.strategy), dashed: true, curve: s.twin.equityCurve });
  }
  for (const l of lines) {
    if (!l.curve.length) continue;
    any = true;
    const series = chart.addSeries(LWC.LineSeries, {
      color: l.color,
      lineWidth: 2,
      lineStyle: l.dashed ? 2 : 0,
      priceLineVisible: false,
      priceFormat: { type: 'custom', formatter: (/** @type {number} */ v) => `$${v.toFixed(2)}`, minMove: 0.01 },
    });
    const firstT = l.curve[0].t - 1000;
    series.setData(toSeries([{ t: firstT, v: start }, ...l.curve.map((/** @type {any} */ p) => ({ t: p.t, v: p.equity }))]));
  }
  chart.timeScale().fitContent();
  return any;
}

// ---------- views ----------

/** @param {string} k @param {string} v @param {string} [sub] @param {string} [cls] */
const tile = (k, v, sub = '', cls = '') =>
  `<div class="tile"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

/** @param {any[]} trades @param {boolean} showStrategy */
function tradesTable(trades, showStrategy) {
  if (!trades.length) return `<div class="empty">No trades yet.</div>`;
  const rows = trades
    .map((t) => {
      const ai = t.aiProbability === null ? '–' : `${Math.round(t.aiProbability * 100)}%`;
      return `<tr>
        ${showStrategy ? `<td><span class="dot" style="background:${colorOf(t.strategy)}"></span> ${esc(strategyName(t.strategy))}</td>` : ''}
        <td>${esc(t.symbol)}</td>
        <td>${esc(stamp(t.openedAt))}</td>
        <td class="num">${price(t.entryPrice)}</td>
        <td class="num">${t.exitPrice === null ? '–' : price(t.exitPrice)}</td>
        <td>${t.status === 'open' ? '<span class="secondary">open</span>' : esc(String(t.exitReason).replace('_', ' '))}</td>
        <td class="num ${signClass(t.pnlUsd)}">${pnlUsd(t.pnlUsd)}</td>
        <td class="num ${signClass(t.pnlPct)}">${pct(t.pnlPct)}</td>
        <td class="num" title="${esc(t.aiRationale ?? '')}">${ai}</td>
        ${t.matchedTradeId ? `<td class="muted">vs #${t.matchedTradeId}</td>` : '<td></td>'}
        <td class="muted">#${t.id}</td>
      </tr>`;
    })
    .join('');
  return `<table class="grid"><thead><tr>
    ${showStrategy ? '<th>Strategy</th>' : ''}<th>Token</th><th>Opened</th><th class="num">Entry</th><th class="num">Exit</th>
    <th>Status</th><th class="num">P&amp;L</th><th class="num">P&amp;L %</th><th class="num" title="AI probability of closing in profit">AI p</th><th></th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/** @param {HTMLElement} view */
async function marketView(view) {
  if (!state.selectedPool && state.tokens.length) state.selectedPool = state.tokens[0].poolAddress;
  if (!state.selectedPool) {
    view.innerHTML = `<div class="empty">Waiting for market data…</div>`;
    return;
  }
  const pool = state.selectedPool;
  const { snapshots, trades } = await getJson(`/api/pools/${encodeURIComponent(pool)}`);
  const s = snapshots[snapshots.length - 1];
  if (!s) {
    view.innerHTML = `<div class="empty">No snapshots for this pool.</div>`;
    return;
  }
  const cap = s.marketCapUsd ?? s.fdvUsd;
  const ratio = bsRatio(s);
  const strategiesHere = [...new Set(trades.map((/** @type {any} */ t) => t.strategy))];
  view.innerHTML = `
    <div class="head">
      <span class="sym">${esc(s.symbol)}</span>
      <span class="secondary">${esc(s.name)}</span>
      <span class="muted">${esc(s.dex ?? '')}</span>
      ${s.source === 'geckoterminal' ? `<a href="https://www.geckoterminal.com/solana/pools/${encodeURIComponent(s.poolAddress)}" target="_blank" rel="noopener">view on GeckoTerminal ↗</a>` : ''}
      <span class="muted">pool ${esc(s.poolAddress.slice(0, 6))}…${esc(s.poolAddress.slice(-4))}</span>
    </div>
    <div class="section chart-wrap"><div class="readout"></div><div class="chart" id="price-chart"></div></div>
    ${strategiesHere.length ? `<div class="legend"><span class="muted">Trade markers: ▲ entry ▼ exit</span>${strategiesHere.map((st) => `<span class="key"><span class="dot" style="background:${colorOf(String(st))}"></span>${esc(strategyName(String(st)))}</span>`).join('')}</div>` : ''}
    <div class="section"><h3>Latest snapshot · ${esc(clock(s.ts))} · ${snapshots.length} stored</h3>
      <div class="tiles">
        ${tile('Price', price(s.priceUsd))}
        ${tile(s.marketCapUsd === null ? 'FDV (no mcap)' : 'Market cap', usd(cap), s.marketCapUsd !== null && s.fdvUsd ? `FDV ${usd(s.fdvUsd)}` : '')}
        ${tile('Liquidity', usd(s.liquidityUsd), cap ? `${((s.liquidityUsd / cap) * 100).toFixed(1)}% of cap` : '')}
        ${tile('Vol 5m', usd(s.volM5), `1h ${usd(s.volH1)}`)}
        ${tile('Vol 24h', usd(s.volH24), `6h ${usd(s.volH6)}`)}
        ${tile('Buyers / sellers 5m', `${s.buyersM5 ?? '–'} / ${s.sellersM5 ?? '–'}`, ratio === null ? '' : `ratio ${ratio.toFixed(2)}`)}
        ${tile('Buys / sells 5m', `${s.buysM5 ?? '–'} / ${s.sellsM5 ?? '–'}`, `1h ${s.buysH1 ?? '–'} / ${s.sellsH1 ?? '–'}`)}
        ${tile('Buys / sells 24h', `${s.buysH24 ?? '–'} / ${s.sellsH24 ?? '–'}`)}
        ${tile('Change 5m', s.priceChangeM5 === null ? '–' : pct(s.priceChangeM5 / 100), s.priceChangeH1 === null ? '' : `1h ${pct(s.priceChangeH1 / 100)}`, signClass(s.priceChangeM5))}
        ${tile('Pool age', age(s.poolCreatedAt), s.poolCreatedAt ? esc(stamp(s.poolCreatedAt)) : '')}
      </div>
    </div>
    <div class="section"><h3>Paper trades on this token</h3>${tradesTable(trades, true)}</div>`;
  priceChart(/** @type {HTMLElement} */ (document.getElementById('price-chart')), snapshots, trades);
}

/** @param {HTMLElement} view @param {string} strategy */
async function strategyView(view, strategy) {
  const [{ events, trades }, results] = await Promise.all([
    getJson(`/api/strategies/${encodeURIComponent(strategy)}`),
    getJson('/api/results'),
  ]);
  const r = results.strategies.find((/** @type {any} */ x) => x.strategy === strategy);
  const meta = state.status.signals.find((/** @type {any} */ s) => s.id === strategy);
  const open = trades.filter((/** @type {any} */ t) => t.status === 'open');
  const closed = trades.filter((/** @type {any} */ t) => t.status === 'closed');
  const ci = r.all.winRateCi ? `95% CI ${Math.round(r.all.winRateCi[0] * 100)}–${Math.round(r.all.winRateCi[1] * 100)}%` : 'no closed trades';
  const m = r.twin?.all ?? null;
  const isRandom = strategy === 'random';
  const description =
    strategy === 'random'
      ? 'Control trades. Every time a signal opens a trade, that signal\'s random twin opens one on a token picked uniformly at random from the same filtered trending list, with identical size, costs and exits, from its own $1,000. A signal is only interesting if it beats its twin. Money figures here are averages across the twins.'
      : meta?.description ?? '';
  view.innerHTML = `
    <div class="head"><span class="sym"><span class="swatch dot" style="background:${colorOf(strategy)}"></span> ${esc(strategyName(strategy))}</span></div>
    <p class="desc">${esc(description)}</p>
    ${meta ? `<p class="params muted">Params: ${Object.entries(meta.params).map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`).join(' · ')}</p>` : ''}
    <div class="section tiles">
      ${tile(isRandom ? 'Equity (avg twin)' : 'Equity', `$${r.equityUsd.toFixed(2)}`, `start $${results.startingBankrollUsd}`)}
      ${isRandom ? '' : tile('Realized P&L', pnlUsd(r.all.pnlUsd), `unrealized ${pnlUsd(r.unrealizedPnlUsd)}`, signClass(r.all.pnlUsd))}
      ${tile('Win rate', r.all.winRate === null ? '–' : `${(r.all.winRate * 100).toFixed(0)}%`, esc(ci))}
      ${tile('Closed / open', `${r.all.closed} / ${r.open}`, isRandom ? 'all twins' : `cash $${r.cashUsd.toFixed(2)}`)}
      ${tile('Avg P&L / trade', pct(r.all.avgPnlPct), `median ${pct(r.all.medianPnlPct)}`, signClass(r.all.avgPnlPct))}
      ${m ? tile('Random twin', m.winRate === null ? '–' : `${(m.winRate * 100).toFixed(0)}% win`, `${m.closed} closed · avg ${pct(m.avgPnlPct)} · equity $${r.twin.equityUsd.toFixed(2)}`) : ''}
    </div>
    <div class="section"><h3>Open trades (${open.length})</h3>${tradesTable(open, false)}</div>
    <div class="section"><h3>Closed trades (${closed.length})</h3>${tradesTable(closed, false)}</div>
    ${strategy === 'random' ? '' : `<div class="section"><h3>Recent signal fires (${events.length})</h3>${eventsTable(events)}</div>`}`;
}

/** @param {any[]} events */
function eventsTable(events) {
  if (!events.length) return `<div class="empty">This signal hasn't fired yet.</div>`;
  const label = /** @type {Record<string, string>} */ ({
    already_open: 'skipped: already holding',
    cooldown: 'skipped: cooldown',
    no_cash: 'skipped: no cash',
  });
  return `<table class="grid"><thead><tr><th>Time</th><th>Token</th><th class="num">Value</th><th>Why</th><th>Result</th></tr></thead><tbody>
    ${events
      .map(
        (e) => `<tr><td>${esc(stamp(e.ts))}</td><td>${esc(e.symbol)}</td><td class="num">${Number(e.value).toFixed(2)}</td>
          <td class="secondary">${esc(e.reason)}</td>
          <td>${e.tradeId ? `opened #${e.tradeId}` : `<span class="muted">${esc(label[e.skipReason] ?? e.skipReason ?? '')}</span>`}</td></tr>`,
      )
      .join('')}
  </tbody></table>`;
}

/** @param {HTMLElement} view */
async function resultsView(view) {
  const res = await getJson('/api/results');
  const rows = res.strategies
    .map((/** @type {any} */ r) => {
      const a = r.all;
      const m = r.twin?.all ?? null;
      const edge = m && a.avgPnlPct !== null && m.avgPnlPct !== null ? a.avgPnlPct - m.avgPnlPct : null;
      const ci = a.winRateCi ? `<span class="muted">${Math.round(a.winRateCi[0] * 100)}–${Math.round(a.winRateCi[1] * 100)}</span>` : '';
      return `<tr>
        <td><span class="dot" style="background:${colorOf(r.strategy)}"></span> ${esc(strategyName(r.strategy))}</td>
        <td class="num">${a.closed}</td>
        <td class="num">${r.open}</td>
        <td class="num">${a.winRate === null ? '–' : `${(a.winRate * 100).toFixed(0)}%`} ${ci}</td>
        <td class="num ${signClass(a.avgPnlPct)}">${pct(a.avgPnlPct)}</td>
        <td class="num ${signClass(a.medianPnlPct)}">${pct(a.medianPnlPct)}</td>
        <td class="num ${signClass(a.pnlUsd)}">${pnlUsd(a.pnlUsd)}</td>
        <td class="num">$${r.equityUsd.toFixed(2)}${r.strategy === 'random' ? ' <span class="muted">avg</span>' : ''}</td>
        <td class="num">${m ? (m.winRate === null ? '–' : `${(m.winRate * 100).toFixed(0)}%`) : ''}</td>
        <td class="num ${signClass(m?.avgPnlPct)}">${m ? pct(m.avgPnlPct) : ''}</td>
        <td class="num">${r.twin ? `$${r.twin.equityUsd.toFixed(2)}` : ''}</td>
        <td class="num ${signClass(edge)}">${edge === null ? (m ? '–' : '') : pct(edge)}</td>
        <td class="secondary wrap">${Object.entries(r.exitReasons).map(([k, v]) => `${esc(k.replace('_', ' '))} ${v}`).join(', ')}</td>
      </tr>`;
    })
    .join('');

  const cal = res.calibration;
  const minClosed = Math.min(...res.strategies.map((/** @type {any} */ r) => r.all.closed));
  view.innerHTML = `
    <div class="section"><h3>Signals vs random baseline</h3>
      <div class="scroll-x"><table class="grid"><thead><tr>
        <th>Strategy</th><th class="num">Closed</th><th class="num">Open</th><th class="num" title="Win = closed with profit after costs. Grey numbers: 95% Wilson interval.">Win rate</th>
        <th class="num">Avg P&amp;L</th><th class="num">Median</th><th class="num">Realized</th><th class="num">Equity</th>
        <th class="num" title="This signal's random twin: random tokens bought at the same moments, from its own $1,000">Twin win</th>
        <th class="num">Twin avg</th><th class="num">Twin equity</th><th class="num" title="Avg P&L minus twin avg P&L">Edge</th><th>Exits</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">Costs: a trade needs a ${pct(res.breakevenMovePct)} price move just to break even (fees plus slippage, both ways).
      ${minClosed < 30 ? 'Some strategies have fewer than 30 closed trades, so treat win rates as noise until the intervals narrow.' : ''}
      Each signal has a random twin with its own $1,000 that buys a random token every time the signal buys, so both face the same market and the same cash limits. "Edge" is the signal's average P&amp;L minus its twin's.</p>
    </div>
    <div class="section"><h3>Equity (realized)</h3>
      <div class="legend">${res.strategies
        .filter((/** @type {any} */ r) => r.strategy !== 'random')
        .map(
          (/** @type {any} */ r) =>
            `<span class="key"><span class="line" style="background:${colorOf(r.strategy)}"></span>${esc(strategyName(r.strategy))}</span>`,
        )
        .join('')}<span class="key"><span class="line dashed"></span>dashed = that signal's random twin</span></div>
      <div class="chart-wrap"><div class="chart small" id="equity-chart"></div></div>
    </div>
    <div class="section"><h3>AI calibration</h3>${calibrationBlock(cal)}</div>`;
  const has = equityChart(/** @type {HTMLElement} */ (document.getElementById('equity-chart')), res.strategies, res.startingBankrollUsd);
  if (!has) {
    destroyCharts();
    /** @type {HTMLElement} */ (document.querySelector('#equity-chart')).innerHTML = `<div class="empty" style="padding:16px">No closed trades yet.</div>`;
  }
}

/** @param {any} cal */
function calibrationBlock(cal) {
  if (!state.status.ai.enabled && cal.n === 0) {
    return `<p class="note">AI scoring is off. When enabled, each new trade gets a probability of closing in profit, and this section compares those estimates with what actually happened.</p>`;
  }
  if (cal.n === 0) return `<p class="note">No scored trades have closed yet.</p>`;
  const verdict = cal.brier < cal.baselineBrier ? 'better than' : 'not better than';
  return `<p class="note">${cal.n} scored trades closed. Brier score ${cal.brier.toFixed(3)} vs ${cal.baselineBrier.toFixed(3)} for always guessing the base rate (lower is better): the model is ${verdict} that baseline so far.</p>
    <table class="grid"><thead><tr><th>Predicted</th><th class="num">Trades</th><th class="num">Avg predicted</th><th class="num">Actual win rate</th></tr></thead><tbody>
    ${cal.buckets
      .map(
        (/** @type {any} */ b) =>
          `<tr><td>${Math.round(b.range[0] * 100)}–${Math.round(b.range[1] * 100)}%</td><td class="num">${b.n}</td><td class="num">${(b.avgPredicted * 100).toFixed(0)}%</td><td class="num">${(b.actualWinRate * 100).toFixed(0)}%</td></tr>`,
      )
      .join('')}
    </tbody></table>`;
}

let rendering = false;
async function renderView() {
  if (rendering) return;
  rendering = true;
  const view = /** @type {HTMLElement} */ (document.getElementById('view'));
  const scrollY = document.querySelector('.main')?.scrollTop ?? 0;
  try {
    destroyCharts();
    if (state.tab === 'market') await marketView(view);
    else if (state.tab === 'results') await resultsView(view);
    else if (state.tab.startsWith('strategy:')) await strategyView(view, state.tab.slice('strategy:'.length));
  } catch (err) {
    view.innerHTML = `<div class="empty neg">Failed to load: ${esc(err instanceof Error ? err.message : err)}</div>`;
  } finally {
    rendering = false;
    const main = document.querySelector('.main');
    if (main) main.scrollTop = scrollY;
  }
}

// ---------- refresh loop ----------

async function refresh() {
  try {
    const [status, tokens] = await Promise.all([getJson('/api/status'), getJson('/api/tokens')]);
    const first = !state.status;
    state.status = status;
    state.tokens = tokens;
    status.signals.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      state.colors[s.id] = css(SERIES_VARS[i % SERIES_VARS.length]);
    });
    state.colors.random = css('--baseline');
    if (first) {
      try {
        const saved = localStorage.getItem('tab');
        if (saved && tabList().some((t) => t.id === saved)) state.tab = saved;
      } catch {}
    }
    renderTopbar();
    renderTabs();
    renderTokens();
    await renderView();
  } catch (err) {
    const ps = document.getElementById('poll-status');
    if (ps) ps.innerHTML = `<span class="neg">server unreachable</span>`;
  }
}

const events = new EventSource('/api/events');
events.addEventListener('cycle', () => void refresh());
setInterval(() => void refresh(), 30_000);
void refresh();
