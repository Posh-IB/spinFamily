// Decides, from Netlify's own runtime metadata, whether this request is real production (IR-02).
// Anything missing, unknown or from another site is treated as NOT production: no production files, no email.
import { SITE_ID } from '../pilot-welcome.mjs';
export const OPS_ORG = 'spinfamily';

export function runtimeFacts(context, env = k => process.env[k]) {
  const siteId = context?.site?.id || env('SITE_ID') || null;
  const deployContext = context?.deploy?.context || env('CONTEXT') || 'unknown';
  const rightSite = siteId === SITE_ID;
  return { siteId, deployContext, rightSite, isProduction: rightSite && deployContext === 'production' };
}
