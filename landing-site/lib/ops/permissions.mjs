// Server-owned roles. The browser never decides what a member may do.
// Mirrors the role matrix in SF-PILOT-OPS-001 section 5.
export const ROLES = {
  founder: { label: 'Founder', riccTitle: 'Founder' },
  coordinator: { label: 'Community & Programs Coordinator', riccTitle: 'Community Operations Coordinator' },
};

const MATRIX = {
  'dashboard.view': ['founder', 'coordinator'],
  'participants.view.all': ['founder'],
  'participants.view.assigned': ['founder', 'coordinator'],
  'participants.create': ['founder', 'coordinator'],
  'participants.update.assigned': ['founder', 'coordinator'],
  'participants.assign': ['founder'],
  'participants.contact.all': ['founder'],
  'participants.markTest': ['founder'],
  'followups.manage': ['founder', 'coordinator'],
  'followups.view.all': ['founder'],
  'outreach.record': ['founder', 'coordinator'],
  'relationships.record': ['founder', 'coordinator'],
  'relationships.approveOffer': ['founder'],
  'resources.view': ['founder', 'coordinator'],
  'resources.upload': ['founder', 'coordinator'],
  'resources.manage': ['founder'],
  'team.manage': ['founder'],
  'audit.view': ['founder'],
};

// Actions that also require a confirmed authenticator code in this session.
export const STEP_UP = new Set(['team.manage', 'participants.contact.all', 'participants.assign', 'participants.markTest', 'resources.manage', 'audit.view', 'relationships.approveOffer']);

export function can(member, action) {
  if (!member || member.status !== 'active') return false;
  return (MATRIX[action] || []).includes(member.role);
}

export function permissionsFor(member) {
  return Object.keys(MATRIX).filter(a => can(member, a));
}
