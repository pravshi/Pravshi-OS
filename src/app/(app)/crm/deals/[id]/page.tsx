import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/crm/error-message';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { EditableSection } from '@/components/crm/editable-section';
import { DeleteDialog } from '@/components/crm/delete-dialog';
import { DealForm } from '@/components/crm/deal-form';
import { StageTransition } from '@/components/crm/stage-transition';
import { isErrorEnvelope, contactDisplayName, type DealStage } from '@/components/crm/types';
import {
  DEAL_STAGE_LABELS,
  formatMoney,
  formatDate,
  formatDateTime,
  stageBadgeClasses,
} from '@/components/crm/format';
import {
  getDealAction,
  getCompanyAction,
  getContactAction,
  listCompaniesAction,
  listContactsAction,
  updateDealAction,
  deleteDealAction,
} from '../../_api';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../../_permissions';

/** /crm/deals/[id] — deal detail with stage transitions, edit, and links. */
export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrmPagePermission('deals', 'view');
  const { id } = await params;

  const [dealRes, companiesRes, contactsRes, held] = await Promise.all([
    getDealAction(id),
    listCompaniesAction({ limit: 100 }),
    listContactsAction({ limit: 100 }),
    getCrmPermissions(),
  ]);

  if (isErrorEnvelope(dealRes)) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorMessage error={dealRes} title="Could not load deal" />
      </div>
    );
  }

  const deal = dealRes;
  const perms = uiPermissionsFor(held, 'deals');

  const companyNames = new Map<string, string>();
  if (!isErrorEnvelope(companiesRes)) {
    for (const c of companiesRes.rows) companyNames.set(c.id, c.name);
  }
  let companyName: string | null = deal.company_id
    ? (companyNames.get(deal.company_id) ?? null)
    : null;
  let contactName: string | null = null;

  if (deal.company_id && companyName === null) {
    const companyRes = await getCompanyAction(deal.company_id);
    if (!isErrorEnvelope(companyRes)) companyName = companyRes.name;
  }
  if (deal.contact_id) {
    const contactRes = await getContactAction(deal.contact_id);
    if (!isErrorEnvelope(contactRes)) contactName = contactDisplayName(contactRes);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BackLink />
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{deal.title}</h1>
          <div className="mt-2 flex items-center gap-3">
            <Badge className={stageBadgeClasses(deal.stage)}>{DEAL_STAGE_LABELS[deal.stage]}</Badge>
            <span className="text-lg font-semibold">{formatMoney(deal.value, deal.currency)}</span>
          </div>
        </div>
        {perms.canDelete && (
          <DeleteDialog
            resourceName="deal"
            recordName={deal.title}
            onDelete={() => deleteDealAction(deal.id)}
            redirectTo="/crm/deals"
          />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <StageTransition
            deal={deal}
            onTransition={(dealId, input: { stage: DealStage }) => updateDealAction(dealId, input)}
            disabled={!perms.canEdit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <DetailField label="Title">{deal.title}</DetailField>
            <DetailField label="Company">
              {deal.company_id ? (
                <DetailLink href={`/crm/companies/${deal.company_id}`}>
                  {companyName ?? 'View company'}
                </DetailLink>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Contact">
              {deal.contact_id ? (
                <DetailLink href={`/crm/contacts/${deal.contact_id}`}>
                  {contactName ?? 'View contact'}
                </DetailLink>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Value">{formatMoney(deal.value, deal.currency)}</DetailField>
            <DetailField label="Currency">{deal.currency}</DetailField>
            <DetailField label="Stage">{DEAL_STAGE_LABELS[deal.stage]}</DetailField>
            <DetailField label="Probability">
              {deal.probability === null ? '—' : `${deal.probability}%`}
            </DetailField>
            <DetailField label="Expected close">{formatDate(deal.expected_close_date)}</DetailField>
            <DetailField label="Closed at">{formatDateTime(deal.closed_at)}</DetailField>
            <DetailField label="Created">{formatDateTime(deal.created_at)}</DetailField>
            <DetailField label="Updated">{formatDateTime(deal.updated_at)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      {perms.canEdit && (
        <EditableSection buttonLabel="Edit deal">
          <DealForm
            initial={deal}
            companies={
              isErrorEnvelope(companiesRes)
                ? []
                : companiesRes.rows.map((c) => ({ id: c.id, name: c.name }))
            }
            contacts={
              isErrorEnvelope(contactsRes)
                ? []
                : contactsRes.rows.map((c) => ({
                    id: c.id,
                    company_id: c.company_id,
                    first_name: c.first_name,
                    last_name: c.last_name,
                    email: c.email,
                  }))
            }
            onSave={(input) => updateDealAction(deal.id, input)}
          />
        </EditableSection>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/crm/deals" className="text-sm text-ink-muted hover:text-foreground">
      ← All deals
    </Link>
  );
}
