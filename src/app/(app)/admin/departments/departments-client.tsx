'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createDepartmentAction, archiveDepartmentAction } from './actions';

interface Department {
  id: string;
  code: string;
  name: string;
  status: string;
  memberCount: number;
}

export function DepartmentsClient({ departments }: { departments: Department[] }) {
  const [showCreate, setShowCreate] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await createDepartmentAction({ code, name });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the department.');
    } finally {
      setPending(false);
    }
  }

  async function onArchive(id: string) {
    setBusy(id);
    try {
      await archiveDepartmentAction(id);
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Button onClick={() => setShowCreate(true)}>New department</Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-cream-dark/50 text-left">
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Members</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono">{d.code}</td>
                <td className="px-4 py-2">{d.name}</td>
                <td className="px-4 py-2">{d.memberCount}</td>
                <td className="px-4 py-2">{d.status}</td>
                <td className="px-4 py-2">
                  {d.status === 'ACTIVE' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === d.id}
                      onClick={() => onArchive(d.id)}
                    >
                      Archive
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {departments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                  No departments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">New department</h3>
            <form onSubmit={onCreate} className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="dept-code">Code</Label>
                <Input
                  id="dept-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ENGINEERING"
                  disabled={pending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dept-name">Name</Label>
                <Input
                  id="dept-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Engineering"
                  disabled={pending}
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Creating…' : 'Create'}
                </Button>
                <Button variant="outline" type="button" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
