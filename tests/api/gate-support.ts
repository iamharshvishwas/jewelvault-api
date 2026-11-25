import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { World } from './cells';

// The gate of the race tests (Task 14 of the access plan, shared by the final review's fix wave). A race test needs two calls to be inside the database at the same moment, and it must not guess how long that
// takes: a trigger that SLEEPs for a fixed time is a window of wall-clock time, and on a busy machine the second call may arrive after it has closed (the test then passes without the race, or fails for no reason).
// Here the call under test is held inside its statement by a NAMED LOCK that the test itself holds (GET_LOCK on a connection of its own), the test polls the database until it has SEEN the state it wants (the call
// is held, the other call waits for a row lock), and only then opens the gate. There is no clock in it but the bound after which a poll gives up.

/** One trigger of a gate: the statement it holds and when. `condition` is the SQL of an IF, over NEW and OLD. */
export interface GateTrigger {
  name: string;
  when: 'BEFORE INSERT' | 'BEFORE UPDATE';
  table: string;
  condition: string;
}
export interface Gate {
  /** How many statements are held at the gate now (read as root: the ten-box user cannot see other sessions). */
  waiting(): Promise<number>;
  /** Opens the gate: every statement held at it goes on. */
  open(): Promise<void>;
}

/**
 * Runs `run` with slow triggers that wait on a NAMED LOCK the test holds, instead of sleeping for a fixed time: a statement that meets one of the triggers' conditions is held until the test has SEEN the other call waiting
 * and opens the gate. The trigger gives the lock back at once, so that a second waiter passes too. The name of the lock is made up for this run; the triggers are dropped, and the gate opened, whatever happens.
 */
export async function withGates<T>(world: World, triggers: GateTrigger[], run: (gate: Gate) => Promise<T>): Promise<T> {
  const lockName = `jv-gate-${randomBytes(6).toString('hex')}`;
  const holder = await world.scratch.connect();
  const root = await world.scratch.root();
  let closed = true;
  const open = async () => {
    if (!closed) return;
    closed = false;
    await holder.query('SELECT RELEASE_LOCK(?)', [lockName]);
  };
  try {
    const [rows] = await holder.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lockName]);
    expect(Number((rows as any[])[0].got), 'the gate is closed').toBe(1);
    for (const t of triggers) {
      await world.sql.query(`DROP TRIGGER IF EXISTS ${t.name}`);
      await world.sql.query(`CREATE TRIGGER ${t.name} ${t.when} ON ${t.table} FOR EACH ROW BEGIN IF ${t.condition} THEN DO GET_LOCK('${lockName}', 60); DO RELEASE_LOCK('${lockName}'); END IF; END`);
    }
    return await run({
      waiting: async () => Number(((await root.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE = 'User lock' AND INFO LIKE ?", [`%${lockName}%`]))[0] as any[])[0].n),
      open,
    });
  } finally {
    await open().catch(() => undefined);
    for (const t of triggers) await world.sql.query(`DROP TRIGGER IF EXISTS ${t.name}`).catch(() => undefined);
    await holder.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
}

/** One slow trigger: withGates over a single trigger. */
export const withGate = <T>(world: World, trigger: string, when: GateTrigger['when'], table: string, condition: string, run: (gate: Gate) => Promise<T>): Promise<T> =>
  withGates(world, [{ name: trigger, when, table, condition }], run);

/** Polls for a thing that happens in the database; there is no clock in it but the bound after which the test gives up. */
export async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2400; i++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`never reached: ${what}`);
}

/** How many calls of this database wait for a row lock of the roles table now (read as root: the ten-box user cannot see other sessions). */
export async function rolesLockWaiters(world: World): Promise<number> {
  const root = await world.scratch.root();
  try {
    const [rows] = await root.query<any[]>(
      "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id WHERE t.trx_state = 'LOCK WAIT' AND t.trx_query LIKE '%FROM roles%' AND p.DB = ?",
      [world.scratch.database],
    );
    return Number((rows as any[])[0].n);
  } finally {
    await root.end();
  }
}
