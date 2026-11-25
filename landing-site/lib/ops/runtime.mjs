// Decides, from Netlify's own runtime metadata, what this request is allowed to be (IR-02, R2-02).
// Only the real SpinFamily site, in a deploy context we explicitly support, may serve the workspace.
// Anything missing, unknown or from another site is refused before a database client exists.
import { SITE_ID } from '../pilot-welcome.mjs';
export const OPS_ORG = 'spinfamily';
export const SUPPORTED_CONTEXTS = ['production', 'deploy-preview', 'branch-deploy'];

export function runtimeFacts(context, env = k => process.env[k]) {
  const siteId = context?.site?.id || env('SITE_ID') || null;
  const deployContext = context?.deploy?.context || env('CONTEXT') || 'unknown';
  const rightSite = siteId === SITE_ID;
  const supported = rightSite && SUPPORTED_CONTEXTS.includes(deployContext);
  return { siteId, deployContext, rightSite, supported, isProduction: supported && deployContext === 'production' };
}

// Secrets are read under different names per context, so a preview can never use the production
// setup or recovery code even if someone scoped those variables to every context.
export function secretsFor(facts, get) {
  const prefix = facts.isProduction ? 'OPS_FOUNDER' : 'OPS_PREVIEW';
  const bootstrap = get(`${prefix}_BOOTSTRAP_CODE`) || null;
  const recovery = get(`${prefix}_RECOVERY_CODE`) || null;
  // The same value for both would let one leaked code do both jobs: refuse it.
  if (bootstrap && recovery && bootstrap.trim() === recovery.trim()) return { bootstrap: null, recovery: null, misconfigured: true };
  return { bootstrap, recovery, misconfigured: false };
}

// Optional features stay off unless named in OPS_FEATURES (comma-separated).
// uploads  – file uploads to Company docs (no malware scanning yet)
// research – creating survey links for real participants
export function featuresFrom(value) {
  return new Set(String(value || '').split(',').map(s => s.trim()).filter(Boolean));
}
