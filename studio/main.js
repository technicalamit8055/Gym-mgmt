import { BrowserWindow, app, desktopCapturer, dialog, ipcMain, safeStorage, screen, session } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from './src/controller.js';
import { createStreamer } from './src/streamer.js';
import { createTokenStore } from './src/tokenStore.js';

/**
 * CoachBook Studio: the class controller that floats over Note 3 on a
 * classroom smartboard — always on top, frameless, a dock (and every other
 * screen) you drag by its grip and fold to a bubble, with panels that open beside it for polls, doubts and ending class.
 *
 * The main process holds everything that matters: the device token (sealed by
 * the OS, src/tokenStore.js), every API call, and the file system — all in
 * src/controller.js, which this file connects to the window over IPC. The
 * dock's page (renderer/) is sandboxed: it never sees the token, and can only
 * upload a PDF the controller found or the teacher picked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// For running a second, throwaway copy (tests, a demo) beside the real one.
if (process.env.STUDIO_USER_DATA) app.setPath('userData', process.env.STUDIO_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

const DOCK = { width: 92, height: 380 };
const MARGIN = 24;

let win = null;
let settings = {};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    settings = {};
  }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

/* ── The window ──────────────────────────────────────────────────────── */

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** Keeps a rectangle on whatever screen it is nearest — a board's display can change. */
function onScreen({ x, y, width, height }) {
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
  return {
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = settings.dock;
  const bounds = onScreen({
    x: saved?.x ?? area.x + area.width - DOCK.width - MARGIN,
    y: saved?.y ?? Math.round(area.y + (area.height - DOCK.height) / 2),
    ...DOCK,
  });
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: 'CoachBook Studio',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The broadcast is drawn on a timer; a throttled window would send 1 fps.
      backgroundThrottling: false,
    },
  });
  // Left out of every screen capture (Windows 10 2004 and later), so the
  // stream shows the board, not the teacher's controls.
  win.setContentProtection(true);
  // 'screen-saver' sits above a full-screen app such as Note 3; plain
  // always-on-top does not.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('always-on-top-changed', (_event, onTop) => {
    if (!onTop) win.setAlwaysOnTop(true, 'screen-saver');
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(here, 'renderer', 'index.html'));
}

/**
 * Resizes for a view or panel, growing away from the screen edge the dock
 * sits nearest, so the dock itself does not jump when a panel opens beside
 * it. Returns that side, so the page can put the dock against it.
 */
function resizeTo(_mode, width, height) {
  const b = win.getBounds();
  const side = sideOf(b);
  win.setBounds(onScreen({ x: side === 'right' ? b.x + b.width - width : b.x, y: b.y, width, height }));
  return { side };
}

/** The screen edge a window sits nearest, which it grows away from. */
function sideOf(b) {
  const area = screen.getDisplayMatching(b).workArea;
  return b.x + b.width / 2 > area.x + area.width / 2 ? 'right' : 'left';
}

/** Where the dock would sit for the window as it is now: where the next launch opens. */
function dockSpot(b) {
  return { x: sideOf(b) === 'right' ? b.x + b.width - DOCK.width : b.x, y: b.y };
}

/* ── Start at login ──────────────────────────────────────────────────── */

// The Run entry's name in the registry; build/installer.nsh removes it on uninstall.
const LOGIN_ITEM = 'CoachBook Studio';

/**
 * Opens Studio when the board's Windows account signs in, so a board switched
 * on in the morning has its dock up without anyone starting it. On unless
 * turned off, and only for the installed app: run from source, the entry
 * would start a bare electron.exe.
 */
const startup = {
  available: () => app.isPackaged && process.platform === 'win32',
  get: () => settings.startAtLogin !== false,
  set(on) {
    saveSettings({ startAtLogin: on });
    applyStartAtLogin();
  },
};

/** Written on every launch, so the entry follows the app if it is reinstalled elsewhere. */
function applyStartAtLogin() {
  if (startup.available()) app.setLoginItemSettings({ openAtLogin: startup.get(), name: LOGIN_ITEM });
}

/* ── Capture ─────────────────────────────────────────────────────────── */

/**
 * What the page may capture: the board's own screen (getDisplayMedia), its
 * camera and its microphone — asked for by the app's own page only.
 */
function allowCapture() {
  const ours = (url) => String(url || '').startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ours(details.requestingUrl || wc.getURL()) && ['media', 'display-capture'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ours(origin) && ['media', 'display-capture'].includes(permission));
  // No picker: the board streams its main screen, the one Note 3 is on.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primary = String(screen.getPrimaryDisplay().id);
    callback({ video: sources.find((s) => s.display_id === primary) ?? sources[0] });
  });
}

/* ── IPC ─────────────────────────────────────────────────────────────── */

function wireIpc(controller, streamer) {
  for (const [name, method] of Object.entries(controller)) {
    ipcMain.handle(`studio:${name}`, async (event, arg) => {
      // Only the app's own page, never anything it might be navigated to.
      if (!event.senderFrame?.url?.startsWith('file://')) return { ok: false, error: 'Not allowed' };
      try {
        return await method(arg ?? {});
      } catch (err) {
        // Errors do not cross IPC well; a result does.
        return { ok: false, error: err?.message || 'Something went wrong' };
      }
    });
  }

  // The broadcast's chunks, straight on to ffmpeg.
  ipcMain.on('studio:stream-chunk', (event, chunk) => {
    if (event.senderFrame?.url?.startsWith('file://') && chunk) streamer.write(chunk);
  });

  // Dragging by the grip, from pointer events: works the same under a finger
  // as under a mouse, which a CSS drag region on a touch screen does not.
  let drag = null;
  ipcMain.on('studio:drag', (_event, { phase, screenX, screenY } = {}) => {
    if (!win || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
    if (phase === 'start') {
      drag = { pointer: { x: screenX, y: screenY }, window: win.getBounds() };
    } else if (phase === 'move' && drag) {
      const { width, height } = drag.window;
      win.setBounds(onScreen({
        x: Math.round(drag.window.x + screenX - drag.pointer.x),
        y: Math.round(drag.window.y + screenY - drag.pointer.y),
        width,
        height,
      }));
    } else if (phase === 'end' && drag) {
      drag = null;
      // Wherever it was dragged to (dock, bubble or a full screen) is where it opens next time.
      saveSettings({ dock: dockSpot(win.getBounds()) });
    }
  });
}

/* ── Start ───────────────────────────────────────────────────────────── */

app.on('second-instance', () => {
  win?.show();
  win?.webContents.send('studio:unfold');
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  loadSettings();
  const streamer = createStreamer({
    // Packaged, the binary sits outside the asar archive.
    ffmpegPath: ffmpegStatic.replace('app.asar', 'app.asar.unpacked'),
    onStatus: (status) => win?.webContents.send('studio:stream-status', status),
  });
  app.on('before-quit', () => streamer.stop());
  const controller = createController({
    settings: { get: () => settings, save: saveSettings },
    tokens: createTokenStore({ file: path.join(app.getPath('userData'), 'device-key.json'), safeStorage }),
    files: { size: (file) => fs.statSync(file).size, read: (file) => fs.readFileSync(file) },
    async pickFolder() {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Where does Note 3 save its PDF exports?',
        defaultPath: settings.notesDir || app.getPath('documents'),
        properties: ['openDirectory'],
      });
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    },
    async pickPdf() {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose the class notes PDF',
        defaultPath: settings.notesDir || app.getPath('documents'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile'],
      });
      const file = picked.canceled ? null : picked.filePaths[0];
      if (!file) return null;
      const stat = fs.statSync(file);
      return { path: file, name: path.basename(file), size: stat.size, modified: stat.mtimeMs };
    },
    resize: resizeTo,
    quit: () => app.quit(),
    streamKey: createTokenStore({ file: path.join(app.getPath('userData'), 'stream-key.json'), safeStorage }),
    streamer,
    startup,
  });
  applyStartAtLogin();
  allowCapture();
  wireIpc(controller, streamer);
  createWindow();
});
