// Server-owned roles. The browser never decides what a member may do.
// Mirrors the role matrix in SF-PILOT-OPS-001 section 5. Roles are per organization (membership).
export const ROLES = {
  founder: { label: 'Founder', riccTitle: 'Founder' },
  coordinator: { label: 'Community & Programs Coordinator', riccTitle: 'Community Operations Coordinator' },
};

const BOTH = ['founder', 'coordinator'], F = ['founder'];
const MATRIX = {
  'dashboard.view': BOTH,
  'participants.view.all': F,
  'participants.view.assigned': BOTH,
  'participants.create': BOTH,
  'participants.update.assigned': BOTH,
  'participants.assign': F,
  'participants.contact.all': F,
  'participants.markTest': F,
  'participants.verify': F,      // mark account/engagement/email states as verified, change cohort, import

  'followups.manage': BOTH,
  'followups.view.all': F,
  'outreach.record': BOTH,
  'relationships.record': BOTH,
  'relationships.approveOffer': F,
  'resources.view': BOTH,
  'resources.upload': BOTH,
  'resources.manage': F,
  'approvals.submit': BOTH,
  'approvals.decide': F,
  'approvals.view.all': F,
  'content.edit': BOTH,
  'research.view': BOTH,
  'research.manage': F,
  'research.sessions': BOTH,
  'research.invite': BOTH,       // coordinators: only for participants assigned to them
  'surveys.draft': BOTH,
  'surveys.approve': F,
  'responses.view.full': F,
  'responses.view.aggregate': BOTH,
  'team.manage': F,
  'audit.view': F,
};

// Actions that also require a confirmed authenticator code in this session.
export const STEP_UP = new Set(['team.manage', 'participants.contact.all', 'participants.assign', 'participants.markTest', 'participants.verify', 'resources.manage', 'audit.view', 'relationships.approveOffer', 'approvals.decide', 'surveys.approve', 'responses.view.full', 'research.manage']);

// `member` is the membership view: { role, status }.
export function can(member, action) {
  if (!member || member.status !== 'active') return false;
  return (MATRIX[action] || []).includes(member.role);
}
export function permissionsFor(member) {
  return Object.keys(MATRIX).filter(a => can(member, a));
}
