import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-memberdocs-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let token;
let studentId;

const call = async (method, urlPath, body, { useToken = token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// A minimal but genuine 1x1 JPEG, base64-encoded, so the mime-sniff-free
// data-URL parser has real bytes to accept.
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
const TINY_PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsO4CjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2Jq';
const SVG_PAYLOAD = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await call(
    'POST',
    '/api/platform/signup',
    {
      slug: 'focus-hall',
      gym_name: 'Focus Study Hall',
      admin_name: 'Priya Rao',
      admin_email: 'owner@focus-hall.test',
      admin_password: 'strongpass123',
      currency: 'INR',
      business_type: 'library',
    },
    { useToken: null },
  );
  assert.equal(signup.status, 201);
  token = signup.body.token;
  base = `${base}/g/focus-hall`;

  const student = await call('POST', '/api/members', { first_name: 'Documented' });
  studentId = student.body.id;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('uploading ID proof', () => {
  it('accepts a JPEG and a PDF, rejects SVG and stays under the size cap', async () => {
    const jpeg = await call('POST', '/api/member-documents', {
      member_id: studentId,
      kind: 'aadhaar_front',
      file: TINY_JPEG,
    });
    assert.equal(jpeg.status, 201);

    const pdf = await call('POST', '/api/member-documents', {
      member_id: studentId,
      kind: 'college_id',
      file: TINY_PDF,
    });
    assert.equal(pdf.status, 201);

    const svg = await call('POST', '/api/member-documents', {
      member_id: studentId,
      kind: 'other',
      file: SVG_PAYLOAD,
    });
    assert.equal(svg.status, 400);

    const tooBig = await call('POST', '/api/member-documents', {
      member_id: studentId,
      kind: 'other',
      file: `data:image/jpeg;base64,${Buffer.alloc(3 * 1024 * 1024, 1).toString('base64')}`,
    });
    assert.equal(tooBig.status, 400);
  });

  it('lists documents for a member, without embedding the bytes', async () => {
    const res = await call('GET', `/api/member-documents?member_id=${studentId}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 2);
    for (const doc of res.body.items) {
      assert.equal(doc.bytes, undefined);
      assert.ok(doc.file_url);
    }
  });

  it('marks a document verified', async () => {
    const list = await call('GET', `/api/member-documents?member_id=${studentId}`);
    const doc = list.body.items[0];
    const verified = await call('POST', `/api/member-documents/${doc.id}/verify`);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.verified, 1);
  });
});

describe('serving the file over a signed URL', () => {
  it('serves the bytes with a valid signature, no-store, and 401s a tampered one', async () => {
    const list = await call('GET', `/api/member-documents?member_id=${studentId}`);
    const doc = list.body.items[0];
    const url = new URL(doc.file_url, base);

    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'private, no-store');

    const tamperedSig = new URL(url);
    tamperedSig.searchParams.set('s', 'not-the-right-signature');
    const bad = await fetch(tamperedSig);
    assert.equal(bad.status, 401);

    const tamperedExpiry = new URL(url);
    tamperedExpiry.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 10));
    const expired = await fetch(tamperedExpiry);
    assert.equal(expired.status, 401);
  });

  it('does not resolve a document id that belongs to a different tenant', async () => {
    const signup = await call(
      'POST',
      '/api/platform/signup',
      {
        slug: 'other-hall',
        gym_name: 'Other Hall',
        admin_name: 'Someone Else',
        admin_email: 'owner@other-hall.test',
        admin_password: 'strongpass123',
        currency: 'INR',
        business_type: 'library',
      },
      { useToken: null },
    );
    const otherBase = base.replace('/g/focus-hall', '/g/other-hall');
    const otherStudent = await fetch(`${otherBase}/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signup.body.token}` },
      body: JSON.stringify({ first_name: 'Elsewhere' }),
    }).then((r) => r.json());
    const otherDoc = await fetch(`${otherBase}/api/member-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signup.body.token}` },
      body: JSON.stringify({ member_id: otherStudent.id, kind: 'other', file: TINY_JPEG }),
    }).then((r) => r.json());

    // The same document id and expiry, resolved under focus-hall's own tenant
    // prefix instead of other-hall's — the signature was minted with
    // "other-hall" baked into it, so it must not verify here even though the
    // numeric id and query string are otherwise identical.
    const crossTenantUrl = new URL(otherDoc.file_url.replace('/g/other-hall', '/g/focus-hall'), base);
    const res = await fetch(crossTenantUrl);
    assert.equal(res.status, 401);
  });
});

describe('the documents module does not leak into a gym', () => {
  it('404s /api/member-documents for a gym tenant', async () => {
    const signup = await call(
      'POST',
      '/api/platform/signup',
      {
        slug: 'iron-house',
        gym_name: 'Iron House',
        admin_name: 'Amit',
        admin_email: 'owner@iron-house.test',
        admin_password: 'strongpass123',
        currency: 'INR',
      },
      { useToken: null },
    );
    const gymBase = base.replace('/g/focus-hall', '/g/iron-house');
    const res = await fetch(`${gymBase}/api/member-documents`, { headers: { Authorization: `Bearer ${signup.body.token}` } });
    assert.equal(res.status, 404);
  });
});
