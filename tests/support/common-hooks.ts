import {
  After,
  Before,
  type ITestCaseHookParameter,
  setDefaultTimeout,
} from '@cucumber/cucumber';
import postgres from 'postgres';
import { env } from '@/config';
import type { ICustomWorld } from './custom-world';
import { buildApp } from './server';

setDefaultTimeout(process.env.PWDEBUG ? -1 : 60 * 1000);

Before({ tags: '@pending' }, () => 'skipped' as any);

Before({ tags: '@debug' }, function (this: ICustomWorld) {
  this.debug = true;
});

Before(async function (this: ICustomWorld, { pickle }: ITestCaseHookParameter) {
  this.startTime = new Date();
  this.testName = pickle.name.replaceAll(/\W/g, '-');
  this.feature = pickle;
  this.context = {};
  this.db = postgres(env.db.url);
  this.server = await buildApp();
  // A real socket on a free port: an end-to-end scenario should reach the
  // application the way a consumer does, not through `inject`.
  this.baseUrl = await this.server.listen({ port: 0, host: '127.0.0.1' });
});

After(async function (this: ICustomWorld, { result }: ITestCaseHookParameter) {
  if (result) {
    this.attach(
      `Status: ${result.status}. Duration:${result.duration.seconds}s`,
    );
  }
  // Every scenario builds its own organization, so each removes it. The
  // cascade takes the services, incidents and windows with it.
  if (this.context.orgId) {
    await this
      .db`delete from "organization" where "id" = ${this.context.orgId}`;
  }
  if (this.context.userId) {
    await this.db`delete from "user" where "id" = ${this.context.userId}`;
  }
  await this.server.close();
  await this.db.end();
});
