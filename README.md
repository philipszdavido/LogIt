# LogIt

Self-hosted session recording. Add one script tag to your site and LogIt records what users see and do. You can then replay each session as a video-like DOM reconstruction, next to the session's console output, network requests and errors.

- **DOM replay**: a full snapshot plus incremental mutations, including CSS-in-JS rules injected through `insertRule`.
- **Interactions**: inputs, clicks, mouse movement, scrolling, viewport resizes and SPA navigation.
- **Console**: `log`, `info`, `warn`, `error` and `debug`, with safe serialization of objects, errors and DOM nodes.
- **Errors**: uncaught exceptions, unhandled promise rejections and failed resource loads, with stack traces.
- **Network**: `fetch` and XHR method, URL, status, duration, headers and bodies, with slow requests flagged.
- **Performance and context**: TTFB, FCP, LCP, DOMContentLoaded, load, browser and screen metadata, user identity, and custom events.
- **Privacy**: passwords and credit-card fields are always masked; `data-logit-mask` masks text and `data-logit-block` blocks an element entirely. Sensitive headers are redacted, hidden input values are dropped, and script contents are never recorded.

There are no runtime dependencies. You only need Node.js 18 or later.

## Quick start

```sh
npm start                       # http://localhost:4000
open http://localhost:4000/demo/     # click around the demo shop
open http://localhost:4000/viewer/   # replay the session
```

## Install on your site

```html
<script src="https://logit.example.com/sdk/logit.js" data-app-id="my-app"></script>
```

Put the tag as early in `<head>` as possible. The ingest endpoint is derived from the script's origin. Optional attributes are `data-endpoint`, `data-mask-all-inputs` and `data-debug`.

To configure it in code instead:

```js
LogIt.init({
  appId: 'my-app',
  endpoint: 'https://logit.example.com/api/ingest',
  sampleRate: 0.25,                // record 25% of sessions
  maskAllInputs: true,
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

`src/recorder.js` lists every option in `DEFAULTS`.

## Server configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | |
| `LOGIT_ADMIN_TOKEN` | — | Bearer token for the session API and viewer. **Required when `NODE_ENV=production`.** |
| `LOGIT_DATA_DIR` | `./data` | Where sessions are stored |
| `LOGIT_ALLOWED_APP_IDS` | any | Comma-separated allowlist of app ids |
| `LOGIT_ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to send data |
| `LOGIT_RETENTION_DAYS` | `30` | Sessions older than this are deleted hourly (`0` disables) |
| `LOGIT_MAX_BODY_BYTES` | `10485760` | Max ingest request size |
| `LOGIT_RATE_LIMIT_PER_MINUTE` | `600` | Ingest requests per IP per minute (`0` disables) |
| `LOGIT_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting |
| `LOGIT_SERVE_DEMO` | on unless production | Serve `/demo/` |

Docker:

```sh
docker build -t logit .
docker run -p 4000:4000 -v logit-data:/data -e LOGIT_ADMIN_TOKEN=change-me logit
```

## HTTP API

| Method | Path | Auth | |
|---|---|---|---|
| `POST` | `/api/ingest` | CORS allowlist | Batch of events from the SDK |
| `GET` | `/api/apps` | token | App ids with session counts |
| `GET` | `/api/sessions?appId=&q=&errors=1&limit=&offset=` | token | Session summaries, newest first |
| `GET` | `/api/sessions/:appId/:sessionId` | token | Summary and all events |
| `DELETE` | `/api/sessions/:appId/:sessionId` | token | Delete a session |
| `GET` | `/healthz` | — | Health check |

## Development

```sh
npm test              # API tests + end-to-end test in headless Chrome
npm run test:server   # API tests only
npm run check         # syntax-check all sources
```

The end-to-end test records a real session on the demo page and replays it in the viewer. It needs Chrome or Chromium; set `CHROME_PATH` if it's not in a standard location. Without a browser, it is skipped.

## Known limitations

- Storage is local files (one directory per session), with summaries indexed in memory. That suits a single server instance. Scaling out needs a shared store.
- Not yet recorded: canvas, video frames, shadow DOM, iframe contents, and `adoptedStyleSheets`.
- Linked stylesheets and images load from their original URLs at replay time, so assets that have since been deployed away will be missing.
# LogIt
