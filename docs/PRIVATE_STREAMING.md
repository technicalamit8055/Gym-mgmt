# Private classes

For paid batches, CoachBook can stream classes privately instead of to
YouTube. A manager chooses it under **Smartboards → Who can watch classes**.
From then on:

1. A teacher taps **Go live** on a classroom board, as before.
2. The board sends the class to CoachBook. Nothing is typed in.
3. Each student of that batch, and only them, gets their **own signed link**
   and watches inside the app in CoachBook's player. A link stops working
   after a few hours or when the class ends, so a forwarded one is useless.
4. Students pick the quality: **Auto, 720p, 480p or 360p**, remembered on
   their phone. They also get play/pause, sound, and **Go live** if they fall
   behind.

There is no YouTube logo, no "Watch on YouTube" and no channel.

## Who carries the video

There are two ways, chosen once for the whole platform with
`PRIVATE_STREAM_BACKEND`.

### This server (the default, no extra cost)

The CoachBook server itself carries the video. Nothing needs setting up.

- **On the board:** Studio encodes the class three times (720p, 480p,
  360p) and uploads it to the server as HLS, in two-second pieces. The
  board's PC does the encoding work, so the server never transcodes.
- **On the server:** it keeps only the last 30 seconds of each class, in
  memory, and hands it to students who hold a valid link.

What it costs is bandwidth.

| | Per hour |
|---|---|
| The board uploads | about 4 Mbps (about 1.8 GB) |
| Each student downloads, at 720p | about 1.1 GB |
| Each student downloads, at 360p | about 0.3 GB |

**Example.** 30 students, 2 hours a day, 26 days a month is roughly
**0.5–1.7 TB a month**, depending on the quality students pick. Many cheap VPS plans include several TB of traffic,
so check your provider's allowance and price for traffic beyond it.

How many students one server carries depends on its network port, not its
processor. A 1 Gbps port fits roughly 400 students watching 720p at once,
across all institutes. Past that, move to a bigger port, a second server,
or Cloudflare.

**What to know:**
- **Recordings are optional.** They are off by default. A manager turns on
  **Record classes** under Smartboards → Who can watch classes → Private.
  - **How it works:** each class is saved to this server's disk as it
    streams. When the class ends, it appears in the batch's **Recorded
    lectures** (My Batches) under its subject. Students rewatch it in the
    app on their own signed link, with seeking, speed and a choice of 480p
    or 360p.
  - **Disk space:** recordings keep 480p and 360p only, which is about
    0.8–0.9 GB per hour of class. They are stored in `RECORDINGS_DIR`
    (default: `recordings/` beside the platform database).
  - **Clean-up:** recordings are deleted automatically after the
    institute's **Keep recordings for** setting (30 days by default). The
    hourly sweep does this, files included. Deleting one from **Recorded
    lectures** removes its files at once, and hiding it stops it playing
    at once.
  - **Restarts:** if the board's stream restarts mid-class, the recording
    carries on as one lecture.
  - **Watch the disk:** `RECORDINGS_DIR` is the largest thing on the
    server.
    - The operator console's **Server storage** card shows free space and
      each institute's recordings, biggest first.
    - **Under 20% free**, the card turns amber, and the operator
      (`PLATFORM_ADMIN_EMAIL`) gets an email once a day, if email is set
      up.
    - **Under 10% free, or under 2 GB**, recording pauses for every
      institute. A recording in progress stops where it is and is still
      filed, and managers see "Recording is paused" on Smartboards. Live
      classes carry on, and recording restarts by itself once there is
      room.
    - Both lines can be changed with `RECORDING_WARN_FREE_PCT` and
      `RECORDING_STOP_FREE_PCT`.
- **A restart drops the stream briefly.** The live window lives in the
  server's memory, so a restart loses it. The board's stream fails, Studio
  starts it again by itself, and students' players pick it up after a few
  seconds.
- **One server process.** It must run as a single process, not a cluster.
- **Set up the reverse proxy for the board's uploads.** Caddy needs
  nothing. If nginx is in front, it needs two changes:
  - **Upload limit.** Set `client_max_body_size 16m;`. Its default of
    1 MB can refuse a 720p segment.
  - **Upload pass-through.** Without it, nginx drops the uploads
    (`408`/`499`/`400` in its access log) and students wait for a video
    that never comes. Put this above `location / {`:
    ```nginx
    location ~ ^(/g/[^/]+)?/api/studio/hls/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_ignore_client_abort on;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    ```
- **The school's internet.** The board needs about 4 Mbps of upload.

### Cloudflare Stream (paid, for scale)

Set `PRIVATE_STREAM_BACKEND=cloudflare` and the Cloudflare values in
`.env`. Cloudflare then carries the video. Cloudflare charges per minute
watched and per minute stored, and classes are recorded on the account.
Each recording is filed in the batch's lectures under its subject a minute
or two after the class ends, once Cloudflare has made the video. Students
play it with a link signed for them alone, like the live class.

To set it up:

1. **Cloudflare account with Stream.** At dash.cloudflare.com, open
   **Stream** and subscribe.
2. **Account ID.** On the account's home page. It goes into
   `CLOUDFLARE_ACCOUNT_ID`.
3. **API token.** **My Profile → API Tokens → Create token → Custom token**,
   with *Account → Stream → Edit*. It goes into
   `CLOUDFLARE_STREAM_API_TOKEN`.
4. **Customer code.** Upload any short video in **Stream**, open it, and
   take the `<code>` from `https://customer-<code>.cloudflarestream.com/...`.
   It goes into `CLOUDFLARE_STREAM_CUSTOMER_CODE`.
5. **Signing key.** Run `npm run stream:key`, then add the two lines it
   prints. Cloudflare shows the key only once.
6. Restart the server.

## YouTube, locked down

Institutes that stay on YouTube also get CoachBook's player. YouTube's
controls are turned off, every tap lands on CoachBook's cover rather than on
YouTube, and YouTube's title bar and logo are cropped off. Know the limits
before relying on it:

- **It breaks YouTube's rules.** YouTube's API Services policies do not
  allow covering or hiding its player. Google can cut off the YouTube API
  app that unlisted classes depend on (docs/YOUTUBE.md), or act against the
  channel.
- **No quality menu.** YouTube's embed no longer lets a page choose the
  quality.
- **The video ID is still in the page.** A determined student can find it.

## How it is built

- `src/coaching/selfHostedStream.js`: the in-memory live window, upload
  tokens and students' watch tokens (HMAC, keyed from `AUTH_SECRET`).
- `src/coaching/privateStream.js`: the backend choice, Cloudflare live
  inputs and their signed tokens, and each student's link.
- `PUT /api/studio/hls/<upload token>/<file>`: the board's uploads.
- `GET /api/live-hls/<watch token>/<file>`: students' players. The token
  is in the path, so the playlists' relative links carry it along.
- `POST /api/studio/sessions/:id/private`: the board asks where to send
  the class.
- `GET/PUT /api/coaching/streaming`: the manager's choice.
- `studio/src/streamer.js`: `hlsArgs`, the three-quality HLS encode.
- `public/js/classPlayer.js`: the player. It uses hls.js
  (`public/js/vendor/hls.light.min.js`, `npm run vendor:hls`) for HLS and
  YouTube's IFrame API for YouTube.
