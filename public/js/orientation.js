/**
 * Turning the phone sideways for a full-screen class.
 *
 * A browser does it with screen.orientation.lock(); the member app's WebView
 * rejects that, so there it goes through the Orientation plugin (android/).
 * Leaving full screen any way at all — the button, back, a swipe — hands the
 * phone its own rotation again.
 */

import { isNativeApp } from './api.js';

const PLUGIN = 'Orientation';
const native = isNativeApp && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
const call = (method) => window.Capacitor.nativePromise(PLUGIN, method, {}).catch(() => {});

let locked = false;

export function landscape() {
  locked = true;
  if (native) return call('landscape');
  return screen.orientation?.lock?.('landscape').catch(() => {});
}

export function unlockOrientation() {
  if (!locked) return;
  locked = false;
  if (native) return call('unlock');
  try { screen.orientation?.unlock?.(); } catch { /* not supported */ }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) unlockOrientation();
});
