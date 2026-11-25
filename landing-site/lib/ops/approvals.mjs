// Approvals inbox: one place for everything that needs the founder's OK before it goes outside the team.
import { json, notFound, Invalid, newId, iso, text, oneOf, rows, row, asJson } from './util.mjs';
import { orgMembers, memberById, sendTo } from './core.mjs';

const CHANNELS = ['email', 'text', 'dm', 'in_person', 'other'];
const toApproval = r => { const a = row(r); return { id: a.id, itemType: a.item_type, itemId: a.item_id, title: a.title, summary: a.summary, payload: a.payload, submittedBy: a.submitted_by, submittedByName: a.submitted_by_name, submittedAt: a.submitted_at, status: a.status, decidedBy: a.decided_by, decidedAt: a.decided_at, decisionNote: a.decision_note }; };

// Called by other modules (docs, content, research) and by the "send a draft for review" form.
export async function submitForApproval(env, { itemType, itemId = null, title, summary = '', payload = {} }) {
  // One open request per item: resubmitting replaces the earlier pending one.
  if (itemId) await env.sql`UPDATE approvals SET status = 'withdrawn', decided_at = ${iso(env.now())}, decision_note = 'Replaced by a newer submission' WHERE org_id = ${env.orgId} AND item_type = ${itemType} AND item_id = ${itemId} AND status IN ('pending', 'changes_requested')`;
  const id = newId('ap');
  await env.sql`INSERT INTO approvals (id, org_id, item_type, item_id, title, summary, payload, submitted_by, submitted_at, status)
    VALUES (${id}, ${env.orgId}, ${itemType}, ${itemId}, ${title.slice(0, 200)}, ${summary.slice(0, 1000)}, ${asJson(payload)}::jsonb, ${env.member.id}, ${iso(env.now())}, 'pending')`;
  await env.audit('approval.submitted', id, { itemType });
  if (env.member.role !== 'founder') {
    for (const f of (await orgMembers(env)).filter(m => m.role === 'founder' && m.status === 'active')) {
      try { await sendTo(env, f, `Needs your OK: ${title}`, `${env.member.name} sent something for your review:\n\n${title}\n\nReview it: ${env.origin}/operations/#/approvals`); } catch { await env.audit('approval.notify_failed', id); }
    }
  }
  return id;
}

async function applyDecision(env, a, decision, body) {
  const approved = decision === 'approved';
  const now = iso(env.now());
  switch (a.itemType) {
    case 'document': {
      const { parseAudience } = await import('./docs.mjs');
      const audience = approved ? await parseAudience(body.audience ?? 'team', env) : 'founder';
      await env.sql`UPDATE documents SET approval = ${approved ? 'approved' : 'draft'}, audience = ${asJson(audience)}::jsonb, updated_at = ${now} WHERE id = ${a.itemId} AND org_id = ${env.orgId}`;
      break;
    }
    case 'content_post':
      await env.sql`UPDATE content_posts SET status = ${approved ? 'approved' : 'changes_requested'}, updated_at = ${now} WHERE id = ${a.itemId} AND org_id = ${env.orgId} AND status = 'in_review'`;
      break;
    case 'offer':
      if (approved) await env.sql`UPDATE relationships SET offer_approved = true, updated_at = ${now}, version = version + 1 WHERE id = ${a.itemId} AND org_id = ${env.orgId}`;
      break;
    case 'survey':
      if (approved) {
        await env.sql`UPDATE survey_definitions SET status = 'retired' WHERE org_id = ${env.orgId} AND status = 'approved' AND title = (SELECT title FROM survey_definitions WHERE id = ${a.itemId}) AND id <> ${a.itemId}`;
        await env.sql`UPDATE survey_definitions SET status = 'approved', approved_by = ${env.member.id}, approved_at = ${now} WHERE id = ${a.itemId} AND org_id = ${env.orgId} AND status = 'draft'`;
      }
      break;
    case 'message': break; // nothing is sent by the workspace; the submitter sends it once approved
  }
}

export async function approvalRoutes(parts, method, body, env) {
  const me = env.member;
  env.need('approvals.submit');
  const all = env.has('approvals.view.all');
  if (method === 'GET' && !parts.length) {
    const list = await env.sql`SELECT a.*, m.name AS submitted_by_name FROM approvals a JOIN members m ON m.id = a.submitted_by
      WHERE a.org_id = ${env.orgId} AND (${all} OR a.submitted_by = ${me.id}) ORDER BY (a.status = 'pending') DESC, a.submitted_at DESC LIMIT 300`;
    return json({ approvals: list.map(toApproval), scope: all ? 'all' : 'mine', channels: CHANNELS });
  }
  // Send a message draft or an offer for review. (Docs, posts and surveys are sent from their own screens.)
  if (method === 'POST' && !parts.length) {
    const type = oneOf(body.itemType, 'type', ['message', 'offer']);
    if (type === 'message') {
      const payload = { channel: oneOf(body.channel, 'channel', CHANNELS), to: text(body.to, 'Who it goes to', 120, { required: true }), message: text(body.message, 'Message', 3000, { required: true }) };
      const id = await submitForApproval(env, { itemType: 'message', title: `Message to ${payload.to}`, summary: payload.message.slice(0, 300), payload });
      return json({ id }, 201);
    }
    const rel = (await env.sql`SELECT id, contact_name, organization FROM relationships WHERE id = ${text(body.relationshipId, 'relationship', 40, { required: true })} AND org_id = ${env.orgId}`)[0];
    if (!rel) throw new Invalid('Unknown relationship');
    const offer = text(body.offer, 'What you want to offer', 1000, { required: true });
    const id = await submitForApproval(env, { itemType: 'offer', itemId: rel.id, title: `Offer to ${rel.contact_name} (${rel.organization})`, summary: offer, payload: { offer } });
    return json({ id }, 201);
  }
  if (parts[0]) {
    const r = (await env.sql`SELECT a.*, m.name AS submitted_by_name FROM approvals a JOIN members m ON m.id = a.submitted_by WHERE a.id = ${parts[0]} AND a.org_id = ${env.orgId}`)[0];
    if (!r) return notFound();
    const a = toApproval(r);
    if (!all && a.submittedBy !== me.id) return notFound();
    if (method === 'POST' && parts[1] === 'decide') {
      env.need('approvals.decide');
      const decision = oneOf(body.decision, 'decision', ['approved', 'changes_requested']);
      const note = text(body.note, 'Note', 1000);
      if (decision === 'changes_requested' && !note) throw new Invalid('Say what needs to change');
      // Only a pending item can be decided, and only once.
      const done = await env.sql`UPDATE approvals SET status = ${decision}, decided_by = ${me.id}, decided_at = ${iso(env.now())}, decision_note = ${note} WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
      if (!done[0]) throw new Invalid('This was already decided or withdrawn. Reload to see the latest.');
      await applyDecision(env, a, decision, body);
      await env.audit(`approval.${decision}`, a.id, { itemType: a.itemType });
      const submitter = await memberById(env, a.submittedBy);
      if (submitter && submitter.id !== me.id) {
        try { await sendTo(env, submitter, decision === 'approved' ? `Approved: ${a.title}` : `Changes requested: ${a.title}`, `${me.name} ${decision === 'approved' ? 'approved' : 'asked for changes to'} "${a.title}".${note ? `\n\nNote: ${note}` : ''}\n\nSee it here: ${env.origin}/operations/#/approvals`); } catch { await env.audit('approval.notify_failed', a.id); }
      }
      return json({ approval: toApproval((await env.sql`SELECT a.*, m.name AS submitted_by_name FROM approvals a JOIN members m ON m.id = a.submitted_by WHERE a.id = ${a.id}`)[0]) });
    }
    if (method === 'POST' && parts[1] === 'withdraw') {
      if (a.submittedBy !== me.id) return notFound();
      const done = await env.sql`UPDATE approvals SET status = 'withdrawn', decided_at = ${iso(env.now())} WHERE id = ${a.id} AND status IN ('pending', 'changes_requested') RETURNING id`;
      if (!done[0]) throw new Invalid('This was already decided.');
      if (a.itemType === 'content_post') await env.sql`UPDATE content_posts SET status = 'draft' WHERE id = ${a.itemId} AND status = 'in_review'`;
      await env.audit('approval.withdrawn', a.id);
      return json({ ok: true });
    }
  }
  return notFound();
}
void rows;
