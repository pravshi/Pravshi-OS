import { LinkButton } from '@/components/crm/link-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isErrorEnvelope } from '@/components/crm/types';
import type { ErrorEnvelope } from '@/lib/authz/errors';
import { listCompaniesAction, listContactsAction, listDealsAction } from './_api';
import { getCrmPermissions, CRM_PERMISSIONS } from './_permissions';

/**
 * /crm — CRM landing. Cards link to each resource with a live count when the
 * counts load; only resources the viewer may see are shown.
 */
export default async function CrmDashboardPage() {
  let held: Set<string>;
  try {
    held = await getCrmPermissions();
  } catch (e) {
    held = new Set();
    console.error('[crm] dashboard permission check failed', e);
  }

  const canView = (key: string) => held.has(key);

  const [companiesRes, contactsRes, dealsRes] = await Promise.all([
    canView(CRM_PERMISSIONS.companies.view)
      ? listCompaniesAction({ limit: 1 }).catch(toEnvelope)
      : null,
    canView(CRM_PERMISSIONS.contacts.view)
      ? listContactsAction({ limit: 1 }).catch(toEnvelope)
      : null,
    canView(CRM_PERMISSIONS.deals.view) ? listDealsAction({ limit: 1 }).catch(toEnvelope) : null,
  ]);

  const cards = [
    {
      key: CRM_PERMISSIONS.companies.view,
      title: 'Companies',
      description: 'Customer and prospect organizations.',
      href: '/crm/companies',
      count: totalOf(companiesRes),
    },
    {
      key: CRM_PERMISSIONS.contacts.view,
      title: 'Contacts',
      description: 'People at customer and prospect organizations.',
      href: '/crm/contacts',
      count: totalOf(contactsRes),
    },
    {
      key: CRM_PERMISSIONS.deals.view,
      title: 'Deals',
      description: 'Pipeline: value, stage, and expected close.',
      href: '/crm/deals',
      count: totalOf(dealsRes),
    },
  ].filter((c) => canView(c.key));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">CRM</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Companies, contacts, and deals — the core of the business record.
        </p>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-lg border border-line p-6 text-sm text-ink-muted">
          Your account does not have access to any CRM section yet. Ask an administrator for access.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <Card key={c.key}>
              <CardHeader>
                <CardTitle>{c.title}</CardTitle>
                <CardDescription>{c.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tracking-tight">
                  {c.count === null ? '—' : c.count.toLocaleString('en-IN')}
                </p>
                <LinkButton href={c.href} variant="outline" className="mt-4">
                  Open {c.title.toLowerCase()}
                </LinkButton>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function totalOf(res: { total: number } | ErrorEnvelope | null): number | null {
  if (res === null) return null;
  if (isErrorEnvelope(res)) return null;
  return res.total;
}

/** A thrown shim becomes an envelope so the dashboard degrades to counts of "—". */
function toEnvelope(error: unknown): ErrorEnvelope {
  return {
    error: {
      code: 'INTERNAL',
      message: error instanceof Error ? error.message : 'Unavailable',
    },
  };
}
