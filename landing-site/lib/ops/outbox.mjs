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

export async function drainOutbox(deps, limit = 10) {
  let sent = 0;
  for (let i = 0; i < limit; i++) {
    const outcome = await deps.tx(async sql => {
      const n = (await sql`SELECT o.id, o.subject, o.body, o.attempts, m.email, m.name, ms.status
        FROM notifications_outbox o JOIN members m ON m.id = o.member_id LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = o.org_id
        WHERE o.org_id = ${deps.orgId} AND o.sent_at IS NULL AND o.attempts < ${MAX_ATTEMPTS}
        ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`)[0];
      if (!n) return 'empty';
      const at = iso(deps.now());
      if (n.status === 'revoked') { await sql`UPDATE notifications_outbox SET attempts = ${MAX_ATTEMPTS}, last_attempt_at = ${at}, last_error = 'recipient_revoked' WHERE id = ${n.id}`; return 'skipped'; }
      try {
        await deps.sendMail(mailFor(deps, n, n.subject, n.body));
        await sql`UPDATE notifications_outbox SET sent_at = ${at}, attempts = attempts + 1, last_attempt_at = ${at}, last_error = NULL WHERE id = ${n.id}`;
        return 'sent';
      } catch (e) {
        await sql`UPDATE notifications_outbox SET attempts = attempts + 1, last_attempt_at = ${at}, last_error = ${String(e?.code || e?.name || 'send_failed').slice(0, 60)} WHERE id = ${n.id}`;
        return 'failed';
      }
    });
    if (outcome === 'empty') break;
    if (outcome === 'sent') sent++;
    if (outcome === 'failed') break; // mail is down; try again on the next request
  }
  return sent;
}
