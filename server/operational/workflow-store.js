'use strict';

/**
 * PostgreSQL workflow store (ADR-0021) — the durable implementation of the
 * workflow state contract in server/workflow/store.js. Same semantics,
 * made multi-instance safe:
 *
 *  - instance creation is idempotent by (workflow_type, instance_key)
 *    via ON CONFLICT DO NOTHING, recording the definition version the
 *    instance began under (ADR-0021 versioning contract);
 *  - a transition is one TRANSACTION: the durable SIGNAL-IDENTITY insert
 *    (primary-key arbitrated — re-delivery conflicts and rolls the whole
 *    transition back, across restarts and API instances), an atomic
 *    compare-and-set on the current state, and the idempotent insert of
 *    its steps — it accepts the signal, advances, and records intents, or
 *    does none of them;
 *  - step claims use FOR UPDATE SKIP LOCKED so concurrent drainers never
 *    double-claim, with attempt counting and stale-claim recovery.
 *
 * Timestamps come from the injected clock as bind parameters (ADR-0006
 * determinism discipline). Nothing sensitive is stored: identifiers and
 * safe workflow facts only.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

function rowToInstance(r) {
  return {
    instanceId: r.instance_id,
    workflowType: r.workflow_type,
    definitionVersion: r.definition_version,
    instanceKey: r.instance_key,
    organizationKey: r.organization_key,
    relatedEntityId: r.related_entity_id,
    state: r.state,
    stateData: JSON.parse(r.state_data),
    correlationId: r.correlation_id,
    createdAtMs: new Date(r.created_at).getTime(),
    updatedAtMs: new Date(r.updated_at).getTime(),
    completedAtMs: r.completed_at === null ? null : new Date(r.completed_at).getTime(),
  };
}

function rowToStep(r) {
  return {
    stepKey: r.step_key,
    instanceId: r.instance_id,
    organizationKey: r.organization_key,
    correlationId: r.correlation_id,
    intent: JSON.parse(r.intent),
    status: r.status,
    attempts: r.attempts,
    claimedAtMs: r.claimed_at === null ? null : new Date(r.claimed_at).getTime(),
    createdAtMs: new Date(r.created_at).getTime(),
  };
}

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresWorkflowStore({ pool, clock }) {
  return {
    async createInstance(record) {
      const now = new Date(clock.now());
      const { rows } = await pool.query(
        `INSERT INTO workflow_instances
           (instance_id, workflow_type, definition_version, instance_key, organization_key, related_entity_id,
            state, state_data, correlation_id, created_at, updated_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,NULL)
         ON CONFLICT (workflow_type, instance_key) DO NOTHING
         RETURNING *`,
        [record.instanceId, record.workflowType, record.definitionVersion, record.instanceKey,
          record.organizationKey, record.relatedEntityId ?? null, record.state,
          JSON.stringify(record.stateData || {}), record.correlationId ?? null, now],
      );
      if (rows.length === 1) return { created: true, instance: rowToInstance(rows[0]) };
      const { rows: existing } = await pool.query(
        'SELECT * FROM workflow_instances WHERE workflow_type = $1 AND instance_key = $2',
        [record.workflowType, record.instanceKey],
      );
      return { created: false, instance: rowToInstance(existing[0]) };
    },

    async get(instanceId) {
      const { rows } = await pool.query('SELECT * FROM workflow_instances WHERE instance_id = $1', [instanceId]);
      return rows.length ? rowToInstance(rows[0]) : undefined;
    },

    async findByKey(workflowType, instanceKey) {
      const { rows } = await pool.query(
        'SELECT * FROM workflow_instances WHERE workflow_type = $1 AND instance_key = $2',
        [workflowType, instanceKey],
      );
      return rows.length ? rowToInstance(rows[0]) : undefined;
    },

    /** Has this instance already accepted this signal identity? */
    async hasSignal(instanceId, signalId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM workflow_signals WHERE instance_id = $1 AND signal_id = $2',
        [instanceId, signalId],
      );
      return rows.length === 1;
    },

    async transition(instanceId, fromState, { toState, stateData, completedAtMs = null, steps = [], signalId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const now = new Date(clock.now());
        if (signalId) {
          // Durable signal acceptance, arbitrated by the primary key: a
          // re-delivered or concurrently-delivered identity conflicts here
          // and the WHOLE transition rolls back — the idempotent no-op.
          const { rowCount: signalInserted } = await client.query(
            `INSERT INTO workflow_signals (instance_id, signal_id, accepted_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (instance_id, signal_id) DO NOTHING`,
            [instanceId, signalId, now],
          );
          if (signalInserted !== 1) {
            await client.query('ROLLBACK');
            return { applied: false, duplicate: true };
          }
        }
        const { rowCount } = await client.query(
          `UPDATE workflow_instances
              SET state = $3, state_data = $4, updated_at = $5, completed_at = $6
            WHERE instance_id = $1 AND state = $2`,
          [instanceId, fromState, toState, JSON.stringify(stateData || {}), now,
            completedAtMs === null ? null : new Date(completedAtMs)],
        );
        if (rowCount !== 1) {
          await client.query('ROLLBACK');
          return { applied: false };
        }
        for (const step of steps) {
          await client.query(
            `INSERT INTO workflow_steps
               (step_key, instance_id, organization_key, correlation_id, intent, status, attempts, claimed_at, created_at)
             VALUES ($1,$2,$3,$4,$5,'pending',0,NULL,$6)
             ON CONFLICT (step_key) DO NOTHING`,
            [step.stepKey, step.instanceId, step.organizationKey, step.correlationId ?? null,
              JSON.stringify(step.intent), now],
          );
        }
        await client.query('COMMIT');
        return { applied: true };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async claimSteps({ maxAttempts, limit = 100 }) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - STALE_CLAIM_MS);
      const { rows } = await pool.query(
        `UPDATE workflow_steps
            SET claimed_at = $1, attempts = attempts + 1
          WHERE step_key IN (
            SELECT step_key FROM workflow_steps
             WHERE status = 'pending' AND attempts < $2
               AND (claimed_at IS NULL OR claimed_at <= $3)
             ORDER BY created_at ASC, step_key ASC
             LIMIT $4
             FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [now, maxAttempts, staleBefore, Math.max(1, limit)],
      );
      return rows.map(rowToStep);
    },

    async markStepCompleted(stepKey) {
      await pool.query("UPDATE workflow_steps SET status = 'completed' WHERE step_key = $1", [stepKey]);
    },

    async markStepFailed(stepKey, { maxAttempts }) {
      const { rows } = await pool.query(
        `UPDATE workflow_steps
            SET status = CASE WHEN attempts >= $2 THEN 'abandoned' ELSE status END,
                claimed_at = CASE WHEN attempts >= $2 THEN claimed_at ELSE NULL END
          WHERE step_key = $1
          RETURNING status`,
        [stepKey, maxAttempts],
      );
      return { abandoned: rows.length === 1 && rows[0].status === 'abandoned' };
    },

    async listInstances({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        'SELECT * FROM workflow_instances ORDER BY created_at DESC, instance_id ASC LIMIT $1',
        [Math.max(1, limit)],
      );
      return rows.map(rowToInstance);
    },

    async getStep(stepKey) {
      const { rows } = await pool.query('SELECT * FROM workflow_steps WHERE step_key = $1', [stepKey]);
      return rows.length ? rowToStep(rows[0]) : undefined;
    },

    /** The pool is owned by the handoff repository; nothing to drain here. */
    async close() {},
  };
}

module.exports = { createPostgresWorkflowStore };
