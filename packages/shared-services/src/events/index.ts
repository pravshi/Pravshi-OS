import * as Sentry from '@/lib/observability/report';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Domain events — the port between the modules that cause things and the modules that react.
 *
 * ADR-010 rule 4 ("reactions go through events"): crm and work state changes, and an inbound
 * webhook, must trigger workflows and outbound webhook deliveries WITHOUT importing the
 * workflows or integrations modules (they sit beside crm and work in L4; importing them made a
 * cycle). The emitting modules import this L3 module instead. It holds no business logic: it
 * forwards each call to the one subscriber registered for its port.
 *
 * ── TWO PORTS, ONE SUBSCRIBER EACH ───────────────────────────────────────────────────────────
 *
 *   dispatchWorkflowEvent(auth, event)         → the workflow dispatcher
 *                                                (src/lib/workflows/events.ts)
 *   emitIntegrationEvent(auth, key, data, opt) → the outbound-webhook fan-out
 *                                                (src/lib/integrations/fanout.ts)
 *
 * Both keep the exact call shapes the emitting modules had before, so each call site changed by
 * its import line only. The registrations are made by src/lib/composition/domain-events.ts, a
 * composition root that the entry points load (apps/web/src/instrumentation.ts for the web app, the worker's
 * runner) — never by a module in src/lib, which may not import it.
 *
 * ── WHAT IS PRESERVED (ADR-005) ──────────────────────────────────────────────────────────────
 *
 *   * Emission stays AFTER the originating commit, at the same call sites (D3).
 *   * Calls are awaited: the subscriber runs inline in the caller's request (D1), inside the
 *     caller's async context, so the AsyncLocalStorage depth bound (D4) holds.
 *   * The SAME Authorization object is handed to the subscriber, which keys its WeakMap
 *     fallback depth on it, and which carries the trigger actor's authority (D2).
 *   * NEVER throws or rejects to the caller (D3): a faulty or missing subscriber is logged and
 *     reported to Sentry, and the originating mutation is unaffected.
 *
 * ── FAIL LOUD WHEN UNWIRED ───────────────────────────────────────────────────────────────────
 *
 * A process that emits without having loaded the composition root would otherwise silently stop
 * triggering workflows and webhooks. An emission with no subscriber is therefore logged as an
 * error and reported to Sentry on EVERY occurrence (never swallowed quietly, and — like every
 * other failure here — never allowed to break the mutation). tests/guards/domain-events-wired
 * pins that the web app and the worker load the composition root.
 *
 * ── THE REGISTRY LIVES ON globalThis ─────────────────────────────────────────────────────────
 *
 * Next.js can bundle instrumentation and each route into separate bundles, each with its own copy
 * of a module's top-level state. A module-level variable registered in one bundle would then be
 * invisible to the others; a process-wide symbol-keyed slot is shared by all of them. Registering
 * again replaces the previous subscriber (a re-evaluated module, hot reload), it never stacks.
 */

// ── event contracts ─────────────────────────────────────────────────────────────────────────

/** The workflow trigger types that domain code emits (a subset of the workflows module's). */
export const DOMAIN_WORKFLOW_EVENT_TYPES = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'task.created',
  'task.status_changed',
  'task.assigned',
  'project.created',
  'webhook',
] as const;
export type DomainWorkflowEventType = (typeof DOMAIN_WORKFLOW_EVENT_TYPES)[number];

export type DomainEntityType = 'deal' | 'task' | 'project' | 'company' | 'contact';

/**
 * What an emitting module supplies for a workflow event; the dispatcher stamps the identity
 * fields (id, org, actor, time) from the Authorization — never from input (ADR-005 D2).
 */
export interface DomainWorkflowEventInput {
  readonly type: DomainWorkflowEventType;
  readonly entityType: DomainEntityType | null;
  readonly entityId: string | null;
  /** Stable per source occurrence: the engine makes re-delivery a no-op on it (D4). */
  readonly dedupKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The outbound-webhook event keys that domain code emits (a subset of the integrations module's). */
export const DOMAIN_INTEGRATION_EVENT_KEYS = ['deal.won', 'deal.lost', 'task.completed'] as const;
export type DomainIntegrationEventKey = (typeof DOMAIN_INTEGRATION_EVENT_KEYS)[number];

export interface DomainIntegrationEventOptions {
  /** A stable id for the event instance, so re-emission dedups (see the fan-out module). */
  readonly eventInstanceId?: string;
}

/**
 * Joins the non-empty parts with `:`, e.g. `buildDedupKey('deal_stage_history', historyId)` →
 * `'deal_stage_history:<uuid>'`. Used for stable dedup keys. Defined here, with the events that
 * carry them; `@/lib/workflows/events` re-exports it.
 */
export function buildDedupKey(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(':');
}

// ── subscribers and the registry ─────────────────────────────────────────────────────────────

export type WorkflowEventSubscriber = (
  auth: Authorization,
  event: DomainWorkflowEventInput,
) => Promise<void>;

export type IntegrationEventSubscriber = (
  auth: Authorization,
  eventKey: DomainIntegrationEventKey,
  data: Record<string, unknown>,
  options?: DomainIntegrationEventOptions,
) => Promise<void>;

interface Ports {
  workflow?: WorkflowEventSubscriber;
  integration?: IntegrationEventSubscriber;
}

const REGISTRY_KEY = Symbol.for('pravshi.domain-events.ports');

function ports(): Ports {
  const slot = globalThis as unknown as Record<symbol, Ports | undefined>;
  return (slot[REGISTRY_KEY] ??= {});
}

/** Registers THE workflow dispatcher. Called by the composition root only. */
export function registerWorkflowEventSubscriber(subscriber: WorkflowEventSubscriber): void {
  if (typeof subscriber !== 'function') {
    throw new TypeError('a workflow event subscriber must be a function');
  }
  ports().workflow = subscriber;
}

/** Registers THE outbound-webhook fan-out. Called by the composition root only. */
export function registerIntegrationEventSubscriber(subscriber: IntegrationEventSubscriber): void {
  if (typeof subscriber !== 'function') {
    throw new TypeError('an integration event subscriber must be a function');
  }
  ports().integration = subscriber;
}

/** Which ports have a subscriber. For the wiring guard and diagnostics; carries no data. */
export function registeredEventPorts(): { workflow: boolean; integration: boolean } {
  const p = ports();
  return { workflow: p.workflow !== undefined, integration: p.integration !== undefined };
}

/** Test utility: forget every subscriber. */
export function resetEventPortsForTests(): void {
  const slot = globalThis as unknown as Record<symbol, Ports | undefined>;
  delete slot[REGISTRY_KEY];
}

// ── emission ─────────────────────────────────────────────────────────────────────────────────

/** Name only: an error's message can carry query text, parameters or a webhook URL. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function reportFailure(port: 'workflow' | 'integration', what: string, event: string): void {
  console.error(`[events] ${what} — event not delivered`, { port, event });
  Sentry.captureMessage(`domain event not delivered: ${what}`, {
    level: 'error',
    tags: { port, event },
  });
}

/**
 * Hands a workflow event to the registered dispatcher and awaits it inline. Never throws.
 */
export async function dispatchWorkflowEvent(
  auth: Authorization,
  event: DomainWorkflowEventInput,
): Promise<void> {
  const subscriber = ports().workflow;
  if (subscriber === undefined) {
    reportFailure('workflow', 'no workflow dispatcher is registered', event.type);
    return;
  }
  try {
    await subscriber(auth, event);
  } catch (error) {
    // The dispatcher already never throws (D3); this is the port's own backstop.
    console.error('[events] workflow dispatch threw — contained', {
      event: event.type,
      error: describeError(error),
    });
    reportFailure('workflow', 'the workflow dispatcher threw', event.type);
  }
}

/**
 * Hands an outbound-webhook event to the registered fan-out and awaits it inline. Never throws.
 */
export async function emitIntegrationEvent(
  auth: Authorization,
  eventKey: DomainIntegrationEventKey,
  data: Record<string, unknown>,
  options?: DomainIntegrationEventOptions,
): Promise<void> {
  const subscriber = ports().integration;
  if (subscriber === undefined) {
    reportFailure('integration', 'no integration fan-out is registered', eventKey);
    return;
  }
  try {
    await subscriber(auth, eventKey, data, options);
  } catch (error) {
    console.error('[events] integration fan-out threw — contained', {
      event: eventKey,
      error: describeError(error),
    });
    reportFailure('integration', 'the integration fan-out threw', eventKey);
  }
}
