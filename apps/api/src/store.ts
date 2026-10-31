import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { evaluate, parsePublishedFlag } from '@w13/evaluator';
import { transaction } from './database.js';
import {
  ApiError,
  changes,
  configsEqual,
  draftFromSnapshot,
  parseDraft,
  snapshot,
  StoredDataError,
} from './domain.js';
import type { Actor, DraftConfig, FlagRow, Scope } from './domain.js';

const selection = `SELECT f.*, d.config, v.config AS active_config FROM flags f
 JOIN flag_drafts d ON d.flag_id=f.id
 LEFT JOIN flag_versions v ON v.flag_id=f.id AND v.version=f.active_version`;
const target = 'f.organization_id=$1 AND f.environment_key=$2 AND f.key=$3';

/** Stored rows were validated on write; a parse failure now is a server fault. */
function stored<T>(flagId: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new StoredDataError(flagId, { cause });
  }
}
const storedDraft = (flag: FlagRow) =>
  stored(flag.id, () => parseDraft(flag.config));
const storedSnapshot = (flag: FlagRow) =>
  stored(flag.id, () => snapshot(flag, flag.config));
const storedActive = (flag: FlagRow) =>
  flag.active_config === null
    ? null
    : stored(flag.id, () => parsePublishedFlag(flag.active_config));

async function audit(
  client: PoolClient,
  actor: Actor,
  flag: FlagRow,
  action: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    "INSERT INTO audit_events(organization_id,environment_key,flag_id,actor_id,action,outcome,metadata) VALUES($1,$2,$3,$4,$5,'allowed',$6)",
    [
      flag.organization_id,
      flag.environment_key,
      flag.id,
      actor.id,
      action,
      JSON.stringify(metadata),
    ],
  );
}

export class FlagStore {
  constructor(readonly pool: Pool) {}

  async get(scope: Scope, key: string) {
    const result = await this.pool.query<FlagRow>(
      `${selection} WHERE ${target}`,
      [scope.organizationId, scope.environmentKey, key],
    );
    const flag = result.rows[0];
    if (!flag)
      throw new ApiError(
        404,
        'FLAG_NOT_FOUND',
        'Flag not found in this environment.',
      );
    const draft = storedDraft(flag);
    const active = storedActive(flag);
    return {
      id: flag.id,
      key: flag.key,
      name: flag.name,
      description: flag.description,
      environmentKey: flag.environment_key,
      revision: flag.revision,
      nextVersion: flag.next_version,
      activeVersion: flag.active_version,
      archived: flag.archived,
      draft,
      active,
      changes: changes(active, draft),
    };
  }

  async list(scope: Scope) {
    const result = await this.pool.query<FlagRow>(
      `${selection} WHERE f.organization_id=$1 AND f.environment_key=$2 ORDER BY f.archived,f.name LIMIT 500`,
      [scope.organizationId, scope.environmentKey],
    );
    return result.rows.map((flag) => {
      const active = storedActive(flag);
      return {
        key: flag.key,
        name: flag.name,
        description: flag.description,
        archived: flag.archived,
        revision: flag.revision,
        activeVersion: flag.active_version,
        hasChanges:
          active === null ||
          !configsEqual(storedDraft(flag), draftFromSnapshot(active)),
        rolloutBps: active?.rollout?.percentageBps ?? null,
        killed: active?.killSwitch ?? false,
      };
    });
  }

  async create(
    scope: Scope,
    actor: Actor,
    input: { key: string; name: string; description: string },
  ) {
    await transaction(this.pool, async (client) => {
      const id = randomUUID();
      const inserted = await client.query<FlagRow>(
        `INSERT INTO flags(id,organization_id,environment_key,key,name,description,salt)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,environment_key,key) DO NOTHING RETURNING *`,
        [
          id,
          scope.organizationId,
          scope.environmentKey,
          input.key,
          input.name,
          input.description,
          randomUUID(),
        ],
      );
      const flag = inserted.rows[0];
      if (!flag)
        throw new ApiError(
          409,
          'DUPLICATE_KEY',
          'This flag key already exists in the environment.',
        );
      await client.query(
        'INSERT INTO flag_drafts(flag_id,config) VALUES($1,$2)',
        [
          id,
          JSON.stringify({
            killSwitch: false,
            defaultValue: false,
            exactRules: [],
          }),
        ],
      );
      await audit(client, actor, flag, 'flag.created', { revision: 1 });
    });
    return this.get(scope, input.key);
  }

  private async mutate(
    scope: Scope,
    key: string,
    actor: Actor,
    revision: number,
    action: string,
    operation: (client: PoolClient, flag: FlagRow) => Promise<void>,
  ) {
    try {
      await transaction(this.pool, async (client) => {
        // Lock only the mutable state row, not the nullable side of the join.
        const locked = await client.query<FlagRow>(
          `${selection} WHERE ${target} FOR UPDATE OF f`,
          [scope.organizationId, scope.environmentKey, key],
        );
        const flag = locked.rows[0];
        if (!flag)
          throw new ApiError(
            404,
            'FLAG_NOT_FOUND',
            'Flag not found in this environment.',
          );
        if (flag.revision !== revision)
          throw new ApiError(
            409,
            'REVISION_CONFLICT',
            'This flag changed. Reload it before trying again.',
          );
        if (flag.archived && action !== 'flag.restored')
          throw new ApiError(
            409,
            'FLAG_ARCHIVED',
            'Restore this flag before changing it.',
          );
        await operation(client, flag);
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await this.pool.query(
          "INSERT INTO audit_events(organization_id,environment_key,actor_id,action,outcome,metadata) VALUES($1,$2,$3,$4,'conflict',$5)",
          [
            scope.organizationId,
            scope.environmentKey,
            actor.id,
            action,
            JSON.stringify({
              targetKey: key,
              expectedRevision: revision,
              code: error.code,
            }),
          ],
        );
      }
      throw error;
    }
    return this.get(scope, key);
  }

  async save(
    scope: Scope,
    key: string,
    actor: Actor,
    revision: number,
    input: { name: string; description: string; config: DraftConfig },
  ) {
    return this.mutate(
      scope,
      key,
      actor,
      revision,
      'draft.saved',
      async (client, flag) => {
        const config = parseDraft(input.config);
        await client.query(
          'UPDATE flag_drafts SET config=$1 WHERE flag_id=$2',
          [JSON.stringify(config), flag.id],
        );
        await client.query(
          'UPDATE flags SET name=$1,description=$2,revision=revision+1,updated_at=now() WHERE id=$3',
          [input.name, input.description, flag.id],
        );
        await audit(client, actor, flag, 'draft.saved', {
          revision: revision + 1,
          changedFields: [
            ...changes(storedDraft(flag), config).map((change) => change.field),
            ...(flag.name === input.name ? [] : ['name']),
            ...(flag.description === input.description ? [] : ['description']),
          ],
        });
      },
    );
  }

  async publish(scope: Scope, key: string, actor: Actor, revision: number) {
    return this.mutate(
      scope,
      key,
      actor,
      revision,
      'flag.published',
      async (client, flag) => {
        const config = storedSnapshot(flag);
        const active = storedActive(flag);
        if (active !== null && configsEqual(config, active))
          throw new ApiError(
            409,
            'NO_CHANGES',
            'The saved draft already matches the active version.',
          );
        await client.query(
          'INSERT INTO flag_versions(flag_id,version,config,created_by) VALUES($1,$2,$3,$4)',
          [flag.id, flag.next_version, JSON.stringify(config), actor.id],
        );
        await client.query(
          'UPDATE flags SET active_version=next_version,next_version=next_version+1,revision=revision+1,updated_at=now() WHERE id=$1',
          [flag.id],
        );
        await audit(client, actor, flag, 'flag.published', {
          fromVersion: flag.active_version,
          toVersion: flag.next_version,
          revision: revision + 1,
        });
      },
    );
  }

  async rollback(
    scope: Scope,
    key: string,
    actor: Actor,
    revision: number,
    version: number,
  ) {
    return this.mutate(
      scope,
      key,
      actor,
      revision,
      'flag.rolled_back',
      async (client, flag) => {
        const old = await client.query<{ config: unknown }>(
          'SELECT config FROM flag_versions WHERE flag_id=$1 AND version=$2',
          [flag.id, version],
        );
        const historical = old.rows[0];
        if (!historical)
          throw new ApiError(
            404,
            'VERSION_NOT_FOUND',
            'Published version not found for this flag.',
          );
        stored(flag.id, () => parsePublishedFlag(historical.config));
        if (flag.active_version === version)
          throw new ApiError(
            409,
            'ALREADY_ACTIVE',
            'This version is already active.',
          );
        await client.query(
          'UPDATE flags SET active_version=$1,revision=revision+1,updated_at=now() WHERE id=$2',
          [version, flag.id],
        );
        await audit(client, actor, flag, 'flag.rolled_back', {
          fromVersion: flag.active_version,
          toVersion: version,
          revision: revision + 1,
        });
      },
    );
  }

  async archive(
    scope: Scope,
    key: string,
    actor: Actor,
    revision: number,
    archived: boolean,
  ) {
    const action = archived ? 'flag.archived' : 'flag.restored';
    return this.mutate(
      scope,
      key,
      actor,
      revision,
      action,
      async (client, flag) => {
        if (flag.archived === archived)
          throw new ApiError(
            409,
            'NO_CHANGES',
            'Flag already has this archive state.',
          );
        await client.query(
          'UPDATE flags SET archived=$1,revision=revision+1,updated_at=now() WHERE id=$2',
          [archived, flag.id],
        );
        await audit(client, actor, flag, action, { revision: revision + 1 });
      },
    );
  }

  async preview(
    scope: Scope,
    key: string,
    expectedRevision: number,
    subjectKey?: string | null,
  ) {
    const query = await this.pool.query<FlagRow>(
      `${selection} WHERE ${target}`,
      [scope.organizationId, scope.environmentKey, key],
    );
    const flag = query.rows[0];
    if (!flag)
      throw new ApiError(
        404,
        'FLAG_NOT_FOUND',
        'Flag not found in this environment.',
      );
    if (flag.revision !== expectedRevision)
      throw new ApiError(
        409,
        'REVISION_CONFLICT',
        'Reload the flag before simulating.',
      );
    if (flag.archived)
      throw new ApiError(
        409,
        'FLAG_ARCHIVED',
        'Restore this flag before simulating.',
      );
    const context = subjectKey === undefined ? {} : { subjectKey };
    const active = storedActive(flag);
    return {
      revision: flag.revision,
      draft: evaluate(storedSnapshot(flag), context),
      active: active === null ? null : evaluate(active, context),
      changes: changes(active, storedDraft(flag)),
    };
  }

  async versions(scope: Scope, key: string) {
    const flag = await this.get(scope, key);
    const result = await this.pool.query<{
      version: number;
      config: unknown;
      createdAt: Date;
      actorName: string;
    }>(
      'SELECT v.version,v.config,v.created_at AS "createdAt",u.name AS "actorName" FROM flag_versions v JOIN users u ON u.id=v.created_by WHERE flag_id=$1 ORDER BY version DESC LIMIT 100',
      [flag.id],
    );
    return result.rows;
  }

  async audit(scope: Scope) {
    const result = await this.pool.query(
      `SELECT a.id::text,a.action,a.outcome,a.metadata,a.created_at AS "createdAt",u.name AS "actorName",f.key AS "flagKey"
       FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN flags f ON f.id=a.flag_id
       WHERE a.organization_id=$1 AND a.environment_key=$2 ORDER BY a.id DESC LIMIT 100`,
      [scope.organizationId, scope.environmentKey],
    );
    return result.rows;
  }
}
