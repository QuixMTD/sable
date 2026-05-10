Here is every table, every column, the data type and exactly what it is for.

---

## organisations

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the firm |
| name | TEXT | Legal firm name |
| trading_name | TEXT | Trading name if different from legal name |
| company_reg | TEXT | Companies House registration number |
| registered_address | TEXT (encrypted) | Legal registered address |
| billing_email | TEXT (encrypted) | Where invoices get sent |
| logo_url | TEXT | Link to firm logo stored in GCS |
| active_modules | TEXT ARRAY | Which modules this firm has paid for — sc, re, crypto, alt, tax |
| seat_count | INTEGER | How many seats the firm has purchased |
| billing_cycle | TEXT | Monthly or annual |
| chatbot_enabled | BOOLEAN | Org-level AI chatbot toggle |
| referral_code | TEXT | Unique code for firm-level referrals |
| joining_date | TIMESTAMPTZ | When the firm signed up — drives anniversary emails |
| status | TEXT | Whether the account is active, suspended, or cancelled |
| stripe_customer_id | TEXT | Stripe customer reference for billing |
| stripe_subscription_id | TEXT | Active Stripe subscription reference |
| subscription_status | TEXT | Live Stripe status — active, past_due, cancelled, trialling |
| created_at | TIMESTAMPTZ | Record creation timestamp |

---

## users

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the person |
| org_id | UUID | Which firm this person belongs to — null for individual users |
| clerk_id | TEXT | Clerk's identifier for this user — used to link auth to our records |
| email | TEXT (encrypted) | Contact email — encrypted because PII |
| phone | TEXT (encrypted) | Contact phone — encrypted because PII |
| name | TEXT | Full name |
| date_of_birth | TEXT (encrypted) | DOB — used exclusively for birthday gift scheduling |
| role | TEXT | Their role within the firm — owner, admin, analyst, trader, viewer |
| active_modules | TEXT ARRAY | Which modules this specific user can access |
| settings | JSONB | Personal preferences — theme, dock position, notifications, chatbot toggle |
| referral_code | TEXT | Their unique referral code for sharing |
| joining_date | TIMESTAMPTZ | When they joined — drives personal anniversary emails |
| account_type | TEXT | user, admin, or individual |
| stripe_customer_id | TEXT | Only set for individual users — org users bill through the org |
| is_active | BOOLEAN | Whether the account is currently active |
| created_at | TIMESTAMPTZ | Record creation timestamp |

---

## admin_accounts

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the admin |
| email | TEXT (encrypted) | Admin email — encrypted because PII |
| name | TEXT | Admin's name |
| admin_role | TEXT | Level of access — super_admin, support, operations, sales |
| ip_allowlist | TEXT ARRAY | The only IP addresses this admin can log in from |
| totp_secret | TEXT (encrypted) | The seed for their hardware TOTP — encrypted at rest |
| last_login_at | TIMESTAMPTZ | When they last logged in |
| last_login_ip | TEXT | IP address of their last login — for security monitoring |
| is_active | BOOLEAN | Whether the admin account is active |
| created_at | TIMESTAMPTZ | Record creation timestamp |
| created_by | UUID | Which admin created this account — audit trail |

---

## org_roles

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the role |
| org_id | UUID | Which firm this custom role belongs to |
| role_name | TEXT | Name the firm gave this role |
| permissions | JSONB | The full permission set — what this role can and cannot do |
| created_at | TIMESTAMPTZ | Record creation timestamp |

---

## waitlist

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the lead |
| name | TEXT | Their name |
| email | TEXT (encrypted) | Contact email |
| phone | TEXT (encrypted) | Contact phone — optional |
| firm_name | TEXT | Firm they work for |
| aum_range | TEXT | How much they manage — used to qualify the lead |
| primary_interest | TEXT | Which module they care about most |
| source | TEXT | How they found us — website, LinkedIn, event etc |
| notes | TEXT | Internal notes about this lead |
| status | TEXT | Where they are in the pipeline — new, contacted, demo booked, converted, not interested |
| assigned_to | UUID | Which team member owns this lead |
| converted_user_id | UUID | Set when they sign up — links waitlist record to their new account |
| invite_token | TEXT | Time-limited token embedded in the invite email |
| invite_sent_at | TIMESTAMPTZ | When the invite was sent |
| invite_expires_at | TIMESTAMPTZ | When the invite token expires — 48 hours |
| created_at | TIMESTAMPTZ | When they joined the waitlist |
| updated_at | TIMESTAMPTZ | Last time their record was updated |

---

## enquiries

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for the enquiry |
| name | TEXT | Their name |
| email | TEXT (encrypted) | Contact email |
| phone | TEXT (encrypted) | Contact phone — optional |
| firm_name | TEXT | Firm they represent |
| enquiry_type | TEXT | What kind of contact — demo request, partnership, press, support, complaint, general |
| message | TEXT | What they actually said |
| source | TEXT | How they reached us — website, LinkedIn, referral, event |
| status | TEXT | Where it is in our process — new, contacted, qualified, demo booked, converted, closed |
| assigned_to | UUID | Which team member is handling it |
| internal_notes | TEXT | Private notes — never shown to the enquirer |
| follow_up_date | DATE | When to contact them next |
| priority | TEXT | Low, normal or high — set by the team |
| created_at | TIMESTAMPTZ | When the enquiry came in |
| updated_at | TIMESTAMPTZ | Last time it was updated |

---

## referral_codes

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | Who owns this code |
| code | TEXT | The unique referral code itself |
| uses | INTEGER | How many times this code has been used |
| created_at | TIMESTAMPTZ | When the code was generated |

---

## referrals

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier for this referral event |
| referrer_user_id | UUID | Who referred someone |
| referee_email | TEXT (encrypted) | The email of the person referred — before they sign up |
| referee_user_id | UUID | Set after the referee creates their account |
| referral_code | TEXT | Which code they used |
| paypal_email | TEXT (encrypted) | The referrer's PayPal email — where their £500 goes |
| status | TEXT | pending, active, eligible, paid, or void |
| signed_up_at | TIMESTAMPTZ | When the referee signed up |
| first_payment_at | TIMESTAMPTZ | When the referee's first payment went through |
| eligible_at | TIMESTAMPTZ | 90 days after first payment — when payout can happen |
| paid_at | TIMESTAMPTZ | When the £500 was sent |
| paypal_batch_id | TEXT | PayPal's reference for the payout — for reconciliation |
| first_month_credit_applied | BOOLEAN | Whether the referee's free month has been credited |
| created_at | TIMESTAMPTZ | When the referral was recorded |

---

## welcome_packs

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | Who the pack is being sent to |
| delivery_address | TEXT (encrypted) | Physical delivery address — decrypted only at dispatch time |
| dispatch_id | TEXT | Postal.io or Sendoso reference for tracking |
| tracking_number | TEXT | Courier tracking number |
| status | TEXT | pending, dispatched, delivered, or failed |
| dispatched_at | TIMESTAMPTZ | When the pack was sent |
| delivered_at | TIMESTAMPTZ | When delivery was confirmed |
| created_at | TIMESTAMPTZ | When the record was created |

---

## birthday_gifts

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | Who the gift is for |
| year | INTEGER | The year the gift was sent — prevents sending twice in one year |
| delivery_address | TEXT (encrypted) | Physical address — decrypted only at dispatch |
| dispatch_id | TEXT | Postal.io or Sendoso reference |
| tracking_number | TEXT | Courier tracking number |
| status | TEXT | pending, dispatched, delivered, or failed |
| dispatched_at | TIMESTAMPTZ | When the gift was sent |
| created_at | TIMESTAMPTZ | When the record was created |

---

## anniversaries

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | Who the anniversary email was sent to |
| year | INTEGER | Which anniversary — 1, 2, 5 etc — prevents double sending |
| email_sent_at | TIMESTAMPTZ | When the email was sent |
| template_used | TEXT | Which email template was used — anniversary_1yr, 2yr, 5yr |

---

## certification_usage

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | One record per user — unique |
| session_hours | FLOAT | Accumulated active usage time |
| commands_run | INTEGER | Total commands executed — counts toward certification thresholds |
| pipelines_built | INTEGER | Total pipelines built — counts toward Professional and Expert levels |
| certification_level | TEXT | Current certification — null, associate, professional, or expert |
| eligible_at | TIMESTAMPTZ | When they first crossed the threshold for their next level |
| applied_at | TIMESTAMPTZ | When they submitted their exam application |
| certified_at | TIMESTAMPTZ | When certification was granted |
| credential_id | TEXT | Reference to tamper-proof ledger record — Stage 2 |
| last_activity_at | TIMESTAMPTZ | Last time they did anything — used for session tracking |

---

## admin_audit_log

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| admin_user_id | UUID | Which admin did this |
| action | TEXT | What they did — in plain English |
| target_type | TEXT | What they did it to — user, org, referral etc |
| target_id | UUID | The specific record they acted on |
| before_state | JSONB | Snapshot of the record before the change |
| after_state | JSONB | Snapshot of the record after the change |
| ip_address | TEXT | IP address they were on when they did it |
| created_at | TIMESTAMPTZ | When the action happened — immutable, no updates ever |

---

## subscriptions

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| org_id | UUID | Which firm — null for individual users |
| user_id | UUID | Which individual user — null for org subscriptions |
| stripe_subscription_id | TEXT | Stripe's reference for this subscription |
| stripe_customer_id | TEXT | Stripe's customer reference |
| module | TEXT | Which module this subscription item covers |
| seat_count | INTEGER | How many seats purchased for this module |
| price_per_seat_gbp | NUMERIC | The rate — £999 |
| billing_cycle | TEXT | Monthly or annual |
| status | TEXT | active, past_due, cancelled, or trialling |
| trial_end_at | TIMESTAMPTZ | When the trial expires |
| current_period_start | TIMESTAMPTZ | Start of current billing period |
| current_period_end | TIMESTAMPTZ | End of current billing period — when next charge happens |
| created_at | TIMESTAMPTZ | When the subscription started |
| updated_at | TIMESTAMPTZ | Last time it changed |

---

## invoices

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| org_id | UUID | Which firm was billed |
| stripe_invoice_id | TEXT | Stripe's reference — for reconciliation |
| amount_gbp | NUMERIC | How much was charged |
| currency | TEXT | GBP |
| status | TEXT | paid, open, or void |
| module | TEXT | Which module this invoice covers |
| seats_billed | INTEGER | How many seats were charged |
| billing_period_start | TIMESTAMPTZ | Start of the period this invoice covers |
| billing_period_end | TIMESTAMPTZ | End of the period this invoice covers |
| paid_at | TIMESTAMPTZ | When payment was confirmed |
| created_at | TIMESTAMPTZ | When Stripe created the invoice |

You are right — the schema is incomplete without indexes, RLS policies, and partitions. Here is everything missing.

---

## Indexes

Every frequently queried column needs an index. Without these the database does full table scans.

**organisations**

| Column | Index type | Why |
|---|---|---|
| stripe_customer_id | Unique | Stripe webhooks look this up on every payment event |
| status | Standard | Filter active orgs frequently |

**users**

| Column | Index type | Why |
|---|---|---|
| clerk_id | Unique | Looked up on every single API request during auth |
| org_id | Standard | List all users in an org frequently |
| stripe_customer_id | Standard | Individual billing webhook lookups |
| referral_code | Unique | Validate referral codes on signup |
| email | Standard | On the encrypted value — login and duplicate checks |
| is_active | Standard | Filter active users |

**admin_accounts**

| Column | Index type | Why |
|---|---|---|
| email | Unique | Admin login lookup |
| admin_role | Standard | Filter admins by role |
| is_active | Standard | Only check active admin accounts |

**waitlist**

| Column | Index type | Why |
|---|---|---|
| email | Standard | Duplicate check on submission |
| status | Standard | Filter leads by stage in CRM |
| assigned_to | Standard | Show leads assigned to a specific team member |
| invite_token | Unique | Validate token when a waitlist person clicks their invite link |

**enquiries**

| Column | Index type | Why |
|---|---|---|
| status | Standard | CRM filters by status constantly |
| assigned_to | Standard | Show enquiries assigned to a specific person |
| enquiry_type | Standard | Filter by type |
| follow_up_date | Standard | Daily scheduler and CRM sort by follow-up date |

**referral_codes**

| Column | Index type | Why |
|---|---|---|
| code | Unique | Validated on every signup with a referral link |
| user_id | Standard | Look up a user's referral code |

**referrals**

| Column | Index type | Why |
|---|---|---|
| referrer_user_id | Standard | Show all referrals made by a user |
| status | Standard | Filter by referral stage |
| eligible_at | Standard | Daily scheduler queries this to find referrals ready for payout |
| referee_user_id | Standard | Look up by referee after they sign up |

**welcome_packs**

| Column | Index type | Why |
|---|---|---|
| user_id | Standard | Check if a user already has a pack |
| status | Standard | Monitor dispatch status |

**birthday_gifts**

| Column | Index type | Why |
|---|---|---|
| user_id + year | Composite unique | Prevent sending two gifts in the same year |
| status | Standard | Monitor dispatch |

**anniversaries**

| Column | Index type | Why |
|---|---|---|
| user_id + year | Composite unique | Prevent sending duplicate anniversary emails |

**certification_usage**

| Column | Index type | Why |
|---|---|---|
| user_id | Unique | One record per user — already effectively a PK |
| certification_level | Standard | Filter certified users |

**admin_audit_log**

| Column | Index type | Why |
|---|---|---|
| admin_user_id | Standard | Find all actions by a specific admin |
| target_id | Standard | Find all actions taken on a specific record |
| created_at | Standard | Time-range queries on the audit log |

**subscriptions**

| Column | Index type | Why |
|---|---|---|
| org_id | Standard | Find all subscriptions for an org |
| user_id | Standard | Find all subscriptions for an individual user |
| stripe_subscription_id | Unique | Stripe webhook lookup |
| stripe_customer_id | Standard | Stripe customer lookup |
| status | Standard | Filter active subscriptions |
| module | Standard | Filter by module |

**invoices**

| Column | Index type | Why |
|---|---|---|
| org_id | Standard | Find all invoices for an org |
| stripe_invoice_id | Unique | Stripe webhook lookup |
| status | Standard | Filter unpaid invoices |
| paid_at | Standard | Date range queries |

---

## Row Level Security (RLS)

RLS policies enforce that users can only see and modify their own data at the database level — not just at the application level. This is a critical security layer for a multi-tenant product.

**organisations**

| Policy | Rule |
|---|---|
| Select | User can only see the org they belong to |
| Update | Only owner or admin role within the org |
| Insert | Any authenticated user can create an org |
| Delete | Super admin only |

**users**

| Policy | Rule |
|---|---|
| Select | User can see their own record AND other users in their org |
| Update | User can update their own record only — admin can update any user in their org |
| Insert | Clerk webhook service account only |
| Delete | Super admin only |

**org_roles**

| Policy | Rule |
|---|---|
| Select | Users can see roles belonging to their org |
| Insert / Update / Delete | Owner or admin within that org |

**waitlist**

| Policy | Rule |
|---|---|
| Select | Admin accounts only — users cannot see the waitlist |
| Insert | Public — anyone can submit |
| Update | Admin accounts only |

**enquiries**

| Policy | Rule |
|---|---|
| Select | Admin accounts only |
| Insert | Public — anyone can submit |
| Update | Admin accounts only |

**referral_codes**

| Policy | Rule |
|---|---|
| Select | User can only see their own referral code |
| Insert | System account on user creation only |

**referrals**

| Policy | Rule |
|---|---|
| Select | Referrer can see referrals they made — admin can see all |
| Insert / Update | System account only |

**welcome_packs / birthday_gifts / anniversaries**

| Policy | Rule |
|---|---|
| Select | User can see their own records — admin can see all |
| Insert / Update | System account and admin only |

**certification_usage**

| Policy | Rule |
|---|---|
| Select | User can see their own record — admin can see all |
| Update | System account only — users cannot manually edit their usage |

**subscriptions**

| Policy | Rule |
|---|---|
| Select | Org owners and admins can see their org's subscriptions — individual users can see their own |
| Insert / Update | Stripe webhook service account and admin only |

**invoices**

| Policy | Rule |
|---|---|
| Select | Org owners and admins can see their org's invoices |
| Insert / Update | Stripe webhook service account only |

**admin_audit_log**

| Policy | Rule |
|---|---|
| Select | Admin accounts only |
| Insert | Admin service account only |
| Update / Delete | Nobody — immutable by policy |

---

## Partitions

Tables that will grow large and are queried by time or year need partitioning to keep performance stable.

**admin_audit_log — partition by month**

This table is written to constantly and grows indefinitely. Queries always filter by date range. Partition by month means old months become small archived tables and current month queries stay fast.

**invoices — partition by year/month**

Financial records grow over time. Billing queries almost always filter by period. Partitioning by billing period keeps range queries fast.

**birthday_gifts — partition by year**

The daily scheduler only ever queries the current year. Partitioning by year means the scheduler never scans historical data.

**anniversaries — partition by year**

Same reasoning as birthday_gifts — the daily scheduler only queries the current year.

---

## Missing Tables Identified

Three more tables are needed that were not in the original spec:

**sessions** — track active login sessions per user for security monitoring and forced logout capability

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique session identifier |
| user_id | UUID | Which user this session belongs to |
| device_id | TEXT | Hardware fingerprint of the device |
| ip_address | TEXT | IP at login time |
| created_at | TIMESTAMPTZ | Session start |
| last_active_at | TIMESTAMPTZ | Last request time — used for idle timeout |
| expires_at | TIMESTAMPTZ | Hard expiry |
| revoked_at | TIMESTAMPTZ | If the session was force-logged-out |

**email_logs** — record every email sent to prevent duplicates and enable debugging

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Unique identifier |
| user_id | UUID | Who it was sent to |
| template | TEXT | Which email template was used |
| sent_at | TIMESTAMPTZ | When it was sent |
| provider_id | TEXT | Resend or SendGrid message ID for delivery tracking |
| status | TEXT | sent, delivered, bounced, failed |

**migrations** — track which SQL migration files have been run

| Column | Type | Purpose |
|---|---|---|
| id | SERIAL | Auto-incrementing run order |
| filename | TEXT | The migration file name |
| run_at | TIMESTAMPTZ | When it was executed |