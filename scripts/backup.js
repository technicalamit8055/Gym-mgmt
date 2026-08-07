/**
 * Takes a backup now, from the command line.
 *
 * The server also runs this on a timer (see startBackupSchedule in
 * src/backup.js). This entry point stays for taking one on demand — before a
 * migration, before a deploy — and for driving backups from an external
 * scheduler instead, with BACKUP_INTERVAL_HOURS=0.
 *
 *   node scripts/backup.js
 *
 * Snapshots the platform registry and every tenant with VACUUM INTO (safe
 * against a live server), reopens each snapshot to verify it, uploads them if
 * BACKUP_S3_* is configured, and prunes old local folders.
 *
 * Restore: stop the server, copy the wanted file back over the original path
 * (e.g. data/tenants/acme.db), delete any stale -wal/-shm alongside it, start
 * the server again.
 */
import { closeBackupHandles, runBackup } from '../src/backup.js';

const summary = await runBackup();
closeBackupHandles();

if (!summary.offsite) {
  console.log(
    '\nThese snapshots are on the same machine as the live databases. Set BACKUP_S3_BUCKET,\n' +
      'BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY to copy them\n' +
      'off-site — see the README.',
  );
}

// Non-zero on failure so a cron job or CI step actually notices.
process.exit(summary.errors.length ? 1 : 0);
