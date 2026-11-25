// Social & content calendar: drafts → founder approval → scheduled → published.
// Nothing is posted by the workspace; Linds posts from the SpinFamily accounts after approval.
import { json, notFound, Invalid, newId, iso, text, oneOf, date, url, row } from './util.mjs';
import { submitForApproval } from './approvals.mjs';
import { getDoc, canSee } from './docs.mjs';

export const CONTENT_CHANNELS = ['instagram', 'facebook', 'fbgroups', 'tiktok', 'other'];
const STATUSES = ['idea', 'draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'cancelled'];
const EDITABLE = ['idea', 'draft', 'changes_requested'];
const CHANNEL_LABEL = { instagram: 'Instagram', facebook: 'Facebook page', fbgroups: 'Facebook group', tiktok: 'TikTok', other: 'Social' };
export const refLinkFor = channel => channel === 'other' ? 'https://spinfamilyapp.com/' : `https://spinfamilyapp.com/?ref=${channel}`;

const toPost = r => { const p = row(r); return { id: p.id, channel: p.channel, plannedDate: p.planned_date, caption: p.caption, refLink: p.ref_link, assetDocumentId: p.asset_document_id, assetTitle: p.asset_title || null, status: p.status, publishedUrl: p.published_url, notes: p.notes, createdBy: p.created_by, createdByName: p.created_by_name, createdAt: p.created_at, updatedAt: p.updated_at }; };
async function getPost(env, id) {
  const r = (await env.sql`SELECT c.id, c.channel, c.planned_date::text AS planned_date, c.caption, c.ref_link, c.asset_document_id, d.title AS asset_title, c.status, c.published_url, c.notes, c.created_by, m.name AS created_by_name, c.created_at, c.updated_at
    FROM content_posts c LEFT JOIN documents d ON d.id = c.asset_document_id LEFT JOIN members m ON m.id = c.created_by WHERE c.id = ${id} AND c.org_id = ${env.orgId}`)[0];
  return r ? toPost(r) : null;
}
async function checkAsset(env, id) {
  if (!id) return null;
  const d = await getDoc(env, id);
  if (!d || !canSee(d, env)) throw new Invalid('Pick a doc from Company docs');
  return d.id;
}

export async function contentRoutes(parts, method, body, env) {
  const me = env.member;
  env.need('content.edit');
  if (method === 'GET' && !parts.length) {
    const list = await env.sql`SELECT c.id, c.channel, c.planned_date::text AS planned_date, c.caption, c.ref_link, c.asset_document_id, d.title AS asset_title, c.status, c.published_url, c.notes, c.created_by, m.name AS created_by_name, c.created_at, c.updated_at
      FROM content_posts c LEFT JOIN documents d ON d.id = c.asset_document_id LEFT JOIN members m ON m.id = c.created_by
      WHERE c.org_id = ${env.orgId} ORDER BY c.planned_date NULLS LAST, c.created_at LIMIT 500`;
    return json({ posts: list.map(toPost), channels: CONTENT_CHANNELS, statuses: STATUSES });
  }
  if (method === 'POST' && !parts.length) {
    const channel = oneOf(body.channel, 'channel', CONTENT_CHANNELS);
    const now = iso(env.now()), id = newId('c');
    await env.sql`INSERT INTO content_posts (id, org_id, channel, planned_date, caption, ref_link, asset_document_id, status, notes, created_by, created_at, updated_at)
      VALUES (${id}, ${env.orgId}, ${channel}, ${date(body.plannedDate, 'planned date')}, ${text(body.caption, 'Caption', 2200)}, ${refLinkFor(channel)}, ${await checkAsset(env, body.assetDocumentId || null)},
      ${body.caption ? 'draft' : 'idea'}, ${text(body.notes, 'Notes', 1000)}, ${me.id}, ${now}, ${now})`;
    await env.audit('content.created', id);
    return json({ post: await getPost(env, id) }, 201);
  }
  if (!parts[0]) return notFound();
  const p = await getPost(env, parts[0]); if (!p) return notFound();
  const mine = p.createdBy === me.id || me.role === 'founder';

  if (method === 'PATCH') {
    if (!mine) throw new Invalid('Only the person who drafted this (or Dion) can edit it');
    if (!EDITABLE.includes(p.status) && !(p.status === 'approved' && body.confirmReapproval === true)) throw new Invalid(p.status === 'approved' ? 'This post is approved. Editing it sends it back for approval.' : `A post that is ${p.status.replace('_', ' ')} can't be edited`);
    const channel = body.channel !== undefined ? oneOf(body.channel, 'channel', CONTENT_CHANNELS) : p.channel;
    const caption = body.caption !== undefined ? text(body.caption, 'Caption', 2200) : p.caption;
    const status = p.status === 'approved' || p.status === 'changes_requested' ? 'draft' : (caption ? 'draft' : 'idea');
    // Only update if nobody moved it on meanwhile (e.g. Dion approving it while you edit).
    const done = await env.sql`UPDATE content_posts SET channel = ${channel}, ref_link = ${refLinkFor(channel)}, caption = ${caption},
      planned_date = ${body.plannedDate !== undefined ? date(body.plannedDate, 'planned date') : p.plannedDate},
      asset_document_id = ${body.assetDocumentId !== undefined ? await checkAsset(env, body.assetDocumentId || null) : p.assetDocumentId},
      notes = ${body.notes !== undefined ? text(body.notes, 'Notes', 1000) : p.notes}, status = ${status}, updated_at = ${iso(env.now())}
      WHERE id = ${p.id} AND status = ${p.status} AND updated_at = ${p.updatedAt}::timestamptz RETURNING id`;
    if (!done[0]) { const e = new Error('conflict'); e.conflict = true; throw e; }
    await env.audit('content.updated', p.id);
    return json({ post: await getPost(env, p.id) });
  }
  if (method === 'POST' && parts[1] === 'submit') {
    if (!mine) throw new Invalid('Only the person who drafted this can send it for approval');
    if (!['draft', 'changes_requested'].includes(p.status)) throw new Invalid('Write a caption first, then send it for approval');
    if (!p.caption) throw new Invalid('Add a caption before sending it for approval');
    const moved = await env.sql`UPDATE content_posts SET status = 'in_review', updated_at = ${iso(env.now())} WHERE id = ${p.id} AND status = ${p.status} RETURNING id`;
    if (!moved[0]) { const e = new Error('conflict'); e.conflict = true; throw e; }
    await submitForApproval(env, { itemType: 'content_post', itemId: p.id, title: `${CHANNEL_LABEL[p.channel] || 'Social'} post${p.plannedDate ? ' for ' + p.plannedDate : ''}`, summary: p.caption.slice(0, 500), payload: { channel: p.channel, plannedDate: p.plannedDate, refLink: p.refLink, assetTitle: p.assetTitle } });
    return json({ post: await getPost(env, p.id) });
  }
  if (method === 'POST' && parts[1] === 'schedule') {
    if (p.status !== 'approved') throw new Invalid('Only approved posts can be scheduled');
    await env.sql`UPDATE content_posts SET status = 'scheduled', planned_date = ${date(body.plannedDate, 'planned date') || p.plannedDate}, updated_at = ${iso(env.now())} WHERE id = ${p.id} AND status = 'approved'`;
    await env.audit('content.scheduled', p.id);
    return json({ post: await getPost(env, p.id) });
  }
  if (method === 'POST' && parts[1] === 'published') {
    if (!['approved', 'scheduled'].includes(p.status)) throw new Invalid('Only approved posts can be marked as posted');
    await env.sql`UPDATE content_posts SET status = 'published', published_url = ${url(body.publishedUrl, 'Link to the post', { required: false })}, updated_at = ${iso(env.now())} WHERE id = ${p.id} AND status IN ('approved', 'scheduled')`;
    await env.audit('content.published', p.id);
    return json({ post: await getPost(env, p.id) });
  }
  if (method === 'POST' && parts[1] === 'cancel') {
    if (!mine) throw new Invalid('Only the person who drafted this (or Dion) can cancel it');
    await env.sql`UPDATE content_posts SET status = 'cancelled', updated_at = ${iso(env.now())} WHERE id = ${p.id} AND status <> 'published'`;
    await env.sql`UPDATE approvals SET status = 'withdrawn', decided_at = ${iso(env.now())} WHERE item_type = 'content_post' AND item_id = ${p.id} AND status = 'pending'`;
    await env.audit('content.cancelled', p.id);
    return json({ post: await getPost(env, p.id) });
  }
  return notFound();
}
