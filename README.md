# LogIt

Self-hosted session recording. Add one script tag to your site and LogIt records what users see and do. You can then replay each session as a video-like DOM reconstruction, next to the session's console output, network requests and errors.

- **DOM replay**: a full snapshot plus incremental mutations, including:
  - open and closed **shadow DOM**;
  - **iframes**: same-origin ones directly, cross-origin ones live when they run LogIt too, or as an archived static copy when they don't;
  - **`adoptedStyleSheets`** (assigned or changed in place) and CSS-in-JS rules injected through `insertRule`;
  - **canvas** (2D and WebGL);
  - **video/audio** playback state, including HLS/DASH streams played through MediaSource, plus frames for stream-backed video.
- **Durable replays**: linked stylesheets are inlined at record time. The server archives the images, fonts, CSS, video, audio and HLS/DASH streams a page uses, plus the HTML of third-party iframes. Assets the server can't fetch, such as ones behind a login, can be uploaded by the SDK from the user's browser or fetched with configured credentials. Replays keep working after the site deploys new assets.
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

Put the tag as early in `<head>` as possible: it has to load before your components attach shadow roots or create WebGL contexts. The ingest endpoint is derived from the script's origin. Optional attributes are `data-endpoint`, `data-mask-all-inputs`, `data-record-canvas`, `data-upload-assets`, `data-parent-origins` and `data-debug`.

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
LogIt.setMediaSource(videoEl, 'https://cdn.example.com/movie/master.m3u8') // only needed with several MSE players
```

`src/recorder.js` lists every option in `DEFAULTS`. The rich-content options:

| Option | Default | |
|---|---|---|
| `recordIframes` | `true` | Record the DOM inside same-origin iframes |
| `recordMedia` | `true` | Record `<video>`/`<audio>` play, pause, seek, rate and volume; replay syncs the element |
| `recordCanvas` | `false` | Sample `<canvas>` frames (WebGL included), plus frames of `<video>` that has no replayable URL (e.g. `MediaStream`, MSE `blob:`) |
| `canvasFps` / `canvasQuality` | `2` / `0.6` | Sampling rate and WebP quality; unchanged frames are not re-sent |
| `inlineStylesheets` | `true` | Embed readable `<link rel=stylesheet>` CSS in the recording |
| `uploadAssets` | `false` | Upload the assets the server reports it couldn't fetch (see [Assets behind a login](#assets-behind-a-login)) |
| `assetUploadMaxBytes` | `5242880` | Largest asset the SDK uploads |
| `assetCredentialOrigins` | `[]` | Other origins whose assets the SDK fetches with cookies before uploading. Those origins must answer with `Access-Control-Allow-Origin: <your site>` and `Access-Control-Allow-Credentials: true`. |
| `recordCrossOriginIframes` | `true` | Accept DOM streamed by cross-origin iframes that run LogIt (see [Cross-origin iframes](#cross-origin-iframes)) |
| `parentOrigins` | `[]` | Inside an iframe: the parent page origins allowed to receive this frame's DOM |

### Cross-origin iframes

A page can't read a cross-origin iframe's DOM, so the iframe has to record itself. Add the SDK to the page loaded in the iframe and list the parent origins that may receive its DOM:

```html
<!-- inside the iframe (e.g. https://widgets.example.com/chat) -->
<script src="https://logit.example.com/sdk/logit.js" data-app-id="chat-widget"
        data-parent-origins="https://shop.example.com"></script>
```

When the recording parent asks for it, the iframe streams its snapshot, mutations, inputs, scrolls and clicks to the parent over `postMessage`, and they replay inside the parent's session. Only listed origins receive the data, since anything else could read a frame it embeds; `*` allows any parent. The parent remaps the frame's node ids into its own id space, so a frame can only address its own content. The frame's console, network and error events stay in its own session, under its own app id.

**Iframes you can't add LogIt to** (third-party widgets, embeds) are recorded by URL. The server fetches their HTML, together with the images and stylesheets it references, and the replay shows that document as a static copy, with its scripts disabled like everything else in a replay. This is the frame as the server sees it: without the user's login, without what the widget's JavaScript renders, and without the user's interactions inside it. Turn it off with `LOGIT_ARCHIVE_FRAMES=false`.

### Streams (HLS / DASH)

Players such as hls.js, dash.js and Shaka give the `<video>` a `blob:` URL, which on its own replays nothing. The SDK matches the manifest request (`.m3u8`/`.mpd`, found through resource timing and network capture) to the video playing it. The server then downloads one video rendition (the best one up to 2 Mbit/s) and joins its init segment and media segments into one file. That file is fragmented MP4 or WebM, which the replay plays like any video. Several things are supported:
- HLS master and media playlists, with fMP4 segments and byte ranges;
- DASH `SegmentTemplate` (`$Number$` or `SegmentTimeline`/`$Time$`), `SegmentList` and single-file representations;
- streams whose `src` is the manifest itself, as with Safari's native HLS.

On pages with several MSE players, call `LogIt.setMediaSource(video, manifestUrl)` to make the match explicit.
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
| `LOGIT_ASSET_MAX_BYTES` | `5242880` | Largest image, font or stylesheet that will be archived |
| `LOGIT_ARCHIVE_MEDIA` | `true` | Also archive `<video>`/`<audio>` files |
| `LOGIT_MEDIA_MAX_BYTES` | `209715200` | Largest video, audio or stream that will be archived. Longer media keeps its beginning (see below). |
| `LOGIT_ARCHIVE_FRAMES` | `true` | Archive the HTML of cross-origin iframes that don't run LogIt |
| `LOGIT_ASSET_HEADERS` | — | Credentials for private asset hosts, as JSON: `{"cdn.example.com": {"Authorization": "Bearer …"}, "*.example.com": {"Cookie": "…"}}`. Headers are sent only to the matching host, including after redirects. |
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

After each ingest, the server collects the asset URLs the batch references in the background: images, `srcset`s, posters, icons, video and audio sources, CSS `url()`s and `@import`s, inside shadow roots, iframes and constructed stylesheets too. It fetches them and stores them by SHA-256 of their content, and archived CSS is rewritten so its own fonts and images point at archived copies. The viewer then loads `/assets/<sha256>` instead of the live URL.

- **What gets archived**: images, fonts, CSS, video, audio and streams. Scripts are never archived. HTML is only archived as the document of a third-party iframe and served as `text/plain`, for the replayer to rebuild without running anything.
- **Media over the limit**: formats that play from their beginning keep their first `LOGIT_MEDIA_MAX_BYTES`. This covers WebM, Ogg, MP3, AAC and MP4 whose index comes before the media data ("faststart"). Streams keep as many segments as fit. Anything else over the limit is skipped.
- **Large files**: media is downloaded to a temporary file and stored in pieces, as files on disk or 1 MB chunks in Postgres, and served as a stream. The archiver never holds a whole video in memory.
- **SSRF protection**: every resolved address (including redirects and IP-literal hosts) is checked against private, loopback, link-local and metadata ranges.
- **Serving**: assets are served with a sandboxing CSP and support byte ranges, so replayed media can seek. Since they are content-addressed, they need no auth and are cached forever.

#### Assets behind a login

The server fetches assets without the user's cookies, so assets that need a login fail. The server reports those URLs back to the SDK in its ingest responses. With `uploadAssets` on (`data-upload-assets`), the SDK fetches each one in the browser, with cookies for same-origin URLs, and uploads it to `POST /api/assets`. Only URLs the server couldn't fetch are uploaded, and each at most once per page.

This is off by default because these assets are often private to the user, such as profile photos or document scans; turning it on stores them with the recording. Uploads go through the same type allowlist and size limits as server-side archiving.

Assets on **another origin** are covered two ways:
- **From the user's browser**: list the origin in `assetCredentialOrigins`, and have it allow your site with credentialed CORS. The SDK then fetches with the user's cookies.
- **From the server**: when the host accepts a service credential (a token, a signed cookie, a basic-auth header), set it in `LOGIT_ASSET_HEADERS`. The server sends it to that host only.

## HTTP API

| Method | Path | Auth | |
|---|---|---|---|
| `POST` | `/api/ingest` | CORS allowlist | Batch of events from the SDK. The response lists `missing` assets the server couldn't fetch. |
| `POST` | `/api/assets?appId=&sessionId=&url=` | CORS allowlist | Asset uploaded by the SDK; the body is the file and `Content-Type` its type |
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

These are browser security boundaries or format limits. LogIt covers each of them as far as it can, as described above.

- **Third-party iframes without LogIt** replay as the server's static copy of their HTML. What the widget's JavaScript renders, anything behind the user's login, and the user's actions inside the frame are not visible to the page, so they aren't recorded.
- **An asset on another origin that needs the user's own login** can only be archived if that origin allows credentialed CORS (`assetCredentialOrigins`), or if the server has its own credential for it (`LOGIT_ASSET_HEADERS`). Otherwise the browser won't let the page read it.
- **Streams**: live streams, DRM-protected or encrypted streams, and HLS with MPEG-TS segments aren't archived; browsers can only play TS segments inside an HLS player. With `recordCanvas` on, their video is captured as frames instead.
- **Media over `LOGIT_MEDIA_MAX_BYTES`** in a format that can't be cut, such as MP4 with its index at the end, WAV or FLAC, isn't archived.
