/**
 * B3 — a tenant workflow cannot select a deployment-level webhook signing secret
 * (`signatureSecretRef` → env WEBHOOK_SIGNING_SECRET_<REF>). One policy
 * (hasDeploymentSecretRef), enforced on every path that saves, activates or executes a
 * workflow; workflows stored before B3 stay readable so they can be found and edited.
 *
 * No database: the job queue and the subscription fan-out are stubbed, and so is the
 * transaction the service reads through (call order: permission check, workflow row, then
 * the status/definition write — reaching the write proves the B3 check let it through).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueJob, deliverToSubscription, dbAnswers, dbCalls } = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  deliverToSubscription: vi.fn(),
  dbAnswers: [] as unknown[],
  dbCalls: { count: 0 },
}));

vi.mock('@/lib/jobs/queue', () => ({ enqueueJob }));
vi.mock('@/lib/integrations/fanout', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSubscriptionTarget: vi.fn(async (_auth: unknown, id: string) => ({
    id,
    url: 'https://hooks.example.com/sub',
    active: true,
  })),
  deliverToSubscription,
}));
vi.mock('@/lib/db/authorized', () => ({
  withAuthorizedDb: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      execute: async () => {
        dbCalls.count += 1;
        if (dbAnswers.length === 0) throw new Error('REACHED_WRITE');
        return { rows: [dbAnswers.shift()] };
      },
    }),
}));
vi.mock('@/lib/authz/require-permission', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertTargetAffected: vi.fn(async () => undefined),
}));

import { executeAction, executeActionResolved } from '@/lib/workflows/actions';
import {
  ActionConfigSchema,
  CreateWorkflowSchema,
  DEPLOYMENT_SECRET_REF_MESSAGE,
  UpdateWorkflowSchema,
} from '@/lib/workflows/schema';
import { activateWorkflow, updateWorkflow } from '@/lib/workflows/service';
import type { Authorization } from '@/lib/authz/require-permission';
import type { WorkflowEvent } from '@/lib/workflows/events';

const SUB_ID = '77777777-7777-4777-8777-777777777777';
const WF_ID = '55555555-5555-4555-8555-555555555555';

const auth = {
  ctx: {
    personId: '44444444-4444-4434-8344-444444444444',
    orgId: '22222222-2222-4222-8222-222222222222',
  },
  requestId: 'test-b3',
} as Authorization;

const event: WorkflowEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  type: 'deal.created',
  entityType: 'deal',
  entityId: '33333333-3333-4333-8333-333333333333',
  actorPersonId: '44444444-4444-4434-8344-444444444444',
  occurredAt: '2026-10-21T08:00:00.000Z',
  dedupKey: 'deal:b3-1',
  payload: { ref: 'ACME' },
};

const webhook = (params: Record<string, unknown>) =>
  ({ type: 'webhook', params }) as Parameters<typeof executeAction>[2];
const definition = (actions: unknown[]) => ({
  name: 'b3',
  trigger: { type: 'deal.created' },
  actions,
});
const storedRow = (actions: unknown[]) => ({
  id: WF_ID,
  name: 'b3',
  description: null,
  status: 'DRAFT',
  trigger: { type: 'deal.created' },
  conditions: [],
  actions,
  version: 1,
  createdBy: auth.ctx.personId,
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
});

const LEGACY = {
  type: 'webhook',
  params: { url: 'https://hooks.example.com/x', signatureSecretRef: 'ACME' },
};
const CLEAN = { type: 'webhook', params: { url: 'https://hooks.example.com/x' } };

beforeEach(() => {
  enqueueJob.mockReset();
  enqueueJob.mockImplementation(async (_auth: unknown, input: { payload: unknown }) => ({
    id: 'job-1',
    payload: input.payload,
  }));
  deliverToSubscription.mockReset();
  deliverToSubscription.mockResolvedValue({ jobId: 'job-2', deliveryId: 'd-1', duplicate: false });
  dbAnswers.length = 0;
  dbCalls.count = 0;
});

describe('save time: create and update', () => {
  it('accepts subscription and URL webhook actions without a reference', () => {
    expect(
      CreateWorkflowSchema.safeParse(
        definition([CLEAN, { type: 'webhook', params: { subscriptionId: SUB_ID } }]),
      ).success,
    ).toBe(true);
    expect(UpdateWorkflowSchema.safeParse({ actions: [CLEAN] }).success).toBe(true);
    expect(UpdateWorkflowSchema.safeParse({ name: 'renamed' }).success).toBe(true);
  });

  it('refuses a URL action naming a deployment secret, at the field, with the B3 message', () => {
    const parsed = CreateWorkflowSchema.safeParse(definition([CLEAN, LEGACY]));
    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues.find((i) => i.message === DEPLOYMENT_SECRET_REF_MESSAGE);
    expect(issue?.path).toEqual(['actions', 1, 'params', 'signatureSecretRef']);
  });

  it('refuses it on update, in a subscription action, and as a template', () => {
    expect(UpdateWorkflowSchema.safeParse({ actions: [LEGACY] }).success).toBe(false);
    for (const params of [
      { subscriptionId: SUB_ID, signatureSecretRef: 'ACME' },
      { url: 'https://hooks.example.com/x', signatureSecretRef: '{{event.payload.ref}}' },
      { url: 'https://hooks.example.com/x', signatureSecretRef: '' },
    ]) {
      expect(
        CreateWorkflowSchema.safeParse(definition([{ type: 'webhook', params }])).success,
      ).toBe(false);
    }
  });

  it('a stored workflow that still has one stays readable (list, detail, trigger matching)', () => {
    expect(ActionConfigSchema.safeParse(LEGACY).success).toBe(true);
  });
});

describe('execution', () => {
  it('refuses a stored action naming a deployment secret; nothing is enqueued', async () => {
    for (const run of [
      () => executeAction(auth, event, webhook(LEGACY.params), { event }),
      () => executeActionResolved(auth, event, webhook(LEGACY.params), LEGACY.params),
      () =>
        executeAction(
          auth,
          event,
          webhook({
            url: 'https://hooks.example.com/x',
            signatureSecretRef: '{{event.payload.ref}}',
          }),
          { event },
        ),
    ]) {
      const result = await run();
      expect(result).toEqual({
        ok: false,
        errorCode: 'INVALID_REQUEST',
        errorMessage: DEPLOYMENT_SECRET_REF_MESSAGE,
      });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(deliverToSubscription).not.toHaveBeenCalled();
  });

  it('a URL action enqueues exactly url + body — no signing reference', async () => {
    const result = await executeAction(
      auth,
      event,
      webhook({ url: 'https://hooks.example.com/x', body: { a: 1 } }),
      { event },
    );
    expect(result).toEqual({ ok: true, output: { jobId: 'job-1' } });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0]![1].payload).toEqual({
      url: 'https://hooks.example.com/x',
      body: { a: 1 },
    });
  });

  it('a subscription action still goes through the subscription delivery', async () => {
    const result = await executeAction(auth, event, webhook({ subscriptionId: SUB_ID }), { event });
    expect(result.ok).toBe(true);
    expect(deliverToSubscription).toHaveBeenCalledTimes(1);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('activation and edits of a workflow stored with a reference', () => {
  it('activation is refused before the status changes', async () => {
    dbAnswers.push({ ok: true }, storedRow([LEGACY]));
    await expect(activateWorkflow(auth, WF_ID)).rejects.toThrow(
      `INVALID_REQUEST: ${DEPLOYMENT_SECRET_REF_MESSAGE}`,
    );
    expect(dbCalls.count).toBe(2);
  });

  it('a clean workflow passes the check and reaches the status write (control)', async () => {
    dbAnswers.push({ ok: true }, storedRow([CLEAN]));
    await expect(activateWorkflow(auth, WF_ID)).rejects.toThrow('REACHED_WRITE');
  });

  it('an edit that keeps the action is refused; one that removes the reference proceeds', async () => {
    dbAnswers.push({ ok: true }, storedRow([LEGACY]));
    await expect(updateWorkflow(auth, WF_ID, { name: 'renamed' })).rejects.toThrow(
      DEPLOYMENT_SECRET_REF_MESSAGE,
    );
    expect(dbCalls.count).toBe(2);

    dbAnswers.push({ ok: true }, storedRow([LEGACY]));
    await expect(updateWorkflow(auth, WF_ID, { actions: [CLEAN] })).rejects.toThrow(
      'REACHED_WRITE',
    );
  });
});
