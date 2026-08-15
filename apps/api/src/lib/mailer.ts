import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { outboundEmails } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Outbound mail. Two transports:
 *
 *  - "store": the email is only written to `outbound_emails` (the dev mailbox)
 *    and the action link is logged, so magic links work with no SMTP server.
 *  - "smtp": real delivery via nodemailer; every attempt is still recorded in
 *    `outbound_emails` (including the error) so what left the system is auditable.
 *
 * `sendMail` NEVER throws: a mail failure must not fail the request that
 * triggered it — in particular, magic-link responses must look identical
 * whether or not an email actually went out.
 */

export interface MailInput {
  to: string;
  subject: string;
  body: string;
  /** Primary action link (e.g. a magic link), surfaced in the dev mailbox UI. */
  link?: string | null;
}

/* ── SMTP transport (lazy singleton) ─────────────────────────────────────── */

let smtpTransport: Transporter | null = null;

function getSmtpTransport(): Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // Only authenticate when credentials are configured (mailpit et al need none).
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return smtpTransport;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export async function sendMail(input: MailInput): Promise<void> {
  const link = input.link ?? null;

  if (env.MAIL_TRANSPORT === 'store') {
    try {
      await db.insert(outboundEmails).values({
        toAddress: input.to,
        subject: input.subject,
        body: input.body,
        link,
        transport: 'store',
      });
      // Deliberate: in store mode the link IS the delivery mechanism for local dev.
      logger.info({ to: input.to, subject: input.subject, link }, 'outbound email stored (dev mailbox)');
    } catch (err) {
      logger.error({ err, subject: input.subject }, 'failed to store outbound email');
    }
    return;
  }

  // MAIL_TRANSPORT === 'smtp'
  let error: string | null = null;
  try {
    await getSmtpTransport().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, subject: input.subject }, 'smtp delivery failed');
  }

  try {
    await db.insert(outboundEmails).values({
      toAddress: input.to,
      subject: input.subject,
      body: input.body,
      link,
      transport: 'smtp',
      error,
    });
  } catch (err) {
    logger.error({ err, subject: input.subject }, 'failed to record outbound email');
  }
}
