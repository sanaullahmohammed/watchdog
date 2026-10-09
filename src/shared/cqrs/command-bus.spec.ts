import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandBus } from '@/shared/cqrs/command-bus';

describe('commandBus', () => {
  it('refuses a second handler for a type, naming it', () => {
    const bus = commandBus();
    bus.register('group.get', async () => 'first');

    assert.throws(
      () => bus.register('group.get', async () => 'second'),
      /group\.get/,
    );
  });

  it('keeps answering with the first handler after a refused duplicate', async () => {
    const bus = commandBus();
    bus.register('group.get', async () => 'first');
    assert.throws(() => bus.register('group.get', async () => 'second'));

    assert.equal(await bus.execute({ type: 'group.get' } as never), 'first');
  });

  it('registers distinct types side by side', async () => {
    const bus = commandBus();
    bus.register('group.get', async () => 'get');
    bus.register('group.list', async () => 'list');

    assert.equal(await bus.execute({ type: 'group.get' } as never), 'get');
    assert.equal(await bus.execute({ type: 'group.list' } as never), 'list');
  });
});
