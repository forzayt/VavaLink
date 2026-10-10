# VavaLink

### Lightweight audio infrastructure for Discord.

Lavalink-inspired audio server: resolve a YouTube / SoundCloud / direct URL (or search text) and get back playable audio transcoded with ffmpeg. Nothing touches disk — everything streams.

## Quickstart

```bash
cp .env.example .env   # adjust PORT, FFMPEG_PATH, YT_DLP_PATH, ...
npm install
npm run dev            # tsx watch src/index.ts
```

Requires `ffmpeg`, `ffprobe`, and `yt-dlp` on `PATH` (or set `FFMPEG_PATH`, `FFPROBE_PATH`, `YT_DLP_PATH`).

## Endpoints

### `POST /v1/audio` — transcode + stream

```bash
curl -X POST http://127.0.0.1:3000/v1/audio \
  -H 'Content-Type: application/json' \
  -d '{"query":"never gonna give you up"}' --output out.mp3
```

Body: `{ "query": string (1–500 chars), "encoding"?: "mp3" | "pcm" }`. Default encoding is `DEFAULT_ENCODING` (mp3).

### `GET /v1/audio/{link}` — directly playable URL

The URL itself **is** the playable link — paste it in a browser, `<audio>` tag, VLC, or Discord:

```
http://127.0.0.1:3000/v1/audio/https://youtu.be/3sB4Iv_tM7U
```

Streams `audio/mpeg` (or `audio/L16`) chunked, with track metadata in `X-VavaLink-*` response headers. Optional `?encoding=mp3|pcm`:

```
http://127.0.0.1:3000/v1/audio/https://youtu.be/3sB4Iv_tM7U?encoding=pcm
```

Pasting the URL into a Chrome address bar returns an instant auto-playing player page (the raw stream takes ~10s to start: two yt-dlp lookups + ffmpeg buffering). Append `?raw=1` to force the raw audio stream — use that form in `<audio src>`, Discord, VLC, and curl.

### `GET /v1/audio?query={link}` — for URLs with `?` and `&`

Raw `youtube.com/watch?v=...&list=...` links cannot survive raw in a path segment (the `?` starts our own query string). Use a query param instead (also supports `?url=` / `?link=`):

```
http://127.0.0.1:3000/v1/audio?query=https://www.youtube.com/watch?v=3sB4Iv_tM7U
http://127.0.0.1:3000/v1/audio?query=https://youtu.be/3sB4Iv_tM7U&encoding=pcm
```

Alternatively percent-encode the link when using path style.

### `GET /v1/audio/{link}?format=json` — return the playable link as JSON

Skips transcoding and returns the resolved upstream CDN URL (expires fast, may need `requestHeaders`):

```
http://127.0.0.1:3000/v1/audio/https://youtu.be/3sB4Iv_tM7U?format=json
```

(`?direct=true` / `?format=direct` work too.) Response:

```json
{
  "track": { "identifier": "...", "title": "...", "author": "...", "lengthMs": 0, "isStream": false, "sourceName": "youtube", "uri": "...", "artworkUrl": "..." },
  "playableUrl": "https://rr...googlevideo.com/...",
  "contentType": "audio/webm; codecs=opus",
  "requestHeaders": { "User-Agent": "..." },
  "sizeBytes": null,
  "source": "youtube",
  "tookMs": 123
}
```

### `GET /health` + `GET /`

Liveness with ffmpeg/ffprobe/source checks (`?refresh=true` bypasses the 10s cache), plus service metadata at `/`.

## Notes

- `GET` streams exactly like `POST` — same resolver (`src/sources/chain.ts`), same ffmpeg pipeline (`src/audio/pipeline.ts`), same `499` handling on client disconnect.
- Prefer the server stream URL over `playableUrl` for playback: CDN URLs are IP-locked and short-lived, while `/v1/audio/...` re-resolves on every request.
- Streaming internals: yt-dlp downloads (`-o -`, documented stdout-streaming pattern) and pipes bytes into ffmpeg's stdin (`-i pipe:0`). ffmpeg never touches `googlevideo.com` directly, so there is no IP-lock/expiry/header race. yt-dlp is pinned to IPv4 by default (`--force-ipv4`; override with `YT_DLP_EXTRA_ARGS=--force-ipv6` on IPv6-only networks), prefers audio-only formats, and resolve metadata is cached 60s to avoid hammering YouTube (one player page = 1 resolve + 1 download instead of 4 lookups).

## Deploy to Render

`render.yaml` in the repo root is a ready blueprint (or copy its values into a manual service):

- **Build command:** `npm install && npm run build && mkdir -p bin && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp && chmod +x bin/yt-dlp && ./bin/yt-dlp --version`
- **Start command:** `npm start` (not `npm run dev`)
- **Env:** `HOST=0.0.0.0`, `YT_DLP_PATH=bin/yt-dlp` (`PORT` is injected by Render; health check is `/`)

Why each bit exists: Render's Node image has `ffmpeg`/`ffprobe` but **no `yt-dlp`** (without it, YouTube/SoundCloud report unavailable), and the server must bind `0.0.0.0:$PORT` — the `127.0.0.1` default is what causes `No open ports detected`.