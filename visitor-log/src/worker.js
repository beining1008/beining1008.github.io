/**
 * edge-metrics — visitor log for beining1008.github.io
 *
 * Three routes:
 *   GET /px.gif    no-JS pixel. Fires in anything that renders the HTML.
 *   GET /collect   JS beacon. Fires only where JavaScript actually executes.
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
 * fields below are clipped.
 */

const RETAIN_DAYS = 365;
const DEFAULT_ROWS = 500;
const MAX_ROWS = 2000;

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
  const s = String(value);
  return s.length > n ? s.slice(0, n) : s;
}

async function collect(request, env, ctx, url, js) {
  const cf = request.cf || {};
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
    p: clip(url.searchParams.get('p') || '/', 100),
    r: clip(url.searchParams.get('r') || request.headers.get('Referer'), 150),
    ua: clip(request.headers.get('User-Agent'), 200),
    js,
  };

  // Keys sort ascending in list(), so store an inverted timestamp to get
  // newest-first ordering for free.
  const inverted = String(1e15 - now).padStart(16, '0');
  const key = `v:${inverted}:${crypto.randomUUID().slice(0, 8)}`;

  ctx.waitUntil(
    env.VISITS.put(key, '', {
      metadata: record,
      expirationTtl: RETAIN_DAYS * 24 * 60 * 60,
    }).catch(() => {}), // a failed write must never break the page
  );

  return new Response(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    },
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

async function readAll(env, limit) {
  const rows = [];
  let cursor;
  do {
    const page = await env.VISITS.list({ prefix: 'v:', limit: 1000, cursor });
    for (const k of page.keys) if (k.metadata) rows.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < limit);
  return rows.slice(0, limit);
}

/**
 * One page view usually produces two records: the pixel and, if scripts ran,
 * the beacon. Fold them back into a single row so the table counts page views
 * rather than requests, and keep whether JS ever fired.
 */
function collapse(rows) {
  const out = [];
  for (const r of rows) {
    const prev = out
      .slice(-40)
      .find(
        (o) =>
          o.ip === r.ip &&
          o.p === r.p &&
          Math.abs(Date.parse(o.t) - Date.parse(r.t)) < 15000,
      );
    if (prev) {
      prev.js = prev.js || r.js;
      prev.hits += 1;
      continue;
    }
    out.push({ ...r, hits: 1 });
  }
  return out;
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
  const raw = await readAll(env, limit * 2);
  const rows = collapse(raw);

  const format = url.searchParams.get('format');
  if (format === 'json') {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' },
    });
  }
  if (format === 'csv') {
    const cols = ['t', 'ip', 'org', 'asn', 'cc', 'city', 'region', 'p', 'r', 'ua', 'js', 'hits'];
    const csv = [
      cols.join(','),
      ...rows.map((r) =>
        cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','),
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

  const tally = { human: 0, scan: 0, bot: 0, nojs: 0 };
  for (const r of rows) tally[verdict(r)[0]] += 1;

  const body = rows
    .map((r) => {
      const [cls, label] = verdict(r);
      const local = new Date(r.t).toLocaleString('sv-SE', { timeZone: 'America/Chicago' });
      const place = [r.city, r.region, r.cc].filter(Boolean).join(', ');
      return `<tr class="${cls}">
  <td class="mono nowrap">${esc(local)}</td>
  <td class="mono nowrap">${esc(r.ip)}<span class="rep">${seen.get(r.ip) > 1 ? ` ×${seen.get(r.ip)}` : ''}</span></td>
  <td>${esc(r.org || '—')}${r.asn ? `<span class="dim"> AS${esc(r.asn)}</span>` : ''}</td>
  <td>${esc(place || '—')}</td>
  <td class="mono">${esc(r.p)}</td>
  <td class="ref">${esc(r.r || '—')}</td>
  <td><span class="tag ${cls}">${esc(label)}</span></td>
  <td class="ua" title="${esc(r.ua)}">${esc(clip(r.ua, 60))}</td>
</tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
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
  tr.human { background: rgba(21,128,61,.05); }
  .note { color: #6b7280; font-size: .78rem; margin-top: 1rem; max-width: 60ch; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    th, td { border-color: #374151; } .wrap, .card { border-color: #374151; }
  }
</style>
</head><body>
<h1>Visitor log</h1>
<div class="sub">${rows.length} 次访问（由 ${raw.length} 条请求合并而来）· 时间为 America/Chicago · 保留 ${RETAIN_DAYS} 天 ·
  <a href="?key=${encodeURIComponent(key)}&limit=${limit}&format=csv">CSV</a> ·
  <a href="?key=${encodeURIComponent(key)}&limit=${limit}&format=json">JSON</a></div>
<div class="cards">
  <div class="card"><b>${tally.human}</b>疑似真人</div>
  <div class="card"><b>${tally.scan}</b>数据中心 / 网关</div>
  <div class="card"><b>${tally.nojs}</b>未执行 JS</div>
  <div class="card"><b>${tally.bot}</b>爬虫</div>
  <div class="card"><b>${seen.size}</b>独立 IP</div>
</div>
<div class="wrap"><table>
<thead><tr><th>时间</th><th>IP</th><th>网络 / 归属</th><th>位置</th><th>页面</th><th>来源</th><th>判定</th><th>User-Agent</th></tr></thead>
<tbody>
${body || '<tr><td colspan="8">暂无记录。</td></tr>'}
</tbody></table></div>
<p class="note">判定是启发式的，按 ASN 归属与 User-Agent 推断，不是结论。
"数据中心 · 未执行 JS" 最常见的来源是邮件安全网关（Microsoft Defender SafeLinks 等）对签名里链接的自动扫描，
只能证明邮件送达并通过了网关，<b>不代表收件人本人打开过</b>。
另外，完全不拉取子资源的纯 HTTP 抓取这里看不到 —— 这套记录的下限如此。</p>
</body></html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
