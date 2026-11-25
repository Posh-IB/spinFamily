import { getDatabase } from '@netlify/database';
import nodemailer from 'nodemailer';
import { handle, PRODUCTION_ORIGIN } from '../../lib/ops/core.mjs';
import { filesFor } from '../../lib/ops/files.mjs';
import { runtimeFacts, OPS_ORG } from '../../lib/ops/runtime.mjs';
import { config as smtpConfig, MAILBOX } from '../../lib/pilot-welcome.mjs';

const db = getDatabase();

// SpinFamily Pilot Operations API. Every request is authenticated inside handle().
export default async (req, context) => {
  const facts = runtimeFacts(context);
  if (!facts.rightSite) {
    console.warn(JSON.stringify({ component: 'ops-api', state: 'refused_unknown_site' }));
    return new Response('Unavailable', { status: 503 });
  }
  return handle(req, {
    sql: db.sql,
    files: filesFor(facts.isProduction),
    orgId: OPS_ORG,
    now: () => Date.now(),
    // Production links always point at the real domain; previews use their own preview URL.
    origin: facts.isProduction ? PRODUCTION_ORIGIN : new URL(req.url).origin,
    deployContext: facts.isProduction ? 'production' : facts.deployContext,
    netlifyUser: context?.user || null,
    mailbox: MAILBOX,
    founderEnrollmentCode: Netlify.env.get('OPS_FOUNDER_ENROLLMENT_CODE') || null,
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
