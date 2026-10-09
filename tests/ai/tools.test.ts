/**
 * Unit tests: AI tool registry and the six read-only CRM tools
 * (phase9-contract-review.md §6.2/§6.3, test plan §11.1).
 *
 * Everything here runs without a database: the tools are composed with fake
 * services through the `createCrmTools` seam, and the dispatcher's
 * permission pre-check is injected. DB-backed enforcement (RLS, scope,
 * cross-tenant) is covered by the integration/security suites.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthorizationError } from '@/lib/authz/errors';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Activity, Company, Contact, Deal, Page } from '@/lib/crm/schema';
import type { Project, Task } from '@/lib/work/schema';
import { createCrmTools, toolRegistry, type CrmToolServices } from '@/lib/ai/tools/crm-tools';
import {
  createToolRegistry,
  dispatchToolCall,
  listProviderToolDefinitions,
  toModelToolResult,
  toProviderToolDefinition,
  DEFAULT_TOOL_TIMEOUT_MS,
  type AiTool,
  type ToolExecutionEvent,
} from '@/lib/ai/tools/registry';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PERSON_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const DEAL_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const TASK_ID = '77777777-7777-4777-8777-777777777777';

/** A fabricated Authorization: the injected seams never verify provenance. */
const fakeAuth = {
  ctx: { personId: PERSON_ID, orgId: ORG_ID, aal: 'aal1' },
  permission: 'ai.use',
  scope: 'GLOBAL',
  aal: 'aal1',
  requestId: '88888888-8888-4888-8888-888888888888',
  meta: {},
} as unknown as Authorization;

const grantAll = async () => 'GLOBAL' as const;
const grantNone = async () => null;

const companyDto: Company = {
  id: COMPANY_ID,
  name: 'Acme Corp',
  domain: 'acme.example',
  industry: 'Manufacturing',
  size: '51-200',
  website: 'https://acme.example',
  phone: '+1-555-0100',
  addressLine1: '1 Hidden Way',
  addressLine2: null,
  addressCity: 'Springfield',
  addressState: 'IL',
  addressPostalCode: '62701',
  countryCode: 'US',
  ownerPersonId: PERSON_ID,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

const contactDto: Contact = {
  id: CONTACT_ID,
  companyId: COMPANY_ID,
  companyName: 'Acme Corp',
  firstName: 'Priya',
  lastName: 'Sharma',
  email: 'priya@acme.example',
  phone: '+1-555-0101',
  title: 'VP Operations',
  department: 'Operations',
  ownerPersonId: PERSON_ID,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

const dealDto: Deal = {
  id: DEAL_ID,
  title: 'Acme rollout',
  companyId: COMPANY_ID,
  companyName: 'Acme Corp',
  contactId: CONTACT_ID,
  contactName: 'Priya Sharma',
  value: '125000.00',
  currency: 'INR',
  stage: 'PROPOSAL',
  pipelineId: null,
  pipelineStageId: null,
  probability: 40,
  ownerPersonId: PERSON_ID,
  expectedCloseDate: '2026-11-30',
  closedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

const activityDto: Activity = {
  id: '99999999-9999-4999-8999-999999999999',
  entityType: 'deal',
  entityId: DEAL_ID,
  type: 'CALL',
  subject: 'Discovery call',
  notes: 'Discussed the rollout plan.',
  occurredAt: '2026-01-02T10:00:00.000Z',
  dueAt: null,
  entityName: 'Acme rollout',
  ownerPersonId: PERSON_ID,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

const projectDto: Project = {
  id: PROJECT_ID,
  name: 'Onboarding',
  description: 'Roll out the platform.',
  isArchived: false,
  dealId: DEAL_ID,
  createdBy: PERSON_ID,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

const taskDto: Task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  projectName: 'Onboarding',
  title: 'Prepare kickoff',
  description: 'Agenda and invites.',
  status: 'todo',
  priority: 'high',
  dueDate: '2026-10-20',
  assigneePersonId: PERSON_ID,
  assigneeName: 'Priya Sharma',
  parentTaskId: null,
  subtaskTotal: null,
  subtaskCompleted: null,
  createdBy: PERSON_ID,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T03:04:05.000Z',
};

function fakeServices(overrides: Partial<CrmToolServices> = {}): CrmToolServices {
  return {
    getCompany: vi.fn(async () => companyDto),
    getContact: vi.fn(async () => contactDto),
    getDeal: vi.fn(async () => dealDto),
    listActivities: vi.fn(async (): Promise<Page<Activity>> => ({
      rows: [activityDto],
      total: 1,
      limit: 20,
      offset: 0,
    })),
    getProject: vi.fn(async () => projectDto),
    getTask: vi.fn(async () => taskDto),
    ...overrides,
  };
}

function registryWith(services: CrmToolServices) {
  return createToolRegistry(createCrmTools(services));
}

describe('registry completeness (§6.3)', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['get_company', 'companies.view'],
    ['get_contact', 'contacts.view'],
    ['get_deal', 'deals.view'],
    ['get_activity_history', 'activities.view'],
    ['get_project', 'projects.view'],
    ['get_task', 'tasks.view'],
  ];

  it('registers exactly the six read-only tools with their §6.3 permissions', () => {
    const tools = toolRegistry.list();
    expect(tools.map((t) => t.id)).toEqual(expected.map(([id]) => id));
    for (const [id, permission] of expected) {
      const tool = toolRegistry.get(id);
      expect(tool, id).toBeDefined();
      expect(tool?.requiredPermission).toBe(permission);
      expect(tool?.classification).toBe('read');
      expect(tool?.description.length).toBeGreaterThan(0);
      expect(tool?.inputSchema).toBeInstanceOf(z.ZodType);
      expect(tool?.outputSchema).toBeInstanceOf(z.ZodType);
      expect(tool?.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
      expect(tool?.audit).toEqual({
        mode: 'count_only',
        includeArguments: false,
        includeResult: false,
      });
      expect(toolRegistry.has(id)).toBe(true);
    }
    expect(toolRegistry.get('delete_company')).toBeUndefined();
    expect(toolRegistry.has('run_sql')).toBe(false);
  });

  it('refuses duplicate ids and non-read classifications at composition time', () => {
    const tool = createCrmTools(fakeServices())[0]!;
    expect(() => createToolRegistry([tool, tool])).toThrow(/registered twice/);
    const writeTool = { ...tool, id: 'write_thing', classification: 'write' } as unknown as AiTool;
    expect(() => createToolRegistry([writeTool])).toThrow(/classification must be 'read'/);
  });

  it('renders provider definitions with strict JSON Schemas (§3.1)', () => {
    const defs = listProviderToolDefinitions(toolRegistry);
    expect(defs.map((d) => d.name)).toEqual(expected.map(([id]) => id));
    const company = toProviderToolDefinition(toolRegistry.get('get_company')!);
    expect(company.description).toBe(toolRegistry.get('get_company')?.description);
    const schema = company.inputSchema as {
      type?: string;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['id']);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('argument validation', () => {
  it.each([
    ['missing id', {}],
    ['non-uuid id', { id: 'acme' }],
    ['injection-shaped id', { id: "1'; DROP TABLE companies; --" }],
    ['wrong type', { id: 42 }],
    ['null id', { id: null }],
    ['unknown extra field', { id: COMPANY_ID, orgId: ORG_ID }],
    ['oversized string', { id: 'x'.repeat(10_000) }],
    ['array instead of object', [COMPANY_ID]],
    ['null arguments', null],
  ])('rejects %s without calling the service', async (_label, args) => {
    const services = fakeServices();
    const result = await dispatchToolCall(registryWith(services), fakeAuth, 'get_company', args, {
      scopeFor: grantAll,
    });
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'invalid_arguments' });
    expect(services.getCompany).not.toHaveBeenCalled();
    expect(toModelToolResult(result)).toEqual({ error: 'unavailable' });
  });

  it('rejects an entityType outside the CRM polymorphic set', async () => {
    const services = fakeServices();
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_activity_history',
      { entityType: 'user', entityId: DEAL_ID },
      { scopeFor: grantAll },
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    expect(services.listActivities).not.toHaveBeenCalled();
  });
});

describe('permission pre-check', () => {
  it('denies before execution when scope_for is null — the service is never called', async () => {
    const services = fakeServices();
    const scopeFor = vi.fn(grantNone);
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_deal',
      { id: DEAL_ID },
      { scopeFor },
    );
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'permission_denied' });
    expect(scopeFor).toHaveBeenCalledWith(fakeAuth, 'deals.view');
    expect(services.getDeal).not.toHaveBeenCalled();
    expect(toModelToolResult(result)).toEqual({ error: 'unavailable' });
  });

  it('treats a failing pre-check as unavailable, never as a pass', async () => {
    const services = fakeServices();
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_task',
      { id: TASK_ID },
      {
        scopeFor: async () => {
          throw new Error('database unreachable');
        },
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(services.getTask).not.toHaveBeenCalled();
  });
});

describe('error mapping — existence never leaks to the model', () => {
  it('maps a service NOT_FOUND to exactly { error: unavailable }', async () => {
    const services = fakeServices({
      getCompany: vi.fn(async () => {
        throw new AuthorizationError('NOT_FOUND', {
          requestId: '88888888-8888-4888-8888-888888888888',
          reason: 'TARGET_NOT_VISIBLE',
        });
      }),
    });
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_company',
      { id: COMPANY_ID },
      { scopeFor: grantAll },
    );
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'not_found' });
    expect(toModelToolResult(result)).toEqual({ error: 'unavailable' });
  });

  it('maps FORBIDDEN the same way, and generic failures leak no detail', async () => {
    const secret = 'sensitive internals: connection string at db.internal';
    const services = fakeServices({
      getContact: vi.fn(async () => {
        throw new AuthorizationError('FORBIDDEN', {
          requestId: '88888888-8888-4888-8888-888888888888',
          reason: 'PERMISSION_DENIED',
        });
      }),
      getDeal: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const registry = registryWith(services);
    const forbidden = await dispatchToolCall(
      registry,
      fakeAuth,
      'get_contact',
      { id: CONTACT_ID },
      { scopeFor: grantAll },
    );
    expect(forbidden).toMatchObject({ ok: false, reason: 'forbidden' });
    const failed = await dispatchToolCall(
      registry,
      fakeAuth,
      'get_deal',
      { id: DEAL_ID },
      { scopeFor: grantAll },
    );
    expect(failed).toMatchObject({ ok: false, error: 'unavailable', reason: 'failed' });
    expect(JSON.stringify(toModelToolResult(failed))).not.toContain('sensitive');
    expect(JSON.stringify(failed)).not.toContain('sensitive');
  });

  it('unknown tool ids are a tool error result, never a throw', async () => {
    const result = await dispatchToolCall(
      toolRegistry,
      fakeAuth,
      'run_sql',
      { q: 'select 1' },
      { scopeFor: grantAll },
    );
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'unknown_tool' });
    expect(toModelToolResult(result)).toEqual({ error: 'unavailable' });
  });
});

describe('successful execution and allowlist projection', () => {
  it('get_company returns only allowlisted fields, with city/state mapped from the DTO', async () => {
    const services = fakeServices();
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_company',
      { id: COMPANY_ID },
      { scopeFor: grantAll },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      id: COMPANY_ID,
      name: 'Acme Corp',
      domain: 'acme.example',
      industry: 'Manufacturing',
      size: '51-200',
      city: 'Springfield',
      state: 'IL',
      countryCode: 'US',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('Hidden Way');
    expect(serialized).not.toContain('ownerPersonId');
    expect(services.getCompany).toHaveBeenCalledWith(fakeAuth, COMPANY_ID);
  });

  it('get_contact drops email, phone and department', async () => {
    const result = await dispatchToolCall(
      registryWith(fakeServices()),
      fakeAuth,
      'get_contact',
      { id: CONTACT_ID },
      { scopeFor: grantAll },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      id: CONTACT_ID,
      firstName: 'Priya',
      lastName: 'Sharma',
      title: 'VP Operations',
      companyName: 'Acme Corp',
    });
  });

  it('get_activity_history calls the service with limit 20 and maps notes to body', async () => {
    const services = fakeServices();
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_activity_history',
      { entityType: 'deal', entityId: DEAL_ID },
      { scopeFor: grantAll },
    );
    expect(services.listActivities).toHaveBeenCalledWith(fakeAuth, {
      entityType: 'deal',
      entityId: DEAL_ID,
      limit: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      entityType: 'deal',
      entityId: DEAL_ID,
      total: 1,
      activities: [
        {
          type: 'CALL',
          subject: 'Discovery call',
          body: 'Discussed the rollout plan.',
          occurredAt: '2026-01-02T10:00:00.000Z',
          dueAt: null,
        },
      ],
    });
  });

  it('truncates long text fields to the §7.3 per-field bound', async () => {
    const long = 'n'.repeat(2_000);
    const services = fakeServices({
      listActivities: vi.fn(async (): Promise<Page<Activity>> => ({
        rows: [{ ...activityDto, notes: long }],
        total: 1,
        limit: 20,
        offset: 0,
      })),
    });
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_activity_history',
      { entityType: 'deal', entityId: DEAL_ID },
      { scopeFor: grantAll },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { activities: Array<{ body: string }> };
    expect(value.activities[0]?.body).toHaveLength(500);
  });

  it('fails the call (unavailable) if a projection ever emits a non-allowlisted field', async () => {
    // A defective service payload that makes the projection produce a value
    // the output schema rejects: name is not a string.
    const services = fakeServices({
      getCompany: vi.fn(async () => ({ ...companyDto, name: undefined }) as unknown as Company),
    });
    const result = await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_company',
      { id: COMPANY_ID },
      { scopeFor: grantAll },
    );
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'failed' });
  });
});

describe('timeout enforcement', () => {
  it('bounds a slow tool by its timeoutMs and reports reason timeout', async () => {
    const slowTool: AiTool = {
      id: 'slow_tool',
      description: 'Test double that never settles in time.',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ done: z.boolean() }),
      requiredPermission: 'deals.view',
      classification: 'read',
      timeoutMs: 25,
      audit: { mode: 'count_only', includeArguments: false, includeResult: false },
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 250)),
    };
    const result = await dispatchToolCall(
      createToolRegistry([slowTool]),
      fakeAuth,
      'slow_tool',
      {},
      { scopeFor: grantAll },
    );
    expect(result).toMatchObject({ ok: false, error: 'unavailable', reason: 'timeout' });
  });

  it('bounds a slow tool by the request deadline signal as well', async () => {
    const controller = new AbortController();
    const slowTool: AiTool = {
      id: 'slow_tool_2',
      description: 'Test double bounded by the request deadline.',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ done: z.boolean() }),
      requiredPermission: 'deals.view',
      classification: 'read',
      timeoutMs: 60_000,
      audit: { mode: 'count_only', includeArguments: false, includeResult: false },
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 250)),
    };
    const pending = dispatchToolCall(
      createToolRegistry([slowTool]),
      fakeAuth,
      'slow_tool_2',
      {},
      { scopeFor: grantAll, signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('audit hook', () => {
  it('fires exactly once per dispatch with metadata only — no arguments, no results', async () => {
    const events: ToolExecutionEvent[] = [];
    const services = fakeServices();
    await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_task',
      { id: TASK_ID },
      {
        scopeFor: grantAll,
        onExecuted: (e) => events.push(e),
      },
    );
    await dispatchToolCall(
      registryWith(services),
      fakeAuth,
      'get_task',
      { id: TASK_ID },
      {
        scopeFor: grantNone,
        onExecuted: (e) => events.push(e),
      },
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ toolId: 'get_task', outcome: 'ok' });
    expect(events[1]).toMatchObject({ toolId: 'get_task', outcome: 'permission_denied' });
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['durationMs', 'outcome', 'toolId']);
      expect(JSON.stringify(event)).not.toContain(TASK_ID);
    }
  });
});
