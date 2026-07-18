-- Operational Store 0006: durable workflow instances and steps (ADR-0021).
--
-- workflow_instances: one row per long-running process instance, unique by
-- logical identity (workflow_type, instance_key) so duplicate durable
-- events can never start duplicates. State data carries SAFE workflow
-- facts and identifiers only — business truth is re-read at step
-- execution, never snapshotted (no caller names, emails, phones, or free
-- text).
--
-- workflow_steps: the durable intents a transition produced, appended in
-- the SAME transaction as the state change (a transition either advances
-- and records its intents, or does neither). Deterministic step keys make
-- replays idempotent; the claim discipline (claimed_at + attempts) gives
-- steps atomic claims, stale-claim recovery, and bounded attempts.
--
-- Additive-only, per ADR-0006 migration policy.

CREATE TABLE workflow_instances (
  instance_id        text PRIMARY KEY,
  workflow_type      text NOT NULL,
  definition_version integer NOT NULL,
  instance_key       text NOT NULL,
  organization_key  text NOT NULL,
  related_entity_id text,
  state             text NOT NULL,
  state_data        text NOT NULL DEFAULT '{}',
  correlation_id    text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  UNIQUE (workflow_type, instance_key)
);

CREATE TABLE workflow_steps (
  step_key          text PRIMARY KEY,
  instance_id       text NOT NULL,
  organization_key  text NOT NULL,
  correlation_id    text,
  intent            text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','abandoned')),
  attempts          integer NOT NULL DEFAULT 0,
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL
);

CREATE INDEX workflow_steps_claimable
  ON workflow_steps (created_at)
  WHERE status = 'pending';

-- Durable signal identities (ADR-0021 §3a): one row per accepted signal per
-- instance, inserted IN THE SAME TRANSACTION as the transition it caused.
-- Re-delivery of the same signal identity conflicts on the primary key and
-- the whole transition rolls back — the idempotent no-op, even across
-- restarts and API instances, and even if the instance has since returned
-- to the same state. Rows carry identity strings only (event ids, timeout
-- names) — never payloads or free text.
CREATE TABLE workflow_signals (
  instance_id  text NOT NULL,
  signal_id    text NOT NULL,
  accepted_at  timestamptz NOT NULL,
  PRIMARY KEY (instance_id, signal_id)
);
