import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { passwordHash } from './auth.js';
import { FlagStore } from './store.js';
import type { Actor } from './domain.js';

export const DEMO_ORGANIZATION = '13000000-0000-4000-8000-000000000001';
export const DEMO_USERS = [
  {
    id: '13000000-0000-4000-8000-000000000002',
    name: 'Ava Chen',
    email: 'ava@example.test',
    role: 'admin',
  },
  {
    id: '13000000-0000-4000-8000-000000000003',
    name: 'Noah Patel',
    email: 'noah@example.test',
    role: 'editor',
  },
  {
    id: '13000000-0000-4000-8000-000000000004',
    name: 'Mira Reyes',
    email: 'mira@example.test',
    role: 'viewer',
  },
] as const;

/** Idempotent seed: never reset passwords, drafts, versions or audit history. */
export async function seed(pool: Pool, adminPassword?: string): Promise<void> {
  await pool.query(
    'INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [DEMO_ORGANIZATION, 'Northstar Studio'],
  );
  for (const environmentKey of ['development', 'production']) {
    await pool.query(
      'INSERT INTO environments(organization_id,key) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [DEMO_ORGANIZATION, environmentKey],
    );
  }
  for (const user of DEMO_USERS) {
    const password =
      user.role === 'admin' && adminPassword
        ? adminPassword
        : randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [user.id, user.email, user.name, await passwordHash(password)],
    );
    for (const environmentKey of ['development', 'production']) {
      const role =
        environmentKey === 'production' && user.role === 'editor'
          ? 'viewer'
          : user.role;
      await pool.query(
        'INSERT INTO memberships(user_id,organization_id,environment_key,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [user.id, DEMO_ORGANIZATION, environmentKey, role],
      );
    }
  }
  const store = new FlagStore(pool);
  const actor: Actor = DEMO_USERS[0];
  const examples = [
    {
      key: 'checkout-redesign',
      name: 'Checkout redesign',
      description:
        'Release the simplified checkout to a stable customer cohort.',
      bps: 500,
    },
    {
      key: 'smart-search',
      name: 'Smart search',
      description:
        'Enable the new search ranking while keeping an explicit internal override.',
      bps: 10_000,
    },
    {
      key: 'invoice-retry',
      name: 'Invoice retry',
      description: 'Operational switch for the automatic invoice retry path.',
      bps: 10_000,
    },
  ];
  for (const environmentKey of ['development', 'production']) {
    const scope = { organizationId: DEMO_ORGANIZATION, environmentKey };
    for (const example of examples) {
      const exists = await pool.query(
        'SELECT id FROM flags WHERE organization_id=$1 AND environment_key=$2 AND key=$3',
        [DEMO_ORGANIZATION, environmentKey, example.key],
      );
      if (exists.rows.length) continue;
      const created = await store.create(scope, actor, example);
      const config = {
        killSwitch: false,
        defaultValue: false,
        exactRules:
          example.key === 'smart-search'
            ? [
                {
                  id: 'internal-preview',
                  subjectKeys: ['staff-1'],
                  value: true,
                },
              ]
            : [],
        rollout: {
          percentageBps: environmentKey === 'production' ? 0 : example.bps,
        },
      };
      const saved = await store.save(
        scope,
        example.key,
        actor,
        created.revision,
        { name: example.name, description: example.description, config },
      );
      const published = await store.publish(
        scope,
        example.key,
        actor,
        saved.revision,
      );
      if (
        environmentKey === 'development' &&
        example.key === 'checkout-redesign'
      ) {
        await store.save(scope, example.key, actor, published.revision, {
          name: example.name,
          description: example.description,
          config: { ...config, rollout: { percentageBps: 2500 } },
        });
      }
    }
  }
}
