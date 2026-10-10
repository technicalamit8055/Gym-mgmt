# Strategic Plan: Zero-Cost Gym SaaS + Member Fitness Add-on & In-App Supplement Store

## 1. Executive Summary & Core Philosophy

### 1.1 The Market Opportunity
Selling gym software in India via traditional B2B SaaS (₹1,500 – ₹3,000/month) faces severe friction:
- Gym owners are price-conscious and delay or default on software subscriptions.
- SaaS fees are seen as an overhead expense.
- Acquisition costs are high, and annual churn is significant.

### 1.2 The Disruptive Business Model
1. **Give Gymbook 100% FREE to Gyms Forever**:
   - Zero software fees for gym owners.
   - Includes full gym management: attendance (QR & biometric), WhatsApp billing/receipts, member CRM, and staff management.
   - **Sales friction is eradicated**: *"Software is free for you."*

2. **Monetize via End-User Fitness Micro-Subscriptions (Hybrid Add-on)**:
   - Diet and Workout Tracker in the Member App is monetized at a micro-subscription rate of **₹79 / month**, **₹199 / 3 months**, or **₹349 / 6 months**.
   - **Hybrid Distribution**:
     - **Direct In-App UPI**: Members can unlock trackers instantly with 1-tap UPI.
     - **Gym Bundling**: Gyms can bundle the add-on into member membership plans at billing.
     - **Gym Commission Share**: The gym earns a recurring **25% commission** (~₹20/month per active member) on all subscriptions. Gym owners and personal trainers become active promoters instead of software buyers.

3. **In-App Store (Supplements & Gym Kits)**:
   - Members can purchase 100% authentic supplements (Whey Protein, Creatine, Pre-workout, Multivitamins) and gym gear (belts, straps, shakers) directly inside the Member App.
   - **Centralized Sourcing & Doorstep Delivery**: Sourced from authorized brand distributors, verified for authenticity, and fulfilled via courier (Shiprocket / Delhivery) directly to the member's doorstep.
   - **Gym Owner Affiliate Cut**: The gym owner earns **7.5% – 10% commission** on every store order placed by their members.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               THE GROWTH & REVENUE ENGINE                              │
│                                                                                        │
│     Gym Owner gets FREE SaaS  ──────────────►  Zero-friction Gym Acquisition           │
│                ▲                                              │                        │
│                │                                              ▼                        │
│     Gym earns 25% Add-on Cut +                Hundreds of active members get           │
│     7.5-10% Store Commissions                 Member App (PWA) with digital pass       │
│                ▲                                              │                        │
│                │                                              ▼                        │
│     High Recurring Revenue    ◄─────────────  Members purchase:                        │
│     + High Store GMV                          1. Diet & Workout Add-on (UPI/Bundle)    │
│                                               2. Authentic Supplements & Gear          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Unit Economics & Revenue Projections

### 2.1 Gym Revenue Breakdown (Example Gym with 150 Active Members)

| Revenue Stream | Member Uptake | Member Price | Platform Revenue | Gym Partner Commission |
| :--- | :--- | :--- | :--- | :--- |
| **Fitness Add-on** | 45% (68 members) | ₹79 / month | ₹5,372 / mo | ₹1,343 / mo (25%) |
| **Supplement & Gear Store** | 15% (23 orders/mo) | ₹2,200 avg order | ₹50,600 GMV / mo (~₹7,590 gross margin @ 15%) | ₹3,795 / mo (7.5%) |
| **Total Monthly Realization** | — | — | **~₹9,167 / month** | **₹5,138 / month (Passive Income)** |

> [!TIP]
> **Why this wins over traditional SaaS**:
> - Traditional SaaS makes **₹1,500/month** per gym and constantly risks churn.
> - This model makes **₹9,000+/month** per gym, and the gym owner earns **₹5,000+/month** instead of paying a software bill!

---

## 3. Product Features & User Flows

### 3.1 Member App (Portal) Store Experience

1. **New "Store" Tab**:
   - Placed in the Member Portal navigation alongside Home, Workout, Diet, and Profile.
   - **Header Highlights**: "100% Authentic Guarantee", "Direct Brand Sourcing", "Fast Doorstep Delivery".
   - **Category Filters**: All, Whey Protein, Creatine, Pre-Workout, Gym Gear & Accessories, Vitamins.
   - **Curated Catalog**: Top essential items displayed in high-resolution, dark-mode cards with authentic batch badges, MRP, discounted price, and quick "Buy Now".

2. **Product Details & Variant Selector**:
   - Flavor picker (e.g. Rich Chocolate, Café Mocha, Cookies & Cream).
   - Size/Weight selector (e.g. 1 kg / 2 kg tub, 100g / 250g jar).
   - Nutritional breakdown per scoop (Protein, Carbs, BCAAs).
   - Verified Lab-Test report viewer link.

3. **1-Tap Checkout Flow**:
   - Shipping address pre-filled from member profile (editable).
   - Razorpay UPI Intent payment modal (PhonePe, Google Pay, Paytm, CRED).
   - Order confirmation with instant WhatsApp receipt & tracking link.

4. **Order Tracking**:
   - View active orders under `Store > My Orders`.
   - Real-time milestone tracker: `Placed → Packed → In Transit → Delivered`.

---

### 3.2 Member App Fitness Add-on (Food & Workout Tracker) Paywall Update

1. **Instant UPI In-App Upgrade**:
   - Replace the static *"Ask the front desk"* message on the paywall with immediate digital checkout options:
     - **Monthly**: ₹79 / month
     - **Quarterly (Most Popular)**: ₹199 / 3 months *(Save 16%)*
     - **Half-Yearly**: ₹349 / 6 months *(Save 26%)*
   - Tapping "Unlock Now" opens Razorpay UPI checkout.
   - Upon successful payment, webhook instantly activates the member's fitness entitlement. No staff intervention required.

2. **Gym-Managed Bundles**:
   - The front desk can still activate or bundle the add-on into membership fees via `fitnessAddonRoutes.post('/subscribe')`.
   - If the gym bundles it, the gym takes payment at the desk and platform logs entitlement directly.

---

### 3.3 Gym Owner Console: "Store & Commissions" Hub

Located in the staff dashboard under **Billing & Earnings**:
- **Live Metrics**:
  - Total active fitness add-on subscribers.
  - Total store GMV ordered by their members this month.
  - Accrued commissions ready for payout.
- **Member Order Ledger**:
  - Anonymized / transparent log of member purchases with commission breakdown.
- **Monthly Payout Settlements**:
  - Automated or manual monthly bank payout transfer (IMPS/NEFT) via Razorpay Route or direct bank settlement.

---

## 4. Technical Architecture & Data Model

### 4.1 Database Schema Extensions (SQLite)

```sql
-- 1. Store Product Catalog
CREATE TABLE IF NOT EXISTS store_products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL,
  brand               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('protein', 'creatine', 'preworkout', 'vitamins', 'gear', 'merch')),
  description         TEXT,
  nutrition_info      TEXT, -- JSON: calories, protein_g, carbs_g, fat_g, servings
  image_urls          TEXT NOT NULL, -- JSON array of image URLs
  mrp                 REAL NOT NULL,
  price               REAL NOT NULL,
  gym_commission_pct  REAL DEFAULT 7.5,
  is_active           INTEGER DEFAULT 1,
  featured            INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now'))
);

-- 2. Product Variants (Flavors, Sizes, Colors)
CREATE TABLE IF NOT EXISTS store_product_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  variant_name    TEXT NOT NULL, -- e.g. "Double Chocolate 1kg"
  sku             TEXT UNIQUE,
  flavor          TEXT,
  weight_or_size  TEXT,
  price_override  REAL,
  stock_quantity  INTEGER DEFAULT 100,
  is_active       INTEGER DEFAULT 1
);

-- 3. Member Store Orders
CREATE TABLE IF NOT EXISTS store_orders (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code           TEXT UNIQUE NOT NULL, -- e.g. "ORD-202610-8X9Y"
  tenant_id            INTEGER NOT NULL REFERENCES tenants(id),
  member_id            INTEGER NOT NULL REFERENCES members(id),
  total_amount         REAL NOT NULL,
  discount_amount      REAL DEFAULT 0,
  shipping_fee         REAL DEFAULT 0,
  payment_status       TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  payment_method       TEXT DEFAULT 'razorpay_upi',
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  shipping_name        TEXT NOT NULL,
  shipping_phone       TEXT NOT NULL,
  shipping_address     TEXT NOT NULL, -- Full street address, city, state, pincode
  fulfillment_status   TEXT DEFAULT 'placed' CHECK (fulfillment_status IN ('placed', 'packed', 'shipped', 'delivered', 'cancelled')),
  courier_name         TEXT,
  tracking_id          TEXT,
  tracking_url         TEXT,
  gym_commission_total REAL DEFAULT 0,
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now'))
);

-- 4. Order Line Items
CREATE TABLE IF NOT EXISTS store_order_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  product_id            INTEGER NOT NULL REFERENCES store_products(id),
  variant_id            INTEGER REFERENCES store_product_variants(id),
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  unit_price            REAL NOT NULL,
  unit_mrp              REAL NOT NULL,
  gym_commission_amount REAL DEFAULT 0
);

-- 5. Gym Commissions Ledger
CREATE TABLE IF NOT EXISTS gym_commissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  source_type   TEXT NOT NULL CHECK (source_type IN ('fitness_addon', 'store_order')),
  source_id     INTEGER NOT NULL, -- References store_orders(id) or member_fitness_addons(id)
  amount        REAL NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  payout_ref    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

### 4.2 API Endpoint Architecture

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/portal/store/products` | Browse catalog, category filters, featured items |
| `GET` | `/api/portal/store/products/:id` | Full product view with variants, nutrition facts, lab report |
| `POST` | `/api/portal/store/checkout` | Create Razorpay order for member cart, calculate gym commission |
| `POST` | `/api/portal/store/verify-payment` | Verify Razorpay HMAC signature and confirm order |
| `GET` | `/api/portal/store/orders` | Member's order history and delivery tracking |
| `POST` | `/api/portal/fitness-addon/checkout` | Create Razorpay order for instant add-on tier (1mo / 3mo / 6mo) |
| `POST` | `/api/portal/fitness-addon/verify` | Verify payment, grant entitlement, credit gym 25% commission |
| `GET` | `/api/billing/commissions` | Gym owner commission earnings statement & ledger |

---

## 5. Execution Roadmap

### Phase 1: Fitness Add-on Direct UPI Upgrade & Commission Engine
- [ ] Add direct Razorpay UPI payment integration to Member Portal paywall (`upgradeSheet`).
- [ ] Support 1-month (₹79), 3-month (₹199), and 6-month (₹349) plans.
- [ ] Automatically calculate and record 25% gym commission in `gym_commissions` on every member purchase.

### Phase 2: In-App Store Backend & Database
- [ ] Add SQLite tables for `store_products`, `store_product_variants`, `store_orders`, `store_order_items`, and `gym_commissions`.
- [ ] Seed curated initial catalog (Whey Protein, Creatine, Pre-workout, Shakers, Lifting Straps).
- [ ] Build `/api/portal/store/*` routes for catalog browsing, cart checkout, and Razorpay payment verification.

### Phase 3: In-App Store Frontend (Member App Experience)
- [ ] Add "Store" tab to Member Portal navigation.
- [ ] Design sleek product showcase cards, category filters, and variant selectors with dark-mode aesthetic.
- [ ] Build 1-tap Razorpay UPI modal and live order tracking screen.

### Phase 4: Gym Owner Commission Hub & Fulfillment Operations
- [ ] Build "Store & Earnings" dashboard tab for gym owners.
- [ ] Set up automated Shiprocket / Delhivery courier webhook tracking.
- [ ] Implement monthly commission payout reporting.
