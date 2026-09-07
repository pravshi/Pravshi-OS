export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="rounded border border-danger/40 bg-danger/5 p-6">
      <p className="font-medium text-danger">{title}</p>
      {detail ? <p className="mt-1 text-sm text-ink-muted">{detail}</p> : null}
    </div>
  );
}
