import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createTokenStore } from '../src/tokenStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-token-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Stands in for Electron's safeStorage: a reversible scramble tied to a "machine". */
const fakeSafeStorage = (machine = 'board-1', available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`${machine}:${Buffer.from(text).toString('hex')}`),
  decryptString: (sealed) => {
    const [owner, hex] = sealed.toString().split(':');
    if (owner !== machine) throw new Error('Cannot decrypt on this machine');
    return Buffer.from(hex, 'hex').toString();
  },
});

const TOKEN = 'cbs_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('the board’s key on disk', () => {
  it('stores the token sealed, never as itself', () => {
    const file = path.join(dir, 'key-1.json');
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage() });
    store.save(TOKEN);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN), 'the file does not contain the token');
    assert.equal(store.load(), TOKEN);
  });

  it('cannot be opened by another machine or account', () => {
    const file = path.join(dir, 'key-2.json');
    createTokenStore({ file, safeStorage: fakeSafeStorage('board-1') }).save(TOKEN);
    assert.equal(createTokenStore({ file, safeStorage: fakeSafeStorage('stolen-laptop') }).load(), null);
  });

  it('refuses to store anything when the OS cannot encrypt', () => {
    const file = path.join(dir, 'key-3.json');
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage('board-1', false) });
    assert.throws(() => store.save(TOKEN), /cannot encrypt/);
    assert.equal(fs.existsSync(file), false);
  });

  it('forgets the token on unpairing, and copes with no file at all', () => {
    const file = path.join(dir, 'key-4.json');
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage() });
    assert.equal(store.load(), null);
    store.save(TOKEN);
    store.clear();
    assert.equal(store.load(), null);
    assert.equal(fs.existsSync(file), false);
  });
});
