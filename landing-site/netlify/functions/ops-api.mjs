import { getDatabase } from '@netlify/database';
import nodemailer from 'nodemailer';
import { handle, PRODUCTION_ORIGIN } from '../../lib/ops/core.mjs';
import { filesFor } from '../../lib/ops/files.mjs';
import { makeDb } from '../../lib/ops/db.mjs';
import { checkEnvironment } from '../../lib/ops/environment.mjs';
import { runtimeFacts, secretsFor, featuresFrom, OPS_ORG } from '../../lib/ops/runtime.mjs';
import { config as smtpConfig, MAILBOX } from '../../lib/pilot-welcome.mjs';

// The database client is created only after the request has passed the site/context guard (R2-02),
// and the database itself must then prove it is the right kind for this deploy.
let db = null, environmentOk = null;
const refuse = (state, extra = {}) => {
  console.warn(JSON.stringify({ component: 'ops-api', state, ...extra }));
  return new Response('The operations workspace is not available on this deploy.', { status: 503, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
};

// SpinFamily Pilot Operations API. Every request is authenticated inside handle().
export default async (req, context) => {
  const facts = runtimeFacts(context);
  if (!facts.rightSite) return refuse('refused_unknown_site');
  if (!facts.supported) return refuse('refused_unsupported_context', { deployContext: facts.deployContext });
  db ??= makeDb(getDatabase().pool);
  if (!environmentOk) {
    const env = await checkEnvironment(db.sql, facts);
    if (!env.ok) return refuse('refused_database_environment', { reason: env.reason });
    environmentOk = env;
  }
  return handle(req, {
    sql: db.sql,
    tx: db.tx,
    files: filesFor(facts.isProduction),
    orgId: OPS_ORG,
    now: () => Date.now(),
    // Production links always point at the real domain; previews use their own preview URL.
    origin: facts.isProduction ? PRODUCTION_ORIGIN : new URL(req.url).origin,
    deployContext: facts.isProduction ? 'production' : facts.deployContext,
    netlifyUser: context?.user || null,
    previewFounderLogin: facts.isProduction ? null : Netlify.env.get('OPS_PREVIEW_FOUNDER_LOGIN') || null,
    mailbox: MAILBOX,
    secrets: secretsFor(facts, k => Netlify.env.get(k)),
    features: featuresFrom(Netlify.env.get('OPS_FEATURES')),
    sendMail: async message => {
      // The real mailbox only sends from production. Previews sign in with Netlify team login instead.
      if (!facts.isProduction) throw new Error('Email is turned off outside production');
      const settings = smtpConfig(k => process.env[k]);
      if (!settings) throw new Error('Mail settings unavailable');
      const t = nodemailer.createTransport(settings);
      try {
        const r = await t.sendMail(message);
        if (!Array.isArray(r.accepted) || !r.accepted.length) throw new Error('not accepted');
        return r;
      } finally { t.close(); }
    },
    log: entry => console.info(JSON.stringify(entry)),
  });
};

export const config = {
  path: '/operations/api/*',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
