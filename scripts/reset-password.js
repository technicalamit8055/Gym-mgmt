/**
 * Last-resort password recovery, for whoever has shell access to the server.
 *
 * The operator console can issue reset links for any gym, but that console only
 * exists when PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are set — and a
 * single-gym self-hosted install typically has neither. This covers that case,
 * and covers losing the operator password itself.
 *
 *   node scripts/reset-password.js                     # the default gym's owner
 *   node scripts/reset-password.js --gym acme          # a specific tenant
 *   node scripts/reset-password.js --gym acme --email owner@acme.com
 *   node scripts/reset-password.js --gym acme --password 'new-password'
 *
 * With --password it sets the password directly. Without, it prints a one-hour
 * single-use reset link to hand to the owner, which is the better option when
 * you should not know their password.
 */
import { config } from '../src/config.js';
import { closeDb, tenantStorage } from '../src/db.js';
import { defaultResetTarget, issuePasswordReset } from '../src/passwordReset.js';
import { hashPassword } from '../src/auth.js';
import { get, run } from '../src/db.js';
import { closeRegistryDb, findTenantBySlug, tenantDbPath } from '../src/tenants.js';

/** `--gym acme --help` -> `{ gym: 'acme', help: true }`. A flag with nothing
 * after it, or followed by another flag, is a bare switch. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const next = argv[i + 1];
    args[flag.slice(2)] = next === undefined || next.startsWith('--') ? true : next;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      'Usage: node scripts/reset-password.js [options]',
      '',
      '  --gym <slug>        Which gym. Omit for the default/single-gym database.',
      '  --email <address>   Which staff account. Omit for the gym owner (oldest admin).',
      '  --password <value>  Set this password directly instead of printing a link.',
      '',
      'Stop the server first if it is running, so it picks up the change on restart.',
    ].join('\n'),
  );
  process.exit(0);
}

function resolveScope() {
  if (!args.gym || args.gym === true) {
    return { slug: 'default', dbFile: config.dbFile, label: `default database (${config.dbFile})` };
  }
  const tenant = findTenantBySlug(String(args.gym));
  if (!tenant) {
    console.error(`No gym registered with the address "${args.gym}".`);
    process.exit(1);
  }
  return {
    slug: tenant.slug,
    dbFile: tenantDbPath(tenant.slug),
    timezone: tenant.timezone || undefined,
    label: `gym "${tenant.slug}"`,
  };
}

const scope = resolveScope();

try {
  tenantStorage.run(scope, () => {
    const email = args.email && args.email !== true ? String(args.email).toLowerCase() : null;

    if (args.password && args.password !== true) {
      const password = String(args.password);
      if (password.length < 8) {
        console.error('That password is too short — use at least 8 characters.');
        process.exit(1);
      }

      const user = email
        ? get('SELECT id, name, email FROM users WHERE email = ? AND active = 1', [email])
        : defaultResetTarget();
      if (!user) {
        console.error(email ? `No active account for ${email}.` : 'No active admin account found.');
        process.exit(1);
      }

      run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
      // Any outstanding reset link for this account is now moot.
      run('DELETE FROM password_resets WHERE user_id = ?', [user.id]);
      console.log(`Password set for ${user.email} (${user.name}) in ${scope.label}.`);
      return;
    }

    const issued = issuePasswordReset(email);
    const path = scope.slug === 'default' ? '/#/reset' : `/g/${scope.slug}/#/reset`;
    console.log(`Reset link for ${issued.email} (${issued.name}) in ${scope.label}:`);
    console.log('');
    console.log(`  <your-app-url>${path}?token=${issued.token}`);
    console.log('');
    console.log(`Single use, valid for ${issued.expires_in_minutes} minutes (until ${issued.expires_at} UTC).`);
  });
} finally {
  closeDb();
  closeRegistryDb();
}
