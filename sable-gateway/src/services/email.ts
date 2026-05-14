// Transactional email via Resend. Every send mirrors into
// gateway.email_logs (status + provider message id only — no recipient
// PII on the log row).
//
// Templates are inlined HTML+text. Variable substitution is `{{name}}`
// style and intentionally trivial — keep template logic in the caller,
// not here. Failures throw INTERNAL_ERROR; the email_logs row is still
// written with status='failed' so the audit trail stays complete.

import { Resend } from 'resend';
import { AppError, optionalEnv, requireEnv, type Sql } from 'sable-shared';

import * as emailLogsDb from '../db/emailLogs.js';

let cached: Resend | undefined;

function client(): Resend {
  cached ??= new Resend(requireEnv('RESEND_API_KEY'));
  return cached;
}

function fromAddress(): string {
  return optionalEnv('EMAIL_FROM') ?? 'Sable <no-reply@sable.fund>';
}

function appUrl(): string {
  return optionalEnv('APP_URL') ?? 'http://localhost:8080';
}

export type EmailTemplate =
  | 'email_verification'
  | 'password_reset'
  | 'org_invite'
  | 'subscription_past_due'
  | 'subscription_cancelled'
  | 'founding_customer_welcome';

export interface SendInput {
  sql: Sql;
  to: string;
  template: EmailTemplate;
  userId?: string | null;
  variables: Record<string, string>;
}

export async function send(input: SendInput): Promise<{ providerMessageId: string }> {
  const tpl = TEMPLATES[input.template];
  const subject = render(tpl.subject, input.variables);
  const html = render(tpl.html, input.variables);
  const text = render(tpl.text, input.variables);

  try {
    const res = await client().emails.send({
      from: fromAddress(),
      to: input.to,
      subject,
      html,
      text,
    });
    if (res.error) {
      await emailLogsDb.append(input.sql, {
        userId: input.userId ?? null,
        template: input.template,
        providerId: null,
        status: 'failed',
      });
      throw new AppError('INTERNAL_ERROR', { message: `Resend rejected: ${res.error.message}` });
    }
    const id = res.data?.id ?? null;
    await emailLogsDb.append(input.sql, {
      userId: input.userId ?? null,
      template: input.template,
      providerId: id,
      status: 'sent',
    });
    return { providerMessageId: id ?? '' };
  } catch (err) {
    if (AppError.is(err)) throw err;
    await emailLogsDb
      .append(input.sql, {
        userId: input.userId ?? null,
        template: input.template,
        providerId: null,
        status: 'failed',
      })
      .catch(() => undefined);
    throw new AppError('INTERNAL_ERROR', { message: 'Resend send failed', cause: err });
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers — call sites stay one-liners.
// ---------------------------------------------------------------------------

export async function sendVerification(sql: Sql, to: string, userId: string, token: string): Promise<void> {
  const url = `${appUrl()}/auth/verify?token=${encodeURIComponent(token)}`;
  await send({ sql, to, userId, template: 'email_verification', variables: { url } });
}

export async function sendPasswordReset(sql: Sql, to: string, userId: string | null, token: string): Promise<void> {
  const url = `${appUrl()}/auth/password/reset/confirm?token=${encodeURIComponent(token)}`;
  await send({ sql, to, userId, template: 'password_reset', variables: { url } });
}

export async function sendOrgInvite(sql: Sql, to: string, inviterName: string, orgName: string, token: string): Promise<void> {
  const url = `${appUrl()}/orgs/invites/accept?token=${encodeURIComponent(token)}`;
  await send({ sql, to, userId: null, template: 'org_invite', variables: { url, inviter: inviterName, org: orgName } });
}

// ---------------------------------------------------------------------------
// Templates. Keep them short — the surrounding layout is a Sable concern,
// not a Resend one.
// ---------------------------------------------------------------------------

interface Template {
  subject: string;
  html: string;
  text: string;
}

const TEMPLATES: Record<EmailTemplate, Template> = {
  email_verification: {
    subject: 'Verify your Sable email',
    html: `<p>Welcome to Sable.</p><p>Confirm your email address to finish signing up: <a href="{{url}}">{{url}}</a></p><p>This link expires in 24 hours.</p>`,
    text: `Welcome to Sable.\n\nConfirm your email to finish signing up: {{url}}\n\nThis link expires in 24 hours.`,
  },
  password_reset: {
    subject: 'Reset your Sable password',
    html: `<p>We received a request to reset your password.</p><p>If it was you: <a href="{{url}}">{{url}}</a></p><p>This link expires in 1 hour. If you didn't request a reset, ignore this email — your password is unchanged.</p>`,
    text: `We received a request to reset your password.\n\nIf it was you: {{url}}\n\nThis link expires in 1 hour. If you didn't request a reset, ignore this email — your password is unchanged.`,
  },
  org_invite: {
    subject: 'You have been invited to {{org}} on Sable',
    html: `<p>{{inviter}} has invited you to join <b>{{org}}</b> on Sable.</p><p>Accept the invite: <a href="{{url}}">{{url}}</a></p><p>This invite expires in 7 days.</p>`,
    text: `{{inviter}} has invited you to join {{org}} on Sable.\n\nAccept the invite: {{url}}\n\nThis invite expires in 7 days.`,
  },
  subscription_past_due: {
    subject: 'Your Sable subscription is past due',
    html: `<p>Your Sable subscription payment didn't go through.</p><p>Update your payment method to restore access: <a href="{{url}}">{{url}}</a></p>`,
    text: `Your Sable subscription payment didn't go through.\n\nUpdate your payment method to restore access: {{url}}`,
  },
  subscription_cancelled: {
    subject: 'Your Sable subscription has been cancelled',
    html: `<p>Your Sable subscription has been cancelled. You'll keep access until the end of the current billing period ({{endDate}}).</p>`,
    text: `Your Sable subscription has been cancelled. You'll keep access until the end of the current billing period ({{endDate}}).`,
  },
  founding_customer_welcome: {
    subject: 'Welcome to Sable — founding customer onboarding',
    html: `<p>Welcome to Sable, {{name}}.</p><p>Your founding-customer onboarding starts here: <a href="{{url}}">{{url}}</a></p>`,
    text: `Welcome to Sable, {{name}}.\n\nYour founding-customer onboarding starts here: {{url}}`,
  },
};

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}
