/**
 * Runtime permissions for the Capacitor member app (android/).
 *
 * The app's WebView can only hand getUserMedia the camera once the app itself
 * holds Android's CAMERA permission. Asking through @capacitor/camera first
 * puts up the system dialog, and gives a clear "denied", before getUserMedia
 * runs. The page has no bundler to import the plugin's JS with, so it calls
 * the native side through the bridge Capacitor injects instead.
 *
 * On the web this resolves at once and the browser asks in its own way.
 */
import { isNativeApp } from './api.js';

/** Resolves once the camera may be used; rejects with a NotAllowedError —
 * what getUserMedia itself throws — when the member has refused it. */
export async function ensureCameraPermission() {
  if (!isNativeApp) return;
  let result;
  try {
    result = await window.Capacitor.nativePromise('Camera', 'requestPermissions', { permissions: ['camera'] });
  } catch {
    // No camera plugin in this build: getUserMedia still asks on its own.
    return;
  }
  if (result?.camera === 'denied') throw new DOMException('Camera permission was denied', 'NotAllowedError');
}
