import { getStore } from '@netlify/blobs';
import nodemailer from 'nodemailer';
import { handle, PRODUCTION_ORIGIN } from '../../lib/ops/api.mjs';
import { blobAdapter, storeNameFor } from '../../lib/ops/store.mjs';
import { config as smtpConfig, MAILBOX } from '../../lib/pilot-welcome.mjs';

// SpinFamily Pilot Operations API. Every request is authenticated inside handle().
export default async (req, context) => {
  const deployContext = context?.deploy?.context || 'dev';
  const reqOrigin = new URL(req.url).origin;
  // Production links always point at the real domain; previews use their own preview URL.
  const origin = deployContext === 'production' ? PRODUCTION_ORIGIN : reqOrigin;
  const store = blobAdapter(getStore({ name: storeNameFor(deployContext), consistency: 'strong' }));
  return handle(req, {
    store,
    now: () => Date.now(),
    origin,
    deployContext,
    netlifyUser: context?.user || null,
    mailbox: MAILBOX,
    sendMail: async message => {
      const settings = smtpConfig(k => process.env[k]);
      if (!settings) throw new Error('Mail settings unavailable in this deploy');
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
