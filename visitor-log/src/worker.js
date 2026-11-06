/**
 * edge-metrics — visitor log for beining1008.github.io
 *
 * Four routes:
 *   GET /px.gif    no-JS pixel. Fires in anything that renders the HTML.
 *   GET /collect   JS beacon. Fires only where JavaScript actually executes.
 *   GET|POST /e    page events from the beacon script: one "leave" per page
 *                  view (visible seconds, scroll depth) and one per outbound
 *                  link click. Sent with navigator.sendBeacon.
 *   GET /logs      private dashboard. Requires ?key=<DASH_KEY>.
 *
 * The point of having both /px.gif and /collect is the difference between them.
 * A hit that shows up on the pixel but never on the beacon is a fetcher that
 * renders HTML without running scripts. A hit on both is a real browser, or a
 * scanner that detonates pages. Neither route sees a plain HTTP GET that pulls
 * no subresources, and that limit is stated on the dashboard rather than hidden.
 *
 * Each visit is one KV key. The record lives entirely in the key's metadata, so
 * the dashboard reads every row from a single list() call instead of one get()
 * per visit. Metadata is capped at 1024 bytes per key, which is why the string
 * fields below are clipped, and why fit() trims a record that would still be
 * too large (KV rejects it outright, and the write fails silently).
 *
 * Events live under their own prefix (e:) and are folded into their page-view
 * row by the page-view id `pv`, so they never count against the row limit.
 *
 * Optional secrets, never in this repo:
 *   WATCHLIST   comma-separated, case-insensitive substrings matched against
 *               the network owner (org). Matching rows are highlighted.
 *   NOTIFY_URL  if set, a plain-text POST goes here when a watchlist row with
 *               js=1 is recorded. Unset means no notification.
 */

const RETAIN_DAYS = 365;
const DEFAULT_ROWS = 500;
const MAX_ROWS = 2000;

// KV rejects metadata whose JSON is over 1024 bytes; keep a little margin.
const META_MAX = 1000;
const TTL = RETAIN_DAYS * 24 * 60 * 60;

// 1x1 transparent GIF.
const PIXEL = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/px.gif':
        return collect(request, env, ctx, url, 0);
      case '/collect':
        return collect(request, env, ctx, url, 1);
      case '/e':
        return pageEvent(env, ctx, url);
      case '/logs':
        return dashboard(request, env, url);
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};

/* ------------------------------------------------------------------ record */

function clip(value, n) {
  if (!value) return '';
  // Control characters are never meaningful here, and JSON escapes each one to
  // six bytes, which would blow the metadata budget.
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, '');
  return s.length > n ? s.slice(0, n) : s;
}

// Short ids minted by the beacon script; anything else is dropped, not stored.
function token(value) {
  return /^[a-z0-9]{6,16}$/i.test(value || '') ? value : '';
}

const utf8 = new TextEncoder();
const metaBytes = (m) => utf8.encode(JSON.stringify(m)).length;

// Longest-first in practice. A record only gets here when its strings are
// mostly multi-byte or escaped characters; normal traffic never trims.
const TRIM_ORDER = ['ua', 'r', 'h', 'org', 'p', 'x', 'region', 'city', 'tz', 'btz', 'lang', 'ip', 'scr'];

function fit(meta) {
  for (const f of TRIM_ORDER) {
    let over;
    while (typeof meta[f] === 'string' && meta[f] && (over = metaBytes(meta) - META_MAX) > 0) {
      // Each UTF-16 unit is at least one byte, so cutting `over` units is
      // enough or close; drop a dangling high surrogate so JSON stays short.
      meta[f] = meta[f].slice(0, Math.max(0, meta[f].length - over)).replace(/[\ud800-\udbff]$/, '');
    }
  }
  return meta;
}

function store(env, ctx, prefix, meta) {
  // Keys sort ascending in list(), so store an inverted timestamp to get
  // newest-first ordering for free.
  const inverted = String(1e15 - Date.now()).padStart(16, '0');
  const key = `${prefix}:${inverted}:${crypto.randomUUID().slice(0, 8)}`;
  ctx.waitUntil(
    env.VISITS.put(key, '', { metadata: fit(meta), expirationTtl: TTL })
      .catch(() => {}), // a failed write must never break the page
  );
}

async function collect(request, env, ctx, url, js) {
  const cf = request.cf || {};
  const q = url.searchParams;
  const now = Date.now();

  const record = {
    t: new Date(now).toISOString(),
    ip: clip(request.headers.get('CF-Connecting-IP'), 45),
    org: clip(cf.asOrganization, 80),
    asn: cf.asn || '',
    cc: clip(cf.country, 8),
    city: clip(cf.city, 48),
    region: clip(cf.region, 48),
    tz: clip(cf.timezone, 40),
    colo: clip(cf.colo, 8),
    p: clip(q.get('p') || '/', 100),
    r: clip(q.get('r') || request.headers.get('Referer'), 150),
    ua: clip(request.headers.get('User-Agent'), 200),
    js,
  };

  // Browser-side fields exist only on the JS beacon. Empty ones are left out
  // so pixel rows stay exactly as small as before.
  if (js) {
    const extra = {
      pv: token(q.get('pv')),
      vid: token(q.get('vid')),
      btz: clip(q.get('btz'), 40),
      lang: clip(q.get('lang'), 16),
      scr: clip(q.get('scr'), 11),
    };
    for (const [k, v] of Object.entries(extra)) if (v) record[k] = v;
  }

  store(env, ctx, 'v', record);

  if (js && env.NOTIFY_URL && !AUTOMATED.test(record.ua)) {
    const hit = watchMatch(record.org, watchTerms(env));
    if (hit) {
      const text = [
        `关注名单命中: ${record.org}`,
        localTime(record.t) + ' America/Chicago',
        [record.city, record.region, record.cc].filter(Boolean).join(', ') || '位置未知',
        `页面 ${record.p}`,
      ].join('\n');
      ctx.waitUntil(
        fetch(env.NOTIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: text,
        }).catch(() => {}), // a dead notifier must not affect logging
      );
    }
  }

  return new Response(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clampInt(value, lo, hi) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/**
 * k=l  leave: d = seconds the page was visible, s = max scroll depth in %.
 * k=c  click: h = link href, x = link text.
 * Anything without a well-formed pv is dropped without a write, since it could
 * never be folded into a row anyway.
 */
function pageEvent(env, ctx, url) {
  const q = url.searchParams;
  const k = q.get('k');
  const pv = token(q.get('pv'));
  let meta = null;
  if (pv && k === 'l') {
    meta = { k, pv, p: clip(q.get('p') || '/', 100), d: clampInt(q.get('d'), 0, 7 * 86400), s: clampInt(q.get('s'), 0, 100) };
  } else if (pv && k === 'c' && q.get('h')) {
    meta = { k, pv, p: clip(q.get('p') || '/', 100), h: clip(q.get('h'), 150), x: clip(q.get('x'), 40) };
  }
  if (meta) store(env, ctx, 'e', meta);
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}

/* --------------------------------------------------------------- dashboard */

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Read page-view records until, after folding, there are more rows than the
 * limit, so the limit counts page views rather than requests. The raw budget
 * only guards against a pathological run of requests that never fold.
 */
async function readRows(env, limit) {
  const rows = [];
  let raw = 0;
  let cursor;
  do {
    const page = await env.VISITS.list({ prefix: 'v:', limit: 1000, cursor });
    const batch = page.keys.filter((k) => k.metadata).map((k) => k.metadata);
    raw += batch.length;
    collapse(batch, rows); // incremental: same result as folding everything at once
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length <= limit && raw < limit * 4);
  return rows.slice(0, limit);
}

const keyTime = (name) => 1e15 - parseInt(name.split(':')[1], 10);

/**
 * Events are always written after their page view, so reading newest-first
 * back to the oldest row on screen (plus a minute of slack) finds every event
 * that can fold into a visible row and nothing older.
 */
async function readEvents(env, since, budget) {
  const events = [];
  let cursor;
  do {
    const page = await env.VISITS.list({ prefix: 'e:', limit: 1000, cursor });
    for (const k of page.keys) {
      if (keyTime(k.name) < since) return events;
      if (k.metadata) events.push(k.metadata);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && events.length < budget);
  return events;
}

// Browser-side fields only the JS beacon carries.
const JS_FIELDS = ['pv', 'vid', 'btz', 'lang', 'scr'];

/**
 * One page view usually produces two records: the pixel and, if scripts ran,
 * the beacon. Fold them back into a single row so the table counts page views
 * rather than requests, and keep whether JS ever fired.
 */
function collapse(rows, out = []) {
  for (const r of rows) {
    const rt = Date.parse(r.t);
    const prev = out
      .slice(-40)
      .find(
        (o) =>
          o.ip === r.ip &&
          o.p === r.p &&
          Math.abs(Date.parse(o.t) - rt) < 15000 &&
          // two beacons with different page-view ids are a quick reload, not one view
          !(o.pv && r.pv && o.pv !== r.pv),
      );
    if (prev) {
      // The pixel may be the record that was kept; the beacon's browser-side
      // fields and its document.referrer are the ones worth showing.
      if (r.js && !prev.js) {
        for (const f of JS_FIELDS) if (r[f]) prev[f] = r[f];
        if (r.r) prev.r = r.r;
      }
      prev.js = prev.js || r.js;
      prev.hits += 1;
      continue;
    }
    out.push({ ...r, hits: 1 });
  }
  return out;
}

/** Attach leave and click events to their page-view row by pv. */
function foldEvents(rows, events) {
  const byPv = new Map();
  for (const r of rows) if (r.pv) byPv.set(r.pv, r);
  let folded = 0;
  // events arrive newest-first; unshift keeps each row's clicks in click order
  for (const e of events) {
    const r = byPv.get(e.pv);
    if (!r) continue;
    folded += 1;
    if (e.k === 'l') {
      r.dwell = Math.max(r.dwell || 0, e.d || 0);
      r.scroll = Math.max(r.scroll || 0, e.s || 0);
    } else if (e.k === 'c') {
      (r.clicks || (r.clicks = [])).unshift({ h: e.h, x: e.x || '' });
    }
  }
  return folded;
}

/* ------------------------------------------------------- watchlist and time */

function watchTerms(env) {
  return String(env.WATCHLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function watchMatch(org, terms) {
  const o = String(org || '').toLowerCase();
  return (o && terms.find((w) => o.includes(w))) || '';
}

// Formatters are expensive to build and the dashboard formats thousands of rows.
const fmtCache = new Map();
function formatter(tz, opts) {
  const id = tz + JSON.stringify(opts);
  if (!fmtCache.has(id)) {
    try {
      fmtCache.set(id, new Intl.DateTimeFormat(opts.locale || 'en-US', { timeZone: tz, ...opts.o }));
    } catch {
      fmtCache.set(id, null); // unknown zone name
    }
  }
  return fmtCache.get(id);
}

function localTime(iso) {
  const f = formatter('America/Chicago', {
    locale: 'sv-SE',
    o: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' },
  });
  return f.format(new Date(iso));
}

function utcOffset(tz, date) {
  const f = formatter(tz, { o: { timeZoneName: 'longOffset' } });
  if (!f) return null;
  const part = f.formatToParts(date).find((x) => x.type === 'timeZoneName');
  return part ? part.value : null;
}

/**
 * Browser time zone vs the zone Cloudflare derives from the IP. Compared by UTC
 * offset at the time of the visit, so aliases (Asia/Calcutta vs Asia/Kolkata)
 * and neighbouring zones that share an offset are not flagged; a real gap
 * usually means a corporate proxy or VPN egressing somewhere else.
 */
function tzMismatch(r) {
  if (!r.btz || !r.tz || r.btz === r.tz) return false;
  const d = new Date(r.t);
  const a = utcOffset(r.btz, d);
  const b = utcOffset(r.tz, d);
  return Boolean(a && b && a !== b);
}

function fmtDwell(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
}

/** Label a clicked link; `hot` marks the CV / PDF clicks that matter most. */
function linkKind(h, x) {
  const s = String(h || '');
  if (/(^|[^a-z])(cv|resume)([^a-z]|$)/i.test(`${s} ${x}`)) return { label: 'CV', hot: true };
  if (/\.pdf(?:[?#]|$)/i.test(s)) return { label: 'PDF', hot: true };
  if (/^mailto:/i.test(s)) return { label: '邮件', hot: false };
  let host = '';
  try {
    host = new URL(s).hostname.replace(/^www\./, '');
  } catch {
    return { label: '链接', hot: false };
  }
  if (/(^|\.)arxiv\.org$/.test(host)) return { label: 'arXiv', hot: false };
  if (/(^|\.)github\.com$/.test(host)) return { label: 'GitHub', hot: false };
  if (/^scholar\.google\./.test(host)) return { label: 'Scholar', hot: false };
  if (/(^|\.)(huggingface\.co|hf\.co)$/.test(host)) return { label: 'HF', hot: false };
  return { label: host || '链接', hot: false };
}

const DATACENTER =
  /(microsoft|azure|google|amazon|aws|cloudflare|digitalocean|hetzner|ovh|linode|oracle|akamai|fastly|zscaler|proofpoint|barracuda|mimecast|forcepoint|netskope|palo ?alto|symantec|trend ?micro|sophos|cisco|iron ?port)/i;
const AUTOMATED =
  /(bot|crawl|spider|slurp|headless|phantom|python-requests|curl|wget|axios|go-http|java\/|okhttp|scrapy|preview|fetcher|monitor|validator|lighthouse)/i;

function verdict(r) {
  if (AUTOMATED.test(r.ua)) return ['bot', '爬虫 / 脚本'];
  if (DATACENTER.test(r.org)) {
    return r.js ? ['scan', '数据中心 · 已执行 JS(邮件网关detonation)'] : ['scan', '数据中心 · 未执行 JS(网关抓取)'];
  }
  if (!r.js) return ['nojs', '住宅 IP · 未执行 JS'];
  return ['human', '疑似真人'];
}

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function dashboard(request, env, url) {
  const key = url.searchParams.get('key') || '';
  if (!env.DASH_KEY || !timingSafeEqual(key, env.DASH_KEY)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  const limit = Math.min(
    MAX_ROWS,
    Math.max(1, parseInt(url.searchParams.get('limit') || DEFAULT_ROWS, 10) || DEFAULT_ROWS),
  );
  const rows = await readRows(env, limit);
  // Fold events only after the row limit is applied, so they never crowd rows out.
  const events = rows.length
    ? await readEvents(env, Date.parse(rows[rows.length - 1].t) - 60000, limit * 12 + 1000)
    : [];
  const folded = foldEvents(rows, events);
  const requests = rows.reduce((n, r) => n + r.hits, 0);

  const terms = watchTerms(env);
  for (const r of rows) {
    r.watch = watchMatch(r.org, terms);
    r.tz_mismatch = tzMismatch(r);
  }

  const format = url.searchParams.get('format');
  if (format === 'json') {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' },
    });
  }
  if (format === 'csv') {
    const cols = [
      't', 'ip', 'org', 'asn', 'cc', 'city', 'region', 'tz', 'p', 'r', 'ua', 'js', 'hits',
      'pv', 'vid', 'btz', 'lang', 'scr', 'dwell', 'scroll', 'clicks', 'watch', 'tz_mismatch',
    ];
    const cell = (r, c) =>
      c === 'clicks' ? (r.clicks || []).map((k) => `${k.h} (${k.x})`).join(' | ') : r[c];
    const csv = [
      cols.join(','),
      ...rows.map((r) =>
        cols.map((c) => `"${String(cell(r, c) ?? '').replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="visitors.csv"',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  // Repeat-visitor counts, computed over the whole window.
  const seen = new Map();
  for (const r of rows) seen.set(r.ip, (seen.get(r.ip) || 0) + 1);

  // The same browser across IPs (home, office, phone hotspot) shares one vid.
  const vids = new Map();
  for (const r of rows) {
    if (!r.vid) continue;
    const v = vids.get(r.vid) || { n: 0, ips: new Set() };
    v.n += 1;
    v.ips.add(r.ip);
    vids.set(r.vid, v);
  }

  const tally = { human: 0, scan: 0, bot: 0, nojs: 0 };
  for (const r of rows) tally[verdict(r)[0]] += 1;

  const watched = rows.filter((r) => r.watch);
  const watchOrgs = new Map();
  for (const r of watched) watchOrgs.set(r.org, (watchOrgs.get(r.org) || 0) + 1);
  const watchCard = terms.length
    ? `<div class="card watch"><b>${watched.length}</b>关注名单命中${
        watchOrgs.size
          ? `<div class="dim">${[...watchOrgs].slice(0, 6).map(([o, n]) => `${esc(o)} ×${n}`).join('<br>')}</div>`
          : ''
      }</div>`
    : '';

  const body = rows
    .map((r) => {
      const [cls, label] = verdict(r);
      const place = [r.city, r.region, r.cc].filter(Boolean).join(', ');
      const v = r.vid && vids.get(r.vid);
      const visitor = v
        ? `<span class="mono">${esc(r.vid.slice(0, 6))}</span><span class="rep">${v.n > 1 ? ` ×${v.n}` : ''}</span>${
            v.ips.size > 1 ? ` <span class="tag multi">${v.ips.size} 个 IP</span>` : ''
          }`
        : '<span class="dim">—</span>';
      const clicks =
        (r.clicks || [])
          .map((c) => {
            const k = linkKind(c.h, c.x);
            const text = c.x && c.x !== k.label ? ` <span class="dim">${esc(clip(c.x, 24))}</span>` : '';
            // plain text, not a link: following it would leak this URL, key included, as Referer
            return `<span class="clk${k.hot ? ' hot' : ''}" title="${esc(c.h)}">${esc(k.label)}${text}</span>`;
          })
          .join(' ') || '<span class="dim">—</span>';
      const browser = [r.lang, r.scr].filter(Boolean).join(' · ');
      return `<tr class="${cls}${r.watch ? ' watch' : ''}">
  <td class="mono nowrap">${esc(localTime(r.t))}</td>
  <td class="mono nowrap">${esc(r.ip)}<span class="rep">${seen.get(r.ip) > 1 ? ` ×${seen.get(r.ip)}` : ''}</span></td>
  <td class="nowrap">${visitor}</td>
  <td>${esc(r.org || '—')}${r.asn ? `<span class="dim"> AS${esc(r.asn)}</span>` : ''}</td>
  <td>${esc(place || '—')}${
        r.tz_mismatch
          ? ` <span class="tag warn" title="浏览器时区 ${esc(r.btz)} · IP 时区 ${esc(r.tz)}">时区不一致</span>`
          : ''
      }</td>
  <td class="mono">${esc(r.p)}</td>
  <td class="mono nowrap">${esc(fmtDwell(r.dwell))}</td>
  <td class="mono nowrap">${r.scroll != null ? `${esc(r.scroll)}%` : '—'}</td>
  <td class="clicks">${clicks}</td>
  <td class="ref">${esc(r.r || '—')}</td>
  <td><span class="tag ${cls}">${esc(label)}</span>${r.watch ? ` <span class="tag watch">关注 · ${esc(r.watch)}</span>` : ''}</td>
  <td class="nowrap">${esc(browser || '—')}${r.btz ? `<div class="dim">${esc(r.btz)}</div>` : ''}</td>
  <td class="ua" title="${esc(r.ua)}">${esc(clip(r.ua, 60))}</td>
</tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Visitor log</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .sub { color: #6b7280; font-size: .8rem; margin-bottom: 1rem; }
  .cards { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .card { border: 1px solid #d1d5db; border-radius: 8px; padding: .5rem .8rem; }
  .card b { display: block; font-size: 1.35rem; }
  .wrap { overflow-x: auto; border: 1px solid #d1d5db; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { position: sticky; top: 0; background: Canvas; font-weight: 600; white-space: nowrap; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .nowrap { white-space: nowrap; }
  .dim, .rep { color: #6b7280; }
  .ua, .ref { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #6b7280; }
  .tag { border-radius: 999px; padding: .1rem .5rem; font-size: 11px; white-space: nowrap; border: 1px solid; }
  .tag.human { border-color: #15803d; color: #15803d; }
  .tag.scan  { border-color: #b45309; color: #b45309; }
  .tag.bot   { border-color: #6b7280; color: #6b7280; }
  .tag.nojs  { border-color: #1d4ed8; color: #1d4ed8; }
  .tag.warn  { border-color: #c2410c; color: #c2410c; }
  .tag.multi { border-color: #7c3aed; color: #7c3aed; }
  .tag.watch { border-color: #dc2626; background: #dc2626; color: #fff; font-weight: 600; }
  tr.human { background: rgba(21,128,61,.05); }
  tr.watch { background: rgba(220,38,38,.12); box-shadow: inset 4px 0 #dc2626; }
  .card.watch { border: 2px solid #dc2626; }
  .card.watch b { color: #dc2626; }
  .card.watch .dim { font-size: .75rem; margin-top: .2rem; }
  .clicks { min-width: 10ch; }
  .clk { display: inline-block; border: 1px solid #9ca3af; border-radius: 4px; padding: 0 .35rem; margin: 0 .2rem .2rem 0; font-size: 11px; white-space: nowrap; cursor: default; }
  .clk.hot { background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 700; }
  .clk.hot .dim { color: inherit; opacity: .85; }
  .note { color: #6b7280; font-size: .78rem; margin-top: 1rem; max-width: 60ch; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    th, td { border-color: #374151; } .wrap, .card { border-color: #374151; }
  }
</style>
</head><body>
<h1>Visitor log</h1>
<div class="sub">${rows.length} 次访问（由 ${requests} 条请求合并而来，另并入 ${folded} 条停留 / 点击事件）· 时间为 America/Chicago · 保留 ${RETAIN_DAYS} 天 ·
  <a href="?key=${encodeURIComponent(key)}&limit=${limit}&format=csv">CSV</a> ·
  <a href="?key=${encodeURIComponent(key)}&limit=${limit}&format=json">JSON</a></div>
<div class="cards">
  ${watchCard}
  <div class="card"><b>${tally.human}</b>疑似真人</div>
  <div class="card"><b>${tally.scan}</b>数据中心 / 网关</div>
  <div class="card"><b>${tally.nojs}</b>未执行 JS</div>
  <div class="card"><b>${tally.bot}</b>爬虫</div>
  <div class="card"><b>${seen.size}</b>独立 IP</div>
</div>
<div class="wrap"><table>
<thead><tr><th>时间</th><th>IP</th><th>访客</th><th>网络 / 归属</th><th>位置</th><th>页面</th><th>停留</th><th>滚动</th><th>点击</th><th>来源</th><th>判定</th><th>浏览器</th><th>User-Agent</th></tr></thead>
<tbody>
${body || '<tr><td colspan="13">暂无记录。</td></tr>'}
</tbody></table></div>
<p class="note">判定是启发式的，按 ASN 归属与 User-Agent 推断，不是结论。
"数据中心 · 未执行 JS" 最常见的来源是邮件安全网关（Microsoft Defender SafeLinks 等）对签名里链接的自动扫描，
只能证明邮件送达并通过了网关，<b>不代表收件人本人打开过</b>。
另外，完全不拉取子资源的纯 HTTP 抓取这里看不到 —— 这套记录的下限如此。</p>
<p class="note">停留只计页面在前台可见的时间，在第一次切走或关闭页面时发出，之后回到页面继续读的部分不计。
访客 ID 存在浏览器 localStorage 里，换浏览器、无痕窗口或清除站点数据后会变成新 ID。
"时区不一致" 按访问时刻的 UTC 偏移比较浏览器时区与 IP 所在时区，多见于公司代理或 VPN。
点击只记站外链接和 PDF 等文件，站内跳转本身就是下一次访问。</p>
</body></html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
