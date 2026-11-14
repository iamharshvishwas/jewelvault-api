import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, insert } from '../schema/support';
import { type EditWorld, body, editWorld } from './edit-support';

// FB-E1 (L3, L4): two X13 create_order calls in the same second, from two sessions (the owner and a biller), through the real route. The counter row order:2026 is made before either transaction
// (ensureSeries) and the number is taken inside it by the UPDATE of sys_counters, which serialises the two: they get consecutive numbers, ORD-2026-0001 and ORD-2026-0002, never the same one and
// never a gap. The world's clock stands still (it only moves on by a microsecond for each reading), so both calls are stamped in the same second.

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('x13two');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const customer = async (mobile: string) => ((await insert(w.world.sql, 'customers', V.customer({ mobile }))) as { id: string }).id;

describe('FB-E1 two creates at once (two sessions)', () => {
  it('two creates in the same second get consecutive numbers: ORD-2026-0001 and ORD-2026-0002, one each, and the counter stands at 2', async () => {
    const [a, b] = [await customer('9111111111'), await customer('9222222222')];
    const call = (caller: 'owner' | 'biller', customerId: string) =>
      w.world.call(caller, 'POST', '/v1/orders', { payload: { order_id: randomUUID(), customer_id: customerId, description: `order of ${caller}` }, headers: { 'idempotency-key': randomUUID() } });
    const [first, second] = await Promise.all([call('owner', a), call('biller', b)]);
    expect([first.statusCode, second.statusCode], `${first.body} ${second.body}`).toEqual([201, 201]);
    const numbers = [body(first).order.order_no, body(second).order.order_no].sort();
    expect(numbers).toEqual(['ORD-2026-0001', 'ORD-2026-0002']);
    expect(body(first).order.created_at.slice(0, 19)).toBe(body(second).order.created_at.slice(0, 19)); // the same second of the API clock (the test clock stands still but never gives one microsecond twice)
    const [[row]] = (await w.world.sql.query<any[]>("SELECT last_value FROM sys_counters WHERE series = 'order:2026'")) as unknown as [any[]];
    expect(Number(row.last_value)).toBe(2);
  });
});
