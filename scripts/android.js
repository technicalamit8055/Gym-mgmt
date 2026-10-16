/**
 * Builds the member app's debug APK (android/, a Capacitor project bundling
 * public/) pointed at one server. Without --gym it is the store app, serving
 * every gym on that server: members pick theirs on the "find your gym"
 * screen. With --gym it is that one gym's own app, and never asks.
 *
 *   npm run android:apk
 *   npm run android:apk -- --server https://gymbook.fly.dev --install
 *   npm run android:apk -- --gym amit-gym
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
    device: { type: 'string' },
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

function resolveServerUrl() {
  if (args.server) return args.server.replace(/\/+$/, '');
  const configPath = path.join(ROOT, 'public', 'native-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (existing?.serverUrl) return existing.serverUrl.replace(/\/+$/, '');
    }
  } catch {
    // Fallback to LAN
  }
  return lanServerUrl().replace(/\/+$/, '');
}

if (args.gym && !/^[a-z][a-z0-9-]{2,39}$/.test(args.gym)) fail(`"${args.gym}" is not a valid gym slug.`);
const serverUrl = resolveServerUrl();

const nativeConfig = args.gym ? { serverUrl, gymSlug: args.gym } : { serverUrl };
fs.writeFileSync(path.join(ROOT, 'public', 'native-config.json'), `${JSON.stringify(nativeConfig, null, 2)}\n`);
console.log(
  args.gym
    ? `App is locked to one gym: ${serverUrl}/g/${args.gym}/#/portal`
    : `App opens the gym finder on ${serverUrl} — members pick their gym by QR, code or search`,
);

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

  // Check connected devices
  const devResult = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' });
  const lines = (devResult.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const devices = [];
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+device\b/);
    if (match) devices.push({ id: match[1], isEmulator: match[1].startsWith('emulator-'), raw: line });
  }

  if (devices.length === 0) {
    fail('No Android devices or emulators found. Connect your phone via USB with USB Debugging enabled, or start an emulator.');
  }

  let targetId = args.device;
  if (!targetId) {
    const physical = devices.filter((d) => !d.isEmulator);
    if (physical.length > 0) {
      targetId = physical[0].id;
    } else {
      targetId = devices[0].id;
    }
  }

  console.log(`\nTarget device: ${targetId}`);
  run(adb, ['-s', targetId, 'install', '-r', APK]);

  // Port forward dev server ports so USB connected device can reach localhost:3001/3000
  spawnSync(adb, ['-s', targetId, 'reverse', 'tcp:3001', 'tcp:3001']);
  spawnSync(adb, ['-s', targetId, 'reverse', 'tcp:3000', 'tcp:3000']);

  // Launch the app
  console.log('\nLaunching app on device...');
  run(adb, ['-s', targetId, 'shell', 'am', 'start', '-n', 'com.gymbook.member/.MainActivity']);
  console.log('\nApp launched successfully!');
}
