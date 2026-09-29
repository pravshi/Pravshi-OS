import type { DealStage } from './types';

/** Deal value formatting: numeric(19,4) strings with an Indian-style readout. */
export function formatMoney(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (Number.isNaN(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString('en-IN')}`;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Short owner reference until a person-name resolver exists (see gap note in README). */
export function shortOwnerId(ownerPersonId: string): string {
  return ownerPersonId.length > 8 ? `${ownerPersonId.slice(0, 8)}…` : ownerPersonId;
}

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

/** The stage's lifecycle neighbors: forward moves plus loss, never backward. */
export function nextStages(stage: DealStage): DealStage[] {
  switch (stage) {
    case 'NEW':
      return ['QUALIFIED', 'LOST'];
    case 'QUALIFIED':
      return ['PROPOSAL', 'LOST'];
    case 'PROPOSAL':
      return ['NEGOTIATION', 'LOST'];
    case 'NEGOTIATION':
      return ['WON', 'LOST'];
    case 'WON':
    case 'LOST':
      return [];
  }
}

export function stageBadgeClasses(stage: DealStage): string {
  switch (stage) {
    case 'WON':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
    case 'LOST':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
    case 'NEGOTIATION':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200';
    case 'PROPOSAL':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    case 'QUALIFIED':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200';
    case 'NEW':
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';
  }
}
