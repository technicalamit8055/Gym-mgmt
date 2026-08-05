import { Router } from 'express';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { requireAuth } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { config } from '../config.js';

export const biometricRoutes = Router();

/* ── WebAuthn Relying Party configuration ─────────────────────────────── */

// rpID must be one shared parent domain across every tenant's subdomain
// (WebAuthn allows a credential's RP ID to be a registrable parent of the
// origin that registered it) — it cannot vary per tenant.
const rpID = () => process.env.WEBAUTHN_RP_ID || 'localhost';

// origin, in contrast, must match the exact browser origin making the call,
// which differs per tenant subdomain — so it's computed per request rather
// than once at module load.
const originFor = (req) => process.env.WEBAUTHN_ORIGIN || `${req.protocol}://${req.get('host')}`;

// The display name shown to the authenticator (e.g. "Acme Gym") is per-tenant
// data, also computed per request rather than once at module load.
const rpNameFor = (req) => req.tenant?.gym_name || config.gymName || 'GymBook';

/* ── In-memory challenge store (per-session, short-lived) ─────────────── */

const challenges = new Map();

function storeChallenge(key, challenge) {
  challenges.set(key, { challenge, ts: Date.now() });
  // Purge entries older than 5 min
  for (const [k, v] of challenges) {
    if (Date.now() - v.ts > 5 * 60_000) challenges.delete(k);
  }
}

function consumeChallenge(key) {
  const entry = challenges.get(key);
  challenges.delete(key);
  return entry?.challenge;
}

/* ── Registration (staff-only) ────────────────────────────────────────── */

biometricRoutes.post('/register/options', requireAuth, async (req, res) => {
  const memberId = Number(req.body.member_id);
  const member = get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Member not found');

  // Gather existing credentials so the authenticator can exclude them
  const existing = all(
    'SELECT credential_id FROM biometric_credentials WHERE member_id = ?',
    [memberId],
  );

  const options = await generateRegistrationOptions({
    rpName: rpNameFor(req),
    rpID: rpID(),
    userName: member.code,
    userDisplayName: `${member.first_name} ${member.last_name}`.trim(),
    userID: new TextEncoder().encode(String(member.id)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  // Store the challenge keyed by a session token so we can verify later
  const sessionKey = `reg_${memberId}_${crypto.randomBytes(8).toString('hex')}`;
  storeChallenge(sessionKey, options.challenge);

  res.json({ options, sessionKey });
});

biometricRoutes.post('/register/verify', requireAuth, async (req, res) => {
  const { sessionKey, member_id, device_name, credential } = req.body;
  const memberId = Number(member_id);
  if (!sessionKey || !credential) throw badRequest('Missing session key or credential');

  const expectedChallenge = consumeChallenge(sessionKey);
  if (!expectedChallenge) throw badRequest('Challenge expired — please try again');

  const member = get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Member not found');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: originFor(req),
      expectedRPID: rpID(),
    });
  } catch (err) {
    throw badRequest(`Registration verification failed: ${err.message}`);
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('Biometric registration was not verified');
  }

  const { credential: regCredential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  run(
    `INSERT INTO biometric_credentials
       (member_id, credential_id, public_key, sign_count, device_type, backed_up, device_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      memberId,
      Buffer.from(regCredential.id).toString('base64url'),
      Buffer.from(regCredential.publicKey).toString('base64url'),
      regCredential.counter,
      credentialDeviceType || 'singleDevice',
      credentialBackedUp ? 1 : 0,
      device_name || null,
    ],
  );

  res.status(201).json({ verified: true });
});

/* ── Authentication (no staff login required) ─────────────────────────── */

biometricRoutes.post('/authenticate/options', async (_req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    userVerification: 'preferred',
  });

  const sessionKey = `auth_${crypto.randomBytes(12).toString('hex')}`;
  storeChallenge(sessionKey, options.challenge);

  res.json({ options, sessionKey });
});

biometricRoutes.post('/authenticate/verify', async (req, res) => {
  const { sessionKey, credential } = req.body;
  if (!sessionKey || !credential) throw badRequest('Missing session key or credential');

  const expectedChallenge = consumeChallenge(sessionKey);
  if (!expectedChallenge) throw badRequest('Challenge expired — please try again');

  // Look up the credential in the database
  const credIdB64 = credential.id; // base64url from browser
  const stored = get(
    'SELECT * FROM biometric_credentials WHERE credential_id = ?',
    [credIdB64],
  );
  if (!stored) throw badRequest('This biometric credential is not registered');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: originFor(req),
      expectedRPID: rpID(),
      credential: {
        id: stored.credential_id,
        publicKey: Buffer.from(stored.public_key, 'base64url'),
        counter: stored.sign_count,
      },
    });
  } catch (err) {
    throw badRequest(`Biometric verification failed: ${err.message}`);
  }

  if (!verification.verified) {
    throw badRequest('Biometric authentication was not verified');
  }

  // Update the sign count to prevent replay attacks
  run(
    'UPDATE biometric_credentials SET sign_count = ? WHERE id = ?',
    [verification.authenticationInfo.newCounter, stored.id],
  );

  // ── Perform the check-in (mirroring the attendance route logic) ──────

  const member = get('SELECT * FROM members WHERE id = ?', [stored.member_id]);
  if (!member) throw badRequest('The member associated with this biometric was not found');
  if (member.status === 'frozen') throw badRequest(`${member.first_name}'s membership is frozen`);
  if (member.status === 'inactive') throw badRequest(`${member.first_name}'s membership is inactive`);

  expireOverdueSubscriptions();
  const sub = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND date('now') BETWEEN start_date AND end_date ORDER BY end_date DESC LIMIT 1",
    [member.id],
  );
  if (!sub) throw badRequest(`${member.first_name} has no active membership — renew before checking in`);
  if (sub.sessions_total !== null && sub.sessions_used >= sub.sessions_total) {
    throw badRequest(`${member.first_name} has used all ${sub.sessions_total} sessions on this plan`);
  }

  const openVisit = get(
    "SELECT * FROM attendance WHERE member_id = ? AND check_out IS NULL AND date(check_in) = date('now')",
    [member.id],
  );

  const VISIT_SELECT = `
    SELECT a.*, m.code AS member_code, m.first_name, m.last_name, m.photo_url
    FROM attendance a JOIN members m ON m.id = a.member_id
  `;

  if (openVisit) {
    return res.status(200).json({
      already_in: true,
      visit: get(`${VISIT_SELECT} WHERE a.id = ?`, [openVisit.id]),
    });
  }

  const visitId = tx(() => {
    const info = run('INSERT INTO attendance (member_id, source) VALUES (?, ?)', [member.id, 'biometric']);
    if (sub.sessions_total !== null) {
      run('UPDATE subscriptions SET sessions_used = sessions_used + 1 WHERE id = ?', [sub.id]);
    }
    return info.lastInsertRowid;
  });

  return res.status(201).json({
    already_in: false,
    visit: get(`${VISIT_SELECT} WHERE a.id = ?`, [visitId]),
    membership: {
      plan_id: sub.plan_id,
      end_date: sub.end_date,
      sessions_total: sub.sessions_total,
      sessions_left: sub.sessions_total === null ? null : sub.sessions_total - (sub.sessions_used + 1),
    },
  });
});

/* ── Credential management (staff-only) ───────────────────────────────── */

biometricRoutes.get('/:memberId/credentials', requireAuth, (req, res) => {
  const memberId = Number(req.params.memberId);
  const items = all(
    'SELECT id, credential_id, device_type, device_name, created_at FROM biometric_credentials WHERE member_id = ? ORDER BY created_at DESC',
    [memberId],
  );
  res.json({ items });
});

biometricRoutes.delete('/:memberId/credentials/:id', requireAuth, (req, res) => {
  const memberId = Number(req.params.memberId);
  const id = Number(req.params.id);
  const info = run(
    'DELETE FROM biometric_credentials WHERE id = ? AND member_id = ?',
    [id, memberId],
  );
  if (!info.changes) throw notFound('Credential not found');
  res.json({ ok: true });
});
