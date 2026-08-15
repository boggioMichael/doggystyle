/**
 * The complete set of actions the conversational agent may invoke.
 *
 * This list is the security boundary (ADR 0004): a model can only ever emit one
 * of these names, the arguments are re-validated server-side, and `sensitive`
 * actions additionally require an explicit human confirmation click.
 */

export const AGENT_ACTIONS = [
  'create_profile',
  'update_profile',
  'update_preferences',
  'confirm_attribute',
  'connect_social_account',
  'import_media',
  'find_matches',
  'show_candidate',
  'request_introduction',
  'accept_introduction',
  'decline_introduction',
  'propose_meetup',
  'change_meetup',
  'cancel_meetup',
  'send_message',
  'block_user',
  'report_user',
  'delete_media',
  'disconnect_account',
  'answer_question',
] as const;

export type AgentActionName = (typeof AGENT_ACTIONS)[number];

export type ActionCategory = 'read' | 'write' | 'sensitive';

/**
 * `sensitive` actions are irreversible, contact a third party, or disclose
 * information — they are never executed straight from model output.
 */
export const ACTION_CATEGORIES: Record<AgentActionName, ActionCategory> = {
  answer_question: 'read',
  find_matches: 'read',
  show_candidate: 'read',

  create_profile: 'write',
  update_profile: 'write',
  update_preferences: 'write',
  confirm_attribute: 'write',
  connect_social_account: 'write',
  import_media: 'write',
  send_message: 'write',
  propose_meetup: 'write',
  change_meetup: 'write',
  accept_introduction: 'write',
  decline_introduction: 'write',

  request_introduction: 'sensitive',
  cancel_meetup: 'sensitive',
  block_user: 'sensitive',
  report_user: 'sensitive',
  delete_media: 'sensitive',
  disconnect_account: 'sensitive',
};

export const ACTION_LABELS: Record<AgentActionName, string> = {
  answer_question: 'Answer a question',
  create_profile: 'Create a dog profile',
  update_profile: 'Update the dog profile',
  update_preferences: 'Update search preferences',
  confirm_attribute: 'Confirm a profile detail',
  connect_social_account: 'Connect a media source',
  import_media: 'Import photos',
  find_matches: 'Search for matches',
  show_candidate: 'Show a candidate',
  request_introduction: 'Request an introduction',
  accept_introduction: 'Accept an introduction',
  decline_introduction: 'Decline an introduction',
  propose_meetup: 'Propose a meetup',
  change_meetup: 'Change a meetup',
  cancel_meetup: 'Cancel a meetup',
  send_message: 'Send a message',
  block_user: 'Block an owner',
  report_user: 'Report an owner',
  delete_media: 'Delete a photo',
  disconnect_account: 'Disconnect a media source',
};

export function isAgentAction(name: string): name is AgentActionName {
  return (AGENT_ACTIONS as readonly string[]).includes(name);
}

export function isSensitiveAction(name: AgentActionName): boolean {
  return ACTION_CATEGORIES[name] === 'sensitive';
}
