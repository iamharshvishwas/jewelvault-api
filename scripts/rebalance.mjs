// Y6 of the spec: after anything that changes a customer's bills or receipts, the customer's ADVANCE is applied to their oldest pending bills, oldest receipt first,
// and unallocated silver the same way. It never changes an existing allocation, and it applies in total at most the customer's advance of V2
// (money received - live allocations - refunds), so money that was handed back is never spent a second time. Opening bills and opening advances are ordinary rows (Y9).
// The walk-in customer is never rebalanced (K5).
//
// The caller holds the customer's lock (SELECT ... FOR UPDATE on the customer row, X0) inside a transaction. Amounts are exact: integers of paise and milligrams inside.
// The import (IM4) and the API's X12 call the same function; there is no second copy of this rule.
import { randomUUID } from 'node:crypto';

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

  // live allocations: not released, and the receipt is still active
  const liveByBill = `SELECT al.bill_id AS bill_id, SUM(al.amount) AS money, SUM(al.fine_grams) AS fine
                        FROM receipt_allocations al JOIN receipts r ON r.id = al.receipt_id
                       WHERE al.customer_id = ? AND al.released_at IS NULL AND r.status = 'active' GROUP BY al.bill_id`;
  const liveByReceipt = `SELECT al.receipt_id AS receipt_id, SUM(al.amount) AS money, SUM(al.fine_grams) AS fine
                           FROM receipt_allocations al JOIN receipts r ON r.id = al.receipt_id
                          WHERE al.customer_id = ? AND al.released_at IS NULL AND r.status = 'active' GROUP BY al.receipt_id`;

  const [bills] = await conn.query(
    `SELECT CAST(b.grand_total AS CHAR) AS total, CAST(b.fine_weight_due AS CHAR) AS fine_total, b.id AS id,
            CAST(COALESCE(a.money, 0) AS CHAR) AS paid, CAST(COALESCE(a.fine, 0) AS CHAR) AS fine_paid
       FROM bills b LEFT JOIN (${liveByBill}) a ON a.bill_id = b.id
      WHERE b.customer_id = ? AND b.status = 'active' ORDER BY b.bill_date, b.created_at, b.id`,
    [customerId, customerId]
  );
  const [receipts] = await conn.query(
    `SELECT r.id AS id, r.kind AS kind, CAST(r.amount AS CHAR) AS amount, CAST(r.fine_grams AS CHAR) AS fine_grams,
            CAST(COALESCE(a.money, 0) AS CHAR) AS used, CAST(COALESCE(a.fine, 0) AS CHAR) AS fine_used
       FROM receipts r LEFT JOIN (${liveByReceipt}) a ON a.receipt_id = r.id
      WHERE r.customer_id = ? AND r.status = 'active' AND r.kind IN ('money', 'fine_silver', 'fine_cash') ORDER BY r.paid_on, r.created_at, r.id`,
    [customerId, customerId]
  );
  const [refunds] = await conn.query("SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS s FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'refund'", [customerId]);

  // the customer's advance: money received - live allocations - refunds; silver received - live silver allocations
  let moneyLeft = -toUnits(refunds[0].s, MONEY);
  let fineLeft = 0n;
  const moneyReceipts = [];
  const fineReceipts = [];
  for (const r of receipts) {
    if (r.kind === 'money') {
      const rem = toUnits(r.amount, MONEY) - toUnits(r.used, MONEY);
      moneyLeft += rem;
      if (rem > 0n) moneyReceipts.push({ id: r.id, rem });
    } else {
      const rem = toUnits(r.fine_grams, FINE) - toUnits(r.fine_used, FINE);
      fineLeft += rem;
      if (rem > 0n) fineReceipts.push({ id: r.id, rem });
    }
  }
  const pending = bills.map((b) => ({
    id: b.id,
    money: toUnits(b.total, MONEY) - toUnits(b.paid, MONEY),
    fine: toUnits(b.fine_total, FINE) - toUnits(b.fine_paid, FINE),
  }));

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
