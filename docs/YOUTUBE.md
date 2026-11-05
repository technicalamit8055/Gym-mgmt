# Unlisted YouTube classes

CoachBook Studio can stream each class to the institute's YouTube channel as
its **own unlisted video**, so a paid batch's lectures are not public. A
manager connects the channel once, from **Smartboards** in the staff app.
From then on:

1. A teacher taps **Go live** (or **Join live**) on a classroom board.
2. CoachBook creates an unlisted broadcast for that class on the channel,
   binds it to the board's own stream, and tells the board where to send
   its video. The board never needs a stream key typed in.
3. Students of that batch, and only them, get the broadcast's link in the
   app, and watch it embedded there.
4. When the class ends, YouTube ends the broadcast and keeps the recording
   on the channel as an unlisted video. CoachBook files it in the batch's
   recorded lectures, under the class's subject, so students rewatch it
   from **My Batches** in the app. If the board never streamed, the empty
   broadcast is deleted, and nothing is filed.

Without a connected channel, boards work as before: a stream key typed into
Studio, streaming to the channel's **public** live feed.

**Unlisted is not private.** An unlisted video is off the channel page,
search and recommendations, but anyone with the link can watch it, so a
student can forward it. YouTube's *private* setting needs each viewer's
Google account invited by hand (50 at most), which does not fit a batch of
students.

## Setting it up (once, for the whole platform)

This is the platform operator's job, not each institute's: one Google app
signs in every institute's channel.

### 1. A Google Cloud project with the YouTube API

1. At [console.cloud.google.com](https://console.cloud.google.com), create a
   project, for example "CoachBook".
2. **APIs & Services → Library**: enable **YouTube Data API v3**.

### 2. The consent screen

**Google Auth Platform** (formerly "OAuth consent screen"):

- **Branding**: the app name institutes will see ("CoachBook"), a support
  email, your homepage, privacy policy and terms URLs, and your root domain
  under *Authorized domains*.
- **Audience**: *External*.
- **Data access**: add the scope `https://www.googleapis.com/auth/youtube`
  ("Manage your YouTube account"). CoachBook needs it to create, bind and end
  live broadcasts. The narrower scopes cannot do that.

### 3. The OAuth client

**Clients → Create client → Web application**. Under *Authorized redirect
URIs*, add exactly:

```
https://<ROOT_DOMAIN>/api/youtube/callback
```

For local development, add `http://localhost:3000/api/youtube/callback` too.
It is one fixed address for every institute: Google allows no wildcards, so it
never sits under `/g/<slug>` or an institute's custom domain.

### 4. The server

```sh
YOUTUBE_CLIENT_ID=1234-abc.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-...
# Only if the redirect URI is not https://$ROOT_DOMAIN/api/youtube/callback:
# YOUTUBE_REDIRECT_URI=https://app.example.com/api/youtube/callback
```

Restart the server. **Smartboards** then shows **Connect YouTube channel**.

## Before institutes rely on it

These are Google's rules, not CoachBook's. Plan for them before announcing
the feature.

### Testing mode: 100 accounts, and a weekly reconnect

A new app starts in **Testing**. Only Google accounts you add as *test
users* (100 at most) can sign in, and **their sign-in expires after 7 days**.
Every connected institute then shows *Needs reconnecting* on Smartboards
each week. That is fine for a pilot, not for production.

### Verification

To leave Testing, **publish** the app (Audience → Publish app). Because the
`youtube` scope is *sensitive*, Google then asks you to verify the app.
Until that is done, institutes see a "Google hasn't verified this app"
warning and the 100-account cap stays. Verification needs:

- the homepage and privacy policy on a domain you have verified in Google
  Search Console, with the privacy policy describing what CoachBook does with
  YouTube data;
- a short video of the sign-in flow and of the feature using the data;
- a written reason for the scope.

It usually takes days to a few weeks.

### Daily quota

A Google project gets **10,000 YouTube API units a day**, shared by every
institute on the platform. Each class costs about **100** (creating the
broadcast and binding it, 50 each), plus 1 to check on it when it ends, and
50 more if it has to be ended or deleted. That makes **roughly 65–100 classes
a day across all institutes**. Past that, boards report that CoachBook's
YouTube allowance is used up until midnight US Pacific time, and classes go
ahead without a stream. To raise it, apply through Google's *YouTube API
Services audit and quota extension* form. It includes a check against the
YouTube API Services Terms and Developer Policies.

### The institute's channel

- Live streaming has to be enabled on the channel (YouTube Studio → Create →
  Go live). The first time takes up to 24 hours.
- The manager signs in with the Google account that owns or manages the
  channel. A Brand Account channel is chosen on Google's account picker.

## How it is built

- `src/coaching/youtube.js`: the OAuth flow, token refresh, each board's
  reusable stream, each class's broadcast, and closing it afterwards.
- `src/routes/coaching/youtube.js`: `GET/POST/DELETE /api/coaching/youtube`
  (managers), and the callback at `/api/youtube/callback`, which is mounted
  before tenant resolution and finds its institute from the sign-in's state.
- `POST /api/studio/sessions/:id/youtube` (`src/routes/coaching/studio.js`):
  the board asks for its class's broadcast.
- The channel's refresh token and each board's stream key are stored
  encrypted (`src/sealed.js`, AES-256-GCM, keyed from `AUTH_SECRET`).
  **Changing `AUTH_SECRET` disconnects every channel**: institutes connect
  again from Smartboards.
- The sign-in's state is `<slug>.<nonce>`. Only a hash of the nonce is
  stored, for ten minutes, and it can be used once.
