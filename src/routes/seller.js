import express, { Router } from 'express';
import { readToken } from '../auth.js';
import { config } from '../config.js';
import { badRequest, tooManyRequests, unauthorized } from '../errors.js';
import {
  FULFILLMENT_STATUSES,
  MAX_STORE_IMAGE_BYTES,
  addProductImage,
  createStoreProduct,
  deleteProductImage,
  deleteStoreProduct,
  listStoreOrders,
  listStoreProducts,
  makeProductImagePrimary,
  storeCategoriesFor,
  storeSettings,
  updateStoreOrder,
  updateStoreProduct,
} from '../monetization.js';
import { lookupStoreBarcode } from '../productBarcode.js';
import { createLimiter } from '../rateLimit.js';
import {
  changeSellerPassword,
  getSeller,
  sellerFromClaims,
  sellerLogin,
  sellerPayoutHistory,
  updateSellerProfile,
} from '../sellers.js';

/**
 * The Shop panel's API — what a partner supplement shop signs in to. Its own
 * token scope ('seller'), so nothing here is reachable with a gym, member or
 * operator token, and a shop token reaches nothing else. Every query below is
 * pinned to `req.seller.id`: a shop only ever sees its own shelf and orders.
 */
export const sellerRoutes = Router();

const loginLimiter = createLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
  lockoutMs: config.loginLockoutMs,
});

sellerRoutes.post('/login', (req, res) => {
  const gate = loginLimiter.check(req.ip);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many failed attempts. Try again later.');
  }
  loginLimiter.recordAttempt(req.ip);
  const result = sellerLogin(req.body);
  loginLimiter.recordSuccess(req.ip);
  res.json(result);
});

function requireSeller(req, _res, next) {
  const header = req.get('authorization') || '';
  const claims = readToken(header.startsWith('Bearer ') ? header.slice(7) : header);
  if (!claims || claims.scope !== 'seller') return next(unauthorized('Your session has expired, please sign in again'));
  const { seller, error } = sellerFromClaims(claims);
  if (error) return next(error);
  req.seller = seller;
  return next();
}

sellerRoutes.use(requireSeller);

const sellerId = (req) => req.seller.id;

/* ── The shop itself ──────────────────────────────────────────────────── */

sellerRoutes.get('/me', (req, res) => {
  const seller = getSeller(sellerId(req));
  // The store this shop sells in — the gym store's settings, or the coaching one's.
  const settings = storeSettings(seller.vertical);
  res.json({
    seller,
    payouts: sellerPayoutHistory(sellerId(req)),
    store_status: settings.store_status,
    // This shop's own rates (a custom or switched-off gym cut, no fee for
    // the operator's own store) — the same ones its next order will carry.
    gym_commission_pct: seller.rates.gym_commission_pct,
    platform_fee_pct: seller.rates.platform_fee_pct,
    defaults: { delivery_eta: settings.delivery_eta, pickup_eta: settings.pickup_eta, pickup_enabled: Boolean(settings.pickup_enabled) },
    options: { categories: storeCategoriesFor(seller.vertical), fulfillment_statuses: FULFILLMENT_STATUSES },
  });
});

sellerRoutes.patch('/me', (req, res) => {
  res.json({ seller: updateSellerProfile(sellerId(req), req.body) });
});

sellerRoutes.post('/me/password', (req, res) => {
  res.json(changeSellerPassword(sellerId(req), req.body));
});

/* ── Its shelf ────────────────────────────────────────────────────────── */

sellerRoutes.get('/products', (req, res) => {
  const items = listStoreProducts({
    sellerId: sellerId(req),
    q: req.query.q ? String(req.query.q).trim() : undefined,
    category: req.query.category ? String(req.query.category) : undefined,
  });
  res.json({ items, total: items.length, categories: storeCategoriesFor(req.seller.vertical) });
});

/** A scanned pack: this shop's own product, or details to start a new one
 * from — never another shop's price (src/productBarcode.js). */
sellerRoutes.get('/barcode/:code', async (req, res) => {
  res.json(await lookupStoreBarcode(req.params.code, { sellerId: sellerId(req), vertical: req.seller.vertical }));
});

sellerRoutes.post('/products', (req, res) => {
  res.status(201).json(createStoreProduct(req.body, { sellerId: sellerId(req) }));
});

sellerRoutes.patch('/products/:id', (req, res) => {
  res.json(updateStoreProduct(Number(req.params.id), req.body, { sellerId: sellerId(req) }));
});

sellerRoutes.delete('/products/:id', (req, res) => {
  res.json(deleteStoreProduct(Number(req.params.id), { sellerId: sellerId(req) }));
});

const rawImage = express.raw({ type: () => true, limit: MAX_STORE_IMAGE_BYTES });

sellerRoutes.post('/products/:id/images', rawImage, (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the request body');
  res.status(201).json(addProductImage(Number(req.params.id), req.body, { sellerId: sellerId(req) }));
});

sellerRoutes.delete('/products/:id/images/:imageId', (req, res) => {
  res.json(deleteProductImage(Number(req.params.id), Number(req.params.imageId), { sellerId: sellerId(req) }));
});

sellerRoutes.post('/products/:id/images/:imageId/primary', (req, res) => {
  res.json(makeProductImagePrimary(Number(req.params.id), Number(req.params.imageId), { sellerId: sellerId(req) }));
});

/* ── Its orders ───────────────────────────────────────────────────────── */

sellerRoutes.get('/orders', (req, res) => {
  const items = listStoreOrders({
    sellerId: sellerId(req),
    status: req.query.status ? String(req.query.status) : undefined,
  });
  res.json({ items, total: items.length });
});

sellerRoutes.patch('/orders/:id', (req, res) => {
  res.json(updateStoreOrder(Number(req.params.id), req.body, { sellerId: sellerId(req) }));
});
