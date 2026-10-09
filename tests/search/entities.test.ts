/**
 * Unit tests: the searchable entity registry (contracts §§16.1, 16.6).
 *
 * Pins the closed 8-type union (no 'lead'), the per-entity view permission
 * keys, the 0017 people-PII rule, and the status allowlists. SQL identifier
 * safety (the ident() guard in query.ts) is structural; these tests pin the
 * data it guards.
 */
import { describe, expect, it } from 'vitest';
import { allowedStatusValues, entityConfig, ENTITY_VIEW_PERMISSIONS } from '@/lib/search/entities';
import { SEARCH_ENTITY_TYPES } from '@/lib/search/types';

const PII_COLUMNS = ['personal_email', 'phone', 'date_of_birth'];

describe('entity registry', () => {
  it('covers exactly the 8 approved types — no lead, no extras', () => {
    expect(SEARCH_ENTITY_TYPES).toHaveLength(8);
    expect(SEARCH_ENTITY_TYPES).not.toContain('lead');
    for (const t of SEARCH_ENTITY_TYPES) {
      expect(() => entityConfig(t)).not.toThrow();
    }
  });

  it('maps every entity to its existing view permission (§16.6, no new permission)', () => {
    expect(ENTITY_VIEW_PERMISSIONS).toEqual({
      contact: 'contacts.view',
      company: 'companies.view',
      deal: 'deals.view',
      activity: 'activities.view',
      project: 'projects.view',
      task: 'tasks.view',
      workflow: 'workflows.view',
      person: 'people.view',
    });
  });

  it('searches people by full_legal_name and work_email ONLY (0017 rule)', () => {
    const person = entityConfig('person');
    expect(person.searchColumns).toEqual(['full_legal_name', 'work_email']);
    const searchable = person.searchColumns.join(' ');
    for (const pii of PII_COLUMNS) {
      expect(searchable).not.toContain(pii);
    }
    expect(person.metadataExpr).not.toContain('personal_email');
    expect(person.metadataExpr).not.toContain('phone');
    expect(person.metadataExpr).not.toContain('date_of_birth');
  });

  it('maps the contract activity description to the notes column (0034)', () => {
    expect(entityConfig('activity').searchColumns).toContain('notes');
  });

  it('exposes strict status allowlists only where the entity has one', () => {
    expect(entityConfig('deal').statusValues).toEqual([
      'NEW',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(entityConfig('task').statusValues).toEqual(['todo', 'in_progress', 'done']);
    expect(entityConfig('workflow').statusValues).toEqual([
      'DRAFT',
      'ACTIVE',
      'PAUSED',
      'ARCHIVED',
    ]);
    expect(entityConfig('activity').statusValues).toEqual(['CALL', 'EMAIL', 'MEETING', 'NOTE']);
    expect(entityConfig('company').statusValues).toBeUndefined();
    expect(entityConfig('contact').statusValues).toBeUndefined();
    expect(entityConfig('person').statusValues).toBeUndefined();
    expect(entityConfig('project').statusValues).toBeUndefined();
  });

  it('unions status values for validation', () => {
    const all = allowedStatusValues(SEARCH_ENTITY_TYPES);
    expect(all.has('WON')).toBe(true);
    expect(all.has('done')).toBe(true);
    expect(all.has('BOGUS')).toBe(false);
  });

  it('gives every entity a frontend deep-link prefix', () => {
    for (const t of SEARCH_ENTITY_TYPES) {
      const prefix = entityConfig(t).urlPrefix;
      expect(prefix.startsWith('/')).toBe(true);
    }
  });

  it('defines owner columns where the entity has an owner concept', () => {
    expect(entityConfig('contact').ownerColumn).toBe('owner_person_id');
    expect(entityConfig('deal').ownerColumn).toBe('owner_person_id');
    expect(entityConfig('task').ownerColumn).toBe('assignee_person_id');
    expect(entityConfig('person').ownerColumn).toBe('id');
  });
});
