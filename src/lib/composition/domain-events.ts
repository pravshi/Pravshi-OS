import {
  DOMAIN_INTEGRATION_EVENT_KEYS,
  DOMAIN_WORKFLOW_EVENT_TYPES,
  registerIntegrationEventSubscriber,
  registerWorkflowEventSubscriber,
  type DomainIntegrationEventKey,
  type DomainWorkflowEventType,
} from '@/lib/events';
import { dispatchWorkflowEvent, type WorkflowTriggerType } from '@/lib/workflows/events';
import { emitIntegrationEvent, type IntegrationEventKey } from '@/lib/integrations/fanout';

/**
 * Composition root for the domain-event ports (ADR-010 rule 4; redesign Step 6).
 *
 * crm, work and the inbound-webhook receiver emit through src/lib/events without importing the
 * modules that react. THIS file is where the reactions are connected: it registers the workflow
 * dispatcher and the outbound-webhook fan-out as the subscribers of the two ports. It imports
 * workflows and integrations, so it sits above the domain modules (an entry-tier module, ADR-010):
 * no module in src/lib may import it.
 *
 * Importing this module IS the registration. The entry points load it:
 *   - the web app: src/instrumentation.ts, in the nodejs runtime, before any request is served;
 *   - the worker: src/worker/runner.ts, with the other modules that register at start-up.
 * tests/guards/domain-events-wired.test.ts pins both. A process that emits without having loaded
 * it reports every undelivered event (see src/lib/events).
 */

// The port's event vocabulary must stay inside the subscribers' vocabulary: a type or key the
// emitting modules may send but the dispatcher or fan-out does not know would be dropped at
// run time, so it fails here, at compile time, instead.
type Assert<T extends true> = T;
export type PortWorkflowTypesAreTriggerTypes = Assert<
  DomainWorkflowEventType extends WorkflowTriggerType ? true : false
>;
export type PortIntegrationKeysAreIntegrationKeys = Assert<
  DomainIntegrationEventKey extends IntegrationEventKey ? true : false
>;

registerWorkflowEventSubscriber(dispatchWorkflowEvent);

registerIntegrationEventSubscriber(async (auth, eventKey, data, options) => {
  // emitIntegrationEvent never throws and its emission summary is not used by any emitter.
  await emitIntegrationEvent(auth, eventKey, data, options);
});

/** What this root registered, for the wiring guard (never read at run time). */
export const COMPOSED_EVENT_VOCABULARY = {
  workflowTypes: DOMAIN_WORKFLOW_EVENT_TYPES,
  integrationKeys: DOMAIN_INTEGRATION_EVENT_KEYS,
} as const;
