# How to run GymBook yourself (no Claude needed)

This is a step-by-step guide for starting the app on your own PC, using
PowerShell (the terminal that opens by default on Windows). Copy-paste each
command one at a time and read what it prints before moving to the next step.

There are two situations covered:

- **[A) Just for you](#a-run-it-just-for-you-on-this-pc)** — the app only
  works on this computer, nobody else can open it. Good for testing.
- **[B) Share it with others right now](#b-share-it-with-others-over-the-internet)**
  — using Cloudflare Tunnel, the free bridge we set up, so you can open the
  link from your phone or send it to someone at the gym. Requires this PC to
  stay on and connected to the internet the whole time.

---

## First time only: install everything

Open PowerShell, then go to the project folder and install dependencies:

```powershell
cd "C:\Users\techn\OneDrive\Desktop\gymbook\gymbook"
npm install
```

This downloads the few libraries the app needs. You only need to do this once
(and again if you ever pull new code that changes `package.json`).

---

## A) Run it just for you, on this PC

```powershell
cd "C:\Users\techn\OneDrive\Desktop\gymbook\gymbook"
npm start
```

You should see:

```
GymBook is running at http://localhost:3000
```

Open that address in your browser: **http://localhost:3000**

- First time ever running it, the terminal also prints an admin email and
  password — use those to log in, then change the password from the sidebar.
- After that, keep using the same login.

**To stop it:** click into the terminal window and press `Ctrl + C`.

That's it for local-only use. Nobody outside this PC can reach it this way —
skip to section B if you want to open it from your phone or let someone else
in.

---

## B) Share it with others over the internet

This uses **Cloudflare Tunnel**, a free program (`cloudflared`) that creates a
temporary public web address pointing at the app running on this PC. Every
time you start the tunnel fresh, it gives you a **brand new random address**
— so this is a 3-step dance every time: start the tunnel, read the address it
gives you, then start the app telling it that exact address.

### Step 1 — Start the tunnel

Open a PowerShell window and run:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
```

Leave this window open and running. After a few seconds it prints something
like:

```
+--------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
|  https://some-random-words-here.trycloudflare.com                                     |
+--------------------------------------------------------------------------------------+
```

**Copy that `https://...trycloudflare.com` address** — you need it for the
next step. It will be different every single time you run this command.

### Step 2 — Start the app, telling it that address

Open a **second** PowerShell window (keep the tunnel window from Step 1
running in the background) and run this, replacing the address with the one
you just copied:

```powershell
cd "C:\Users\techn\OneDrive\Desktop\gymbook\gymbook"
$env:ROOT_DOMAIN = "some-random-words-here.trycloudflare.com"
npm start
```

`ROOT_DOMAIN` must match the tunnel address **exactly** (no `https://`, no
trailing slash) — this is what lets the app tell your gym's site apart from
someone else's. If you skip this or get it wrong, opening the link shows an
error like `"No gym found for ..."` instead of the app.

### Step 3 — Open and share the link

Visit the `https://...trycloudflare.com` address from any device — your
phone, another computer, whatever. That's the same link you can give to
someone else to try, as long as this PC stays on with both windows running.

**To stop everything:** go to each PowerShell window and press `Ctrl + C`
(you need to stop both — the tunnel window and the app window).

**Starting again later:** repeat Steps 1–2 from scratch. You will get a
**new** random address each time, so anyone you previously shared the old
link with will need the new one.

---

## Common problem: "No gym found for ..."

This means the app is running with a `ROOT_DOMAIN` that doesn't match the
address you're opening in the browser. Fix: stop the app (`Ctrl + C` in its
window) and start it again with the *current* tunnel address, exactly as
shown in Step 2 above.

## Good to know

- This tunnel setup is meant to be **temporary** — it's free and needs no
  credit card, but it depends on your PC staying on and gives you a
  throwaway address that changes every restart. Once you're ready to run
  this properly (a stable address, works even when your PC is off), that's
  the Fly.io deployment described in the main [README.md](README.md#deploy-flyio)
  — it just needs a debit/credit card to set up, which was the blocker last
  time this came up.
- Your data (members, payments, etc.) lives in files under the `data/`
  folder in this project — it does **not** depend on the tunnel or the
  random address, so it's safe across restarts either way.
