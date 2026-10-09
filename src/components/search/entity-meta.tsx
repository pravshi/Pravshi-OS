import {
  Activity,
  Building2,
  FolderKanban,
  Handshake,
  ListTodo,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { SearchEntityType } from '@/lib/search/types';

/**
 * Display metadata for the 8 approved search entity types (contract §16.1 —
 * no 'lead'). Shared by the header typeahead and the results page so icons
 * and labels stay consistent.
 */
export interface EntityMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
}

export const ENTITY_META: Record<SearchEntityType, EntityMeta> = {
  contact: { label: 'Contact', plural: 'Contacts', icon: User },
  company: { label: 'Company', plural: 'Companies', icon: Building2 },
  deal: { label: 'Deal', plural: 'Deals', icon: Handshake },
  project: { label: 'Project', plural: 'Projects', icon: FolderKanban },
  task: { label: 'Task', plural: 'Tasks', icon: ListTodo },
  activity: { label: 'Activity', plural: 'Activities', icon: Activity },
  workflow: { label: 'Workflow', plural: 'Workflows', icon: Workflow },
  person: { label: 'Person', plural: 'People', icon: Users },
};
