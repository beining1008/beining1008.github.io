# visitor-log

Self-hosted visitor log for `beining1008.github.io`: time, IP, network owner,
location, page, referrer, and User-Agent for every hit, stored in your own
Cloudflare account.

Not published with the site — `visitor-log` is in the Jekyll `exclude:` list.

## What it records

One row per page view, folded from up to two requests:

| route | fires when | tells you |
|---|---|---|
| `/px.gif` | anything renders the HTML | the page was fetched and rendered |
| `/collect` | JavaScript actually executes | a real browser, or a scanner that detonates pages |

A hit on the pixel with no matching beacon is a renderer that does not run
scripts, which is the usual shape of a mail security gateway. A plain HTTP GET
that pulls no subresources appears in neither, and the dashboard says so rather
than pretending otherwise.

## Deploy (one time, ~15 min)

```bash
cd visitor-log
npx wrangler login                       # opens a browser
npx wrangler kv namespace create VISITS  # prints an id
```

Paste that id into `wrangler.toml` as `kv_namespaces[0].id`, then:

```bash
npx wrangler secret put DASH_KEY         # paste a long random string; this is the dashboard password
npx wrangler deploy
```

`deploy` prints the URL, e.g. `https://edge-metrics.<subdomain>.workers.dev`.

Put that URL in the site's `_config.yml`, no trailing slash:

```yaml
visitor_log_endpoint     : "https://edge-metrics.<subdomain>.workers.dev"
```

Commit and push. The beacon is off until that value is non-empty, so nothing
records before you are ready.

## Reading the log

```
https://edge-metrics.<subdomain>.workers.dev/logs?key=<DASH_KEY>
```

- `&limit=2000` — more rows (default 500)
- `&format=csv` / `&format=json` — export

Bookmark it with the key in the URL. `/logs` returns 401 without it and is
served `noindex, nofollow`.

## Verify it works

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://edge-metrics.<subdomain>.workers.dev/px.gif?p=/test"
# expect: 200 image/gif
```

Then load the dashboard; the row should appear within a second or two.

## Limits and costs

Free tier: 100,000 Worker requests/day and 1,000 KV writes/day. A page view
costs two writes, so the write limit is the binding one at roughly 500 views per
day — far above what a personal academic page sees. Records expire after 365
days (`RETAIN_DAYS` in `src/worker.js`).

## Notes

- The Worker URL is visible in the page source of the site. Anyone who reads the
  HTML can see that hits are being logged, and one of your correspondents has
  already shown an interest in auditing how your pages are built. The name
  `edge-metrics` is chosen to be unremarkable rather than concealing.
- `DASH_KEY` is a Wrangler secret and is never committed to this repository.
- Logging visitor IPs on your own site is ordinary web analytics, but IP
  addresses are personal data under GDPR. If you would rather not hold them,
  hash `record.ip` in `collect()` before the `put()` — you lose the ability to
  match a specific visit against a specific recipient, which is the whole point
  here, so it is a real trade-off rather than a free improvement.
