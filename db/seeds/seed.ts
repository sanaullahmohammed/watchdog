/**
 * Story 2.19 — seed a demonstrable organization.
 *
 * Fills an empty database with one organization a person can sign into and
 * look at: services in groups, an active incident carrying updates, and a
 * scheduled maintenance window. For demonstration only. Tests build and tear
 * down their own fixtures and never read these rows.
 *
 * Every WatchDog row is written through the commands the API executes, so each
 * runs under its own tenant transaction and emits the same events. The app is
 * built without listening, as the worker does, because that is what registers
 * the handlers. Identity belongs to Better Auth and is created through its
 * server API. The only SQL here is the read that makes a second run a no-op.
 */
import env from '@/config/env';
import { createIncidentCommand } from '@/modules/incident/commands/create-incident/create-incident.handler';
import { postIncidentUpdateCommand } from '@/modules/incident/commands/post-incident-update/post-incident-update.handler';
import { transitionIncidentCommand } from '@/modules/incident/commands/transition-incident/transition-incident.handler';
import { scheduleMaintenanceCommand } from '@/modules/maintenance/commands/schedule-maintenance/schedule-maintenance.handler';
import { createServiceCommand } from '@/modules/service/commands/create-service/create-service.handler';
import { createServiceGroupCommand } from '@/modules/service/commands/create-service-group/create-service-group.handler';
import {
  type ListServicesQueryResult,
  listServicesQuery,
} from '@/modules/service/queries/list-services/list-services.handler';
import { auth } from '@/server/auth/auth';
import { buildApp } from '@/server/build-app';
import type { Action } from '@/shared/cqrs/bus.types';
import sql, { closeDbConnection } from '@/shared/db/postgres';

const ORGANIZATION = { name: 'Acme Cloud', slug: 'acme-demo' };

/** Demonstration credentials, printed at the end. Never used by a test. */
const OPERATOR = {
  name: 'Demo Operator',
  email: 'demo@example.com',
  password: 'watchdog-demo',
};

const CATALOG = [
  {
    group: { name: 'Core platform', slug: 'core-platform' },
    services: [
      {
        name: 'Public API',
        slug: 'public-api',
        description: 'REST and GraphQL endpoints',
      },
      {
        name: 'Web dashboard',
        slug: 'web-dashboard',
        description: 'The operator console',
      },
      {
        name: 'Authentication',
        slug: 'authentication',
        description: 'Sign-in, sessions and SSO',
      },
    ],
  },
  {
    group: { name: 'Data', slug: 'data' },
    services: [
      {
        name: 'Primary database',
        slug: 'primary-database',
        description: 'Transactional storage',
      },
      {
        name: 'Object storage',
        slug: 'object-storage',
        description: 'Uploads and backups',
      },
    ],
  },
  {
    group: { name: 'Integrations', slug: 'integrations' },
    services: [
      {
        name: 'Webhooks',
        slug: 'webhooks',
        description: 'Outbound event delivery',
      },
      {
        name: 'Email delivery',
        slug: 'email-delivery',
        description: 'Transactional email',
      },
    ],
  },
];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function findOrCreateOperator(): Promise<string> {
  // A run that failed after creating the user must not fail again on sign-up.
  const [existing] = await sql<{ id: string }[]>`
    select "id" from "user" where "email" = ${OPERATOR.email}
  `;
  if (existing) return existing.id;

  const { user } = await auth.api.signUpEmail({ body: OPERATOR });
  return user.id;
}

/** 02:00 UTC, three days from now: a plausible low-traffic window. */
function nextWindowStart(): Date {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 3);
  start.setUTCHours(2, 0, 0, 0);
  return start;
}

async function seed(): Promise<void> {
  if (env.isProduction) {
    console.error(
      'Refusing to seed: NODE_ENV is production. Seed data is for demonstration only.',
    );
    process.exitCode = 1;
    return;
  }

  const [already] = await sql<{ id: string }[]>`
    select "id" from "organization" where "slug" = ${ORGANIZATION.slug}
  `;
  if (already) {
    console.log(
      `Already seeded: organization "${ORGANIZATION.slug}" exists (${already.id}). Nothing written.`,
    );
    return;
  }

  const userId = await findOrCreateOperator();
  // `userId` is Better Auth's server-only way to name the creator without a
  // session; the creator becomes the organization's owner.
  const organization = await auth.api.createOrganization({
    body: { ...ORGANIZATION, userId },
  });
  if (!organization) {
    throw new Error('Better Auth did not create the organization');
  }
  const orgId = organization.id;

  const app = await buildApp({ logger: false });
  await app.ready();

  try {
    const execute = (command: Action<unknown>) =>
      app.commandBus.execute<string>(command);

    const serviceIds = new Map<string, string>();
    const serviceId = (slug: string) => {
      const id = serviceIds.get(slug);
      if (!id) throw new Error(`Seed catalog has no service "${slug}"`);
      return id;
    };

    for (const [groupOrder, { group, services }] of CATALOG.entries()) {
      const serviceGroupId = await execute(
        createServiceGroupCommand({
          orgId,
          ...group,
          displayOrder: groupOrder,
        }),
      );
      for (const [order, service] of services.entries()) {
        serviceIds.set(
          service.slug,
          await execute(
            createServiceCommand({
              orgId,
              ...service,
              serviceGroupId,
              displayOrder: order,
            }),
          ),
        );
      }
    }

    // Declared incidents start at investigating. Neither declaring nor
    // transitioning writes a timeline entry today, so each step is followed by
    // the update an operator would post.
    const incidentId = await execute(
      createIncidentCommand({
        orgId,
        userId,
        title: 'Elevated error rates on the Public API',
        impact: 'major',
        startedAt: new Date(Date.now() - 40 * MINUTE),
        affectedServices: [
          { serviceId: serviceId('public-api'), impact: 'major' },
          { serviceId: serviceId('webhooks'), impact: 'minor' },
        ],
      }),
    );
    await execute(
      postIncidentUpdateCommand({
        orgId,
        incidentId,
        userId,
        message:
          'We are investigating elevated 5xx responses from the Public API. Webhook deliveries may be delayed.',
      }),
    );
    await execute(
      transitionIncidentCommand({
        orgId,
        id: incidentId,
        status: 'identified',
      }),
    );
    await execute(
      postIncidentUpdateCommand({
        orgId,
        incidentId,
        userId,
        message:
          'The cause is a misconfigured connection pool in the latest API deploy. A rollback is in progress.',
      }),
    );

    const windowStart = nextWindowStart();
    await execute(
      scheduleMaintenanceCommand({
        orgId,
        userId,
        title: 'Primary database version upgrade',
        description:
          'A minor-version upgrade with a brief failover. Writes may pause for up to a minute.',
        scheduledStartAt: windowStart,
        scheduledEndAt: new Date(windowStart.getTime() + 2 * HOUR),
        affectedServiceIds: [
          serviceId('primary-database'),
          serviceId('public-api'),
        ],
      }),
    );

    // Status recomputation runs after each command commits and is not awaited
    // by it. Closing before it settles would leave last_known_status behind the
    // incident just declared.
    await (
      app.diContainer.resolve(
        'recomputeServiceStatusEventHandler' as never,
      ) as {
        drain(): Promise<void>;
      }
    ).drain();

    const services = await app.queryBus.execute<ListServicesQueryResult>(
      listServicesQuery({ orgId }),
    );

    console.log(
      [
        `Seeded "${ORGANIZATION.name}" (${ORGANIZATION.slug}, ${orgId})`,
        `  ${services.length} services in ${CATALOG.length} groups:`,
        ...services.map(
          (service) =>
            `    ${service.name.padEnd(18)} ${service.lastKnownStatus}`,
        ),
        '  1 active incident with 2 updates, now identified',
        `  1 maintenance window scheduled for ${windowStart.toISOString()}`,
        '',
        `Sign in with POST /api/auth/sign-in/email as ${OPERATOR.email} / ${OPERATOR.password},`,
        'then GET /api/v1/services. Without an active organization, the first membership is used.',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
    // Better Auth holds its own pg pool open; exit rather than wait out its
    // idle timeout.
    process.exit();
  });
