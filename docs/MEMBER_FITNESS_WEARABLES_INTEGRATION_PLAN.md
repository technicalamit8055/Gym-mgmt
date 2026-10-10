# Product Concept & Architecture Plan: Wearables & Fitness Tracker Integration for Member PWA

## 1. Executive Summary & Problem Context

### 1.1 The Multi-Tenant Challenge
In a multi-tenant gym SaaS like **Gymbook / Seatbook**, every gym has its own branding, tenant database, and optional custom domain (e.g. `fitclub.com` or `gymbook.in/portal`).

Building separate native mobile apps for each individual gym and publishing them to the Google Play Store and Apple App Store is **unviable**:
* **Google Play Policy**: Demands 20 testers for 14 continuous days for any personal developer account before publishing.
* **Apple App Store Guideline 4.3 (Spam / Templating)**: Strictly bans publishing identical "cookie-cutter" or white-labeled clones under separate client accounts.
* **High Operational Overhead**: Managing separate builds, developer certificates, and store credentials for dozens or hundreds of gyms is impossible to maintain for a lean team.

### 1.2 The Solution
Deliver fitness tracker connectivity **100% inside the existing Member Web App / PWA** using **Cloud-to-Cloud OAuth 2.0**.
* **Zero app store publishing**: Runs seamlessly in the mobile browser or as an installed PWA.
* **Single platform integration**: You set up **one** central OAuth client for your platform. All gyms and all members authenticate through this single pipe.
* **Zero additional cost**: Connects to free public REST APIs (Google Fit, Fitbit, Strava).

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        CLOUD-TO-CLOUD WEARABLE INTEGRATION FLOW                        │
│                                                                                        │
│   ┌───────────────────────────┐           ┌──────────────────────────────────────┐     │
│   │ Member Web App / PWA      │           │ Google / Fitbit / Strava OAuth       │     │
│   │ (Any Gym's Tenant URL)    │           │ (Member Authorizes Cloud Access)     │     │
│   │ [ Connect Google Fit ]    │──────────►│ accounts.google.com / fitbit.com     │     │
│   └───────────────────────────┘           └──────────────────┬───────────────────┘     │
│                 ▲                                            │                         │
│                 │ (Redirect back with code)                  │ (Grant Auth Code)       │
│                 │                                            ▼                         │
│   ┌─────────────┴────────────────────────────────────────────────────────────────┐     │
│   │ Gymbook Central Backend API Server                                           │     │
│   │ - Stores refresh tokens securely per member                                  │     │
│   │ - Scheduled sync or instant refresh on Member App open                       │     │
│   └──────────────────────────────┬───────────────────────────────────────────────┘     │
│                                  │                                                     │
│                                  ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────────────────┐     │
│   │ Fitness Provider REST APIs                                                   │     │
│   │ (Google Fitness API / Fitbit Web API / Strava API)                           │     │
│   │ Returns: Daily Steps, Active Calories, Distance, Cardio Workouts             │     │
│   └──────────────────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Supported Fitness Providers & Strategy Matrix

| Provider | Data Captured | Sync Reliability | Member Barrier | Platform Cost | Recommended Priority |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Google Fit (REST API)** | Steps, Active Calories, Move Minutes, Heart Points | High (Cloud API) | Very Low (most Android & WearOS users already have a Google account) | **Free** | **Phase 1 (Primary)** |
| **Fitbit Web API** | Steps, Active Calories, Resting Heart Rate, Sleep, Workouts | Very High (Reliable REST endpoints) | Low (Fitbit, Pixel Watch, or free Fitbit app users) | **Free** | **Phase 1 (Primary)** |
| **Strava API** | Running, Cycling, Outdoor Cardio, GPS Routes, Gym Workouts | Very High (Instant Webhooks) | Low (Popular among fitness enthusiasts & runners) | **Free** | **Phase 2** |
| **Apple Health** | Steps, Active Energy, Workouts | ⚠️ *No native Web API* | Locked inside iOS; Requires bridge via Google Fit / Strava / Fitbit | **Free** | Handled via Bridge (See §2.1) |

### 2.1 The Apple Health Strategy (For iPhone Users)
Apple explicitly blocks web applications from reading on-device HealthKit data. To support iPhone users on the Member Web App without building a native iOS app:
1. **Google Fit on iOS**: iPhone users can install the free Google Fit app, which reads steps and calories from Apple Health and syncs them to Google Cloud.
2. **Strava on iOS**: iPhone users sync Apple Health workouts to Strava, which automatically syncs to Gymbook.
3. In the Member App UI, provide a friendly helper tip:
   > *"Using an iPhone? Connect your Apple Health to Google Fit or Strava, and your daily steps and cardio will sync here automatically."*

---

## 3. Product Features & User Experience (UX)

### 3.1 Member Portal Experience (Phone-First UI)

#### A. "Connected Devices & Apps" Settings Card
Located inside the Member Portal **Profile** or **Workout** tab:
* **Connection Status Badges**:
  * `Google Fit` ── `[ Connect ]` (or `[ Connected • Synced 15m ago ]`)
  * `Fitbit` ── `[ Connect ]`
  * `Strava` ── `[ Connect ]`
* **Sync Button**: A manual `"Sync Now"` icon button with an auto-spin animation to pull the latest steps on demand.
* **Disconnect Option**: Ability to revoke permissions and delete stored tokens anytime.

#### B. Today's Daily Activity Widget (Home & Workout Tabs)
On the member dashboard, display an interactive summary card:
* **Step Tracker Ring**: Daily steps visual ring (e.g. `8,420 / 10,000 steps` with completion percentage).
* **Active Calorie Burn**: Integrates with the existing Diet Tracker!
  * `Intake (Diet Log): 2,100 kcal` vs. `Active Burn (Wearables): 450 kcal` ➔ **Net Energy Balance**.
* **Cardio Sessions**: Outdoor runs or walks synced from Strava/Google Fit displayed directly alongside their logged gym weightlifting sets.

```
┌────────────────────────────────────────────────────────┐
│  🔥 Today's Activity                        Sync ↺     │
│                                                        │
│     ╭───────╮      👟 Steps: 8,420 / 10,000            │
│     │  84%  │      🔥 Active Burn: 420 kcal            │
│     ╰───────╯      ⏱️ Active Time: 48 mins             │
│                                                        │
│  Synced from Google Fit • Updated 12m ago              │
└────────────────────────────────────────────────────────┘
```

---

## 4. Gym Owner & Personal Trainer Value (SaaS Monetization)

Connecting wearables is not just a member convenience — it is a major value driver for gyms and the SaaS platform:

### 4.1 Enhanced Fitness Add-on Value
* Gyms currently sell or bundle the **Diet & Workout Add-on** (at ₹79/month or bundled into plans).
* Adding automated step counting and calorie sync makes the fitness add-on feel like a complete digital coach (similar to Cult.fit or HealthifyMe), driving higher member subscription conversion.

### 4.2 Trainer Visibility in Staff Console
* When a personal trainer or gym admin views a member's profile in the staff console, they see:
  * Weekly step averages and consistency.
  * Active calorie expenditure outside gym hours.
  * Trainers can give better diet advice based on real daily energy expenditure.

### 4.3 Gym Leaderboards & Gamification (Optional Engagement Feature)
* **"Step Challenge of the Week"**: Gyms can run internal monthly challenges (e.g. *"Walk 250,000 steps this month for 10% off membership renewal"*).
* Members opt-in to appear on the gym's internal leaderboard, driving community engagement and gym retention.

---

## 5. High-Level Technical Architecture

### 5.1 Centralized Multi-Tenant OAuth Model
Because members access the app through different gym URLs (`gym1.yourdomain.com`, `gym2.yourdomain.com`, or custom domains), the OAuth flow uses a **Central Callback Hub**:

1. **Initiation**:
   * Member taps **"Connect Google Fit"** in their gym portal.
   * Client sends request to `/api/portal/integrations/google-fit/auth-url`.
   * Server generates a secure Google OAuth URL containing a signed `state` token:
     ```json
     { "member_id": 142, "tenant_id": "ironhouse", "redirect_origin": "https://ironhouse.gymbook.in" }
     ```
2. **Consent & Callback**:
   * Member grants read permission on Google's consent screen.
   * Google redirects to the platform's central callback endpoint: `https://api.gymbook.in/api/integrations/google-fit/callback`.
3. **Token Storage**:
   * Central backend exchanges the `code` for an `access_token` and `refresh_token`.
   * Saves the tokens in the database tagged to `member_id`.
   * Redirects the user back to their specific gym domain (`redirect_origin/#/portal/profile`).

### 5.2 Conceptual Data Model

```sql
-- Tracks external fitness accounts connected by members
CREATE TABLE member_fitness_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                -- 'google_fit', 'fitbit', 'strava'
  provider_user_id TEXT,                 -- Unique user ID from the provider
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TEXT NOT NULL,
  scopes TEXT,                           -- Authorized scopes
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(member_id, provider)
);

-- Aggregated daily summary pulled from the wearable
CREATE TABLE member_daily_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  steps INTEGER DEFAULT 0,
  active_calories REAL DEFAULT 0,        -- kcal
  distance_meters REAL DEFAULT 0,
  active_minutes INTEGER DEFAULT 0,
  source TEXT NOT NULL,                  -- 'google_fit', 'fitbit', etc.
  synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(member_id, date)
);
```

### 5.3 Sync Mechanism
* **On-Demand Sync (Lazy Loading)**: When a member opens the portal or taps the "Sync" button, the frontend calls `/api/portal/integrations/sync`. If last sync was > 15 minutes ago, the backend fetches fresh numbers from the provider.
* **Lightweight Background Cron**: A scheduled job once every night to aggregate final end-of-day step counts for weekly summaries and leaderboards.

---

## 6. Phased Rollout Roadmap

### Phase 1: Foundation & Google Fit / Fitbit OAuth
* Create central Google Cloud & Fitbit developer apps with standard OAuth 2.0.
* Build database tables for connection tokens and daily activity aggregates.
* Implement the OAuth redirect and token exchange flow.
* Add "Connected Apps" card in the Member Portal settings.

### Phase 2: Daily Activity Display in Member PWA
* Fetch today's steps, active calories, and distance.
* Render the Step Ring and Active Calorie summary on the Member Home / Workout tab.
* Combine active calorie burn with the existing Diet/Meal Tracker to show net calorie balance.

### Phase 3: Strava Integration for Cardio Sessions
* Add Strava OAuth for members who do running, cycling, or outdoor sports.
* Pull completed cardio activities and list them under the member's Workout History.

### Phase 4: Trainer Insights & Gym Engagement
* Display member daily activity summary inside the staff console for trainers.
* Optional gym-level "Weekly Step Leaderboard" for member motivation.

---

## 7. Key Takeaways
1. **No native app stores needed**: Stays 100% inside your lightweight, fast PWA.
2. **Infinite scalability for white-label gyms**: A single OAuth application services all existing and future gyms effortlessly.
3. **Direct commercial uplift**: Increases member retention and reinforces the perceived value of the member fitness add-on subscription.
