import { requirePagePermission } from '@/lib/authz/page';
import { getTeamsPageData } from './actions';
import { TeamsClient } from './teams-client';

/** /admin/teams — teams live inside departments. teams.view to see, teams.manage to change. */
export default async function AdminTeamsPage() {
  await requirePagePermission('teams.view');
  const { teams, departments, people } = await getTeamsPageData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Teams</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Teams belong to a department. Manage membership per team; archiving a team ends its
          memberships.
        </p>
      </div>
      <TeamsClient teams={teams} departments={departments} people={people} />
    </div>
  );
}
