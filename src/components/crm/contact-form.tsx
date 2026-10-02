'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ContactFormSchema, type ContactFormInput } from './schemas';
import { FieldLabel, FieldError, CompanyPicker } from './pickers';
import { isErrorEnvelope, type Company, type Contact, type CrmResult } from './types';

/** Contact create/edit form, with a company picker for the link. */
export function ContactForm({
  initial,
  companies,
  onSave,
}: {
  initial?: Contact;
  companies: Pick<Company, 'id' | 'name'>[];
  onSave: (input: ContactFormInput) => Promise<CrmResult<Contact>>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [companyId, setCompanyId] = useState(initial?.companyId ?? '');
  const [values, setValues] = useState({
    firstName: initial?.firstName ?? '',
    lastName: initial?.lastName ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    title: initial?.title ?? '',
    department: initial?.department ?? '',
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
      const parsed = ContactFormSchema.safeParse({
        ...values,
        companyId: companyId === '' ? undefined : companyId,
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
        router.push(`/crm/contacts/${result.id}`);
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
    opts?: { placeholder?: string; maxLength?: number; type?: string },
  ) => (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={`contact-${key}`}>{label}</FieldLabel>
      <Input
        id={`contact-${key}`}
        type={opts?.type ?? 'text'}
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
        <CardTitle>{initial ? 'Edit contact' : 'New contact'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {text('firstName', 'First name *', { placeholder: 'Priya', maxLength: 100 })}
            {text('lastName', 'Last name *', { placeholder: 'Sharma', maxLength: 100 })}
            {text('email', 'Email', {
              placeholder: 'priya@acme.com',
              maxLength: 254,
              type: 'email',
            })}
            {text('phone', 'Phone', { placeholder: '+91 98XXX XXXXX', maxLength: 50 })}
            {text('title', 'Title', { placeholder: 'Head of Operations', maxLength: 150 })}
            {text('department', 'Department', { placeholder: 'Operations', maxLength: 100 })}
            <div className="space-y-1.5 sm:col-span-2">
              <FieldLabel htmlFor="contact-company">Company</FieldLabel>
              <CompanyPicker
                id="contact-company"
                companies={companies}
                value={companyId}
                onChange={setCompanyId}
                disabled={pending}
              />
              <FieldError message={fieldErrors.companyId} />
            </div>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : initial ? 'Save changes' : 'Create contact'}
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
