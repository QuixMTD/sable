# sable-gateway — Complete Database Design Document

> Version 1.0 — Pre-build — May 2026
> sable-gateway handles all authentication, login, session management, and request
> routing. Every table the gateway owns and manages is documented here.
>
> 🔐 ENCRYPTED — AES-256 via GCP Cloud KMS
> #️⃣ HASHED — SHA-256, one-way, never reversible
> ○ PLAIN — not sensitive, stored as-is

---

## organisations

Firms using Sable. The gateway reads this on every request to verify module access.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| name | TEXT | ○ | Legal firm name |
| trading_name | TEXT | ○ | Trading name if different |
| company_reg | TEXT | ○ | Companies House registration number |
| registered_address | TEXT | 🔐 ENCRYPTED | Legal registered address |
| billing_email | TEXT | 🔐 ENCRYPTED | Where invoices are sent |
| logo_url | TEXT | ○ | GCS link to firm logo |
| active_modules | TEXT ARRAY | ○ | Modules paid for — sc, re, crypto, alt, tax |
| seat_count | INTEGER | ○ | Total paid seats |
| billing_cycle | TEXT | ○ | monthly or annual |
| chatbot_enabled | BOOLEAN | ○ | Org-level chatbot toggle |
| referral_code | TEXT | ○ | Unique org-level referral code |
| joining_date | TIMESTAMPTZ | ○ | When the firm signed up |
| status | TEXT | ○ | active, suspended, or cancelled |
| stripe_customer_id | TEXT | ○ | Stripe customer reference |
| stripe_subscription_id | TEXT | ○ | Active Stripe subscription |
| subscription_status | TEXT | ○ | active, past_due, cancelled, trialling |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| stripe_customer_id | Unique | Stripe webhook lookup on every payment event |
| status | Standard | Filter active orgs |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees only their own org |
| UPDATE | Owner or admin role within the org |
| INSERT | Any authenticated user |
| DELETE | Super admin only |

**Partitions** — none

---

## users

Every person with a Sable seat. Core auth table — looked up on every single request.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| org_id | UUID FK | ○ | Which firm — null for individual users |
| email | TEXT | 🔐 ENCRYPTED | Contact email |
| email_verified | BOOLEAN | ○ | Whether the email address has been verified |
| password_hash | TEXT | #️⃣ HASHED | Argon2id hash of the user's password — never stored in plaintext |
| phone | TEXT | 🔐 ENCRYPTED | Contact phone |
| name | TEXT | ○ | Full name |
| date_of_birth | TEXT | 🔐 ENCRYPTED | DOB — used for birthday gift scheduling only |
| role | TEXT | ○ | owner, admin, analyst, trader, viewer |
| active_modules | TEXT ARRAY | ○ | Modules this user can access |
| settings | JSONB | ○ | Personal preferences — theme, dock position, chatbot toggle etc |
| referral_code | TEXT UNIQUE | ○ | Their unique referral code |
| joining_date | TIMESTAMPTZ | ○ | When they joined — drives anniversary emails |
| account_type | TEXT | ○ | user, admin, or individual |
| stripe_customer_id | TEXT | ○ | Set for individual users only — org users bill through the org |
| is_active | BOOLEAN | ○ | Whether the account is active |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| email | Standard | Looked up on every login attempt — must be fast |
| org_id | Standard | List all users in an org |
| stripe_customer_id | Standard | Individual billing webhook lookups |
| referral_code | Unique | Validate referral codes on signup |
| email_verified | Standard | Filter verified users |
| is_active | Standard | Filter active users only |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own record and other users in their org |
| UPDATE | User updates own record only. Admin updates any user in their org. |
| INSERT | Gateway service account only — on signup |
| DELETE | Super admin only |

**Partitions** — none

---

## email_verification_tokens

Time-limited tokens sent to a user's email to verify their address on signup or on email change.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Which user this token belongs to |
| token_hash | TEXT | #️⃣ HASHED | SHA-256 hash of the token — raw token only ever exists in the email link |
| expires_at | TIMESTAMPTZ | ○ | 24 hours from creation |
| used_at | TIMESTAMPTZ | ○ | When it was consumed — null if unused |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| token_hash | Unique | Looked up when user clicks the verification link |
| user_id | Standard | Find active tokens for a specific user |
| expires_at | Standard | Sweep expired tokens |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account only |
| INSERT | Gateway service account only — on signup and email change |
| UPDATE | Gateway service account only — mark as used |
| DELETE | Gateway service account only — expired token sweep |

**Partitions** — none

---

## password_reset_tokens

Time-limited tokens for the forgot password flow. One active token per user at a time.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Which user requested the reset |
| token_hash | TEXT | #️⃣ HASHED | SHA-256 hash of the token — raw token only ever exists in the email link |
| expires_at | TIMESTAMPTZ | ○ | 1 hour from creation — short window reduces risk |
| used_at | TIMESTAMPTZ | ○ | When it was consumed — null if unused |
| ip_requested_from | TEXT | ○ | IP that requested the reset — security monitoring and alerting |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| token_hash | Unique | Looked up when user clicks the reset link |
| user_id | Standard | Find or invalidate existing tokens for a user |
| expires_at | Standard | Sweep expired tokens |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account only |
| INSERT | Gateway service account only — on forgot password request |
| UPDATE | Gateway service account only — mark as used |
| DELETE | Gateway service account only — expired token sweep |

**Partitions** — none

---

## admin_accounts

Internal Sable team accounts. Cannot be created via standard signup. Gateway enforces elevated security on all admin requests.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| email | TEXT | 🔐 ENCRYPTED | Admin email |
| name | TEXT | ○ | Admin's name |
| admin_role | TEXT | ○ | super_admin, support, operations, sales |
| ip_allowlist | TEXT ARRAY | ○ | Only these IPs can log in as this admin |
| totp_secret | TEXT | 🔐 ENCRYPTED | Hardware TOTP seed |
| last_login_at | TIMESTAMPTZ | ○ | When they last logged in |
| last_login_ip | TEXT | ○ | IP of their last login — security monitoring |
| is_active | BOOLEAN | ○ | Whether the admin account is active |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |
| created_by | UUID | ○ | Which admin created this account |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| email | Unique | Admin login lookup |
| admin_role | Standard | Filter by role |
| is_active | Standard | Active accounts only |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only — never exposed to standard users |
| INSERT / UPDATE / DELETE | Super admin only |

**Partitions** — none

---

## sessions

Active login sessions per user. Enables forced logout, idle timeout, and cross-device session management.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique session identifier |
| user_id | UUID FK | ○ | Which user this session belongs to |
| session_token_hash | TEXT UNIQUE | #️⃣ HASHED | SHA-256 hash of the session token — raw token stored in an HTTP-only cookie only |
| device_fingerprint_hash | TEXT | #️⃣ HASHED | Fingerprint of the device this session started on |
| ip_address | TEXT | ○ | IP at session start |
| platform | TEXT | ○ | macos, windows, web |
| created_at | TIMESTAMPTZ | ○ | Session start |
| last_active_at | TIMESTAMPTZ | ○ | Last request time — used for idle timeout |
| expires_at | TIMESTAMPTZ | ○ | Hard expiry |
| revoked_at | TIMESTAMPTZ | ○ | When force-logged-out — null if still valid |
| revoked_by | UUID | ○ | Admin who revoked — null if not revoked |
| revoke_reason | TEXT | ○ | Why the session was revoked |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Standard | Find all active sessions for a user |
| session_token_hash | Unique | Looked up on every authenticated request — must be instant |
| expires_at | Standard | Sweep expired sessions |
| revoked_at | Standard | Filter active vs revoked |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees only their own sessions. Admin sees all. |
| INSERT | Gateway service account only |
| UPDATE | Gateway service account and admin — revoke and last_active updates |
| DELETE | Nobody — use revoked_at |

**Partitions** — partition by month. Sessions accumulate constantly.

---

## org_roles

Custom roles defined by firms with their own permission sets.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| org_id | UUID FK | ○ | Which firm this role belongs to |
| role_name | TEXT | ○ | Name the firm gave this role |
| permissions | JSONB | ○ | Full permission set for this role |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| org_id | Standard | Find all custom roles for an org |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Users see roles in their org |
| INSERT / UPDATE / DELETE | Owner or admin within the org |

**Partitions** — none

---

## waitlist

Pre-launch and ongoing interest capture. Public endpoint — no auth required to submit.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| name | TEXT | ○ | Their name |
| email | TEXT | 🔐 ENCRYPTED | Contact email |
| phone | TEXT | 🔐 ENCRYPTED | Contact phone — optional |
| firm_name | TEXT | ○ | Firm they work for |
| aum_range | TEXT | ○ | AUM — qualifies the lead |
| primary_interest | TEXT | ○ | Which module they care about most |
| source | TEXT | ○ | How they found us |
| notes | TEXT | ○ | Internal notes |
| status | TEXT | ○ | new, contacted, demo_booked, converted, not_interested |
| assigned_to | UUID | ○ | Which team member owns this lead |
| converted_user_id | UUID | ○ | Linked to their account when they sign up |
| invite_token | TEXT | ○ | Time-limited signup token embedded in invite email |
| invite_sent_at | TIMESTAMPTZ | ○ | When the invite was sent |
| invite_expires_at | TIMESTAMPTZ | ○ | When the invite token expires — 48 hours |
| created_at | TIMESTAMPTZ | ○ | When they joined the waitlist |
| updated_at | TIMESTAMPTZ | ○ | Last update timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| email | Standard | Duplicate check on submission |
| status | Standard | Filter leads by stage |
| assigned_to | Standard | Leads assigned to a specific team member |
| invite_token | Unique | Validate token when they click the invite link |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Public — no auth required |
| UPDATE | Admin accounts only |

**Partitions** — none

---

## enquiries

Every inbound contact. Public endpoint — no auth required to submit.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| name | TEXT | ○ | Their name |
| email | TEXT | 🔐 ENCRYPTED | Contact email |
| phone | TEXT | 🔐 ENCRYPTED | Contact phone — optional |
| firm_name | TEXT | ○ | Firm they represent |
| enquiry_type | TEXT | ○ | demo_request, partnership, press, support, complaint, general |
| message | TEXT | ○ | What they said |
| source | TEXT | ○ | website, linkedin, referral, event |
| status | TEXT | ○ | new, contacted, qualified, demo_booked, converted, closed |
| assigned_to | UUID | ○ | Which team member is handling it |
| internal_notes | TEXT | ○ | Private notes — never shown to the enquirer |
| follow_up_date | DATE | ○ | When to contact them next |
| priority | TEXT | ○ | low, normal, or high |
| created_at | TIMESTAMPTZ | ○ | When the enquiry came in |
| updated_at | TIMESTAMPTZ | ○ | Last update timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| status | Standard | CRM filters by status constantly |
| assigned_to | Standard | Enquiries assigned to a specific person |
| enquiry_type | Standard | Filter by type |
| follow_up_date | Standard | Sort by follow-up date |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Public — no auth required |
| UPDATE | Admin accounts only |

**Partitions** — none

---

## referral_codes

One unique referral code per user. Generated on signup.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Who owns this code |
| code | TEXT UNIQUE | ○ | The referral code itself |
| uses | INTEGER | ○ | Total signups via this code |
| created_at | TIMESTAMPTZ | ○ | When generated |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| code | Unique | Validated on every signup with a referral link |
| user_id | Standard | Look up a user's code |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees only their own code |
| INSERT | System account on user creation only |

**Partitions** — none

---

## referrals

Full lifecycle of every referral event from signup to payout.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| referrer_user_id | UUID FK | ○ | Who referred someone |
| referee_email | TEXT | 🔐 ENCRYPTED | Email of the person referred — before they sign up |
| referee_user_id | UUID | ○ | Set after the referee creates their account |
| referral_code | TEXT | ○ | Which code they used |
| paypal_email | TEXT | 🔐 ENCRYPTED | Referrer's PayPal email — where the £500 goes |
| status | TEXT | ○ | pending, active, eligible, paid, or void |
| signed_up_at | TIMESTAMPTZ | ○ | When the referee signed up |
| first_payment_at | TIMESTAMPTZ | ○ | When the referee's first payment went through |
| eligible_at | TIMESTAMPTZ | ○ | 90 days after first payment — when payout triggers |
| paid_at | TIMESTAMPTZ | ○ | When the £500 was sent |
| paypal_batch_id | TEXT | ○ | PayPal's reference for reconciliation |
| first_month_credit_applied | BOOLEAN | ○ | Whether referee's free month has been credited |
| created_at | TIMESTAMPTZ | ○ | When the referral was recorded |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| referrer_user_id | Standard | All referrals made by a user |
| status | Standard | Filter by referral stage |
| eligible_at | Standard | Daily scheduler finds referrals ready for payout |
| referee_user_id | Standard | Look up by referee after they sign up |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Referrer sees their own referrals. Admin sees all. |
| INSERT / UPDATE | System account only |

**Partitions** — none

---

## welcome_packs

Tracks physical welcome pack dispatch per user. Prevents duplicate sends.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Who the pack is for |
| delivery_address | TEXT | 🔐 ENCRYPTED | Physical delivery address — decrypted at dispatch only |
| dispatch_id | TEXT | ○ | Postal.io reference |
| tracking_number | TEXT | ○ | Courier tracking number |
| status | TEXT | ○ | pending, dispatched, delivered, failed |
| dispatched_at | TIMESTAMPTZ | ○ | When sent |
| delivered_at | TIMESTAMPTZ | ○ | When delivery confirmed |
| created_at | TIMESTAMPTZ | ○ | Record creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Unique | Prevent sending a second pack to the same user |
| status | Standard | Monitor dispatch status |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own record. Admin sees all. |
| INSERT / UPDATE | System account and admin only |

**Partitions** — none

---

## birthday_gifts

Tracks birthday gift dispatch per user per year. Prevents duplicate sends.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Who the gift is for |
| year | INTEGER | ○ | Year the gift was sent — prevents double dispatch |
| delivery_address | TEXT | 🔐 ENCRYPTED | Physical address — decrypted at dispatch only |
| dispatch_id | TEXT | ○ | Postal.io reference |
| tracking_number | TEXT | ○ | Courier tracking number |
| status | TEXT | ○ | pending, dispatched, delivered, failed |
| dispatched_at | TIMESTAMPTZ | ○ | When sent |
| created_at | TIMESTAMPTZ | ○ | Record creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id + year | Composite unique | Prevent sending two gifts in the same year |
| status | Standard | Monitor dispatch |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own record. Admin sees all. |
| INSERT / UPDATE | System account and admin only |

**Partitions** — partition by year. Daily scheduler only queries current year.

---

## anniversaries

Tracks anniversary emails sent per user per year. Prevents duplicate sends.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Who the email was sent to |
| year | INTEGER | ○ | Which anniversary year — prevents double sending |
| email_sent_at | TIMESTAMPTZ | ○ | When the email was sent |
| template_used | TEXT | ○ | Which template — anniversary_1yr, 2yr, 5yr |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id + year | Composite unique | Prevent sending duplicate anniversary emails |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own record. Admin sees all. |
| INSERT | System account only |

**Partitions** — partition by year. Daily scheduler only queries current year.

---

## certification_usage

One record per user. Accumulates usage stats that drive certification eligibility.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK UNIQUE | ○ | One record per user |
| session_hours | FLOAT | ○ | Accumulated active usage time |
| commands_run | INTEGER | ○ | Total commands executed |
| pipelines_built | INTEGER | ○ | Total pipelines built |
| certification_level | TEXT | ○ | null, associate, professional, or expert |
| eligible_at | TIMESTAMPTZ | ○ | When threshold first crossed |
| applied_at | TIMESTAMPTZ | ○ | When exam application submitted |
| certified_at | TIMESTAMPTZ | ○ | When certification granted |
| credential_id | TEXT | ○ | Tamper-proof ledger reference — Stage 2 |
| last_activity_at | TIMESTAMPTZ | ○ | Last time they did anything |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Unique | One record per user |
| certification_level | Standard | Filter certified users |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own record. Admin sees all. |
| UPDATE | System account only — users cannot edit their own usage |

**Partitions** — none

---

## admin_audit_log

Immutable record of every action taken by an admin. No updates or deletes ever.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| admin_user_id | UUID FK | ○ | Which admin did this |
| action | TEXT | ○ | What they did |
| target_type | TEXT | ○ | What they acted on — user, org, referral etc |
| target_id | UUID | ○ | The specific record they acted on |
| before_state | JSONB | ○ | Snapshot before the change |
| after_state | JSONB | ○ | Snapshot after the change |
| ip_address | TEXT | ○ | IP they were on when they did it |
| created_at | TIMESTAMPTZ | ○ | When the action happened — immutable |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| admin_user_id | Standard | All actions by a specific admin |
| target_id | Standard | All actions taken on a specific record |
| created_at | Standard | Time-range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Admin service account only |
| UPDATE / DELETE | Nobody — immutable by policy |

**Partitions** — partition by month. Grows constantly, queries always time-bounded.

---

## subscriptions

One row per module per org or individual user. Source of truth for what is paid for.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| org_id | UUID FK | ○ | Which firm — null for individual users |
| user_id | UUID FK | ○ | Which individual — null for org subscriptions |
| stripe_subscription_id | TEXT | ○ | Stripe subscription reference |
| stripe_customer_id | TEXT | ○ | Stripe customer reference |
| module | TEXT | ○ | Which module — sc, re, crypto, alt, tax |
| seat_count | INTEGER | ○ | How many seats for this module |
| price_per_seat_gbp | NUMERIC | ○ | £999 |
| billing_cycle | TEXT | ○ | monthly or annual |
| status | TEXT | ○ | active, past_due, cancelled, trialling |
| trial_end_at | TIMESTAMPTZ | ○ | When the trial expires |
| current_period_start | TIMESTAMPTZ | ○ | Start of current billing period |
| current_period_end | TIMESTAMPTZ | ○ | End of current billing period |
| created_at | TIMESTAMPTZ | ○ | When the subscription started |
| updated_at | TIMESTAMPTZ | ○ | Last change timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| org_id | Standard | All subscriptions for an org |
| user_id | Standard | All subscriptions for an individual user |
| stripe_subscription_id | Unique | Stripe webhook lookup |
| stripe_customer_id | Standard | Stripe customer lookup |
| status | Standard | Filter active subscriptions |
| module | Standard | Filter by module |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Org owners and admins see their org subscriptions. Individuals see their own. |
| INSERT / UPDATE | Stripe webhook service account and admin only |

**Partitions** — none

---

## invoices

Record of every Stripe invoice. Financial audit trail.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| org_id | UUID FK | ○ | Which firm was billed |
| stripe_invoice_id | TEXT | ○ | Stripe reference — for reconciliation |
| amount_gbp | NUMERIC | ○ | How much was charged |
| currency | TEXT | ○ | GBP |
| status | TEXT | ○ | paid, open, or void |
| module | TEXT | ○ | Which module this invoice covers |
| seats_billed | INTEGER | ○ | How many seats were charged |
| billing_period_start | TIMESTAMPTZ | ○ | Start of the period covered |
| billing_period_end | TIMESTAMPTZ | ○ | End of the period covered |
| paid_at | TIMESTAMPTZ | ○ | When payment was confirmed |
| created_at | TIMESTAMPTZ | ○ | When Stripe created the invoice |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| org_id | Standard | All invoices for an org |
| stripe_invoice_id | Unique | Stripe webhook lookup |
| status | Standard | Filter unpaid invoices |
| paid_at | Standard | Date range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Org owners and admins see their own invoices |
| INSERT / UPDATE | Stripe webhook service account only |

**Partitions** — partition by month. Financial records grow indefinitely.

---

## api_keys

Programmatic API access without a Clerk JWT.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| org_id | UUID FK | ○ | Which firm — null for individual users |
| user_id | UUID FK | ○ | Which user created it |
| key_hash | TEXT | #️⃣ HASHED | SHA-256 hash of the raw key — never stored in plaintext |
| prefix | TEXT | ○ | First 8 characters shown in the UI |
| name | TEXT | ○ | Human label |
| scopes | TEXT ARRAY | ○ | What this key can do |
| last_used_at | TIMESTAMPTZ | ○ | When last used |
| expires_at | TIMESTAMPTZ | ○ | Hard expiry — null means never |
| is_active | BOOLEAN | ○ | Whether valid |
| revoked_at | TIMESTAMPTZ | ○ | When revoked — null if active |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| key_hash | Unique | Looked up on every API key request |
| org_id | Standard | All keys for an org |
| is_active | Standard | Filter active keys |
| expires_at | Standard | Sweep expired keys |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Org owners and admins see keys in their org. Users see keys they created. |
| INSERT | Org owners and admins only |
| UPDATE | Org owners and admins only |
| DELETE | Nobody — use revoked_at |

**Partitions** — none

---

## rate_limit_policies

Custom rate limits that override global defaults per org or user.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| entity_type | TEXT | ○ | org or user |
| entity_id | UUID | ○ | The org or user this applies to |
| requests_per_minute | INTEGER | ○ | Per-minute limit |
| requests_per_hour | INTEGER | ○ | Per-hour limit |
| requests_per_day | INTEGER | ○ | Per-day limit |
| burst_allowance | INTEGER | ○ | Short burst above per-minute limit |
| reason | TEXT | ○ | Why this was set |
| created_by | UUID | ○ | Admin who set it |
| expires_at | TIMESTAMPTZ | ○ | When it expires — null means permanent |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| entity_type + entity_id | Composite | Looked up on every request with a custom policy |
| expires_at | Standard | Sweep expired policies |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT / UPDATE / DELETE | Admin accounts only |

**Partitions** — none

---

## blocked_entities

Persistent blocks on IPs, users, orgs or device fingerprints.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| entity_type | TEXT | ○ | ip, user_id, org_id, or device_fingerprint |
| entity_value | TEXT | ○ | The IP, UUID or fingerprint being blocked |
| reason | TEXT | ○ | Why blocked |
| block_type | TEXT | ○ | full, throttle, or monitor |
| blocked_by | UUID | ○ | Admin who applied the block |
| blocked_at | TIMESTAMPTZ | ○ | When applied |
| expires_at | TIMESTAMPTZ | ○ | When it lifts — null means permanent |
| is_active | BOOLEAN | ○ | Whether in force |
| notes | TEXT | ○ | Internal notes |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| entity_type + entity_value | Composite | Checked on every incoming request |
| is_active | Standard | Only check active blocks |
| expires_at | Standard | Sweep expired blocks |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT / UPDATE | Admin accounts only |
| DELETE | Nobody |

**Partitions** — none

---

## security_events

Immutable log of every security event at the gateway.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| event_type | TEXT | ○ | auth_failure, rate_limit_exceeded, blocked_entity_hit, hmac_failure, bot_detected, api_key_invalid, replay_attack |
| user_id | UUID | ○ | Which user — null if auth failed before identification |
| org_id | UUID | ○ | Which org — null if auth failed |
| ip_address | TEXT | ○ | Request IP |
| device_fingerprint | TEXT | ○ | Hardware fingerprint if available |
| api_key_prefix | TEXT | ○ | First 8 chars — never the full key |
| request_path | TEXT | ○ | Which endpoint was hit |
| request_method | TEXT | ○ | GET, POST, PATCH, DELETE |
| details | JSONB | ○ | Additional context — no PII |
| created_at | TIMESTAMPTZ | ○ | When it occurred — immutable |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Standard | All events for a user |
| org_id | Standard | All events for an org |
| ip_address | Standard | All events from an IP |
| event_type | Standard | Filter by category |
| created_at | Standard | Time-range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Gateway service account only |
| UPDATE / DELETE | Nobody — immutable |

**Partitions** — partition by month.

---

## service_routes

Dynamic routing config. Maps path prefixes to downstream services without redeployment.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| path_prefix | TEXT | ○ | URL prefix — e.g. /sc, /re, /core |
| method | TEXT | ○ | GET, POST, PATCH, DELETE, or ANY |
| target_service | TEXT | ○ | sable-core, sable-sc, sable-re etc |
| target_url | TEXT | ○ | Full base URL of the target service |
| required_module | TEXT | ○ | Module required — null means no module check |
| auth_required | BOOLEAN | ○ | Whether JWT or API key required |
| is_active | BOOLEAN | ○ | Whether this route is live |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |
| updated_at | TIMESTAMPTZ | ○ | Last modified |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| path_prefix | Standard | Matched on every incoming request |
| is_active | Standard | Only active routes |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account and admin only |
| INSERT / UPDATE / DELETE | Admin only |

**Partitions** — none

---

## request_logs

Full request audit trail for debugging and security investigation.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID | ○ | Which user — null if unauthenticated |
| org_id | UUID | ○ | Which org — null if unauthenticated |
| ip_address | TEXT | ○ | Request IP |
| device_fingerprint | TEXT | ○ | Hardware fingerprint if available |
| request_method | TEXT | ○ | GET, POST, PATCH, DELETE |
| request_path | TEXT | ○ | Endpoint — no query params with PII |
| target_service | TEXT | ○ | Which service handled it |
| status_code | INTEGER | ○ | HTTP response status |
| duration_ms | INTEGER | ○ | Request duration |
| auth_type | TEXT | ○ | jwt, api_key, or none |
| created_at | TIMESTAMPTZ | ○ | When the request was made |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Standard | All requests from a user |
| org_id | Standard | All requests from an org |
| ip_address | Standard | All requests from an IP |
| status_code | Standard | Filter 4xx and 5xx |
| created_at | Standard | Time-range queries |
| target_service | Standard | Requests to a specific service |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Gateway service account only |
| UPDATE / DELETE | Nobody — immutable |

**Partitions** — partition by day. Very high write volume. Retain 90 days.

---

## webhook_logs

Every incoming webhook logged before processing. Enables replay if downstream fails.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| provider | TEXT | ○ | stripe or clerk |
| event_type | TEXT | ○ | e.g. customer.subscription.updated |
| provider_event_id | TEXT UNIQUE | ○ | Provider's event ID — idempotency |
| payload | JSONB | ○ | Full webhook payload for replay |
| signature_valid | BOOLEAN | ○ | Whether signature verification passed |
| processed | BOOLEAN | ○ | Whether handled successfully |
| processed_at | TIMESTAMPTZ | ○ | When processing completed |
| error | TEXT | ○ | Error if processing failed |
| created_at | TIMESTAMPTZ | ○ | When the webhook arrived |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| provider_event_id | Unique | Prevent processing the same event twice |
| provider | Standard | Filter by source |
| processed | Standard | Find unprocessed events for replay |
| created_at | Standard | Time-range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin accounts only |
| INSERT | Gateway service account only |
| UPDATE | Gateway service account only — mark processed |
| DELETE | Nobody |

**Partitions** — partition by month. Retain 12 months.

---

## hmac_key_versions

Tracks HMAC key versions for rotation with a grace period.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| version | INTEGER UNIQUE | ○ | Key version number |
| key_ref | TEXT | ○ | GCP Secret Manager resource name — never the key |
| is_active | BOOLEAN | ○ | Whether this version accepts signatures |
| activated_at | TIMESTAMPTZ | ○ | When it became active |
| deprecated_at | TIMESTAMPTZ | ○ | When it stopped being used for new signatures |
| expires_at | TIMESTAMPTZ | ○ | When old signatures with this version stop being accepted |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| version | Unique | Look up a specific version |
| is_active | Standard | Find active versions on every HMAC validation |
| expires_at | Standard | Sweep expired versions |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account and admin only |
| INSERT / UPDATE | Admin only |
| DELETE | Nobody |

**Partitions** — none

---

## used_nonces

Prevents HMAC replay attacks. Every signed request uses a nonce exactly once.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| nonce | TEXT UNIQUE | ○ | Nonce value from the request |
| user_id | UUID | ○ | Which user sent it |
| used_at | TIMESTAMPTZ | ○ | When first seen |
| expires_at | TIMESTAMPTZ | ○ | 30 seconds after used_at |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| nonce | Unique | Checked on every signed request |
| expires_at | Standard | Sweep every 30 seconds |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account only |
| INSERT | Gateway service account only |
| DELETE | Gateway service account only — automated sweep |

**Partitions** — partition by minute. Extremely high volume. 30-second retention.

---

## device_fingerprints

Known hardware fingerprints per user. New fingerprint triggers security event.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID FK | ○ | Which user |
| fingerprint_hash | TEXT | #️⃣ HASHED | SHA-256 hash — raw hardware data never stored |
| device_name | TEXT | ○ | Human label — e.g. MacBook Pro |
| platform | TEXT | ○ | macos, windows, web |
| first_seen_at | TIMESTAMPTZ | ○ | When this device first appeared |
| last_seen_at | TIMESTAMPTZ | ○ | Most recent request |
| is_trusted | BOOLEAN | ○ | Whether user has verified this device |
| trusted_at | TIMESTAMPTZ | ○ | When user confirmed it |
| is_active | BOOLEAN | ○ | Whether recognised |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id + fingerprint_hash | Composite unique | Check if fingerprint known for this user on every request |
| user_id | Standard | All devices for a user |
| is_trusted | Standard | Filter trusted devices |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own. Admin sees all. |
| INSERT | Gateway service account only |
| UPDATE | Gateway service account and admin |
| DELETE | Admin only |

**Partitions** — none

---

## bot_scores

Persistent bot suspicion scores. Redis counters write here when threshold is crossed.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| entity_type | TEXT | ○ | user_id or ip |
| entity_value | TEXT | ○ | The UUID or IP |
| score | INTEGER | ○ | 0–100. Above 70 throttle. Above 90 block. |
| reasons | TEXT ARRAY | ○ | What contributed — inhuman_speed, no_mouse_events etc |
| last_updated_at | TIMESTAMPTZ | ○ | When score last recalculated |
| reviewed_by | UUID | ○ | Admin who reviewed — null if not reviewed |
| reviewed_at | TIMESTAMPTZ | ○ | When reviewed |
| review_notes | TEXT | ○ | Admin notes |
| created_at | TIMESTAMPTZ | ○ | When first created |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| entity_type + entity_value | Composite unique | Look up score for a specific entity |
| score | Standard | Find high-score entities for review |
| reviewed_by | Standard | Find unreviewed high scores |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin only |
| INSERT / UPDATE | Gateway service account and admin |
| DELETE | Admin only |

**Partitions** — none

---

## ip_whitelist

Application-level IP allowlist for admin accounts and trusted partner IPs.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| ip_address | TEXT | ○ | IP address or CIDR range |
| entity_type | TEXT | ○ | admin_account, org, or global |
| entity_id | UUID | ○ | The admin or org — null for global |
| reason | TEXT | ○ | Why this IP is whitelisted |
| added_by | UUID | ○ | Admin who added it |
| expires_at | TIMESTAMPTZ | ○ | When it expires — null means permanent |
| is_active | BOOLEAN | ○ | Whether in force |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| ip_address | Standard | Checked on admin login and sensitive operations |
| entity_type + entity_id | Composite | All whitelisted IPs for a specific admin or org |
| is_active | Standard | Filter active entries |
| expires_at | Standard | Sweep expired entries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin only |
| INSERT / UPDATE / DELETE | Admin only |

**Partitions** — none

---

## cors_origins

Allowed CORS origins per environment.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| origin | TEXT | ○ | Allowed origin — e.g. https://sableterminal.com |
| environment | TEXT | ○ | production, staging, or development |
| allow_credentials | BOOLEAN | ○ | Whether credentials can be sent from this origin |
| is_active | BOOLEAN | ○ | Whether currently allowed |
| added_by | UUID | ○ | Admin who added it |
| created_at | TIMESTAMPTZ | ○ | Creation timestamp |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| origin | Standard | Checked on every request with an Origin header |
| environment | Standard | Filter by environment |
| is_active | Standard | Only active origins |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account and admin |
| INSERT / UPDATE / DELETE | Admin only |

**Partitions** — none

---

## service_health_log

Tracks when downstream services go up and down.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| service_name | TEXT | ○ | sable-core, sable-sc, sable-re etc |
| status | TEXT | ○ | healthy, degraded, or down |
| response_time_ms | INTEGER | ○ | Health check response time |
| error_message | TEXT | ○ | Error if degraded or down |
| checked_at | TIMESTAMPTZ | ○ | When the health check ran |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| service_name | Standard | Health history for a specific service |
| status | Standard | Filter by status |
| checked_at | Standard | Time-range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Admin and gateway service account |
| INSERT | Gateway service account only |
| UPDATE / DELETE | Nobody — immutable |

**Partitions** — partition by week.

---

## gateway_config

Key-value config store. Updates without redeployment.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| key | TEXT UNIQUE | ○ | Config key — e.g. global_rate_limit_per_minute |
| value | TEXT | ○ | Config value — parsed by application |
| description | TEXT | ○ | What this key controls |
| updated_by | UUID | ○ | Admin who last changed it |
| updated_at | TIMESTAMPTZ | ○ | When last changed |
| created_at | TIMESTAMPTZ | ○ | When first set |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| key | Unique | Direct lookup by config key |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | Gateway service account and admin |
| INSERT / UPDATE / DELETE | Admin only |

**Partitions** — none

---

## email_logs

Record of every email sent. Prevents duplicates and enables delivery debugging.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | UUID PK | ○ | Unique identifier |
| user_id | UUID | ○ | Who it was sent to |
| template | TEXT | ○ | Which email template was used |
| sent_at | TIMESTAMPTZ | ○ | When it was sent |
| provider_id | TEXT | ○ | Resend or SendGrid message ID for delivery tracking |
| status | TEXT | ○ | sent, delivered, bounced, or failed |

**Indexes**

| Column(s) | Type | Reason |
|---|---|---|
| user_id | Standard | All emails sent to a specific user |
| template | Standard | Filter by email type |
| status | Standard | Find bounced or failed emails |
| sent_at | Standard | Time-range queries |

**RLS**

| Operation | Rule |
|---|---|
| SELECT | User sees their own. Admin sees all. |
| INSERT | System account only |
| UPDATE | System account only — update delivery status |
| DELETE | Nobody |

**Partitions** — partition by month.

---

## migrations

Tracks which SQL migration files have been applied.

| Column | Type | Security | Purpose |
|---|---|---|---|
| id | SERIAL | ○ | Auto-incrementing run order |
| filename | TEXT UNIQUE | ○ | The migration filename |
| run_at | TIMESTAMPTZ | ○ | When it was executed |

---

## Redis Keys

| Key pattern | TTL | Purpose |
|---|---|---|
| `rate:user:{user_id}:minute` | 60s | Per-user request count this minute |
| `rate:user:{user_id}:hour` | 3600s | Per-user request count this hour |
| `rate:user:{user_id}:day` | 86400s | Per-user request count today |
| `rate:org:{org_id}:minute` | 60s | Per-org aggregate count this minute |
| `rate:ip:{ip}:minute` | 60s | Per-IP request count this minute |
| `modules:user:{user_id}` | 300s | Cached module access list — invalidated on module change |
| `blacklist:jwt:{jti}` | JWT remaining lifetime | Revoked JWT tokens |
| `nonce:{nonce}` | 30s | Used nonces for replay prevention |
| `block:cache:{type}:{value}` | 60s | Mirror of active blocked_entities |
| `whitelist:cache:{type}:{value}` | 300s | Mirror of active ip_whitelist |
| `session:{session_id}` | Session remaining lifetime | Cached session state |
| `bot:requests:{user_id}:50ms` | 60s | Request frequency counter |
| `bot:pattern:{ip}:regularity` | 300s | Regularity score |
| `bot:mouse:{user_id}` | 600s | Interaction telemetry variance score |
| `route:cache` | 3600s | Cached service_routes |
| `hmac:versions` | 3600s | Cached active HMAC key versions |
| `fingerprint:user:{user_id}` | 3600s | Cached trusted fingerprints |
| `config:cache` | 3600s | Cached gateway_config |
| `health:{service_name}` | 30s | Latest health status per service |
| `cors:origins` | 3600s | Cached allowed CORS origins |

---

## Security Summary

| Concern | Approach |
|---|---|
| All PII | AES-256 encrypted via GCP Cloud KMS before writing to DB |
| API keys | SHA-256 hashed — raw key shown once, never stored |
| Device fingerprints | SHA-256 hashed — raw hardware data never stored |
| Session fingerprints | SHA-256 hashed |
| Password storage | Argon2id hashed — never bcrypt, never plaintext |
| Email verification | SHA-256 hashed token in email link — raw token never stored |
| Password reset tokens | SHA-256 hashed, 1-hour expiry, IP logged on request |
| Session tokens | SHA-256 hashed — raw token in HTTP-only cookie only |
| HMAC replay | used_nonces + Redis nonce cache — 30-second window |
| HMAC rotation | hmac_key_versions with grace period |
| Rate limiting | Redis counters + PostgreSQL custom policies |
| Bot detection | Redis counters → bot_scores for persistence |
| Session management | sessions table + Redis cache — revoke deletes Redis key instantly |
| Blocked entities | Redis cache (60s) + PostgreSQL fallback |
| IP whitelisting | Redis cache (300s) + PostgreSQL fallback |
| Audit logs | Immutable — no UPDATE or DELETE on security_events, request_logs, webhook_logs, service_health_log, admin_audit_log |
| Admin access | Admin JWT + IP allowlist at Cloud Armor AND application level |
| All secrets | GCP Secret Manager only — no .env in production |
| TLS | 1.3 minimum everywhere |
| PII in logs | None — safeLog wrapper enforced, no PII in any log field |

---

*sable-gateway — Complete database design document — May 2026 — Confidential*
