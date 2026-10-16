// Y6 of the spec: after anything that changes a customer's bills or receipts, the customer's ADVANCE is applied to their oldest pending bills, oldest receipt first,
// and unallocated silver the same way. It never changes an existing allocation, and it applies in total at most the customer's advance of V2
// (money received - live allocations - refunds), so money that was handed back is never spent a second time. Opening bills and opening advances are ordinary rows (Y9).
// The walk-in customer is never rebalanced (K5).
//
// Reads are the correlated queries of db/queries (S1, S2, V2_one). The caller holds the customer's lock (SELECT ... FOR UPDATE on the customer row, X0) inside a transaction. Amounts are exact: integers of paise and milligrams inside.
// The import (IM4) and the API's X12 call the same function; there is no second copy of this rule.
import { randomUUID } from 'node:crypto';
import { loadQueries } from './queries.mjs';

const Q = loadQueries();

const MONEY = 2;
const FINE = 3;

/** '123.45' -> 12345n (scale 2); a value with more decimals than the scale is an error: MariaDB would round it silently. */
export function toUnits(text, scale) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(text)}`);
  const frac = m[3] ?? '';
  if (frac.length > scale) throw new Error(`${JSON.stringify(text)} has more than ${scale} decimals`);
  const n = BigInt(m[2] + frac.padEnd(scale, '0'));
  return m[1] === '-' ? -n : n;
}

export function fromUnits(units, scale) {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
}

const min = (...xs) => xs.reduce((a, b) => (a < b ? a : b));

export async function rebalanceCustomer(conn, customerId, opts = {}) {
  const newId = opts.newId ?? randomUUID;
  const empty = { allocations: [], applied: fromUnits(0n, MONEY), fine_applied: fromUnits(0n, FINE) };
  const [cust] = await conn.query('SELECT is_walkin FROM customers WHERE id = ? FOR UPDATE', [customerId]);
  if (cust.length === 0) throw new Error(`customer ${customerId} does not exist`);
  if (Number(cust[0].is_walkin) === 1) return empty;

  // What is open, by the correlated reads of X0 item 8 (S1, S2) and the advance of V2 (one customer): never a join to a grouped derived table over the customer's history (RM5-1).
  // Read at call time, inside the transaction and after the change, so what the change re-opened (a void, a cancel, a re-issue) is in it (RM5-2).
  const [bills] = await conn.query(Q.S1, [customerId]);
  const [receipts] = await conn.query(Q.S2, [customerId]);
  const advance = (await conn.query(Q.V2_one, [customerId]))[0][0];

  // the customer's advance: money received - live allocations - refunds; silver received - live silver allocations (V2: advance, fine_advance)
  let moneyLeft = toUnits(advance.advance, MONEY);
  let fineLeft = toUnits(advance.fine_advance, FINE);
  const moneyReceipts = [];
  const fineReceipts = [];
  for (const r of receipts) {
    if (r.kind === 'money') {
      const rem = toUnits(r.remaining, MONEY);
      if (rem > 0n) moneyReceipts.push({ id: r.id, rem });
    } else {
      const rem = toUnits(r.fine_remaining, FINE);
      if (rem > 0n) fineReceipts.push({ id: r.id, rem });
    }
  }
  const pending = bills.map((b) => ({ id: b.id, money: toUnits(b.pending, MONEY), fine: toUnits(b.fine_pending, FINE) }));

  const allocations = [];
  const apply = (list, key, scale, capacity) => {
    let total = 0n;
    for (const r of list) {
      for (const b of pending) {
        if (capacity <= 0n) return total;
        if (r.rem <= 0n) break;
        if (b[key] <= 0n) continue;
        const take = min(r.rem, b[key], capacity);
        r.rem -= take;
        b[key] -= take;
        capacity -= take;
        total += take;
        allocations.push({
          id: newId(),
          receipt_id: r.id,
          bill_id: b.id,
          amount: fromUnits(key === 'money' ? take : 0n, MONEY),
          fine_grams: fromUnits(key === 'fine' ? take : 0n, FINE),
        });
      }
    }
    return total;
  };
  const applied = apply(moneyReceipts, 'money', MONEY, moneyLeft);
  const fineApplied = apply(fineReceipts, 'fine', FINE, fineLeft);

  for (let i = 0; i < allocations.length; i += 200) {
    const part = allocations.slice(i, i + 200);
    await conn.query(
      `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      part.flatMap((a) => [a.id, a.receipt_id, a.bill_id, customerId, a.amount, a.fine_grams])
    );
  }
  return { allocations, applied: fromUnits(applied, MONEY), fine_applied: fromUnits(fineApplied, FINE) };
}
