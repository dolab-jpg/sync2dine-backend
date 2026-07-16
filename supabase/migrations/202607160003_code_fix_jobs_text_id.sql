-- Node queue uses opaque ids like cf-<timestamp>-<rand>; allow text PKs.
alter table code_fix_jobs
  alter column id drop default;

alter table code_fix_jobs
  alter column id type text using id::text;
