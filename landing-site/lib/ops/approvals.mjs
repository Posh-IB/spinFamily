// Approvals inbox: one place for everything that needs the founder's OK before it goes outside the team.
//
// R2-04: an approval is for one exact, immutable version of the item. Submitting stores the complete
// reviewable content (snapshot), its SHA-256 digest and the item's version. Any edit to the item
// supersedes the pending request in the same transaction. Deciding re-reads the item under lock and
// refuses if it no longer matches the snapshot; decision, item change, audit and the notification
// to the submitter are one transaction.
import { sha256 } from './security.mjs';
import { json, notFound, Invalid, newId, iso, text, oneOf, row, asJson } from './util.mjs';
import { orgMembers, memberById } from './core.mjs';
import { inTx, barrier } from './db.mjs';
import { enqueue } from './outbox.mjs';

const CHANNELS = ['email', 'text', 'dm', 'in_person', 'other'];
const toApproval = r => { const a = row(r); return { id: a.id, itemType: a.item_type, itemId: a.item_id, itemVersion: a.item_version, title: a.title, summary: a.summary, payload: a.payload, snapshot: a.snapshot, digest: a.digest, submittedBy: a.submitted_by, submittedByName: a.submitted_by_name, submittedAt: a.submitted_at, status: a.status, decidedBy: a.decided_by, decidedAt: a.decided_at, decisionNote: a.decision_note }; };

export class Stale extends Error { constructor(m) { super(m); this.stale = true; } }

// Canonical JSON (sorted keys) so the same content always has the same digest.
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
export const digestOf = snapshot => sha256(canon(snapshot));

// The complete reviewable content of an item, read under lock. null if the item is gone.
export async function currentItem(t, itemType, itemId) {
  if (itemType === 'document') {
    const d = (await t.sql`SELECT id, version, kind, title, url, intended_use, category, file_name, content_type, size, file_sha256 FROM documents WHERE id = ${itemId} AND org_id = ${t.orgId} FOR UPDATE`)[0];
    return d && { version: d.version, snapshot: { kind: d.kind, title: d.title, url: d.url, intendedUse: d.intended_use, category: d.category, fileName: d.file_name, contentType: d.content_type, size: d.size, fileSha256: d.file_sha256 } };
  }
  if (itemType === 'content_post') {
    const c = (await t.sql`SELECT c.id, c.version, c.channel, c.planned_date::text AS planned_date, c.caption, c.ref_link, c.asset_document_id, d.version AS asset_version, d.title AS asset_title, d.file_sha256 AS asset_sha
      FROM content_posts c LEFT JOIN documents d ON d.id = c.asset_document_id WHERE c.id = ${itemId} AND c.org_id = ${t.orgId} FOR UPDATE OF c`)[0];
    return c && { version: c.version, snapshot: { channel: c.channel, plannedDate: c.planned_date, caption: c.caption, refLink: c.ref_link, asset: c.asset_document_id ? { id: c.asset_document_id, version: c.asset_version, title: c.asset_title, sha256: c.asset_sha } : null } };
  }
  if (itemType === 'survey') {
    const s = (await t.sql`SELECT id, revision, title, version, intro, questions FROM survey_definitions WHERE id = ${itemId} AND org_id = ${t.orgId} FOR UPDATE`)[0];
    return s && { version: s.revision, snapshot: { title: s.title, version: s.version, intro: s.intro, questions: s.questions } };
  }
  if (itemType === 'offer') {
    const r = (await t.sql`SELECT id, contact_name, organization FROM relationships WHERE id = ${itemId} AND org_id = ${t.orgId} FOR UPDATE`)[0];
    return r && { version: null, snapshot: { contactName: r.contact_name, organization: r.organization } };
  }
  return null;
}

// Any edit to an item calls this in the edit's own transaction.
export async function supersedePending(t, itemType, itemId, why = 'Changed after it was sent for review') {
  return (await t.sql`UPDATE approvals SET status = 'superseded', decided_at = ${iso(t.now())}, decision_note = ${why} WHERE org_id = ${t.orgId} AND item_type = ${itemType} AND item_id = ${itemId} AND status IN ('pending', 'changes_requested') RETURNING id`).length;
}

// Must run inside the transaction that holds the item's lock (callers use inTx).
export async function submitForApproval(env, { itemType, itemId = null, title, summary = '', payload = {} }) {
  return inTx(env, async t => {
    let version = null, snapshot = { ...payload };
    if (itemId) {
      const cur = await currentItem(t, itemType, itemId);
      if (!cur) throw new Invalid('That item no longer exists');
      version = cur.version;
      snapshot = { ...cur.snapshot, ...(itemType === 'offer' ? { offer: payload.offer } : {}) };
      await supersedePending(t, itemType, itemId, 'Replaced by a newer submission');
    }
    const id = newId('ap');
    await t.sql`INSERT INTO approvals (id, org_id, item_type, item_id, item_version, title, summary, payload, snapshot, digest, submitted_by, submitted_at, status)
      VALUES (${id}, ${t.orgId}, ${itemType}, ${itemId}, ${version}, ${title.slice(0, 200)}, ${summary}, ${asJson(payload)}::jsonb, ${asJson(snapshot)}::jsonb, ${digestOf(snapshot)}, ${t.member.id}, ${iso(t.now())}, 'pending')`;
    await t.audit('approval.submitted', id, { itemType });
    if (t.member.role !== 'founder')
      for (const f of (await orgMembers(t)).filter(m => m.role === 'founder' && m.status === 'active'))
        await enqueue(t, f, `Needs your OK: ${title}`, `${t.member.name} sent something for your review:\n\n${title}\n\nReview it: ${t.origin}/operations/#/approvals`);
    return id;
  });
}

async function applyDecision(t, a, decision, body) {
  const approved = decision === 'approved';
  const now = iso(t.now());
  const one = rows => { if (!rows.length) throw new Stale('This item changed after it was sent for review. Ask for it to be sent again.'); };
  switch (a.itemType) {
    case 'document': {
      const { parseAudience } = await import('./docs.mjs');
      const audience = approved ? await parseAudience(body.audience ?? 'team', t) : 'founder';
      one(await t.sql`UPDATE documents SET approval = ${approved ? 'approved' : 'draft'}, audience = ${asJson(audience)}::jsonb, updated_at = ${now} WHERE id = ${a.itemId} AND org_id = ${t.orgId} AND version = ${a.itemVersion} RETURNING id`);
      break;
    }
    case 'content_post':
      one(await t.sql`UPDATE content_posts SET status = ${approved ? 'approved' : 'changes_requested'}, updated_at = ${now} WHERE id = ${a.itemId} AND org_id = ${t.orgId} AND status = 'in_review' AND version = ${a.itemVersion} RETURNING id`);
      break;
    case 'offer':
      if (approved) one(await t.sql`UPDATE relationships SET offer_approved = true, updated_at = ${now}, version = version + 1 WHERE id = ${a.itemId} AND org_id = ${t.orgId} RETURNING id`);
      break;
    case 'survey':
      if (approved) {
        // Retire the previous approved version and approve this exact revision together; the unique
        // index guarantees there is never more than one approved version of a questionnaire.
        await t.sql`UPDATE survey_definitions SET status = 'retired' WHERE org_id = ${t.orgId} AND status = 'approved' AND title = (SELECT title FROM survey_definitions WHERE id = ${a.itemId}) AND id <> ${a.itemId}`;
        await barrier(t, 'approval.survey.retired');
        one(await t.sql`UPDATE survey_definitions SET status = 'approved', approved_by = ${t.member.id}, approved_at = ${now} WHERE id = ${a.itemId} AND org_id = ${t.orgId} AND status = 'draft' AND revision = ${a.itemVersion} RETURNING id`);
      }
      break;
    case 'message': break; // nothing is sent by the workspace; the submitter sends it once approved
  }
}

const SELECT_ONE = (sql, id) => sql`SELECT a.*, m.name AS submitted_by_name FROM approvals a JOIN members m ON m.id = a.submitted_by WHERE a.id = ${id}`;

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
      const id = await submitForApproval(env, { itemType: 'message', title: `Message to ${payload.to}`, summary: payload.message, payload });
      return json({ id }, 201);
    }
    const rel = (await env.sql`SELECT id, contact_name, organization FROM relationships WHERE id = ${text(body.relationshipId, 'relationship', 40, { required: true })} AND org_id = ${env.orgId}`)[0];
    if (!rel) throw new Invalid('Unknown relationship');
    const offer = text(body.offer, 'What you want to offer', 1000, { required: true });
    const id = await submitForApproval(env, { itemType: 'offer', itemId: rel.id, title: `Offer to ${rel.contact_name} (${rel.organization})`, summary: offer, payload: { offer } });
    return json({ id }, 201);
  }
  if (parts[0]) {
    const r = (await SELECT_ONE(env.sql, parts[0]))[0];
    if (!r || r.org_id !== env.orgId) return notFound();
    const a0 = toApproval(r);
    if (!all && a0.submittedBy !== me.id) return notFound();
    if (method === 'POST' && parts[1] === 'decide') {
      env.need('approvals.decide');
      const decision = oneOf(body.decision, 'decision', ['approved', 'changes_requested']);
      const note = text(body.note, 'Note', 1000);
      if (decision === 'changes_requested' && !note) throw new Invalid('Say what needs to change');
      // The founder decides on the digest they were shown; if it moved on, nothing is decided.
      if (body.digest !== undefined && body.digest !== a0.digest) throw new Stale('This request was replaced. Reload to review the latest version.');
      try {
        await inTx(env, async t => {
          const a = toApproval((await t.sql`SELECT a.*, '' AS submitted_by_name FROM approvals a WHERE a.id = ${a0.id} FOR UPDATE`)[0]);
          if (a.status !== 'pending') throw new Invalid('This was already decided, withdrawn or replaced. Reload to see the latest.');
          if (a.itemId) {
            const cur = await currentItem(t, a.itemType, a.itemId);
            const snap = cur && (a.itemType === 'offer' ? { ...cur.snapshot, offer: a.snapshot?.offer } : cur.snapshot);
            if (!cur || !a.digest || digestOf(snap) !== a.digest || (cur.version ?? null) !== (a.itemVersion ?? null)) throw new Stale('This item changed after it was sent for review. Ask for it to be sent again.');
          }
          await barrier(t, 'approval.decide.checked');
          await t.sql`UPDATE approvals SET status = ${decision}, decided_by = ${me.id}, decided_at = ${iso(t.now())}, decision_note = ${note} WHERE id = ${a.id}`;
          await applyDecision(t, a, decision, body);
          await t.audit(`approval.${decision}`, a.id, { itemType: a.itemType, digest: a.digest });
          const submitter = await memberById(t, a.submittedBy);
          if (submitter && submitter.id !== me.id) await enqueue(t, submitter, decision === 'approved' ? `Approved: ${a.title}` : `Changes requested: ${a.title}`, `${me.name} ${decision === 'approved' ? 'approved' : 'asked for changes to'} "${a.title}".${note ? `\n\nNote: ${note}` : ''}\n\nSee it here: ${t.origin}/operations/#/approvals`);
        });
      } catch (e) {
        // A stale request is marked replaced (in its own transaction) so it leaves the inbox.
        if (e.stale) await inTx(env, async t => { await t.sql`UPDATE approvals SET status = 'superseded', decided_at = ${iso(t.now())}, decision_note = 'Changed after it was sent for review' WHERE id = ${a0.id} AND status = 'pending'`; await t.audit('approval.superseded', a0.id); });
        throw e;
      }
      return json({ approval: toApproval((await SELECT_ONE(env.sql, a0.id))[0]) });
    }
    if (method === 'POST' && parts[1] === 'withdraw') {
      if (a0.submittedBy !== me.id) return notFound();
      await inTx(env, async t => {
        const done = await t.sql`UPDATE approvals SET status = 'withdrawn', decided_at = ${iso(t.now())} WHERE id = ${a0.id} AND status IN ('pending', 'changes_requested') RETURNING id`;
        if (!done[0]) throw new Invalid('This was already decided.');
        if (a0.itemType === 'content_post') await t.sql`UPDATE content_posts SET status = 'draft', version = version + 1 WHERE id = ${a0.itemId} AND status = 'in_review'`;
        await t.audit('approval.withdrawn', a0.id);
      });
      return json({ ok: true });
    }
  }
  return notFound();
}
