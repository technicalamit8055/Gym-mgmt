# Task: Oracle Cloud Off-Site Database Backup (S3 Replication)

**Priority:** Backlog / When scaling live gyms  
**Status:** Deferred for later  
**Estimated Time to Complete:** 5–10 minutes  

---

## 1. Context & Objective
* **Current State:** The production Oracle Cloud VM is **already taking local database backups automatically every 24 hours** using SQLite's `VACUUM INTO` and keeping 14 days of history in `./backups/`.
* **Objective:** Mirror these backups off-site into Oracle Cloud Object Storage (or Cloudflare R2) so that if the VM boot volume ever fails or is deleted, all tenant gym databases can be restored immediately from cloud storage.
* **Code Readiness:** GymBook's backend (`src/s3.js` and `src/backup.js`) is **100% written and ready**. No code changes are required—only 4 configuration variables need to be added to the server's `.env`.

---

## 2. Checklist When Ready to Implement

### Step 1: Create the Storage Bucket in Oracle Cloud
1. Log in to [Oracle Cloud Console](https://cloud.oracle.com/).
2. Open the navigation menu (☰) → **Storage** → **Object Storage & Archive Storage** → **Buckets**.
3. Click **Create Bucket**:
   - **Bucket Name:** `gymbook-backups`
   - **Storage Tier:** `Standard`
   - Click **Create**.

### Step 2: Find Your Region & Namespace
- **Region:** Look at the top-right header in Oracle Cloud (e.g., `ap-mumbai-1`, `us-ashburn-1`).
- **Namespace:** Click your **Profile avatar (top-right)** → **Tenancy: <name>** → under *Object Storage Settings*, copy your **Object Storage Namespace** string (e.g. `ax9k2example`).

### Step 3: Generate S3 Customer Secret Key
1. In Oracle Cloud Console, click **Profile avatar** → **My Profile** (or **User Settings**).
2. In the left sidebar under *Resources*, click **Customer Secret Keys**.
3. Click **Generate Secret Key**:
   - Name: `gymbook-backup-key`
   - Click **Generate Secret Key**.
4. **Important:** Copy the **Access Key** and **Secret Key** immediately (the secret key is only shown once).

### Step 4: Configure Server `.env`
SSH into your Oracle Cloud VM and open the environment file:
```bash
nano /home/ubuntu/gymbook/.env
```

Add or uncomment these lines:
```env
BACKUP_S3_BUCKET=gymbook-backups
BACKUP_S3_ENDPOINT=https://<your-namespace>.compat.objectstorage.<your-region>.oraclecloud.com
BACKUP_S3_REGION=<your-region>
BACKUP_S3_ACCESS_KEY_ID=<your-access-key>
BACKUP_S3_SECRET_ACCESS_KEY=<your-secret-key>
```

Save and exit (`Ctrl + O`, `Enter`, `Ctrl + X`).

### Step 5: Restart & Verify
1. Restart the server process:
   ```bash
   pm2 restart gymbook
   ```
2. Run a test backup from the command line:
   ```bash
   node scripts/backup.js
   ```
   *Expected output:* `uploaded 3 file(s) off-site` and `Backup OK`.
3. Open the Platform Console (`/#/platform`).
   *Expected subtext:* `Every 24h · keeping 14 · off-site copy configured`.

---

## 3. Alternative Option: Cloudflare R2
If Oracle Cloud IAM / Customer Secret Keys are cumbersome, Cloudflare R2 can be used instead:
* 10 GB free forever (holds ~7,000 GymBook snapshots).
* 2-click setup in Cloudflare dashboard under **R2 Object Storage**.
* Direct S3 endpoint with zero bandwidth/egress fees.
