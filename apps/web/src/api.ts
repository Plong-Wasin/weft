import { t } from './i18n';

export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export function csrf() {
  return document.cookie.split('; ').find((item) => item.startsWith('weft_csrf='))?.split('=')[1] ?? '';
}

export function isTextEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase()) && !navigator.onLine) {
    throw new Error(t('err.offline'));
  }
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) headers.set('x-csrf-token', csrf());
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch (reason) {
    if (['POST', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
      throw new Error(t('err.unreachable'));
    }
    throw reason;
  }
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (response.status === 401) window.dispatchEvent(new Event('weft:unauthorized'));
  if (!response.ok) throw Object.assign(new Error(readableError(response.status, body)), { status: response.status, body });
  return body as T;
}

export const MAX_COMMENT_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const COMMAND_PREFIX = /^(?:create|status|milestone|generate|ai|split|links?|suggest|column|calendar|timeline|export|templates?|plan|schedules?|overview)\b/i;

// Server error codes that reach a person as-is; any other code stays as the server sent it.
const errorMessages: Record<string, string> = {
  attachment_quota_exceeded: 'Attachment limit reached: a comment holds at most 10 files and a Task at most 64 MiB in total (across all its comments).',
  file_already_exists: 'A file with that name already exists in the Vault, so it was not added.',
  milestone_unavailable: 'That Milestone is not available: choose a Milestone of the Task\'s own Project.',
  detach_required: 'Choose what happens to the Tasks of this Milestone before archiving it.'
};

type CycleStep = { number?: number; title?: string; unreadable?: boolean };
function readableError(status: number, body: { error?: string; detail?: string; message?: string; chain?: CycleStep[] } | undefined) {
  if (body?.error === 'invalid_query' && body.message) return `That Smart List query is not valid: ${body.message}.`;
  if (body?.error === 'relation_cycle' && Array.isArray(body.chain)) {
    const steps = body.chain.map((step) => step.unreadable ? 'a Task you cannot read' : `#${step.number} ${step.title}`);
    return `That dependency would make a loop: ${steps.join(' blocks ')}.`;
  }
  const known = (body?.detail && errorMessages[body.detail]) || (body?.error && errorMessages[body.error]);
  if (known) return known;
  if (body?.error) return body.error;
  return status === 413 ? 'That upload is too large: each file can be at most 10 MiB.' : `Request failed (${status})`;
}

export async function clearClientCaches() {
  if (!('caches' in window)) return;
  try {
    await Promise.all((await caches.keys()).filter((name) => !name.startsWith('weft-shell-')).map((name) => caches.delete(name)));
  } catch { /* Cache cleanup must not prevent sign-in or sign-out. */ }
}
