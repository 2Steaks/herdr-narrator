// A reconnect attempt that dies before the subscribe acknowledgement must leave exactly one reconnect chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerdrClient } from '../lib/herdr.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a reconnect that closes before the ack leaves one chain and one subscribed socket', async () => {
  const herdr = await startFakeHerdr();
  const logs = [];
  const client = createHerdrClient({ socketPath: herdr.socketPath, log: (e) => logs.push(e) });
  try {
    await client.subscribe([{ type: 'pane.focused' }], () => {});
    herdr.dropNextSubscribeAcks(1); // the first reconnect attempt connects, then loses the connection before the ack
    herdr.dropConnections();
    const deadline = Date.now() + 4000;
    while (!logs.some((l) => l.msg === 'subscription restored') && Date.now() < deadline) await sleep(20);
    assert.ok(logs.some((l) => l.msg === 'subscription restored'), 'it eventually reconnects');
    await sleep(1500); // a second chain would have retried and subscribed again by now
    assert.equal(herdr.state.subscribers.size, 1, 'one subscribed socket');
    assert.equal(herdr.requestsFor('events.subscribe').length, 3, 'initial, the dropped attempt, one success');
    assert.equal(logs.filter((l) => l.msg === 'subscription restored').length, 1);
  } finally {
    client.close();
    await herdr.close();
  }
});
