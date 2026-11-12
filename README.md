# LogIt

Self-hosted session recording. Add one script tag to your site and LogIt records what users see and do. You can then replay each session as a video-like DOM reconstruction, next to the session's console output, network requests and errors.

- **DOM replay**: a full snapshot plus incremental mutations, including:
  - open and closed **shadow DOM**;
  - same-origin **iframes**;
  - **`adoptedStyleSheets`** and CSS-in-JS rules injected through `insertRule`;
  - **canvas** (2D and WebGL);
  - **video/audio** playback state, plus frames for stream-backed video.
- **Durable replays**: linked stylesheets are inlined at record time, and the server archives the images, fonts and CSS a page uses. Replays keep working after the site deploys new assets.
- **Interactions**: inputs, clicks, mouse movement, scrolling, viewport resizes and SPA navigation.
- **Console**: `log`, `info`, `warn`, `error` and `debug`, with safe serialization of objects, errors and DOM nodes.
- **Errors**: uncaught exceptions, unhandled promise rejections and failed resource loads, with stack traces.
- **Network**: `fetch` and XHR method, URL, status, duration, headers and bodies, with slow requests flagged.
- **Performance and context**: TTFB, FCP, LCP, DOMContentLoaded, load, browser and screen metadata, user identity, and custom events.
- **Privacy**: passwords and credit-card fields are always masked; `data-logit-mask` masks text and `data-logit-block` blocks an element entirely. Sensitive headers are redacted, hidden input values are dropped, and script contents are never recorded.
- **Scales out**: local files for a single instance, or Postgres so any number of instances can share sessions behind a load balancer.

Requires Node.js 18 or later. The only dependency is `pg`, and it's only loaded when Postgres is configured.

## Quick start

```sh
npm install
npm start                            # http://localhost:4000
open http://localhost:4000/demo/     # click around the demo shop
open http://localhost:4000/viewer/   # replay the session
```

## Install on your site

```html
<script src="https://logit.example.com/sdk/logit.js" data-app-id="my-app"></script>
```

Put the tag as early in `<head>` as possible: it has to load before your components attach shadow roots or create WebGL contexts. The ingest endpoint is derived from the script's origin. Optional attributes are `data-endpoint`, `data-mask-all-inputs`, `data-record-canvas` and `data-debug`.

To configure it in code instead:

```js
LogIt.init({
  appId: 'my-app',
  endpoint: 'https://logit.example.com/api/ingest',
  sampleRate: 0.25,                // record 25% of sessions
  maskAllInputs: true,
  recordCanvas: true,              // off by default: costs CPU and bandwidth
  canvasFps: 2,
  ignoreUrls: [/\/analytics\//],
  beforeSend(event) {              // scrub or drop any event
    if (event.type === 'network' && event.data.url.includes('/auth/')) delete event.data.responseBody
    return event
  }
})

LogIt.identify('user-42', { email: 'ada@example.com', plan: 'pro' })
LogIt.track('Checkout Started', { total: 39.98 })
LogIt.log('Feature flag evaluated', { flag: 'new-cart', value: true })
LogIt.getSessionURL()   // link to this session in the viewer, e.g. for support tickets
```

`src/recorder.js` lists every option in `DEFAULTS`. The rich-content options:

| Option | Default | |
|---|---|---|
| `recordIframes` | `true` | Record the DOM inside same-origin iframes |
| `recordMedia` | `true` | Record `<video>`/`<audio>` play, pause, seek, rate and volume; replay syncs the element |
| `recordCanvas` | `false` | Sample `<canvas>` frames (WebGL included), plus frames of `<video>` that has no replayable URL (e.g. `MediaStream`, MSE `blob:`) |
| `canvasFps` / `canvasQuality` | `2` / `0.6` | Sampling rate and WebP quality; unchanged frames are not re-sent |
| `inlineStylesheets` | `true` | Embed readable `<link rel=stylesheet>` CSS in the recording |

## Server configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | |
| `LOGIT_ADMIN_TOKEN` | — | Bearer token for the session API and viewer. **Required when `NODE_ENV=production`.** |
| `LOGIT_DATABASE_URL` | — | Postgres connection string. When set, sessions and assets are stored in Postgres (tables are created on startup). |
| `LOGIT_DB_POOL_SIZE` | `10` | Postgres connections per instance |
| `LOGIT_DATA_DIR` | `./data` | Session and asset storage when no database is configured |
| `LOGIT_ALLOWED_APP_IDS` | any | Comma-separated allowlist of app ids |
| `LOGIT_ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to send data |
| `LOGIT_RETENTION_DAYS` | `30` | Sessions older than this are deleted hourly, along with assets nothing references any more (`0` disables) |
| `LOGIT_MAX_BODY_BYTES` | `10485760` | Max ingest request size |
| `LOGIT_RATE_LIMIT_PER_MINUTE` | `600` | Ingest requests per IP per minute, per instance (`0` disables) |
| `LOGIT_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting |
| `LOGIT_ARCHIVE_ASSETS` | `true` | Fetch and store the images, fonts and stylesheets recorded pages reference |
| `LOGIT_ASSET_HOSTS` | any | Comma-separated hosts (and their subdomains) assets may be archived from |
| `LOGIT_ASSET_ALLOW_PRIVATE` | on unless production | Allow archiving from private/loopback addresses. Keep this off in production: it is the SSRF guard. |
| `LOGIT_ASSET_MAX_BYTES` | `5242880` | Largest asset that will be archived |
| `LOGIT_SERVE_DEMO` | on unless production | Serve `/demo/` |

### Storage and scaling

- **Single instance (default)**: sessions live in `LOGIT_DATA_DIR` as one directory per session, and assets in `LOGIT_DATA_DIR/.assets`.
- **Multiple instances**: set `LOGIT_DATABASE_URL` on every instance and put them behind a load balancer. Event batches are stored gzip-compressed. Session summaries are merged atomically in SQL, so concurrent ingests to the same session from different instances never lose updates. Schema creation is guarded by an advisory lock. Rate limits are per instance.

```sh
docker build -t logit .
docker run -p 4000:4000 -v logit-data:/data -e LOGIT_ADMIN_TOKEN=change-me logit        # single instance
LOGIT_ADMIN_TOKEN=change-me docker compose up --scale logit=3                           # Postgres + 3 instances
```

### Asset archiving

After each ingest, the server collects the asset URLs the batch references in the background: images, `srcset`s, posters, icons, CSS `url()`s and `@import`s, inside shadow roots, iframes and constructed stylesheets too. It fetches them and stores them by SHA-256 of their content, and archived CSS is rewritten so its own fonts and images point at archived copies. The viewer then loads `/assets/<sha256>` instead of the live URL.

- **What gets archived**: images, fonts and CSS only. HTML and scripts are never archived.
- **SSRF protection**: every resolved address (including redirects and IP-literal hosts) is checked against private, loopback, link-local and metadata ranges.
- **Serving**: assets are served with a sandboxing CSP. Since they are content-addressed, they need no auth and are cached forever.

## HTTP API

| Method | Path | Auth | |
|---|---|---|---|
| `POST` | `/api/ingest` | CORS allowlist | Batch of events from the SDK |
| `GET` | `/api/apps` | token | App ids with session counts |
| `GET` | `/api/sessions?appId=&q=&errors=1&limit=&offset=` | token | Session summaries, newest first |
| `GET` | `/api/sessions/:appId/:sessionId` | token | Summary, all events, and the archived asset map |
| `DELETE` | `/api/sessions/:appId/:sessionId` | token | Delete a session |
| `GET` | `/assets/:sha256` | — | Archived asset |
| `GET` | `/healthz` | — | Health check (`503` when storage is unreachable) |

## Development

```sh
npm test              # everything: API, storage, assets, end-to-end
npm run test:server   # API, storage contract and asset archiver tests
npm run test:e2e      # records the demo in headless Chrome and replays it in the viewer
npm run check         # syntax-check all sources
```

- **End-to-end test**: needs Chrome or Chromium. Set `CHROME_PATH` if it isn't in a standard location; without a browser, the test is skipped.
- **Postgres tests**: start a throwaway cluster with the local `initdb`/`pg_ctl`, or use `LOGIT_TEST_DATABASE_URL`. Without either, they are skipped.

## Known limitations

- **Cross-origin iframes** render as empty frames. Their DOM can't be read from the parent page.
- **Assets behind authentication** (cookies, signed URLs that expire) can't be archived, so they load from the live URL.
- **In-place changes to `adoptedStyleSheets`** (e.g. `document.adoptedStyleSheets.push(sheet)`) aren't detected. Assigning a new array, which is what Lit and most libraries do, is recorded.
- **Video and audio** with a normal `http(s)` URL replay from that URL, so they aren't archived.
