'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DealFormSchema, type DealFormInput } from './schemas';
import { FieldLabel, FieldError, CompanyPicker, ContactPicker } from './pickers';
import {
  isErrorEnvelope,
  DEAL_STAGES,
  type Company,
  type Contact,
  type Deal,
  type CrmResult,
} from './types';
import { DEAL_STAGE_LABELS } from './format';

/**
 * Deal create/edit form. The contact picker narrows to the chosen company so
 * the (contact, company) pairing the database enforces can't be violated.
 */
export function DealForm({
  initial,
  companies,
  contacts,
  onSave,
}: {
  initial?: Deal;
  companies: Pick<Company, 'id' | 'name'>[];
  contacts: Pick<Contact, 'id' | 'company_id' | 'first_name' | 'last_name' | 'email'>[];
  onSave: (input: DealFormInput) => Promise<CrmResult<Deal>>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [companyId, setCompanyId] = useState(initial?.company_id ?? '');
  const [contactId, setContactId] = useState(initial?.contact_id ?? '');
  const [values, setValues] = useState({
    title: initial?.title ?? '',
    value: initial?.value ?? '',
    currency: initial?.currency ?? 'INR',
    stage: initial?.stage ?? 'NEW',
    probability:
      initial?.probability !== null && initial?.probability !== undefined
        ? String(initial.probability)
        : '',
    expected_close_date: initial?.expected_close_date?.slice(0, 10) ?? '',
  });

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function onCompanyChange(id: string) {
    setCompanyId(id);
    // The picked contact may not belong to the new company; clear it so the
    // pairing rule stays satisfied.
    if (id !== '') {
      const kept = contacts.find((c) => c.id === contactId);
      if (contactId && kept?.company_id !== id) setContactId('');
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const parsed = DealFormSchema.safeParse({
        ...values,
        company_id: companyId === '' ? undefined : companyId,
        contact_id: contactId === '' ? undefined : contactId,
      });
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (path && !errors[path]) errors[path] = issue.message;
        }
        setFieldErrors(errors);
        setFormError('Please fix the highlighted fields.');
        return;
      }
      const result = await onSave(parsed.data);
      if (isErrorEnvelope(result)) {
        setFormError(result.error.message);
      } else {
        router.push(`/crm/deals/${result.id}`);
        router.refresh();
      }
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? 'Edit deal' : 'New deal'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <FieldLabel htmlFor="deal-title">Title *</FieldLabel>
              <Input
                id="deal-title"
                value={values.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="Acme — annual platform license"
                maxLength={200}
                disabled={pending}
              />
              <FieldError message={fieldErrors.title} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-company">Company</FieldLabel>
              <CompanyPicker
                id="deal-company"
                companies={companies}
                value={companyId}
                onChange={onCompanyChange}
                disabled={pending}
              />
              <FieldError message={fieldErrors.company_id} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-contact">Contact</FieldLabel>
              <ContactPicker
                id="deal-contact"
                contacts={contacts}
                companyId={companyId === '' ? undefined : companyId}
                value={contactId}
                onChange={setContactId}
                disabled={pending}
              />
              <FieldError message={fieldErrors.contact_id} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-value">Value</FieldLabel>
              <Input
                id="deal-value"
                value={values.value}
                onChange={(e) => set('value', e.target.value)}
                placeholder="250000"
                inputMode="decimal"
                disabled={pending}
              />
              <FieldError message={fieldErrors.value} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-currency">Currency *</FieldLabel>
              <Input
                id="deal-currency"
                value={values.currency}
                onChange={(e) => set('currency', e.target.value)}
                placeholder="INR"
                maxLength={3}
                disabled={pending}
              />
              <FieldError message={fieldErrors.currency} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-stage">Stage *</FieldLabel>
              <select
                id="deal-stage"
                value={values.stage}
                onChange={(e) => set('stage', e.target.value)}
                disabled={pending}
                className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
              >
                {DEAL_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {DEAL_STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.stage} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-probability">Probability (%)</FieldLabel>
              <Input
                id="deal-probability"
                value={values.probability}
                onChange={(e) => set('probability', e.target.value)}
                placeholder="50"
                inputMode="numeric"
                disabled={pending}
              />
              <FieldError message={fieldErrors.probability} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="deal-expected-close">Expected close date</FieldLabel>
              <Input
                id="deal-expected-close"
                type="date"
                value={values.expected_close_date}
                onChange={(e) => set('expected_close_date', e.target.value)}
                disabled={pending}
              />
              <FieldError message={fieldErrors.expected_close_date} />
            </div>
          </div>
          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : initial ? 'Save changes' : 'Create deal'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
