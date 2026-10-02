'use client';

import { Label } from '@/components/ui/label';
import { cn } from 'cn';
import type { Company, Contact } from './types';
import { contactDisplayName } from './types';

/**
 * Relationship pickers for CRM forms: plain styled selects fed by server-side
 * option lists (fetched in the page, where RLS applies). The contact picker
 * narrows to the chosen company so the deal pairing rule can't be violated.
 */

const selectClasses =
  'w-full rounded-md border border-line bg-background px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export function CompanyPicker({
  id,
  companies,
  value,
  onChange,
  disabled,
}: {
  id: string;
  companies: Pick<Company, 'id' | 'name'>[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={selectClasses}
    >
      <option value="">No company</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

export function ContactPicker({
  id,
  contacts,
  companyId,
  value,
  onChange,
  disabled,
}: {
  id: string;
  contacts: Pick<Contact, 'id' | 'companyId' | 'firstName' | 'lastName' | 'email'>[];
  /** When set, only contacts of this company are offered. */
  companyId?: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const options = companyId ? contacts.filter((c) => c.companyId === companyId) : contacts;
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(selectClasses, companyId && options.length === 0 && 'opacity-70')}
    >
      <option value="">No contact</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {contactDisplayName(c)}
          {c.email ? ` — ${c.email}` : ''}
        </option>
      ))}
    </select>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <Label htmlFor={htmlFor} className="text-sm font-medium">
      {children}
    </Label>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
