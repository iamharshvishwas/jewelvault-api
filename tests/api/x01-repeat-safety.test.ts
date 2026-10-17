import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as locks from '../../src/db/locks';
import { dbError } from './tx-support';
import { deferred } from './x0-support';
import {
  type Designs,
  type EditWorld,
  addCustomer,
  addDesigns,
  billBody,
  billRow,
  body,
  codeOf,
  counterOf,
  countOf,
  editWorld,
  errorField,
  footprint,
  item,
  newKey,
  piece,
  pieceRow,
  postBill,
  rows,
  saved,
  setEstimate,
} from './x01-support';

// API20, X1 create_bill: the tests that need two sessions or a repeated key. T-C04 (two concurrent bills on one piece: one wins, the other is JV_PIECE_UNAVAILABLE, no number is used; K2),
// T-C05 (the same Idempotency-Key twice makes one bill and the same answer with Idempotent-Replay: true; another caller or another cart under the key is refused; L5, L6) and T-C06 (a failed
// create_bill leaves no piece Sold and no number used; K2, C5). Every test that counts numbers gives itself a bill prefix of its own, so no other test moves its counter.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x01rep');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const cartOf = (customer: string, pieces: string[], extra: Record<string, unknown> = {}) => billBody(customer, 'Retail', pieces.map((id) => item(id, { metal_rate: '10.00' })), extra);

describe('T-C04 two concurrent create_bill on one piece: exactly one succeeds, the other is JV_PIECE_UNAVAILABLE, no number is used (K2)', () => {
  it('10 rounds, two customers: one 201, one 409 naming the piece; the loser\'s customer has no bill and the counter stepped once', async () => {
    await setEstimate(w, { prefix: 'RA', roundOff: true });
    for (let round = 1; round <= 10; round++) {
      const [c1, c2] = [await addCustomer(w), await addCustomer(w)];
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const [r1, r2] = await Promise.all([postBill(w, 'owner', cartOf(c1, [p])), postBill(w, 'biller', cartOf(c2, [p]))]);
      const statuses = [r1.statusCode, r2.statusCode].sort();
      expect(statuses, `round ${round}: ${r1.body} ${r2.body}`).toEqual([201, 409]);
      const [win, lose] = r1.statusCode === 201 ? [r1, r2] : [r2, r1];
      expect(codeOf(lose)).toBe('JV_PIECE_UNAVAILABLE');
      expect(body(lose).error.details.sku_ids).toEqual([p]);
      expect(await pieceRow(w, p)).toMatchObject({ status: 'Sold', sold_bill_id: body(win).bill.id });
      expect(await counterOf(w, 'bill:RA:2026'), `round ${round}: the loser used a number`).toBe(round);
      expect(await countOf(w, 'bills', "bill_no LIKE 'RA-%'")).toBe(round);
    }
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('one customer, one piece, two sessions at once: the customer lock serialises them, the second sees the piece Sold', async () => {
    await setEstimate(w, { prefix: 'RB', roundOff: true });
    const c = await addCustomer(w);
    for (let round = 1; round <= 5; round++) {
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const answers = await Promise.all([postBill(w, 'owner', cartOf(c, [p])), postBill(w, 'owner', cartOf(c, [p]))]);
      expect(answers.map((a) => a.statusCode).sort(), answers.map((a) => a.body).join(' ')).toEqual([201, 409]);
      expect(await counterOf(w, 'bill:RB:2026')).toBe(round);
    }
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('bills with overlapping pieces, in opposite orders, at once: no deadlock, each piece sold once, no number lost (the pieces are locked in one statement, X0 item 5)', async () => {
    await setEstimate(w, { prefix: 'RC', roundOff: true });
    for (let round = 1; round <= 5; round++) {
      const [c1, c2] = [await addCustomer(w), await addCustomer(w)];
      const ps = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
      const [a, b] = await Promise.all([postBill(w, 'owner', cartOf(c1, ps)), postBill(w, 'owner', cartOf(c2, [...ps].reverse()))]);
      expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([201, 409]);
      expect(await countOf(w, 'skus', "status = 'Sold' AND id IN (?, ?, ?)", ps)).toBe(3);
    }
    expect(await counterOf(w, 'bill:RC:2026')).toBe(5);
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('negative control: with the piece lock replaced by a plain read, both sessions see the piece In Stock and the loser is NOT told JV_PIECE_UNAVAILABLE (only the conditional UPDATE of X1 (h) saves the books)', async () => {
    await setEstimate(w, { prefix: 'RH', roundOff: true });
    const COLUMNS = 'id, design_id, sku_no, barcode, status, sold_bill_id, gross_weight, customer_net_weight, stones, stone_weight, kundan, kundan_weight, piroi, labour_retail, labour_semi, labour_wholesale, location, archived_at, updated_at';
    let arrived = 0;
    const both = deferred();
    const noLock = vi.spyOn(locks, 'lockPieces').mockImplementation(async (tx, ids) => {
      locks.noteStep(tx, 'pieces');
      const found = await tx.rows<locks.PieceLockRow>(`SELECT ${COLUMNS} FROM skus WHERE id IN (${ids.map(() => '?').join(', ')})`, ids); // no ORDER BY ... FOR UPDATE
      if (++arrived === 2) both.resolve();
      await both.promise; // both sessions have read the piece before either goes on
      return found;
    });
    try {
      const [c1, c2] = [await addCustomer(w), await addCustomer(w)];
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const answers = await Promise.all([postBill(w, 'owner', cartOf(c1, [p])), postBill(w, 'owner', cartOf(c2, [p]))]);
      const statuses = answers.map((a) => a.statusCode).sort();
      expect(statuses, 'without the lock the clean 409 of the test above is gone').not.toEqual([201, 409]);
      expect(statuses).toEqual([201, 500]); // the second bill's conditional UPDATE found the piece Sold: JV_INTERNAL, rolled back whole
      expect(await counterOf(w, 'bill:RH:2026'), 'even then the loser used no number').toBe(1);
      expect(await countOf(w, 'bills', "bill_no LIKE 'RH-%'")).toBe(1);
    } finally {
      noLock.mockRestore();
      await setEstimate(w, { prefix: 'JV', roundOff: true });
    }
  });

  it('control: the same pair of bills on different pieces both succeed (the lock is on the pieces, not on the function)', async () => {
    const [c1, c2] = [await addCustomer(w), await addCustomer(w)];
    const [p1, p2] = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
    const [a, b] = await Promise.all([postBill(w, 'owner', cartOf(c1, [p1])), postBill(w, 'biller', cartOf(c2, [p2]))]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(body(a).bill.bill_no).not.toBe(body(b).bill.bill_no);
  });
});

describe('T-C05 the same Idempotency-Key twice makes one bill and returns the same result (L5, L6)', () => {
  it('the second call is answered from the stored result: the same status and body, Idempotent-Replay: true, one bill, one number, one set of lines', async () => {
    await setEstimate(w, { prefix: 'RD', roundOff: true });
    const c = await addCustomer(w);
    const p = await piece(w, d.silver925, { nw: '2.000', retail: '5.00' }); // no daily rate for 925: the answer carries a warning, which the replay must carry too
    const key = newKey();
    const cart = billBody(c, 'Retail', [item(p, { metal_rate: '80.00', labour_rate: '5.00' })], { notes: 'once' });
    const first = await postBill(w, 'biller', cart, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(body(first).warnings).toEqual(['RATE_MISSING']);
    const before = await footprint(w);
    const second = await postBill(w, 'biller', cart, key);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toBe(first.body);
    expect(await footprint(w), 'the replay changed something').toEqual(before);
    expect(await countOf(w, 'bills', "bill_no LIKE 'RD-%'")).toBe(1);
    expect(await countOf(w, 'bill_items', 'bill_id = ?', [body(first).bill.id])).toBe(1);
    expect(await counterOf(w, 'bill:RD:2026')).toBe(1);
    expect((await rows(w, 'SELECT fn, result FROM sys_idempotency WHERE request_id = ?', [key]))[0].fn).toBe('create_bill');
    expect((await billRow(w, body(first).bill.id)).request_id).toBe(key); // the bill remembers the request that made it (D11)
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('a key written in capitals is the same key', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const key = newKey();
    const cart = cartOf(c, [p]);
    const first = await postBill(w, 'owner', cart, key);
    const again = await postBill(w, 'owner', cart, key.toUpperCase());
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toBe(first.body);
  });

  it('another caller under the key is refused, and so is the same key with another cart; neither makes a bill', async () => {
    const c = await addCustomer(w);
    const [p, q] = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
    const key = newKey();
    const cart = cartOf(c, [p]);
    expect((await postBill(w, 'owner', cart, key)).statusCode).toBe(201);
    const before = await footprint(w);
    const other = await postBill(w, 'biller', cart, key);
    expect(other.statusCode, other.body).toBe(422);
    expect(codeOf(other)).toBe('JV_INVALID_INPUT');
    expect(errorField(other)).toBe('Idempotency-Key');
    for (const changed of [cartOf(c, [q]), cartOf(c, [p], { discount: '1.00' }), cartOf(c, [p], { notes: 'different' }), billBody(c, 'Wholesale', [item(p, { metal_rate: '10.00', labour_rate: '1.00' })])]) {
      const res = await postBill(w, 'owner', changed, key);
      expect(res.statusCode, res.body).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(errorField(res)).toBe('Idempotency-Key');
    }
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, q)).status, 'the piece of the refused cart is still In Stock').toBe('In Stock');
  });

  it('8 identical requests at once: one bill, one number, one success and seven replays of it', async () => {
    await setEstimate(w, { prefix: 'RE', roundOff: true });
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const key = newKey();
    const cart = cartOf(c, [p]);
    const answers = await Promise.all(Array.from({ length: 8 }, () => postBill(w, 'biller', cart, key)));
    expect(answers.map((a) => a.statusCode), answers.map((a) => a.body).join(' ')).toEqual(Array(8).fill(201));
    expect(answers.filter((a) => a.headers['idempotent-replay'] === 'true')).toHaveLength(7);
    expect(new Set(answers.map((a) => a.body)).size, 'one result for all eight').toBe(1);
    expect(await countOf(w, 'bills', "bill_no LIKE 'RE-%'")).toBe(1);
    expect(await counterOf(w, 'bill:RE:2026')).toBe(1);
    expect(await countOf(w, 'sys_idempotency', 'request_id = ?', [key])).toBe(1);
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('once the nightly job has emptied the result of a request row (L6), a repeat of the key is refused and makes no second bill', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const key = newKey();
    const cart = cartOf(c, [p]);
    expect((await postBill(w, 'owner', cart, key)).statusCode).toBe(201);
    await w.world.sql.query('UPDATE sys_idempotency SET result = NULL WHERE request_id = ?', [key]);
    const before = await footprint(w);
    const res = await postBill(w, 'owner', cart, key);
    expect(res.statusCode, res.body).toBe(422);
    expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    expect(await footprint(w)).toEqual(before);
  });

  it('a missing Idempotency-Key, or one that is not a UUID, is refused naming the header, and nothing is saved', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const before = await footprint(w);
    for (const key of [null, 'not-a-uuid', '', '12345678-1234-1234-1234-12345678901']) {
      const res = await postBill(w, 'owner', cartOf(c, [p]), key);
      expect(res.statusCode, String(key)).toBe(422);
      expect(errorField(res)).toBe('Idempotency-Key');
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a call the route wrapper refuses never uses up its key, and neither does a save that fails: the same key goes through once the cause is gone', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00', status: 'Repair' });
    const key = newKey();
    const cart = cartOf(c, [p]);
    // a body the wrapper refuses (an unknown field), a caller it refuses (staff), then a save that fails (the piece is in repair)
    expect((await postBill(w, 'owner', { ...cart, surprise: 1 }, key)).statusCode).toBe(422);
    expect((await postBill(w, 'staff', cart, key)).statusCode).toBe(403);
    expect((await postBill(w, 'owner', cart, key)).statusCode).toBe(409);
    expect(await countOf(w, 'sys_idempotency', 'request_id = ?', [key]), 'a refusal left a claim row').toBe(0);
    await w.world.sql.query("UPDATE skus SET status = 'In Stock' WHERE id = ?", [p]);
    const res = await postBill(w, 'owner', cart, key);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('T-C06 a failed create_bill leaves no piece Sold and no number used (K2, C5)', () => {
  // A statement that is made to fail at each write of the bill, after the number is taken. The failure is a plain error from the driver's layer (a 500, JV_INTERNAL): the call is rolled back whatever it is.
  const FAIL_AT: [string, RegExp][] = [
    ['the insert of the bill', /^INSERT INTO bills\b/],
    ['the insert of the lines', /^INSERT INTO bill_items\b/],
    ['the update of the pieces to Sold', /^UPDATE skus SET status = \?/],
    ['the touch of the customer', /^UPDATE customers SET updated_at = \?/],
    ['the storing of the result', /^UPDATE sys_idempotency SET result = \?/],
  ];
  for (const [what, re] of FAIL_AT) {
    it(`a failure at ${what}: no bill, no line, no Sold piece, no number used, no claim, and the same key works afterwards`, async () => {
      await setEstimate(w, { prefix: 'RF', roundOff: true });
      const c = await addCustomer(w);
      const ps = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
      const key = newKey();
      const cart = cartOf(c, ps);
      const counterBefore = await counterOf(w, 'bill:RF:2026');
      const before = await footprint(w);
      let hit = 0;
      w.world.spy.intercept = async (e) => {
        if (re.test(e.sql.trim())) {
          hit++;
          throw new Error(`injected failure at ${what}`);
        }
      };
      try {
        const res = await postBill(w, 'owner', cart, key);
        expect(hit, 'the statement was never sent').toBe(1);
        expect(res.statusCode, res.body).toBe(500);
        expect(codeOf(res)).toBe('JV_INTERNAL');
        expect(res.body).not.toContain('injected');
      } finally {
        w.world.spy.intercept = null;
      }
      expect(await footprint(w)).toEqual(before);
      expect((await counterOf(w, 'bill:RF:2026')) ?? 0, 'a number stayed used').toBe(counterBefore ?? 0);
      for (const p of ps) expect(await pieceRow(w, p)).toMatchObject({ status: 'In Stock', sold_bill_id: null });
      const retry = await postBill(w, 'owner', cart, key);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(body(retry).bill.bill_no).toBe(`RF-2026-${String((counterBefore ?? 0) + 1).padStart(4, '0')}`);
      await setEstimate(w, { prefix: 'JV', roundOff: true });
    });
  }

  it('a lock wait that times out at the pieces (error 1205) is JV_BUSY and nothing is saved', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const before = await footprint(w);
    w.world.spy.intercept = async (e) => {
      if (/FROM skus WHERE id IN .* FOR UPDATE/.test(e.sql)) throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
    };
    try {
      const res = await postBill(w, 'owner', cartOf(c, [p]));
      expect(res.statusCode, res.body).toBe(503);
      expect(codeOf(res)).toBe('JV_BUSY');
    } finally {
      w.world.spy.intercept = null;
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('defence in depth (X1 (h)): when the conditional UPDATE of the pieces changes fewer rows than the bill has lines, the call is rolled back (JV_INTERNAL) and nothing is saved', async () => {
    const c = await addCustomer(w);
    const ps = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
    const before = await footprint(w);
    w.world.spy.intercept = async (e) => {
      if (/^UPDATE skus SET status = \?/.test(e.sql.trim())) return { result: [{ fieldCount: 0, affectedRows: 1, insertId: 0, info: '', serverStatus: 2, warningStatus: 0 }, undefined] };
    };
    try {
      const res = await postBill(w, 'owner', cartOf(c, ps));
      expect(res.statusCode, res.body).toBe(500);
      expect(codeOf(res)).toBe('JV_INTERNAL');
    } finally {
      w.world.spy.intercept = null;
    }
    expect(await footprint(w)).toEqual(before);
    for (const p of ps) expect((await pieceRow(w, p)).status).toBe('In Stock');
  });

  it('refusals that come after the customer lock (an archived customer, a piece in repair, a discount above the total, a By Weight quantity of 2) use no number and sell nothing', async () => {
    await setEstimate(w, { prefix: 'RG', roundOff: true });
    const archived = await addCustomer(w, { archived_at: '2026-09-01 12:00:00.000000' });
    const c = await addCustomer(w);
    const [ok, repair, bw] = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00', status: 'Repair' }), await piece(w, d.gold22, { retail: '10.00' })];
    const before = await footprint(w);
    const attempts = [
      postBill(w, 'owner', cartOf(archived, [ok])),
      postBill(w, 'owner', cartOf(c, [ok, repair])),
      postBill(w, 'owner', cartOf(c, [ok], { discount: '10.01' })),
      postBill(w, 'owner', billBody(c, 'Retail', [item(bw, { metal_rate: '10.00', labour_rate: '1.00', quantity: 2 })])),
    ];
    const answers: number[] = [];
    for (const a of attempts) answers.push((await a).statusCode);
    expect(answers).toEqual([409, 409, 422, 422]);
    expect(await footprint(w)).toEqual(before);
    expect(await counterOf(w, 'bill:RG:2026'), 'the series row exists but no number was taken').toBe(0);
    expect((await pieceRow(w, ok)).status).toBe('In Stock');
    // and the next bill is number 1: nothing was used
    expect((await saved(await postBill(w, 'owner', cartOf(c, [ok])))).bill.bill_no).toBe('RG-2026-0001');
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });
});
