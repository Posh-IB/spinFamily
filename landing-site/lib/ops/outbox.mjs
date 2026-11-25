// Notifications outbox (R2-04). Messages are written in the same transaction as the change that
// causes them, so a rolled-back change sends nothing and a committed one is never silently lost.
// They are sent after commit by drainOutbox, which claims rows with SKIP LOCKED so two requests
// never send the same message.
import { newId, iso } from './util.mjs';

export const MAX_ATTEMPTS = 5;

export async function enqueue(env, member, subject, body) {
  if (!member) return null;
  const id = newId('nt');
  await env.sql`INSERT INTO notifications_outbox (id, org_id, member_id, subject, body, created_at) VALUES (${id}, ${env.orgId}, ${member.id}, ${subject.slice(0, 150)}, ${body.slice(0, 5000)}, ${iso(env.now())})`;
  return id;
}

export function mailFor(deps, to, subject, body) {
  return { from: { name: 'SpinFamily Operations', address: deps.mailbox }, replyTo: deps.mailbox, to: { address: to.email, name: '' }, subject: subject.slice(0, 150), text: `Hi ${to.name.split(' ')[0]},\n\n${body}\n\nSpinFamily Operations\nA Rootlayer Software LLC product.`, disableFileAccess: true, disableUrlAccess: true };
}

// Delivery is at-least-once with a visible "uncertain" state, never claimed exactly-once:
//  1. claim: queued/failed -> 'sending' (attempt recorded) in its own committed transaction
//  2. send over SMTP, outside any transaction
//  3. record 'sent', or 'failed' when the mail server refused before accepting (safe to retry)
// A row left in 'sending' (process died between 2 and 3) may or may not have been delivered: after
// SENDING_STALE_MS it becomes 'uncertain' and is not retried automatically; the founder sees it.
export const SENDING_STALE_MS = 10 * 60 * 1000;
export async function drainOutbox(deps, limit = 10) {
  const at = () => iso(deps.now());
  await deps.sql`UPDATE notifications_outbox SET status = 'uncertain', last_error = 'outcome_not_recorded' WHERE org_id = ${deps.orgId} AND status = 'sending' AND last_attempt_at < ${iso(deps.now() - SENDING_STALE_MS)}`;
  let sent = 0;
  for (let i = 0; i < limit; i++) {
    const n = await deps.tx(async sql => (await sql`UPDATE notifications_outbox o SET status = 'sending', attempts = attempts + 1, last_attempt_at = ${at()}
      WHERE o.id = (SELECT id FROM notifications_outbox WHERE org_id = ${deps.orgId} AND status IN ('queued', 'failed') AND attempts < ${MAX_ATTEMPTS} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.subject, o.body, o.member_id`)[0]);
    if (!n) break;
    const to = (await deps.sql`SELECT m.email, m.name, ms.status FROM members m LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.id = ${n.member_id}`)[0];
    if (!to || to.status === 'revoked') { await deps.sql`UPDATE notifications_outbox SET status = 'failed', attempts = ${MAX_ATTEMPTS}, last_error = 'recipient_revoked' WHERE id = ${n.id}`; continue; }
    try {
      await deps.sendMail(mailFor(deps, to, n.subject, n.body));
    } catch (e) {
      // Only errors that happen before the server could have accepted the message are safe to retry.
      const before = ['ECONNREFUSED', 'EDNS', 'EAUTH', 'EENVELOPE', 'ECONNECTION'].includes(e?.code) || /not accepted|turned off|unavailable/.test(e?.message || '');
      if (!before) { await deps.sql`UPDATE notifications_outbox SET status = 'uncertain', last_error = ${String(e?.code || e?.name || 'unknown').slice(0, 60)} WHERE id = ${n.id}`; break; }
      await deps.sql`UPDATE notifications_outbox SET status = 'failed', last_error = ${String(e?.code || e?.name || 'send_failed').slice(0, 60)} WHERE id = ${n.id}`;
      break; // mail is down; try again on the next request
    }
    await deps.sql`UPDATE notifications_outbox SET status = 'sent', sent_at = ${at()}, last_error = NULL WHERE id = ${n.id}`;
    sent++;
  }
  return sent;
}

export async function outboxHealth(deps) {
  return (await deps.sql`SELECT count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain, count(*) FILTER (WHERE status = 'failed' AND attempts >= ${MAX_ATTEMPTS})::int AS gave_up, count(*) FILTER (WHERE status IN ('queued', 'failed') AND attempts < ${MAX_ATTEMPTS})::int AS waiting FROM notifications_outbox WHERE org_id = ${deps.orgId}`)[0];
}
