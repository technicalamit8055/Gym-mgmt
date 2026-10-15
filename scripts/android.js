/**
 * Builds the member app's debug APK (android/, a Capacitor project bundling
 * public/) pointed at one server and one gym.
 *
 *   npm run android:apk -- --gym amit-gym
 *   npm run android:apk -- --gym amit-gym --server https://gymbook.fly.dev --install
 *
 * --server defaults to this PC's LAN address and PORT, so a phone on the same
 * Wi-Fi reaches the local dev server. --install puts the APK on whatever
 * device `adb devices` lists (a USB phone or a running emulator).
 *
 * The choice is written to public/native-config.json, which only the app reads
 * (see public/js/api.js) — rerun this to point it somewhere else.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

const { values: args } = parseArgs({
  options: {
    gym: { type: 'string' },
    server: { type: 'string' },
    install: { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: ROOT, ...options });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** http://<first LAN IPv4>:<PORT> — what a phone on the same Wi-Fi can reach. */
function lanServerUrl() {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env is optional.
  }
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface?.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.'));
  if (!lan) fail('No LAN address found — pass --server <url> instead.');
  return `http://${lan.address}:${process.env.PORT || 3000}`;
}

if (!args.gym) fail('Which gym should the app open? Pass --gym <slug> (the slug in /g/<slug>/).');
if (!/^[a-z][a-z0-9-]{2,39}$/.test(args.gym)) fail(`"${args.gym}" is not a valid gym slug.`);
const serverUrl = (args.server || lanServerUrl()).replace(/\/+$/, '');

fs.writeFileSync(path.join(ROOT, 'public', 'native-config.json'), `${JSON.stringify({ serverUrl, gymSlug: args.gym }, null, 2)}\n`);
console.log(`App will open ${serverUrl}/g/${args.gym}/#/portal`);

// Called through node, not npx/gradlew.bat: Windows .cmd shims break on a
// project path containing "&".
run(process.execPath, [path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android']);

if (process.platform === 'win32') {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) fail('JAVA_HOME is not set — point it at a JDK 21+ (Android Studio ships one in its jbr folder).');
  run(
    path.join(javaHome, 'bin', 'java.exe'),
    ['-classpath', path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', 'assembleDebug'],
    { cwd: ANDROID },
  );
} else {
  run('./gradlew', ['assembleDebug'], { cwd: ANDROID });
}
console.log(`\nDebug APK: ${APK}`);

if (args.install) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const adb = sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb';
  run(adb, ['install', '-r', APK]);
}
