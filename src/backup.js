import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { putObject, s3Configured } from './s3.js';
import { closeRegistryDb, listTenants, tenantDbPath } from './tenants.js';

/**
 * Taking, verifying, shipping and pruning database backups.
 *
 * Every gym is a single SQLite file, so a backup is a file copy — but the three
 * things that make a backup an actual backup were all missing: it only ran when
 * a human remembered to run it, it never left the machine it was taken on, and
 * nothing ever checked that what came out was readable. A snapshot sitting on
 * the same Fly volume as the live database, that nobody has ever restored, is
 * not a backup. All three are addressed here.
 *
 * `VACUUM INTO` is what makes this safe against a live server: it takes a read
 * transaction and writes a fresh, defragmented database, so there is no torn
 * copy and no downtime, WAL or not.
 */

/** Escapes a path for embedding in the VACUUM INTO string literal. SQLite has
 * no parameter binding for this statement. */
const sqlLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

/**
 * Reopens a snapshot and confirms it is a usable database.
 *
 * This is the step that turns "a file was written" into "a file we could
 * restore from". An unverified backup fails at the only moment it matters.
 */
export function verifySnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // The column is named after the pragma itself, so read the row's single
    // value positionally rather than guessing at a key.
    const row = db.prepare('PRAGMA integrity_check').get();
    const result = row ? Object.values(row)[0] : undefined;
    if (result !== 'ok') {
      throw new Error(`integrity check on ${path.basename(file)}: ${result ?? 'no result'}`);
    }

    // Readable schema plus a real row count: a syntactically intact but empty
    // file would pass integrity_check and be worthless.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const counts = {};
    for (const { name } of tables) {
      counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    }
    return { tables: tables.length, rows: Object.values(counts).reduce((a, b) => a + b, 0), counts };
  } finally {
    db.close();
  }
}

function snapshot(label, sourceFile, destDir) {
  if (!fs.existsSync(sourceFile)) return { label, skipped: `no file at ${sourceFile}` };

  const dest = path.join(destDir, `${label}.db`);
  const db = new DatabaseSync(sourceFile);
  try {
    db.exec(`VACUUM INTO ${sqlLiteral(dest)}`);
  } finally {
    db.close();
  }

  const checked = verifySnapshot(dest);
  return { label, file: dest, bytes: fs.statSync(dest).size, ...checked };
}

/**
 * Deletes all but the newest `keep` backup folders.
 *
 * Without this a daily backup fills the volume and then the *live* database is
 * the thing that cannot write — turning a safety net into an outage.
 */
function prune(rootDir, keep) {
  if (!keep || keep < 1 || !fs.existsSync(rootDir)) return [];

  const folders = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort() // timestamped names sort chronologically
    .reverse();

  const removed = folders.slice(keep);
  for (const name of removed) {
    fs.rmSync(path.join(rootDir, name), { recursive: true, force: true });
  }
  return removed;
}

async function upload(results, stamp) {
  const prefix = config.backup.s3.prefix ? `${config.backup.s3.prefix.replace(/\/$/, '')}/` : '';
  const uploaded = [];

  for (const result of results) {
    if (!result.file) continue;
    const key = `${prefix}${stamp}/${result.label}.db`;
    await putObject(key, fs.readFileSync(result.file), 'application/x-sqlite3');
    uploaded.push(key);
  }
  return uploaded;
}

/**
 * Runs one full backup: snapshot every database, verify each, upload if a
 * destination is configured, prune old local folders.
 *
 * Never throws — a failed backup must not take the server down with it. The
 * outcome is returned and logged loudly enough to notice.
 */
export async function runBackup({ quiet = false } = {}) {
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rootDir = config.backup.dir;
  const destDir = path.join(rootDir, stamp);
  fs.mkdirSync(destDir, { recursive: true });

  const results = [];
  const errors = [];

  const take = (label, file) => {
    try {
      const result = snapshot(label, file, destDir);
      results.push(result);
      if (result.skipped) log(`  skip ${label}: ${result.skipped}`);
      else log(`  ${label}: ${result.rows} rows in ${result.tables} tables, ${result.bytes} bytes — verified`);
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      console.error(`  FAILED ${label}: ${err.message}`);
    }
  };

  log(`Backup ${stamp} -> ${destDir}`);
  take('platform', config.platformDbFile);
  take('default', config.dbFile);

  let tenants = [];
  try {
    tenants = listTenants();
  } catch (err) {
    // No registry yet (single-gym install) is normal, not a failure.
    log(`  no tenant registry: ${err.message}`);
  }
  for (const tenant of tenants) take(tenant.slug, tenantDbPath(tenant.slug));

  let uploaded = [];
  if (s3Configured()) {
    try {
      uploaded = await upload(results, stamp);
      log(`  uploaded ${uploaded.length} file(s) off-site`);
    } catch (err) {
      errors.push(`upload: ${err.message}`);
      console.error(`  FAILED upload: ${err.message}`);
    }
  } else {
    log('  off-site upload not configured — these snapshots live on this machine only');
  }

  let pruned = [];
  try {
    pruned = prune(rootDir, config.backup.keep);
    if (pruned.length) log(`  pruned ${pruned.length} old backup folder(s)`);
  } catch (err) {
    errors.push(`prune: ${err.message}`);
  }

  const summary = {
    stamp,
    dir: destDir,
    databases: results.filter((r) => r.file).length,
    skipped: results.filter((r) => r.skipped).length,
    uploaded: uploaded.length,
    pruned: pruned.length,
    errors,
    offsite: s3Configured(),
  };

  if (errors.length) console.error(`Backup ${stamp} finished with ${errors.length} problem(s)`);
  else log(`Backup ${stamp} OK`);

  return summary;
}

/**
 * Starts the in-process backup timer, or returns null when disabled.
 *
 * An in-process timer is only trustworthy because fly.toml now keeps a machine
 * running; under the old `auto_stop_machines = "suspend"` it would never have
 * fired. Set BACKUP_INTERVAL_HOURS=0 to turn it off and drive
 * scripts/backup.js from an external scheduler instead.
 */
export function startBackupSchedule() {
  const hours = config.backup.intervalHours;
  if (!hours || hours <= 0) return null;

  const intervalMs = hours * 60 * 60 * 1000;
  const tick = () => {
    runBackup({ quiet: true }).catch((err) => console.error('Scheduled backup failed:', err));
  };

  // Not immediately on boot: a crash-loop would otherwise spend its whole life
  // taking backups. Five minutes in is late enough to be past startup and early
  // enough that a short-lived deployment still gets one.
  const first = setTimeout(tick, 5 * 60_000);
  const repeat = setInterval(tick, intervalMs);
  console.log(`Automatic backups every ${hours}h into ${config.backup.dir}`);

  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

/** Releases the registry handle the backup opened. For the CLI entry point;
 * the server keeps its own handles. */
export function closeBackupHandles() {
  closeRegistryDb();
}
