import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ROOT_DOMAIN = 'yourapp.fly.dev';

const { extractSlug } = await import('../src/tenant.js');

describe('extractSlug with ROOT_DOMAIN configured', () => {
  it('resolves the bare root domain to no tenant (default)', () => {
    assert.equal(extractSlug('yourapp.fly.dev'), null);
    assert.equal(extractSlug('YOURAPP.FLY.DEV'), null); // case-insensitive
  });

  it('resolves a subdomain of the root to its tenant slug', () => {
    assert.equal(extractSlug('acme.yourapp.fly.dev'), 'acme');
  });

  it('rejects a host that does not match the configured root at all', () => {
    assert.equal(extractSlug('acme.some-other-domain.com'), null);
  });

  it('rejects a nested subdomain (more than one label under the root)', () => {
    assert.equal(extractSlug('a.b.yourapp.fly.dev'), null);
  });

  it('rejects reserved or invalid slugs even when the root matches', () => {
    assert.equal(extractSlug('www.yourapp.fly.dev'), null);
    assert.equal(extractSlug('1invalid.yourapp.fly.dev'), null);
  });

  it('strips the port before matching', () => {
    assert.equal(extractSlug('acme.yourapp.fly.dev:3000'), 'acme');
  });
});
