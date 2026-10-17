// X6 create_customer (POST /v1/customers), K5, D10, Z3, L5, X0: makes a customer. Never the walk-in (that row is the seed's, and `is_walkin` is not an input); opening balances are X12.
//
//   body     name (1 to 120 characters), mobile (required: ten digits, or + and 7 to 15 digits, spaces and dashes taken out), customer_type (Retail by default), email, address, gst_number, pan,
//            notes. The widths, the mobile pattern and the PAN pattern are the fields of the customer edit (src/edit/customers.ts), so a customer cannot be made with something a PATCH would refuse.
//            Every pattern is checked here, before any statement is sent: a mistake is a refusal of the field (422), never the database's CHECK (4025, which would be a bug and a 500).
//   header   Idempotency-Key (a UUID the screen makes once for each customer it saves and reuses for a retry).
//   answer   201 { customer }: the row in the wire format of the sync read of the caller's role, so the cache applies it as it applies a polled row. A repeat of the key answers the same body and
//            status with `Idempotent-Replay: true`.
//
// ORDER OF WORK (NODE-DESIGN 4.3, X0). The route wrapper has already refused everything it can without a database (no session, a role not on the row, an invalid body), and none of that touches the
// Idempotency-Key. Then: the key is read from the header (missing or not a UUID: 422 naming the header, nothing claimed) and ONE transaction runs: the claim of the key (first statement), the role
// check again (X0 item 2), the insert, the audit row of mechanism (b) when JV_AUDIT_MODE=node (mechanism (a) writes it by itself), the stored result. A new customer has nothing to lock and nobody to
// number: no customer lock, no piece lock, no counter. A failure anywhere rolls the claim back with the rest, so a retry of the key runs again.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { output } from 'zod';
import { auditChange } from '../db/audit.js';
import { idempotencyKey, idempotent, markReplay } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { txContextFor, withTx } from '../db/tx.js';
import { CUSTOMERS } from '../edit/customers.js';
import { readRow, wireRow } from '../edit/engine.js';
import { unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';

/** The columns of a customer that X6 takes (A5 lists the same eight for the edit), each with the field of the edit. */
const field = (name: keyof typeof CUSTOMERS.fields) => CUSTOMERS.fields[name].schema;

export const createCustomerBody = wire.strictObject({
  name: field('name'),
  // a named customer has a mobile number (D10): the field takes a blank as "none" (an imported customer may have none), so X6 refuses the none
  mobile: field('mobile').refine((v) => v !== null, { error: 'must be given: a customer has a mobile number' }),
  customer_type: field('customer_type').optional(),
  email: field('email').optional(),
  address: field('address').optional(),
  gst_number: field('gst_number').optional(),
  pan: field('pan').optional(),
  notes: field('notes').optional(),
});

/** What the schema returns: the text is trimmed, the mobile has no spaces or dashes, a blank optional text is null. */
export interface CreateCustomerInput {
  name: string;
  mobile: string;
  customer_type?: string;
  email?: string | null;
  address?: string | null;
  gst_number?: string | null;
  pan?: string | null;
  notes?: string | null;
}
export type CreateCustomerBody = output<typeof createCustomerBody>;

const ACTION = 'fn:create_customer';
const ROUTE_NAME = 'POST /v1/customers';

const INSERT_SQL =
  'INSERT INTO customers (id, name, mobile, customer_type, email, address, gst_number, pan, notes, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

export interface CreatedCustomer {
  customer: Record<string, unknown>;
}

/**
 * The service function. `key` is the Idempotency-Key as idempotencyKey() read it. Returns the answer and whether it is the stored answer of an earlier call with the same key.
 */
export async function createCustomer(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, input: CreateCustomerInput): Promise<{ value: CreatedCustomer; replayed: boolean }> {
  if (!app.db) throw unavailableError();
  const { id: userId, role } = auth.user;
  const ctx = txContextFor(app.db, request, { id: userId, role });
  return withTx(ctx, (tx) =>
    idempotent<CreatedCustomer>(tx, { key, fn: 'create_customer', route: ROUTE_NAME, body: input }, async () => {
      assertMayCall(role, ACTION); // X0 item 2: the wrapper has checked; the function checks again, after the claim, so a refusal here rolls the claim back
      const at = app.clock.read(); // both stamps from one reading of the API clock (S6)
      const id = newId();
      await tx.run(INSERT_SQL, [
        id,
        input.name,
        input.mobile,
        input.customer_type ?? 'Retail',
        input.email ?? null,
        input.address ?? null,
        input.gst_number ?? null,
        input.pan ?? null,
        input.notes ?? null,
        at.timestamp,
        at.timestamp,
        userId,
        userId,
      ]);
      const after = await readRow(tx, 'customers', id, false);
      if (!after) throw new Error(`customers ${id}: the row is gone after its own insert`);
      await auditChange(tx, { table: 'customers', rowId: id, action: 'insert', before: null, after }); // L1 (b): only when JV_AUDIT_MODE=node; the triggers of (a) write their own row
      return { customer: wireRow('customers', role, after) };
    }),
  );
}

/** Registers `fn:create_customer`. */
export function registerCreateCustomer(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: createCustomerBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await createCustomer(a, request, auth, key, body as CreateCustomerInput);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
