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

Where JavaScript runs, the beacon also sends:

| field | where | meaning |
|---|---|---|
| `pv` | `/collect` | random page-view id, used to fold the events below into their row |
| `vid` | `/collect` | random visitor id kept in `localStorage` (omitted if storage is blocked); the same browser on different IPs shares it |
| `btz`, `lang`, `scr` | `/collect` | browser time zone, `navigator.language`, screen size |
| leave event | `/e?k=l` | seconds the page was visible, max scroll depth in %; once per page view, on the first navigating link click, switch to hidden, or `pagehide` |
| click event | `/e?k=c` | href (150 chars) and link text (40) of a click on an outbound link or a file such as a PDF; same-site page links are not logged, since they show up as the next page view; at most 10 per page view |

Events are stored under their own key prefix (`e:`) and folded into the
page-view row by `pv` when the dashboard is read, so the row limit counts page
views. The dashboard shows 停留 / 滚动 / 点击, a short visitor id with its repeat
count, and a 时区不一致 marker when the browser time zone's UTC offset differs
from the one Cloudflare derives from the IP (often a corporate proxy or VPN).
No canvas, audio or font fingerprinting.

## Optional: watchlist and alert

Both are Wrangler secrets, so their values never enter this public repository:

```bash
npx wrangler secret put WATCHLIST    # comma-separated, case-insensitive substrings of the network owner (org)
npx wrangler secret put NOTIFY_URL   # optional: any URL that accepts a plain-text POST
```

Rows whose `org` contains a watchlist entry are highlighted, with a 关注名单命中
card at the top. If `NOTIFY_URL` is set, a short message (time, org, location,
page) is POSTed to it whenever a watchlist row with `js=1` is recorded and the
User-Agent is not a self-declared crawler. Unset means nothing is sent. There is
no de-duplication: a visitor who opens five pages sends five messages.

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

Free tier: 100,000 Worker requests/day, 1,000 KV writes/day and 1,000 KV
list operations/day. A page view by a real browser costs three writes (pixel,
beacon, leave event) plus one per outbound-link click, capped at 10 per view; a
no-JS fetch costs one. The write limit is therefore the binding one at roughly
300 views per day, which is far above what a personal academic page sees. One dashboard load
costs a few list operations (one per 1,000 keys read, rows and events
together). Records and events expire after 365 days (`RETAIN_DAYS` in
`src/worker.js`).

Each record lives in KV key metadata, which is capped at 1,024 bytes of JSON.
Every field is clipped, control characters are dropped, and `fit()` trims the
longest strings of any record that would still exceed 1,000 bytes (that only
happens with mostly multi-byte or escaped input), so a write never fails for
size.

## Notes

- The Worker URL is visible in the page source of the site. Anyone who reads the
  HTML can see that hits are being logged, and one of your correspondents has
  already shown an interest in auditing how your pages are built. The name
  `edge-metrics` is chosen to be unremarkable rather than concealing.
- `DASH_KEY`, `WATCHLIST` and `NOTIFY_URL` are Wrangler secrets and are never
  committed to this repository.
- The visitor id is a persistent identifier stored in the visitor's browser.
  EU ePrivacy rules generally expect consent before storing one. If that
  matters for your audience, delete the `vid` block in
  `_includes/visitor-beacon.html`. Everything else keeps working without it.
- Logging visitor IPs on your own site is ordinary web analytics, but IP
  addresses are personal data under GDPR. If you would rather not hold them,
  hash `record.ip` in `collect()` before the `put()` — you lose the ability to
  match a specific visit against a specific recipient, which is the whole point
  here, so it is a real trade-off rather than a free improvement.
