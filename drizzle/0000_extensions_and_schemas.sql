create schema if not exists authz;
comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. Phase 1 populates it.';
