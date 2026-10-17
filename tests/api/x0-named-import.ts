// A function in the style of src/: it imports the state read BY NAME, as every money function will. tests/api/x0-locks.test.ts shows that the test build's hook (x0-support.ts, Gates) still catches it,
// because the module's exports are looked up at each call.
import { readCustomerState } from '../../src/db/state';
import type { Tx } from '../../src/db/tx';

export async function readsByName(tx: Tx, customerId: string) {
  const st = await readCustomerState(tx, { fn: 'named_import', customerId });
  return st.openBills.length;
}
