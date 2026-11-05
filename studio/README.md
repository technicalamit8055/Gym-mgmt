# CoachBook Studio

The class controller for classroom smartboards. It is a slim dock on the edge
of the screen that floats over Note 3 (or any full-screen app), always on top.
Its pop-ups are only as big as they need to be. Every screen (the dock, the
lectures list, set-up) has a **⋮⋮** grip to drag it anywhere on the screen, and
**–** folds it down to a single bubble (a LIVE one during a class). Tap the
bubble, or open Studio again from its shortcut, to unfold it. Studio opens
wherever it was last dragged to. It has three buttons:

- **⚡ Poll**: tap 30s or 45s and the poll starts; students answer A–D. When
  the time is up, tap the right answer to reveal it. The answer is never on
  the board before the voting ends, so the class cannot read it off the
  screen. Then the dock shows the percentages and the fastest right answers.
- **❓ Doubts**: students' doubts, with a counter of new ones. **Pin** puts a
  doubt on every student's screen; **Answered** clears it.
- **⏹ End**: ends the class, finds the PDF Note 3 exported, and publishes it
  to the batch as the class's notes.

## Setting up a board

1. In CoachBook, a manager registers the board for its classroom
   (`POST /api/coaching/studio-devices`). That gives a pairing code, valid for 15 minutes.
2. On the board, run Studio and enter the institute's CoachBook address
   (for example `https://coachbook.in/g/apex`) and the code.
3. Set **Note 3 exports** to the folder Note 3 saves its PDFs into.
4. Optional: set up **YouTube Live** with the channel's stream key (YouTube
   Studio → Create → Go live → Stream) and channel ID (Settings → Channel →
   Advanced). Choose the camera and microphone, or "No camera".

## YouTube Live

When YouTube Live is set up, going live also streams the board to the
institute's channel:

- **What it streams:** the screen, with the camera in the corner and the
  microphone. Studio's own window is left out of the capture (Windows 10
  version 2004 and later).
- **How it gets there:** ffmpeg (bundled through `ffmpeg-static`) sends it as
  720p30 H.264 over RTMPS.
- **Unlisted (channel connected in CoachBook):** when a manager has connected
  the institute's channel under **Smartboards**, CoachBook creates an unlisted
  broadcast for each class and gives the board the address to stream to. No
  stream key or channel ID is typed in here, only the camera and microphone.
  Students of that batch get the class's own link. See
  [docs/YOUTUBE.md](../docs/YOUTUBE.md).
- **Public (a typed-in key):** without a connected channel, students' app
  plays the channel's live feed, which YouTube only shows for **public**
  streams. Set the channel's default live-stream visibility to Public.
- **Keeping the key safe:** the stream key is encrypted like the device key,
  and blanked out of every error message.

From then on, the board lists the lectures timetabled in its room today. **Go live** starts one as
its timetabled teacher. **Join live** takes over a class the teacher already started from their phone.

To cut a board off, issue it a new pairing code or remove it in CoachBook.
Its key stops working immediately.

## Installing it on a board

Boards don't need Node or this code. Build the installer once, on a 64-bit
Windows PC:

```sh
npm install
npm run dist   # → dist/CoachBook-Studio-Setup-<version>.exe
```

Copy the `.exe` to the board and run it. It installs for that Windows account
only, so it needs no admin rights. It adds Start menu and desktop shortcuts and
opens Studio when it finishes.

- **Start with Windows.** The installed Studio opens whenever the board's
  account signs in, so the dock is up when the board is switched on. Turn this
  off or on under **Start with Windows** on the lectures screen. Task Manager's
  Startup tab can turn it off as well. Running from source (`npm start`) never
  adds this, because it would start a bare `electron.exe`.
- **Upgrading.** Run a newer installer over the old one. Pairing, the stream
  key and the settings carry over.
- **Uninstalling** (Settings → Apps) also removes the start-at-login entry. It
  leaves the settings and the sealed key in `%APPDATA%\coachbook-studio`, the same folder `npm start` uses, so
  reinstalling keeps the board paired. To cut a board off, unpair it in
  CoachBook.
- **Unsigned.** The installer isn't code-signed yet, so Windows SmartScreen
  shows "Windows protected your PC" the first time. Choose **More info → Run
  anyway**. To sign it, set `CSC_LINK` and `CSC_KEY_PASSWORD` before
  `npm run dist`.
- **Build on Windows x64.** `ffmpeg-static` downloads the ffmpeg build for the
  PC running `npm install`, and the installer ships that one.

## Running it from source

```sh
npm install
npm start      # the app
npm test       # unit tests, including a real ffmpeg encode; no Electron needed
```

`STUDIO_USER_DATA=<folder>` runs a separate copy with its own settings and key.

## How it keeps the board's key safe

- **Encrypted on disk.** The device token is encrypted with Windows DPAPI
  (Electron `safeStorage`) in `device-key.json`, so only this Windows account
  on this machine can open it. If the OS cannot encrypt, pairing is not saved
  at all.
- **Kept away from the page.** The token never reaches the dock's page. The
  main process (`src/controller.js`) makes every API call. The page runs
  sandboxed, with context isolation and a strict CSP.
- **Uploads are restricted.** The page can upload only a PDF the app found in
  the export folder or the teacher picked in a file dialog.
- **The server keeps only hashes** of the token and the pairing code.
