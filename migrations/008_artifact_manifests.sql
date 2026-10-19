BEGIN;
CREATE TABLE IF NOT EXISTS artifact_manifests (
  artifact_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size >= 0 AND size <= 5242880),
  storage_ref text NOT NULL,
  mime text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'binary', 'archive', 'executable')),
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS artifact_manifests_project_idx ON artifact_manifests(project_id, artifact_id, version DESC);
-- Versions stored before this migration (P04, P06) get a manifest. manifest_hash = SHA-256 of
-- artifact_id|version|project_id|hash|size|storage_ref (same formula as server/artifactFormat.ts).
INSERT INTO artifact_manifests(artifact_id, version, project_id, hash, size, storage_ref, mime, kind, manifest, manifest_hash, created_at)
SELECT a.artifact_id, a.version, a.project_id, a.hash, a.size, 'pg:' || a.id, a.mime, 'text',
       jsonb_build_object('schema', 1, 'artifact_id', a.artifact_id, 'version', a.version, 'project_id', a.project_id,
         'filename', a.filename, 'mime', a.mime, 'declared_mime', a.mime, 'kind', 'text', 'size', a.size, 'hash', a.hash,
         'storage_ref', 'pg:' || a.id, 'created_by', a.created_by, 'derived_from', a.derived_from),
       encode(sha256(convert_to(a.artifact_id || '|' || a.version || '|' || a.project_id || '|' || a.hash || '|' || a.size || '|pg:' || a.id, 'UTF8')), 'hex'),
       a.created_at
FROM artifacts a
ON CONFLICT (artifact_id, version) DO NOTHING;
COMMIT;
