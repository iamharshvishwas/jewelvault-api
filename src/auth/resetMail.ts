// Forgot password by e-mail: the words of the mail that carries a reset link (DESIGN.md of password-help-2026-11-26, part 2, "The mail"). Plain text and simple HTML that say the same things: whose
// password someone asked to reset, the link, that it works once within 30 minutes, and that a person who did not ask can ignore the mail. Nothing here sends or logs anything (src/mail/mailer.ts sends;
// src/auth/resetRoutes.ts decides who gets it): the message holds an address and a token, and is handed to the mailer and to nobody else.
import type { MailMessage } from '../mail/mailer.js';

export const RESET_MAIL_SUBJECT = 'Reset your password: Jaishri Gold Palace';

/** The HTML form of a text: the five characters that mean something in HTML are written as entities. */
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The mail to `to` (the login's own e-mail, as stored) with `link` (`<JV_RESET_LINK_BASE>#t=<token>`). */
export function resetMail(to: string, link: string): MailMessage {
  const text = [
    `Someone asked to reset the CRM password of ${to}.`,
    '',
    'To choose a new password, open this link:',
    link,
    '',
    'The link works once, within 30 minutes.',
    '',
    'If it was not you, ignore this mail: your password stays as it is.',
    '',
    'Jaishri Gold Palace',
    '',
  ].join('\n');
  const html = [
    `<p>Someone asked to reset the CRM password of <strong>${escapeHtml(to)}</strong>.</p>`,
    `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`,
    `<p>Or copy this link into your browser:<br>${escapeHtml(link)}</p>`,
    '<p>The link works once, within 30 minutes.</p>',
    '<p>If it was not you, ignore this mail: your password stays as it is.</p>',
    '<p>Jaishri Gold Palace</p>',
  ].join('\n');
  return { to, subject: RESET_MAIL_SUBJECT, text, html };
}
