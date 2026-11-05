/**
 * Makes the Cloudflare Stream signing key CoachBook signs each student's
 * private class link with (src/coaching/privateStream.js), and prints the
 * two lines to add to .env. Cloudflare shows the key once, so run it once.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN in .env first.
 *
 * Usage: npm run stream:key
 */
import { config } from '../src/config.js';

const { accountId, apiToken } = config.cloudflareStream;
if (!accountId || !apiToken) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN in .env first (docs/PRIVATE_STREAMING.md).');
  process.exit(1);
}

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/keys`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiToken}` },
});
const body = await res.json().catch(() => null);
if (!res.ok || !body?.success) {
  console.error(`Cloudflare refused (${res.status}):`, body?.errors?.map((e) => e.message).join('; ') || 'no reason given');
  process.exit(1);
}

console.log('Add these to .env, then restart the server:\n');
console.log(`CLOUDFLARE_STREAM_KEY_ID=${body.result.id}`);
console.log(`CLOUDFLARE_STREAM_KEY_PEM=${body.result.pem}`);
