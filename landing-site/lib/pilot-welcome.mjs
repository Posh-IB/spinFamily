import { createHash } from 'node:crypto';

export const SITE_ID = '9e71977e-2acc-4e07-be5d-c6e46a8361cc';
export const MAILBOX = 'hello@spinfamilyapp.com';
export const REQUIRED = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','PILOT_EMAIL_FROM','PILOT_EMAIL_REPLY_TO'];
const childrenOptions = new Set(['1','2','3','4 or more']);
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;

export function parsePilot(data) {
  if (!data || typeof data !== 'object') return null;
  // Netlify's modern event exposes submitted fields, not a guaranteed form name.
  // This site has exactly one form. Require its distinctive fields and reject a
  // conflicting name when Netlify includes one. Revisit if additional forms are added.
  if (data['form-name'] !== undefined && data['form-name'] !== 'pilot') return null;
  if (data.form_name !== undefined && data.form_name !== 'pilot') return null;
  if (data.consent !== 'yes' || (data.company !== undefined && data.company !== '') || !childrenOptions.has(data.children_under_10) || typeof data.source !== 'string' || !/^[\w-]{1,40}$/.test(data.source)) return null;
  if (typeof data.email !== 'string' || typeof data.first_name !== 'string') return null;
  const email = data.email.trim().toLowerCase();
  const firstName = data.first_name.trim();
  if (email.length > 120 || !emailPattern.test(email) || email.includes('..') || !firstName || firstName.length > 60 || /[\u0000-\u001f\u007f<>]/.test(firstName)) return null;
  return { email, firstName };
}

export function config(env) {
  if (env('SITE_ID') !== SITE_ID) return null;
  if (REQUIRED.some(k => !env(k))) return null;
  if (env('SMTP_HOST') !== 'smtp.purelymail.com' || env('SMTP_PORT') !== '465' || env('SMTP_USER') !== MAILBOX || env('PILOT_EMAIL_REPLY_TO') !== MAILBOX || ![MAILBOX, `SpinFamily <${MAILBOX}>`].includes(env('PILOT_EMAIL_FROM'))) return null;
  return { host: env('SMTP_HOST'), port: 465, secure: true, auth: {user: MAILBOX, pass: env('SMTP_PASSWORD')}, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, tls: {rejectUnauthorized: true, minVersion: 'TLSv1.2'}, logger: false, debug: false };
}

export function welcomeMessage(parent) {
  const text = `Hi ${parent.firstName},\n\nWelcome to SpinFamily!\n\nThank you for joining our family pilot program. We're excited to help you spend less time planning and more time creating meaningful experiences with your family.\n\nYou're ready to get started! Your pilot registration has been received.\n\n1. Open the SpinFamily app: https://app.spinfamilyapp.com\n2. Select Create free account and register using your email address, or sign in if you already have an account.\n3. Explore the activities and give the SpinFamily wheel your first spin.\n4. Try planning an activity with your family and let us know how it goes!\n\nNo paid subscription is required to get started.\n\nMore information about the pilot program, a short questionnaire about your family's experience, and updates on additional SpinFamily Plus features are coming soon. We'll share the details by email.\n\nAs a pilot participant, your experience and feedback will help shape the future of SpinFamily. If you have any questions, suggestions or difficulties getting started, or would like to opt out of pilot emails, simply reply to this email.\n\nThank you for being part of the SpinFamily community!\n\nThe SpinFamily Team\nPlan it. Share it. Live it.\nhttps://spinfamilyapp.com\nA Rootlayer Software LLC product.`;
  return {from: {name: 'SpinFamily', address: MAILBOX}, replyTo: MAILBOX, to: {address: parent.email, name: ''}, subject: "Welcome to SpinFamily — Let's Get Started!", text, disableFileAccess: true, disableUrlAccess: true};
}

export function keyFor(email) {return 'welcome-v1/' + createHash('sha256').update(email).digest('hex');}

// A single atomic claim per normalized email. Once SMTP has been attempted,
// never automatically retry: a crash after SMTP acceptance can be ambiguous.
// The owner reconciles uncertain/claimed records with the mailbox/provider.
export async function processWelcome(data, {env, storeFactory, send, log = () => {}, now = () => new Date().toISOString()}) {
  const parent = parsePilot(data);
  if (!parent) {log('skipped_invalid');return 'skipped_invalid';}
  const smtp = config(env);
  if (!smtp) {log('skipped_missing_or_invalid_config');return 'skipped_config';}
  const key = keyFor(parent.email);
  const store = await storeFactory();
  const claim = await store.setJSON(key,{state:'claimed',at:now(),version:1},{onlyIfNew:true});
  if (claim.modified !== true) {log('skipped_duplicate');return 'duplicate';}
  if (!claim.etag) {log('claim_missing_etag');throw new Error('Pilot claim missing ETag; send suppressed');}
  let result;
  try {
    result = await send(smtp, welcomeMessage(parent));
    if (!Array.isArray(result.accepted) || !result.accepted.some(v => typeof v === 'string' && v.toLowerCase() === parent.email)) throw new Error('SMTP recipient not accepted');
  } catch {
    try {await store.setJSON(key,{state:'uncertain',at:now(),version:1},{onlyIfMatch:claim.etag});} catch {log('status_write_failed');}
    log('smtp_failure_or_uncertain');
    throw new Error('Pilot welcome SMTP acceptance not confirmed; manual review required');
  }
  try {
    const updated = await store.setJSON(key,{state:'smtp_accepted',at:now(),version:1},{onlyIfMatch:claim.etag});
    if (!updated.modified) throw new Error('Claim changed');
  } catch {log('smtp_accepted_status_write_failed');throw new Error('SMTP accepted; ledger update uncertain; do not retry automatically');}
  log('smtp_accepted');
  return 'smtp_accepted';
}
