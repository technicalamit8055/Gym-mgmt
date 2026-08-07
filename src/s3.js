import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * The smallest S3 client that can put an object, so backups can leave the
 * machine they were taken on.
 *
 * A local backup on the same Fly volume as the live database protects against
 * a bad UPDATE and nothing else — one volume failure and both are gone. Getting
 * the snapshot off the box is the entire point, and every S3-compatible store
 * (Cloudflare R2, Backblaze B2, MinIO, S3 itself) speaks this one call.
 *
 * Hand-rolled SigV4 rather than @aws-sdk/client-s3 because that pulls in
 * hundreds of packages, and this app's whole shape is three dependencies and no
 * build step. It is about sixty lines and only ever has to sign a PUT.
 */

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Uploads are disabled until every part of the destination is configured —
 * a half-filled config must not look like working off-site backups. */
export function s3Configured() {
  const { bucket, endpoint, accessKeyId, secretAccessKey } = config.backup.s3;
  return Boolean(bucket && endpoint && accessKeyId && secretAccessKey);
}

/** Each path segment is encoded, but the separators are not — S3 canonical
 * URIs keep `/` literal. */
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

/**
 * PUTs one object. Resolves on 2xx, throws with the response body otherwise so
 * a misconfigured bucket says why rather than failing silently.
 */
export async function putObject(key, body, contentType = 'application/octet-stream') {
  if (!s3Configured()) throw new Error('Off-site backup is not configured');

  const { bucket, endpoint, region, accessKeyId, secretAccessKey } = config.backup.s3;
  const url = new URL(endpoint);
  const host = url.host;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payloadHash = sha256Hex(payload);

  // Path-style addressing (bucket in the path, not the hostname): R2 and MinIO
  // both require it, and S3 still accepts it.
  const canonicalUri = `/${encodeURIComponent(bucket)}/${encodeKey(key)}`;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  // Signed headers must be lowercase and sorted; the values must match what is
  // actually sent, byte for byte.
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = ['aws4_request'].reduce(
    (key, part) => hmac(key, part),
    [region, 's3'].reduce(hmac, hmac(`AWS4${secretAccessKey}`, dateStamp)),
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(`${url.origin}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': contentType,
      'Content-Length': String(payload.length),
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upload of ${key} failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return `${url.origin}${canonicalUri}`;
}
