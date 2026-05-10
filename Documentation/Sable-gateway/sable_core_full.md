# sable-core — Full Service Specification

> The central account management, customer success, and orchestration service.
> Everything that touches a user, a firm, a subscription, a certification, or a lifecycle moment lives here.
> Version 1.0 — Pre-build — May 2026

---

## What sable-core Is

sable-core is the heart of the Sable ecosystem. It is not just a user management service — it is the full institutional membership layer. It knows who every user is, what they have access to, how long they have been a member, when their birthday is, and whether they have earned a certification. It sends them a welcome pack when they sign up, a gift on their birthday, and a personal email on their anniversary. It pays their referral rewards via PayPal. It manages every waitlist lead, every enquiry, and every inbound contact.

It is also the most security-critical service in the stack. Every piece of PII it stores is encrypted at rest. Every secret is in GCP Secret Manager. No PII ever touches a log.

---

## 1. Account Types

### 1.1 Standard User Account

A human being with a Sable seat. Belongs to an organisation. Has a role, a module list, a birthday, and a joining date.

**Required on signup:**
- Full name
- Email address (encrypted at rest)
- Phone number (encrypted at rest)
- Date of birth (encrypted at rest — used for birthday gifts)
- Organisation (existing firm or create new)

**System-generated on signup:**
- Unique user ID (UUID)
- Unique referral code
- Joining date (for anniversary tracking)
- Welcome pack dispatch triggered

### 1.2 Admin Account

An internal Sable team account. Has elevated access across all organisations. Cannot be created via the standard signup flow — admin accounts are created by the admin microservice only.

**Admin roles:**
- `super_admin` — full access to everything, all data, all firms
- `support` — read access to user and firm data, can handle enquiries and issues
- `operations` — billing, subscription management, gift dispatch tracking
- `sales` — enquiries, waitlist, lead pipeline only

Admin accounts are verified by IP allowlist and require a hardware 2FA token (TOTP via Authy or Google Authenticator) in addition to the standard JWT. Admin sessions expire after 30 minutes of inactivity.

Admin account management lives in a separate microservice (sable-admin). sable-core exposes a set of admin-only API endpoints that the admin microservice calls after its own auth layer verifies the request.

### 1.3 Waitlist Account

A person who has expressed interest but not yet signed up. Not a full account — just a lead record. Lives in the `waitlist` table until converted by an admin or invited directly.

---

## 2. Organisation (Firm) Management

An organisation is a paying firm using Sable. It holds multiple users (seats), a module subscription, and billing information.

**Organisation fields:**
- Name, trading name
- Company registration number
- Registered address (encrypted)
- Billing email (encrypted)
- Logo URL
- Active modules (array of module codes)
- Seat count (paid seats vs active seats)
- Subscription tier and billing cycle
- Chatbot enabled (org-level toggle)
- Referral code (org-level referral tracking)
- Created at, joining anniversary date

**Firm management operations:**
- Create organisation (on first user signup or admin creation)
- Invite users to join (email invitation with magic link)
- Remove users from firm
- Upgrade or downgrade module subscriptions
- Transfer firm ownership
- Suspend firm (admin only)

---

## 3. Role-Based Access and Permissions

Every user has a role within their organisation. The role determines what they can see and do in the product.

**Default roles:**

| Role | Permissions |
|---|---|
| Owner | Full access. Billing, user management, all modules, all workspace pages |
| Admin | User management, module access, full workspace. No billing. |
| Analyst | Run commands, build pipelines, full workspace read/write. No user management. |
| Trader | Execute commands, view portfolios. No pipeline building, no workspace write. |
| Viewer | Read-only access to shared dashboards only. No commands. |

Custom roles: org owners and admins can define custom roles with any permission combination. Stored as JSONB in `org_roles`.

**Module-level access:**

Access to each module (S&C, Property, Crypto, Alternatives, Tax) is checked per user on every request by sable-gateway. The source of truth for which modules a user can access is stored in `users.active_modules` and `organisations.active_modules`.

---

## 4. Module Subscription Management

Modules are activated at the organisation level and assigned to seats individually.

**Module codes:** `sc` (S&C), `re` (Property), `crypto` (Crypto), `alt` (Alternatives), `tax` (Sable Tax)

**Subscription logic:**
- Organisation buys N seats for module X
- Admin assigns seats to specific users
- Unassigned seats are purchased but inactive
- Adding a module: call sable-core `POST /org/modules` → updates `organisations.active_modules` → sable-gateway picks up on next request
- Removing a module: queued for end of billing cycle, not immediate

---

## 5. Security — Non-Negotiable

### 5.1 Encryption at Rest

All PII encrypted before writing to PostgreSQL. Decrypted only when needed for application logic. GCP Cloud KMS manages the encryption keys — keys never touch application code.

**Fields encrypted at rest:**
- `users.email`
- `users.phone`
- `users.date_of_birth`
- `users.address` (if collected)
- `organisations.billing_email`
- `organisations.registered_address`
- `waitlist.email`
- `waitlist.phone`
- `enquiries.email`
- `enquiries.phone`
- `referrals.paypal_email`
- `welcome_packs.delivery_address`
- `birthday_gifts.delivery_address`

**Encryption implementation:**

```typescript
import { KeyManagementServiceClient } from '@google-cloud/kms'

const kmsClient = new KeyManagementServiceClient()
const KEY_NAME = process.env.GCP_KMS_KEY_NAME

async function encrypt(plaintext: string): Promise<string> {
  const [result] = await kmsClient.encrypt({
    name: KEY_NAME,
    plaintext: Buffer.from(plaintext)
  })
  return Buffer.from(result.ciphertext as Uint8Array).toString('base64')
}

async function decrypt(ciphertext: string): Promise<string> {
  const [result] = await kmsClient.decrypt({
    name: KEY_NAME,
    ciphertext: Buffer.from(ciphertext, 'base64')
  })
  return Buffer.from(result.plaintext as Uint8Array).toString('utf8')
}
```

### 5.2 Secrets Management

Every secret in GCP Secret Manager. No `.env` files with actual secrets in production. Environment variables in production only contain the resource name, not the value.

Secrets managed here:
- `clerk-secret-key`
- `database-url`
- `gcp-kms-key-name`
- `sendgrid-api-key` (or Resend)
- `paypal-client-id`
- `paypal-client-secret`
- `postal-io-api-key` (or Sendoso)
- `hmac-app-secret`
- `jwt-secret`

### 5.3 No PII in Logs

Custom logging wrapper strips known PII fields before any log entry is written. Email, phone, DOB, name, address — none of these ever appear in application logs.

```typescript
const SENSITIVE_FIELDS = ['email', 'phone', 'date_of_birth', 'address', 'paypal_email']

function safeLog(data: Record<string, unknown>) {
  const sanitised = { ...data }
  SENSITIVE_FIELDS.forEach(field => {
    if (sanitised[field]) sanitised[field] = '[REDACTED]'
  })
  console.log(JSON.stringify(sanitised))
}
```

### 5.4 TLS and Transport

- TLS 1.3 minimum on all endpoints
- HSTS enforced
- All internal service-to-service calls over HTTPS even within GCP
- Certificate pinning enforced on Flutter desktop app

### 5.5 Admin Account Security

- IP allowlist enforced at GCP Cloud Armor level
- Hardware TOTP required (no SMS-based 2FA)
- 30-minute session expiry on inactivity
- All admin actions written to an immutable audit log
- Admin JWT separate from user JWT — different signing key, shorter expiry (15 minutes)

---

## 6. Authentication

Authentication is handled by Clerk. sable-core and sable-gateway both use Clerk's JWKS endpoint to verify JWTs without storing passwords.

**Signup flow:**
1. User visits sableterminal.com/signup
2. Clerk handles email verification and account creation
3. On successful Clerk signup, Clerk webhook fires to sable-core `POST /webhooks/clerk/user.created`
4. sable-core creates the user record, encrypts PII, generates referral code, records joining date
5. sable-core triggers welcome pack dispatch and welcome email
6. sable-core returns session JWT

**Login flow:**
1. User logs in via Clerk (web or desktop)
2. Clerk issues JWT
3. Flutter app sends JWT with every request to sable-gateway
4. sable-gateway verifies JWT against Clerk JWKS, extracts user ID
5. sable-gateway calls sable-core to get user's active modules
6. Gateway forwards request to correct service

**Desktop vs web:**
- Web: standard Clerk hosted login page
- Desktop: Clerk embedded components in Flutter WebView for auth flow, then native JWT handling from that point forward

---

## 7. Waitlist

Pre-launch and ongoing interest capture. Managed by admin CRM.

**Waitlist entry fields:**
- Name
- Email (encrypted)
- Phone (optional, encrypted)
- Firm name
- AUM range (< £50M / £50M–£200M / £200M–£500M / £500M+)
- Primary interest (S&C / Property / Crypto / Alternatives / Full suite)
- Source (website, LinkedIn, event, referral, cold outreach)
- Notes
- Status (New / Contacted / Demo booked / Converted / Not interested)
- Created at

**Waitlist to account conversion:**
- Admin sends invite from sable-admin CRM
- sable-core generates a time-limited signup token (48 hours)
- Token embedded in invitation email
- User clicks link, completes signup with token pre-validating their email
- Waitlist record status updates to Converted, linked to new user ID

---

## 8. Enquiries

Every inbound contact to Sable goes into the enquiries table. This feeds directly into the admin CRM.

**Enquiry fields:**
- Name
- Email (encrypted)
- Phone (optional, encrypted)
- Firm name
- Enquiry type (Demo request / General / Partnership / Press / Support / Complaint)
- Message
- Source (Website, LinkedIn, Referral, Cold outreach, Event)
- Status (New / Contacted / Qualified / Demo booked / Converted / Closed)
- Assigned to (user ID of team member — Tommy or Chris)
- Internal notes
- Follow up date
- Priority (Low / Normal / High — admin sets this)
- Created at, updated at

**Automatic routing:**
- Demo request → assigned to Chris (UK) or Tommy (US) based on phone prefix or stated location
- Press enquiry → flagged for Tommy only
- Support → flagged for operations
- All new enquiries trigger a Slack notification to the team channel

---

## 9. Referral System

**Structure:**
- Every user gets a unique referral code on signup
- Referral link: `sableterminal.com/signup?ref=CODE`
- Referrer: receives £500 GBP cash via PayPal per successful referral (90-day hold)
- Referee: receives first month free (credited to account, not a rate reduction)

**Referral status flow:**

```
Referee clicks referral link
        ↓
Signup completed (referee_signed_up_at recorded)
        ↓
Referee's payment processes successfully
        ↓
90-day hold begins
        ↓
At 90-day mark: check referee is still active and paying
        ↓
If active: trigger PayPal payout to referrer's PayPal email
        ↓
Referral status → PAID
        ↓
If inactive/churned: status → VOID, no payout
```

**PayPal Payouts integration:**

```typescript
// sable-core — trigger payout at 90-day mark
async function processReferralPayout(referralId: string) {
  const referral = await getReferral(referralId)
  const referrer = await getUser(referral.referrer_user_id)

  const payout = await paypalClient.payouts.create({
    sender_batch_header: {
      sender_batch_id: `sable-ref-${referralId}`,
      email_subject: 'Your Sable referral reward',
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: { value: '500.00', currency: 'GBP' },
      receiver: await decrypt(referral.paypal_email),
      note: `Thank you for referring a Sable customer`,
    }]
  })

  await updateReferralStatus(referralId, 'PAID', payout.batch_id)
}
```

**Referral table fields:**
- Referrer user ID
- Referee email (encrypted, before signup) / referee user ID (after signup)
- Referral code used
- PayPal email of referrer (encrypted — collected when they want to claim)
- Status (Pending / Active / Eligible / Paid / Void)
- Signup date
- First payment date
- 90-day eligibility date
- Payout date
- PayPal batch ID (for reconciliation)
- First month credit applied (bool)

---

## 10. Premium Lifecycle Touchpoints

### 10.1 Welcome Pack

Every new signup triggers a physical welcome pack dispatch.

**Contents (TBD — premium unboxing experience):**
- Sable branded notebook
- Sable pen
- Physical certification tracker card
- Personal welcome letter (name-printed)
- QR code linking to onboarding resources

**Dispatch:**
- sable-core captures delivery address on signup (encrypted at rest)
- Calls Postal.io (or Sendoso) API to trigger dispatch
- Tracks dispatch status in `welcome_packs` table
- Follow-up email sent when pack is dispatched with tracking number

```typescript
// sable-core — trigger welcome pack
async function dispatchWelcomePack(userId: string, address: EncryptedAddress) {
  const decryptedAddress = await decryptAddress(address)

  const dispatch = await postalClient.send({
    recipient: decryptedAddress,
    pack_id: 'sable-welcome-v1',
    personalisation: {
      name: decryptedAddress.name
    }
  })

  await db`
    INSERT INTO welcome_packs (user_id, dispatch_id, status, dispatched_at)
    VALUES (${userId}, ${dispatch.id}, 'dispatched', NOW())
  `
}
```

### 10.2 Birthday Gifts

Every seat holder receives a birthday gift each year. This requires DOB captured on signup.

**Birthday gift scheduler:**
- Daily Cloud Scheduler job runs at 06:00 UTC
- Queries `users` table for any user whose DOB day and month match today
- For each matching user: triggers gift dispatch, logs in `birthday_gifts`
- Also sends a personal birthday email

**gift dispatch:** Same Postal.io integration as welcome packs. Different pack SKU.

**birthday_gifts table fields:**
- User ID
- Year (the year the gift was sent — prevents double dispatch)
- Dispatch ID
- Status
- Dispatched at

### 10.3 Anniversary Emails

On the anniversary of a user's joining date, a personal email is sent.

**Anniversary email scheduler:**
- Daily Cloud Scheduler job at 07:00 UTC
- Queries users for joining_date month+day matching today
- Sends personalised anniversary email (1 year, 2 years, 5 years — different copy per milestone)
- Logs in `anniversaries` table (prevents double send)

**Milestone email copy:**
- Year 1: "One year ago you joined Sable. Here's what you've built."
- Year 2: "Two years of Sable. Your certification is on the horizon."
- Year 5: "Five years. You're part of the original cohort."

---

## 11. Certification System

The Sable Institute certification programme. Usage hours and activity logged per user. Thresholds trigger eligibility. Certified users receive a tamper-proof digital credential (Stage 2 — logged for now, ledger in Stage 2).

**Certification levels:**

| Level | Requirement | Description |
|---|---|---|
| Sable Associate | 50 hours + 100 commands | Entry-level certification |
| Sable Professional | 200 hours + 500 commands + 10 pipelines built | Professional-grade |
| Sable Expert | 500 hours + 2000 commands + 50 pipelines + peer review | Expert designation |

**Usage tracking (updated on every user action):**
- Session hours (accumulated active usage time)
- Commands run (total count)
- Pipelines built (total count)
- Last activity at

**Certification flow:**
1. User hits eligibility threshold
2. sable-core sends eligibility notification email + in-app notification
3. User applies for certification exam via sable-core `POST /certification/apply`
4. Exam booked (manual process Stage 1, automated Stage 2)
5. On pass: certification record created, credential issued, email sent
6. Stage 2: credential written to tamper-proof distributed ledger

---

## 12. Email System

All transactional email via Resend (preferred) or SendGrid.

**Email triggers and templates:**

| Trigger | Template | Notes |
|---|---|---|
| Signup | `welcome` | Sent immediately on account creation |
| Welcome pack dispatched | `welcome_pack_shipped` | Includes tracking number |
| Seat invitation | `seat_invite` | Magic link, 48-hour expiry |
| Waitlist invite | `waitlist_invite` | Conversion magic link |
| Referral sign up | `referral_confirmed` | To referrer confirming their referral signed up |
| Referral eligible | `referral_eligible` | At 90-day mark before payout |
| Referral paid | `referral_paid` | PayPal payout sent confirmation |
| Birthday | `birthday` | Sent on birthday morning |
| Anniversary | `anniversary_1yr` / `_2yr` / `_5yr` | Sent on joining anniversary |
| Certification eligible | `cert_eligible` | When threshold crossed |
| Certification passed | `cert_passed` | With credential attached |
| Module added | `module_added` | When firm buys new module |
| Password reset | `password_reset` | Handled via Clerk but notification from sable-core |
| Enquiry received | `enquiry_received` | Auto-reply to enquirer |
| Enquiry team alert | internal Slack | To #enquiries channel |

**Email security:**
- SPF, DKIM, and DMARC configured on sableterminal.com mail domain
- All links in emails use HTTPS
- Unsubscribe link in all non-transactional emails
- No PII in email subjects (in case of email client preview exposure)

---

## 13. Full Database Schema (sable-core)

### organisations

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT | Firm name |
| trading_name | TEXT | Optional trading name |
| company_reg | TEXT | Company registration number |
| registered_address | TEXT | Encrypted |
| billing_email | TEXT | Encrypted |
| logo_url | TEXT | GCS URL |
| active_modules | TEXT[] | ['sc', 're', 'crypto'] |
| seat_count | INTEGER | Paid seats |
| billing_cycle | TEXT | 'monthly' / 'annual' |
| chatbot_enabled | BOOLEAN | Default true |
| referral_code | TEXT | Unique |
| joining_date | TIMESTAMPTZ | For anniversary tracking |
| status | TEXT | 'active' / 'suspended' / 'cancelled' |
| created_at | TIMESTAMPTZ | |

### users

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID FK | organisations |
| clerk_id | TEXT UNIQUE | Clerk user ID |
| email | TEXT | Encrypted |
| phone | TEXT | Encrypted |
| name | TEXT | |
| date_of_birth | TEXT | Encrypted |
| role | TEXT | owner / admin / analyst / trader / viewer |
| active_modules | TEXT[] | Subset of org modules |
| settings | JSONB | User preferences |
| referral_code | TEXT UNIQUE | |
| joining_date | TIMESTAMPTZ | |
| account_type | TEXT | 'user' / 'admin' |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |

### admin_accounts

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| email | TEXT | Encrypted |
| name | TEXT | |
| admin_role | TEXT | super_admin / support / operations / sales |
| ip_allowlist | TEXT[] | Allowed IP addresses |
| totp_secret | TEXT | Encrypted TOTP seed |
| last_login_at | TIMESTAMPTZ | |
| last_login_ip | TEXT | |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |
| created_by | UUID | ID of admin who created this account |

### org_roles

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID FK | |
| role_name | TEXT | |
| permissions | JSONB | |
| created_at | TIMESTAMPTZ | |

### waitlist

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT | |
| email | TEXT | Encrypted |
| phone | TEXT | Encrypted, optional |
| firm_name | TEXT | |
| aum_range | TEXT | |
| primary_interest | TEXT | |
| source | TEXT | |
| notes | TEXT | |
| status | TEXT | new / contacted / demo_booked / converted / not_interested |
| assigned_to | UUID | Admin user ID |
| converted_user_id | UUID | Set on conversion |
| invite_token | TEXT | Time-limited signup token |
| invite_sent_at | TIMESTAMPTZ | |
| invite_expires_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### enquiries

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT | |
| email | TEXT | Encrypted |
| phone | TEXT | Encrypted, optional |
| firm_name | TEXT | |
| enquiry_type | TEXT | demo_request / general / partnership / press / support / complaint |
| message | TEXT | |
| source | TEXT | website / linkedin / referral / cold_outreach / event |
| status | TEXT | new / contacted / qualified / demo_booked / converted / closed |
| assigned_to | UUID | Admin or team member |
| internal_notes | TEXT | Private notes |
| follow_up_date | DATE | |
| priority | TEXT | low / normal / high |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### referral_codes

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK | |
| code | TEXT UNIQUE | |
| uses | INTEGER | Total signups via this code |
| created_at | TIMESTAMPTZ | |

### referrals

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| referrer_user_id | UUID FK | |
| referee_email | TEXT | Encrypted — before signup |
| referee_user_id | UUID | Set after referee signs up |
| referral_code | TEXT | Code used |
| paypal_email | TEXT | Encrypted — referrer's PayPal |
| status | TEXT | pending / active / eligible / paid / void |
| signed_up_at | TIMESTAMPTZ | |
| first_payment_at | TIMESTAMPTZ | |
| eligible_at | TIMESTAMPTZ | 90 days after first payment |
| paid_at | TIMESTAMPTZ | |
| paypal_batch_id | TEXT | For reconciliation |
| first_month_credit_applied | BOOLEAN | Default false |
| created_at | TIMESTAMPTZ | |

### welcome_packs

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK | |
| delivery_address | TEXT | Encrypted |
| dispatch_id | TEXT | Postal.io / Sendoso ID |
| tracking_number | TEXT | |
| status | TEXT | pending / dispatched / delivered / failed |
| dispatched_at | TIMESTAMPTZ | |
| delivered_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

### birthday_gifts

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK | |
| year | INTEGER | Year the gift was sent |
| delivery_address | TEXT | Encrypted |
| dispatch_id | TEXT | |
| tracking_number | TEXT | |
| status | TEXT | pending / dispatched / delivered / failed |
| dispatched_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

### anniversaries

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK | |
| year | INTEGER | Year of anniversary |
| email_sent_at | TIMESTAMPTZ | |
| template_used | TEXT | anniversary_1yr / 2yr / 5yr |

### certification_usage

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK UNIQUE | |
| session_hours | FLOAT | Accumulated |
| commands_run | INTEGER | Accumulated |
| pipelines_built | INTEGER | Accumulated |
| certification_level | TEXT | null / associate / professional / expert |
| eligible_at | TIMESTAMPTZ | When threshold first crossed |
| applied_at | TIMESTAMPTZ | When exam application submitted |
| certified_at | TIMESTAMPTZ | When certification granted |
| credential_id | TEXT | Tamper-proof ledger reference (Stage 2) |
| last_activity_at | TIMESTAMPTZ | |

### admin_audit_log

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| admin_user_id | UUID FK | |
| action | TEXT | What was done |
| target_type | TEXT | user / org / referral / etc |
| target_id | UUID | |
| before_state | JSONB | Snapshot before change |
| after_state | JSONB | Snapshot after change |
| ip_address | TEXT | |
| created_at | TIMESTAMPTZ | Immutable — no updates allowed |

---

## 14. REST API Endpoints

### Auth and Accounts
| Method | Endpoint | Description |
|---|---|---|
| POST | /webhooks/clerk/user.created | Clerk webhook on signup |
| POST | /auth/admin/login | Admin login (IP + TOTP required) |
| GET | /user/me | Current user profile |
| PATCH | /user/me | Update profile |
| POST | /user/referral/claim | Submit PayPal email to claim referral reward |

### Organisations
| Method | Endpoint | Description |
|---|---|---|
| POST | /org | Create organisation |
| GET | /org/:id | Get org details |
| PATCH | /org/:id | Update org |
| POST | /org/:id/invite | Invite user to org |
| DELETE | /org/:id/users/:userId | Remove user from org |
| POST | /org/:id/modules | Add module to org |
| DELETE | /org/:id/modules/:module | Remove module |

### Waitlist
| Method | Endpoint | Description |
|---|---|---|
| POST | /waitlist | Submit to waitlist (public) |
| GET | /waitlist | List all waitlist entries (admin only) |
| POST | /waitlist/:id/invite | Send invite to waitlist entry (admin only) |
| PATCH | /waitlist/:id | Update status or notes (admin only) |

### Enquiries
| Method | Endpoint | Description |
|---|---|---|
| POST | /enquiries | Submit enquiry (public) |
| GET | /enquiries | List enquiries (admin only) |
| PATCH | /enquiries/:id | Update status, notes, assignee (admin only) |

### Referrals
| Method | Endpoint | Description |
|---|---|---|
| GET | /referrals/my | Current user's referral stats |
| GET | /referrals/check/:code | Validate referral code |
| POST | /referrals/apply | Apply referral code at signup |

### Certifications
| Method | Endpoint | Description |
|---|---|---|
| GET | /certification/me | Current user's certification status |
| POST | /certification/apply | Apply for certification exam |
| GET | /certification/verify/:credentialId | Public credential verification |

### Admin (admin JWT required + IP check)
| Method | Endpoint | Description |
|---|---|---|
| GET | /admin/users | List all users |
| GET | /admin/users/:id | Get user detail |
| PATCH | /admin/users/:id | Update user (suspend, change role) |
| GET | /admin/orgs | List all organisations |
| POST | /admin/accounts | Create new admin account |
| GET | /admin/audit-log | View audit log |

---

## 15. Scheduled Jobs (GCP Cloud Scheduler)

| Job | Schedule | Description |
|---|---|---|
| Birthday gift dispatch | Daily 06:00 UTC | Check DOB, trigger gifts and emails |
| Anniversary email | Daily 07:00 UTC | Check joining date, send anniversary email |
| Referral eligibility check | Daily 08:00 UTC | Check 90-day mark, trigger PayPal payouts |
| Waitlist follow-up nudge | Weekly Monday 09:00 UTC | Alert team to any New/Contacted entries >7 days old |

---

## 16. Third-Party Integrations

| Service | Purpose | Notes |
|---|---|---|
| Clerk | Auth, user identity | JWT verification via JWKS |
| GCP Cloud KMS | Encryption key management | AES-256, keys never in app code |
| GCP Secret Manager | All secrets | No .env with real values in production |
| GCP Cloud Scheduler | Scheduled jobs | Birthday, anniversary, referral eligibility |
| GCP Pub/Sub | Cross-service events | portfolio.updated, holdings.imported etc |
| Resend (or SendGrid) | Transactional email | SPF + DKIM + DMARC on sableterminal.com |
| PayPal Payouts API | Referral cash rewards | GBP payouts to referrer PayPal email |
| Postal.io (or Sendoso) | Physical welcome packs and birthday gifts | Encrypted address passed at dispatch time only |
| Slack (internal) | Team alerts — new enquiries, new waitlist, issues | sable-admin Slack workspace |

---

## 17. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| Database | PostgreSQL 16+ — raw SQL via postgres.js |
| Encryption | GCP Cloud KMS |
| Secrets | GCP Secret Manager |
| Scheduling | GCP Cloud Scheduler |
| Messaging | GCP Pub/Sub |
| Auth | Clerk (JWKS verification) |
| Email | Resend |
| Payments | PayPal Payouts API |
| Physical dispatch | Postal.io |
| Deployment | GCP Cloud Run |
| Containerisation | Docker |
| Structure | src/ with routes/ middleware/ services/ |

---

*sable-core — Full service specification — May 2026 — Confidential*

---

## 18. Stripe Payments

All subscription billing handled by Stripe. Stripe is the source of truth for what a firm or individual has paid for. Module activation in sable-core is always downstream of a confirmed Stripe payment — never manually set.

### Stripe Objects

Every organisation and individual user gets a Stripe Customer object on signup:

```typescript
// On org creation or individual signup
const customer = await stripe.customers.create({
  email: await decrypt(user.email),
  name: org ? org.name : user.name,
  metadata: {
    sable_org_id: org?.id ?? null,
    sable_user_id: user.id
  }
})
// Store stripe_customer_id on org or user record
```

### Stripe Subscription Model

One Stripe Subscription per organisation (or individual). One Subscription Item per active module. Seat count handled via quantity on each item.

```
Stripe Subscription
  ├── Item: sc     × 3 seats  @ £999/seat/month
  ├── Item: re     × 3 seats  @ £999/seat/month
  └── Item: crypto × 2 seats  @ £999/seat/month
```

Adding a module → add a Subscription Item
Removing a module → remove Subscription Item at period end
Changing seat count → update quantity on the item

### Stripe Webhooks

sable-core exposes `POST /webhooks/stripe` — verified with Stripe signature before processing.

| Event | Action |
|---|---|
| `customer.subscription.created` | Activate modules in `organisations.active_modules` |
| `customer.subscription.updated` | Update modules and seat counts |
| `customer.subscription.deleted` | Deactivate all modules, flag account |
| `invoice.payment_succeeded` | Log invoice, send receipt email |
| `invoice.payment_failed` | Send payment failure email, flag account as `past_due` |
| `checkout.session.completed` | First-time signup payment confirmed — trigger welcome pack + onboarding |

### Stripe Webhook Handler

```typescript
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch {
    return res.status(400).send('Webhook signature verification failed')
  }

  switch (event.type) {
    case 'customer.subscription.updated':
      await syncModulesFromStripe(event.data.object)
      break
    case 'invoice.payment_failed':
      await flagAccountPastDue(event.data.object.customer)
      await sendPaymentFailedEmail(event.data.object.customer)
      break
    // ... etc
  }

  res.json({ received: true })
})

async function syncModulesFromStripe(subscription: Stripe.Subscription) {
  const modules = subscription.items.data.map(item => item.price.metadata.module_code)
  const orgId = subscription.metadata.sable_org_id

  await sql`
    UPDATE organisations
    SET active_modules = ${modules},
        subscription_status = ${subscription.status}
    WHERE stripe_customer_id = ${subscription.customer}
  `
}
```

### Additional DB Fields for Stripe

**organisations table — additional columns:**

| Column | Type | Notes |
|---|---|---|
| stripe_customer_id | TEXT | Stripe customer ID |
| stripe_subscription_id | TEXT | Active subscription ID |
| subscription_status | TEXT | active / past_due / cancelled / trialling |

**users table — additional column for individuals:**

| Column | Type | Notes |
|---|---|---|
| stripe_customer_id | TEXT | For individual (non-firm) users only |

### subscriptions table

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID FK | null for individual users |
| user_id | UUID FK | null for org subscriptions |
| stripe_subscription_id | TEXT | |
| stripe_customer_id | TEXT | |
| module | TEXT | sc / re / crypto / alt / tax |
| seat_count | INTEGER | |
| price_per_seat_gbp | NUMERIC | £999 |
| billing_cycle | TEXT | monthly / annual |
| status | TEXT | active / past_due / cancelled / trialling |
| trial_end_at | TIMESTAMPTZ | |
| current_period_start | TIMESTAMPTZ | |
| current_period_end | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### invoices table

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID FK | |
| stripe_invoice_id | TEXT | |
| amount_gbp | NUMERIC | |
| currency | TEXT | Default GBP |
| status | TEXT | paid / open / void |
| module | TEXT | |
| seats_billed | INTEGER | |
| billing_period_start | TIMESTAMPTZ | |
| billing_period_end | TIMESTAMPTZ | |
| paid_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

---

## 19. Individual User Path

Not every Sable user belongs to a firm. A serious individual property investor buying Sable RE, or a solo quant buying S&C, has no organisation to attach to. The individual path is a first-class supported flow — not a workaround.

### How Individual Signup Works

1. User visits sableterminal.com/signup
2. Selects "Individual" (not "Firm")
3. Completes Clerk signup (email, phone, DOB required)
4. Selects which module(s) they want
5. Stripe Checkout — payment directly to their personal Stripe customer
6. On payment confirmed: modules activated on the user record directly (not an org)
7. Welcome pack dispatched, welcome email sent

### DB Difference for Individuals

- `users.org_id` is NULL for individual users
- `users.stripe_customer_id` is set (instead of on an org)
- `users.active_modules` is managed directly
- `users.account_type` = `individual`
- No seat invitations, no firm management, no org-level roles

### Module Activation for Individuals

Same webhook flow as organisations — Stripe fires `customer.subscription.updated`, sable-core checks `metadata.sable_user_id`, updates `users.active_modules` directly.

```typescript
async function syncModulesFromStripe(subscription: Stripe.Subscription) {
  const modules = subscription.items.data.map(item => item.price.metadata.module_code)

  if (subscription.metadata.sable_org_id) {
    // Org subscription
    await sql`
      UPDATE organisations SET active_modules = ${modules}
      WHERE stripe_customer_id = ${subscription.customer}
    `
  } else {
    // Individual subscription
    await sql`
      UPDATE users SET active_modules = ${modules}
      WHERE stripe_customer_id = ${subscription.customer}
    `
  }
}
```

### Gateway Access Check for Individuals

sable-gateway already reads `user.active_modules` from sable-core. For individual users this field is on the user record. For org users it is on the org record, intersected with the user's assigned modules. The gateway does not need to know which type — it just checks the resolved module list.

---

## 20. Module Activation Rules

Modules are ONLY ever activated by a confirmed Stripe webhook. No admin can manually activate a module without a corresponding Stripe subscription. This is enforced in sable-core's module management service.

```typescript
// The ONLY function that activates modules
async function activateModules(entityId: string, entityType: 'org' | 'user', modules: string[]) {
  // Verify a live Stripe subscription exists for these modules
  const subscription = await verifyStripeSubscription(entityId, entityType, modules)
  if (!subscription) throw new Error('No confirmed Stripe subscription for these modules')

  if (entityType === 'org') {
    await sql`UPDATE organisations SET active_modules = ${modules} WHERE id = ${entityId}`
  } else {
    await sql`UPDATE users SET active_modules = ${modules} WHERE id = ${entityId}`
  }

  safeLog({ event: 'modules_activated', entity_id: entityId, modules })
}
```

Module deactivation is also only triggered by Stripe — either on `subscription.deleted` or at the end of the billing period when a module is removed.

---

*sable-core — Full service specification — Updated with Stripe, individual users, module activation — May 2026 — Confidential*
