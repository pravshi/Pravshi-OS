'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CompanyFormSchema, type CompanyFormInput } from './schemas';
import { FieldLabel, FieldError } from './pickers';
import { isErrorEnvelope, COMPANY_SIZES, type Company, type CrmResult } from './types';

/**
 * Company create/edit form. Client-validates with the (duplicated) zod schema,
 * then hands a clean object to the server action; the server re-validates and
 * stamps ownership (created_by = acting person — the DB INSERT rule requires
 * owner = actor, so no owner picker is offered on create).
 */
export function CompanyForm({
  initial,
  onSave,
}: {
  initial?: Company;
  onSave: (input: CompanyFormInput) => Promise<CrmResult<Company>>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [values, setValues] = useState({
    name: initial?.name ?? '',
    domain: initial?.domain ?? '',
    industry: initial?.industry ?? '',
    size: initial?.size ?? '',
    website: initial?.website ?? '',
    phone: initial?.phone ?? '',
    addressLine1: initial?.addressLine1 ?? '',
    addressLine2: initial?.addressLine2 ?? '',
    addressCity: initial?.addressCity ?? '',
    addressState: initial?.addressState ?? '',
    addressPostalCode: initial?.addressPostalCode ?? '',
    countryCode: initial?.countryCode ?? 'IN',
  });

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const parsed = CompanyFormSchema.safeParse({
        ...values,
        size: values.size === '' ? undefined : values.size,
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
        router.push(`/crm/companies/${result.id}`);
        router.refresh();
      }
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  const text = (
    key: keyof typeof values,
    label: string,
    opts?: { placeholder?: string; maxLength?: number },
  ) => (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={`company-${key}`}>{label}</FieldLabel>
      <Input
        id={`company-${key}`}
        value={values[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={opts?.placeholder}
        maxLength={opts?.maxLength}
        disabled={pending}
      />
      <FieldError message={fieldErrors[key]} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? 'Edit company' : 'New company'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {text('name', 'Name *', { placeholder: 'Acme Industries', maxLength: 200 })}
            {text('domain', 'Domain', { placeholder: 'acme.com', maxLength: 253 })}
            {text('industry', 'Industry', { placeholder: 'Manufacturing', maxLength: 100 })}
            <div className="space-y-1.5">
              <FieldLabel htmlFor="company-size">Size</FieldLabel>
              <select
                id="company-size"
                value={values.size}
                onChange={(e) => set('size', e.target.value)}
                disabled={pending}
                className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
              >
                <option value="">Not set</option>
                {COMPANY_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.size} />
            </div>
            {text('website', 'Website', { placeholder: 'https://acme.com', maxLength: 500 })}
            {text('phone', 'Phone', { placeholder: '+91 80 1234 5678', maxLength: 50 })}
            {text('addressLine1', 'Address line 1', { maxLength: 200 })}
            {text('addressLine2', 'Address line 2', { maxLength: 200 })}
            {text('addressCity', 'City', { maxLength: 100 })}
            {text('addressState', 'State', { maxLength: 100 })}
            {text('addressPostalCode', 'Postal code', { maxLength: 20 })}
            {text('countryCode', 'Country code *', { placeholder: 'IN', maxLength: 2 })}
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : initial ? 'Save changes' : 'Create company'}
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
