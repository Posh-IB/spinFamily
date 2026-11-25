// Company docs: shared links and uploaded files. File bytes live in Netlify Blobs; metadata in Postgres.
import { json, fail, notFound, Invalid, newId, iso, text, oneOf, url, row, asJson } from './util.mjs';
import { orgMembers } from './core.mjs';
import { submitForApproval, supersedePending } from './approvals.mjs';
import { inTx } from './db.mjs';
import { enqueue } from './outbox.mjs';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Netlify functions accept about 6 MB per request; base64 adds a third
export const APPROVAL = ['approved', 'pending_review', 'draft', 'retired'];
export const DOC_CATEGORIES = ['outreach', 'brand', 'research', 'training', 'policy', 'meeting', 'other'];
export const DEFAULT_RESOURCES = [
  { title: 'SpinFamily Social & Campus Guide', url: 'https://drive.google.com/file/d/1HL0obgvYmgcNOFAXPkuftEjqugN7zvV_/view', intendedUse: 'Lindsey\'s working guide: role, brand rules, tracking links, content plan.', approval: 'approved', category: 'training' },
  { title: 'Cincinnati State campus flyer', url: 'https://drive.google.com/file/d/1s7SGFY1Q6evgrE3w6fE2IrgBPeqFEI3I/view', intendedUse: 'Campus posting once Student Activities approves. QR: ?ref=campus.', approval: 'approved', category: 'outreach' },
  { title: 'Parenting Resource Center one-pager', url: 'https://drive.google.com/file/d/1Fnm6a6dPDRKgKApFbq2oldr79bIWq-ZR/view', intendedUse: 'Meeting with Parenting Resources. QR: ?ref=campus-groups.', approval: 'pending_review', category: 'outreach' },
  { title: 'Business Division one-pager', url: 'https://drive.google.com/file/d/1DExuLG-2HSGDkOr-DdfG8IJQNaJozZqP/view', intendedUse: 'Meeting with the Business Division. Offers need founder approval before use.', approval: 'pending_review', category: 'outreach' },
  { title: 'SpinFamily logo (color, transparent)', url: 'https://drive.google.com/file/d/1_TOgR0e9UUxCME81dylzCXPQXli2pT5e/view', intendedUse: 'Social posts and flyers on light backgrounds.', approval: 'approved', category: 'brand' },
  { title: 'SpinFamily logo (reverse, transparent)', url: 'https://drive.google.com/file/d/1Dre0e_D1tXomKmBVRyHl1EItbcwh0b1S/view', intendedUse: 'Social posts and flyers on teal or dark backgrounds.', approval: 'approved', category: 'brand' },
];

// File types are identified from the file's own bytes, not its name. Nothing that can run in a browser is accepted.
const ZIP = b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
const FILE_TYPES = [
  { ext: ['pdf'], type: 'application/pdf', test: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { ext: ['png'], type: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: ['jpg', 'jpeg'], type: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['webp'], type: 'image/webp', test: b => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 },
  { ext: ['docx'], type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: ZIP },
  { ext: ['xlsx'], type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: ZIP },
  { ext: ['pptx'], type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', test: ZIP },
];
export function identifyFile(fileName, bytes) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  const t = FILE_TYPES.find(f => f.ext.includes(ext));
  return t && bytes.length >= 12 && t.test(bytes) ? { type: t.type, ext } : null;
}
function cleanFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim();
  return (base || 'file').slice(-120);
}

const toDoc = r => { const d = row(r); return { id: d.id, version: d.version, kind: d.kind, title: d.title, url: d.url, intendedUse: d.intended_use, category: d.category, approval: d.approval, audience: d.audience, fileName: d.file_name, contentType: d.content_type, size: d.size, uploadedBy: d.uploaded_by, uploadedByName: d.uploaded_by_name || null, createdAt: d.created_at, updatedAt: d.updated_at, fileKey: d.file_key }; };
const publicDoc = d => { const { fileKey, ...rest } = d; return rest; };
export async function getDoc(env, id) {
  const r = (await env.sql`SELECT d.*, m.name AS uploaded_by_name FROM documents d LEFT JOIN members m ON m.id = d.uploaded_by WHERE d.id = ${id} AND d.org_id = ${env.orgId}`)[0];
  return r ? toDoc(r) : null;
}

// Who can see a document: the whole team, the founder only, or named people. The uploader always can.
export function canSee(d, env) {
  if (env.has('resources.manage')) return true;
  if (d.uploadedBy === env.member.id) return true;
  if (d.approval === 'retired') return false;
  const a = d.audience || 'team';
  return a === 'team' || (Array.isArray(a) && a.includes(env.member.id));
}
export async function parseAudience(v, env) {
  if (v === undefined || v === null || v === '' || v === 'team') return 'team';
  if (v === 'founder') return 'founder';
  if (!Array.isArray(v) || v.length > 50) throw new Invalid('Choose who can see this');
  const ids = [...new Set(v.map(String))];
  const members = await orgMembers(env);
  for (const id of ids) if (!members.some(m => m.id === id && m.status !== 'revoked')) throw new Invalid('Unknown team member');
  return ids;
}
// Queued in the caller's transaction; sent after commit (R2-04).
export async function notifyShare(env, doc) {
  const members = (await orgMembers(env)).filter(m => m.status !== 'revoked' && m.id !== env.member.id);
  const a = doc.audience || 'team';
  const to = a === 'team' ? members : a === 'founder' ? members.filter(m => m.role === 'founder') : members.filter(m => a.includes(m.id));
  for (const m of to) await enqueue(env, m, `Shared with you: ${doc.title}`, `${env.member.name} shared "${doc.title}" with you in SpinFamily Operations.\n\n${doc.intendedUse ? doc.intendedUse + '\n\n' : ''}Open Company docs: ${env.origin}/operations/#/docs\n\nYou'll need to be signed in.`);
  return to.length;
}
const held = () => fail(403, 'feature_held', 'File uploads and downloads are switched off until file scanning is approved. Share a Google Drive link instead.');

async function seed(env) {
  const seeded = await env.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${env.orgId}, 'docs_seeded', ${asJson({ at: iso(env.now()) })}::jsonb) ON CONFLICT DO NOTHING RETURNING key`;
  if (!seeded[0]) return;
  const now = iso(env.now());
  for (const r of DEFAULT_RESOURCES) await env.sql`INSERT INTO documents (id, org_id, kind, title, url, intended_use, category, approval, audience, created_at, updated_at) VALUES (${newId('res')}, ${env.orgId}, 'link', ${r.title}, ${r.url}, ${r.intendedUse}, ${r.category}, ${r.approval}, '"team"'::jsonb, ${now}, ${now})`;
}

export async function docRoutes(parts, method, body, env) {
  const me = env.member;
  env.need('resources.view');
  await seed(env);
  if (method === 'GET' && !parts.length) {
    const all = (await env.sql`SELECT d.*, m.name AS uploaded_by_name FROM documents d LEFT JOIN members m ON m.id = d.uploaded_by WHERE d.org_id = ${env.orgId} ORDER BY d.created_at DESC LIMIT 500`).map(toDoc);
    return json({ resources: all.filter(d => canSee(d, env)).map(publicDoc), approvals: APPROVAL, categories: DOC_CATEGORIES, maxFileBytes: MAX_FILE_BYTES, uploadsEnabled: !!env.features?.has('uploads') });
  }

  if (method === 'POST' && parts[0] === 'upload') {
    env.need('resources.upload');
    if (!env.features?.has('uploads')) return held();
    const isFounder = me.role === 'founder';
    if (isFounder) env.need('resources.manage');
    const title = text(body.title, 'Title', 120, { required: true });
    const fileName = cleanFileName(text(body.fileName, 'File name', 200, { required: true }));
    if (typeof body.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64)) throw new Invalid('The file did not upload correctly. Try again.');
    const bytes = new Uint8Array(Buffer.from(body.dataBase64, 'base64'));
    if (!bytes.length) throw new Invalid('That file is empty.');
    if (bytes.length > MAX_FILE_BYTES) throw new Invalid('That file is over 4 MB. Compress it or share a Drive link instead.');
    const kind = identifyFile(fileName, bytes);
    if (!kind) throw new Invalid('Upload a PDF, Word, Excel or PowerPoint file, or a PNG, JPG or WebP image.');
    const audience = isFounder ? await parseAudience(body.audience, env) : 'founder';
    const approval = isFounder ? oneOf(body.approval, 'approval', APPROVAL, 'approved') : 'pending_review';
    const now = iso(env.now()), id = newId('res'), fileKey = `files/${env.orgId}/${id}`;
    const intendedUse = text(body.intendedUse, "What it's for", 300), category = oneOf(body.category, 'category', DOC_CATEGORIES, 'other');
    const fileSha = createHash('sha256').update(bytes).digest('hex');
    // Bytes first (an orphaned blob has no record and is never served); then record, approval
    // request and notifications in one transaction.
    await env.files.put(fileKey, bytes, { resourceId: id, contentType: kind.type, sha256: fileSha });
    const notified = await inTx(env, async t => {
      await t.sql`INSERT INTO documents (id, org_id, kind, title, intended_use, category, approval, audience, file_name, content_type, size, file_key, file_sha256, uploaded_by, created_at, updated_at)
        VALUES (${id}, ${t.orgId}, 'file', ${title}, ${intendedUse}, ${category}, ${approval}, ${asJson(audience)}::jsonb,
        ${fileName}, ${kind.type}, ${bytes.length}, ${fileKey}, ${fileSha}, ${me.id}, ${now}, ${now})`;
      await t.audit('docs.uploaded', id, { size: bytes.length, audience: Array.isArray(audience) ? 'named' : audience });
      const doc = await getDoc(t, id);
      if (isFounder) return body.notify === true ? notifyShare(t, doc) : 0;
      await submitForApproval(t, { itemType: 'document', itemId: id, title: `Doc: ${title}`, summary: doc.intendedUse || `${fileName} uploaded for review` });
      return 0;
    });
    return json({ resource: publicDoc(await getDoc(env, id)), notified }, 201);
  }

  if (parts[0] && parts[1] === 'file' && method === 'GET') {
    const d = await getDoc(env, parts[0]);
    if (!d || d.kind !== 'file' || !canSee(d, env)) return notFound();
    if (!env.features?.has('uploads')) return held();
    const f = await env.files.get(d.fileKey);
    if (!f) return fail(404, 'not_found', 'File missing.');
    await env.audit('docs.downloaded', d.id);
    return new Response(f.bytes, { status: 200, headers: {
      'content-type': d.contentType, 'content-length': String(f.bytes.length),
      'content-disposition': `attachment; filename="${d.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(d.fileName)}`,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "sandbox; default-src 'none'", 'x-robots-tag': 'noindex, nofollow',
    } });
  }

  env.need('resources.manage');
  if (method === 'POST' && !parts.length) {
    const now = iso(env.now()), id = newId('res');
    const audience = await parseAudience(body.audience, env);
    const v = { title: text(body.title, 'title', 120, { required: true }), url: url(body.url, 'link'), intendedUse: text(body.intendedUse, 'intended use', 300), category: oneOf(body.category, 'category', DOC_CATEGORIES, 'other'), approval: oneOf(body.approval, 'approval', APPROVAL, 'draft') };
    await inTx(env, async t => {
      await t.sql`INSERT INTO documents (id, org_id, kind, title, url, intended_use, category, approval, audience, uploaded_by, created_at, updated_at)
        VALUES (${id}, ${t.orgId}, 'link', ${v.title}, ${v.url}, ${v.intendedUse}, ${v.category}, ${v.approval}, ${asJson(audience)}::jsonb, ${me.id}, ${now}, ${now})`;
      await t.audit('docs.link_added', id);
      if (body.notify === true) await notifyShare(t, await getDoc(t, id));
    });
    return json({ resource: publicDoc(await getDoc(env, id)) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    const d = await getDoc(env, parts[0]); if (!d) return notFound();
    const next = {
      approval: body.approval !== undefined ? oneOf(body.approval, 'approval', APPROVAL) : d.approval,
      intendedUse: body.intendedUse !== undefined ? text(body.intendedUse, 'intended use', 300) : d.intendedUse,
      title: body.title !== undefined ? text(body.title, 'title', 120, { required: true }) : d.title,
      category: body.category !== undefined ? oneOf(body.category, 'category', DOC_CATEGORIES) : d.category,
      audience: body.audience !== undefined ? await parseAudience(body.audience, env) : d.audience,
    };
    const contentChanged = next.title !== d.title || next.intendedUse !== d.intendedUse || next.category !== d.category;
    const notified = await inTx(env, async t => {
      const r = await t.sql`UPDATE documents SET approval = ${next.approval}, intended_use = ${next.intendedUse}, title = ${next.title}, category = ${next.category}, audience = ${asJson(next.audience)}::jsonb, updated_at = ${iso(t.now())},
        version = version + ${contentChanged ? 1 : 0} WHERE id = ${d.id} AND version = ${Number.isInteger(body.version) ? body.version : d.version} RETURNING id`;
      if (!r[0]) { const e = new Error('conflict'); e.conflict = true; throw e; }
      // The founder deciding directly here settles any open request for this doc.
      if (contentChanged || body.approval !== undefined) await supersedePending(t, 'document', d.id, contentChanged ? 'Changed after it was sent for review' : 'Decided directly in Company docs');
      await t.audit('docs.updated', d.id, { approval: next.approval });
      return body.notify === true && JSON.stringify(next.audience) !== JSON.stringify(d.audience) ? notifyShare(t, await getDoc(t, d.id)) : 0;
    });
    return json({ resource: publicDoc(await getDoc(env, d.id)), notified });
  }
  return notFound();
}
