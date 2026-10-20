import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryPhotos } from "../../src/jobs/backupFolder";
import { createPhotoCopyPhase } from "../../src/jobs/photoCopy";
import { JOB_LIMITS } from "../../src/jobs/schedule";
import { runTick } from "../../src/jobs/tick";
import {
  type PhotoObject,
  type TickWorld,
  addPhotoObjects,
  at,
  backupRuns,
  copiedRows,
  tickWorld,
} from "./tick-support";

// T-R04 (I8, B2, D25, D17): the `photo_copy` phase of the tick. "The photo copy works in the slices of the tick: each photo file is independent, a slice stops starting new work after 25 seconds, so
// that 25 seconds plus one statement of up to 20 stays under the tick's own handler timer of 50 seconds; it records where it stopped in `detail` and the next tick goes on", "a backup_runs row with
// ok true is written only when a phase is complete for the day (D17)", and the copy is nightly work: once for a business date, not before 02:00 in Asia/Kolkata.
// The time of a slice is the API's clock (S5): the store these tests give the phase moves the test's clock by what a photo "costs", so a slice of 25 seconds takes no time to run.
// The clock only moves forward, so each describe is one story told in order, one business date for each step.

const set = (w: TickWorld, iso: string) => {
  w.time.time.micros = at(iso);
};
const outcome = (res: { json(): unknown }) =>
  ((res.json() as any).phases as { job: string; outcome: string }[]).find(
    (p) => p.job === "photo_copy",
  )?.outcome;
const photosOf = (w: TickWorld) =>
  readdir(path.join(w.backupDir!, "photos")).then((n) => n.sort());
const nameOf = (p: PhotoObject) => `${p.id}-${p.kind}`;

describe("T-R04 the photo copy in slices of 25 seconds: where it stopped, the next tick goes on, ok and the heartbeat only when complete", () => {
  let w: TickWorld;
  let cost = 0n; // microseconds that one photo takes on the clock
  let puts: string[] = [];
  let failId: string | null = null;
  let abort: AbortController | null = null;
  let removeWhenPut: { after: string; remove: string } | null = null;
  const store = (dir: string) => {
    const real = directoryPhotos(dir);
    return {
      ...real,
      async put(id: string, kind: string, bytes: Buffer) {
        if (id === failId) throw new Error("the disk said no");
        puts.push(`${id}-${kind}`);
        await real.put(id, kind, bytes);
        w.time.time.micros += cost;
        abort?.abort();
        if (removeWhenPut && id === removeWhenPut.after) {
          await w.sql.query(
            "UPDATE design_photos SET removed_at = ?, bytes = NULL WHERE id = ?",
            ["2026-10-22 20:30:01.000000", removeWhenPut.remove],
          );
        }
      },
    };
  };
  const phase = createPhotoCopyPhase({ store });

  beforeAll(async () => {
    w = await tickWorld("tickpc", { phases: [phase] });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it("the limits are the spec's: a slice stops starting new work after 25 seconds, and 25 seconds plus one statement of up to 20 stays under the handler timer of 50", () => {
    expect(JOB_LIMITS.photoSliceSeconds).toBe(25);
    expect(JOB_LIMITS.statementSeconds).toBe(20);
    expect(
      JOB_LIMITS.photoSliceSeconds + JOB_LIMITS.statementSeconds,
    ).toBeLessThan(50);
  });

  it('with no photo at all the first tick of the night is complete: the row is ok, the folder photos/ is there, ONE backup_runs row says photo_copy ok with the time of the API clock; a second tick says "already done"', async () => {
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe("ran");
    const [run] = await w.runs("photo_copy");
    expect([run.run_date, run.status]).toEqual(["2026-10-17", "ok"]);
    expect(run.detail).toMatchObject({ copied: 0, bytes: 0, slices: 1 });
    expect(await photosOf(w)).toEqual([]);
    const rows = await backupRuns(w.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "photo_copy", ok: 1, bytes: 0 });
    expect(rows[0].ran_at.startsWith("2026-10-17 10:00:00")).toBe(true); // the API's clock, not the database's
    expect(rows[0].detail).toMatchObject({
      copied: 0,
      folder: { files: 0, bytes: 0, photos: 0 },
    });

    set(w, "2026-10-17T10:30:00Z");
    expect(outcome(await w.tick())).toBe("already_done");
    expect(await backupRuns(w.sql)).toHaveLength(1);
  });

  it("seven photos and a photo that costs 10 seconds: the first slice starts three (the fourth would start at 30 s), the row stays running with the end of the slice and where it stopped, and NO ok row is written", async () => {
    const objects = await addPhotoObjects(w.sql, 7);
    cost = 10_000_000n;
    puts = [];
    set(w, "2026-10-17T20:30:00Z"); // 02:00:00 on 18 Oct
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe("partial");
    expect(puts).toEqual(objects.slice(0, 3).map(nameOf)); // oldest first
    const [, run] = await w.runs("photo_copy");
    expect([run.run_date, run.status]).toEqual(["2026-10-18", "running"]);
    expect(run.finished_at).not.toBeNull(); // the slice has ended: nobody is working on it
    expect(run.detail).toMatchObject({ slices: 1, copied: 3, stopped: "time" });
    expect(
      await backupRuns(w.sql),
      "D17: never an ok for a partial slice",
    ).toHaveLength(1);
    expect((await copiedRows(w.sql)).map((r) => r.photo_id).sort()).toEqual(
      objects
        .slice(0, 3)
        .map((o) => o.id)
        .sort(),
    );
    const event = (await w.jobEvents())
      .filter((e) => e.new_row.job === "photo_copy")
      .at(-1)!;
    expect(event.new_row).toMatchObject({
      event: "job_phase",
      job: "photo_copy",
      run_date: "2026-10-18",
      outcome: "partial",
      copied: 3,
    });
  });

  it("the next tick goes on where the last stopped (three more), and the one after copies the last photo, is complete, and writes the ok row with the total", async () => {
    const objects = (await copiedRows(w.sql)).length; // 3 so far
    expect(objects).toBe(3);
    puts = [];
    set(w, "2026-10-17T21:30:00Z");
    expect(outcome(await w.tick())).toBe("partial");
    expect(puts).toHaveLength(3);
    const [, mid] = await w.runs("photo_copy");
    expect(mid).toMatchObject({
      status: "running",
      detail: { slices: 2, copied: 6 },
    });
    expect(await backupRuns(w.sql)).toHaveLength(1);

    puts = [];
    set(w, "2026-10-17T22:30:00Z");
    const last = await w.tick();
    expect(outcome(last)).toBe("ran");
    expect(puts).toHaveLength(1);
    const [, done] = await w.runs("photo_copy");
    expect(done.status).toBe("ok");
    expect(done.detail).toMatchObject({ slices: 3, copied: 7 });
    const rows = await backupRuns(w.sql);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: "photo_copy", ok: 1 });
    expect(rows[1].bytes).toBeGreaterThan(7 * 200);
    expect(rows[1].detail).toMatchObject({
      copied: 7,
      slices: 3,
      folder: { files: 7, photos: 7 },
    });
    expect((await copiedRows(w.sql)).length).toBe(7);
    expect(await photosOf(w)).toHaveLength(7);
    const events = (await w.jobEvents()).filter(
      (e) =>
        e.new_row.job === "photo_copy" && e.new_row.run_date === "2026-10-18",
    );
    expect(events.map((e) => e.new_row.outcome)).toEqual([
      "partial",
      "partial",
      "ok",
    ]); // one event row for every run (T-D14)

    set(w, "2026-10-17T23:30:00Z");
    expect(outcome(await w.tick())).toBe("already_done");
    expect(await backupRuns(w.sql)).toHaveLength(2);
  });

  it("a photo that takes 24.9 seconds lets a second one start (24.9 is under 25), one that takes 25.1 does not: one photo per slice, then two, then the rest", async () => {
    const objects = await addPhotoObjects(w.sql, 4, { from: 100 });
    set(w, "2026-10-18T20:30:00Z"); // 02:00 on 19 Oct
    cost = 25_100_000n;
    puts = [];
    expect(outcome(await w.tick())).toBe("partial");
    expect(puts).toEqual([nameOf(objects[0])]);

    cost = 24_900_000n;
    puts = [];
    set(w, "2026-10-18T21:30:00Z");
    expect(outcome(await w.tick())).toBe("partial");
    expect(puts).toEqual([nameOf(objects[1]), nameOf(objects[2])]);

    cost = 0n;
    puts = [];
    set(w, "2026-10-18T22:30:00Z");
    expect(outcome(await w.tick())).toBe("ran");
    expect(puts).toEqual([nameOf(objects[3])]);
  });

  it("a call whose client has gone (the signal aborts) starts no new photo: the slice ends there, the row stays running, the next tick finishes", async () => {
    const objects = await addPhotoObjects(w.sql, 3, { from: 200 });
    set(w, "2026-10-19T20:30:00Z"); // 02:00 on 20 Oct
    cost = 0n;
    puts = [];
    abort = new AbortController();
    const r = await runTick(w.world.app, {
      phases: [phase],
      requestId: randomUUID(),
      signal: abort.signal,
    });
    abort = null;
    expect(r.phases).toEqual([{ job: "photo_copy", outcome: "partial" }]);
    expect(puts).toEqual([nameOf(objects[0])]);
    expect((await w.runs("photo_copy")).at(-1)).toMatchObject({
      run_date: "2026-10-20",
      status: "running",
      detail: { stopped: "signal", copied: 1 },
    });
    set(w, "2026-10-19T21:30:00Z");
    expect(outcome(await w.tick())).toBe("ran");
    expect(puts).toHaveLength(3); // the 1 and the 2 that were left
  });

  it("a removed photo is not copied, a photo already recorded is not written again, and a file that is already there with the same bytes (a crash before the record) is recorded without a fault", async () => {
    const [live1, live2, removedOne, recorded, leftOver] = [
      ...(await addPhotoObjects(w.sql, 2, { from: 300 })),
      ...(await addPhotoObjects(w.sql, 1, { from: 310, removed: true })),
      ...(await addPhotoObjects(w.sql, 1, { from: 320 })),
      ...(await addPhotoObjects(w.sql, 1, { from: 330 })),
    ];
    await w.sql.query(
      "INSERT INTO sys_photo_copies (photo_id, kind, sha256, size) VALUES (?, ?, UNHEX(SHA2(?, 256)), ?)",
      [recorded.id, recorded.kind, recorded.bytes, recorded.bytes.length],
    );
    await mkdir(path.join(w.backupDir!, "photos"), { recursive: true });
    await writeFile(
      path.join(w.backupDir!, "photos", nameOf(leftOver)),
      leftOver.bytes,
    ); // the earlier run died after the file and before the row
    // RV3a-F1: the nightly check looks at every recorded copy, so a copy that is recorded must be IN the folder for "not written again" to be what is meant (a recorded copy that is missing from
    // the folder is written again: tests/api/rv3a-photo-verify.test.ts)
    await writeFile(
      path.join(w.backupDir!, "photos", nameOf(recorded)),
      recorded.bytes,
    );
    puts = [];
    set(w, "2026-10-20T20:30:00Z"); // 02:00 on 21 Oct
    cost = 0n;
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe("ran");
    expect(puts.sort()).toEqual(
      [nameOf(live1), nameOf(live2), nameOf(leftOver)].sort(),
    );
    const names = await photosOf(w);
    expect(names).toContain(nameOf(live1));
    expect(names).not.toContain(nameOf(removedOne));
    expect(names).toContain(nameOf(recorded)); // it was said to be copied, and it is there: nothing was written (it is not in `puts` above)
    expect(names.some((n) => n.endsWith(".partial"))).toBe(false);
    expect(
      (await readFile(path.join(w.backupDir!, "photos", nameOf(live1)))).equals(
        live1.bytes,
      ),
    ).toBe(true);
    const rows = await copiedRows(w.sql);
    for (const p of [live1, live2, leftOver])
      expect(
        rows.some((r) => r.photo_id === p.id),
        nameOf(p),
      ).toBe(true);
    expect(rows.some((r) => r.photo_id === removedOne.id)).toBe(false);
  });

  it("a photo that cannot be copied fails the phase AFTER the others were copied: the tick answers an error, the row is failed, ONE backup_runs row says ok false (once for the date); when it can be copied the same row ends ok and the heartbeat is written", async () => {
    const objects = await addPhotoObjects(w.sql, 4, { from: 400 });
    failId = objects[1].id;
    puts = [];
    set(w, "2026-10-21T20:30:00Z"); // 02:00 on 22 Oct
    const bad = await w.tick();
    expect(bad.statusCode).toBe(500);
    expect(puts.sort()).toEqual(
      [objects[0], objects[2], objects[3]].map(nameOf).sort(),
    );
    const failedRun = (await w.runs("photo_copy")).at(-1)!;
    expect([failedRun.run_date, failedRun.status]).toEqual([
      "2026-10-22",
      "failed",
    ]);
    expect(failedRun.detail.error.name).toBe("PhotoCopyError");
    expect(failedRun.detail.error.message).toMatch(
      /1 of 4 photo objects could not be copied/,
    );
    const before = (await backupRuns(w.sql)).length;
    const row = (await backupRuns(w.sql)).at(-1)!;
    expect(row).toMatchObject({ kind: "photo_copy", ok: 0 });
    expect(row.detail).toMatchObject({ failed: 1, copied: 3 });

    set(w, "2026-10-21T21:30:00Z");
    expect((await w.tick()).statusCode).toBe(500); // still failing
    expect(
      (await backupRuns(w.sql)).length,
      "a second ok-false row for the same date",
    ).toBe(before);

    failId = null;
    puts = [];
    set(w, "2026-10-21T22:30:00Z");
    const good = await w.tick();
    expect(good.statusCode, good.body).toBe(200);
    expect(puts).toEqual([nameOf(objects[1])]);
    const runs = (await w.runs("photo_copy")).filter(
      (r) => r.run_date === "2026-10-22",
    );
    expect(runs).toHaveLength(1); // the same row, back to running and then ok
    expect(runs[0].id).toBe(failedRun.id);
    expect(runs[0].status).toBe("ok");
    const last = (await backupRuns(w.sql)).at(-1)!;
    expect(last).toMatchObject({ kind: "photo_copy", ok: 1 });
    expect(last.detail.folder.photos).toBeGreaterThanOrEqual(4);
  });

  it("a photo the owner removes while the slice runs is not a fault: it is left out (a tombstone is never copied), the others are copied, the phase is complete and the heartbeat is written", async () => {
    const [first, doomed, last] = await addPhotoObjects(w.sql, 3, {
      from: 500,
    });
    removeWhenPut = { after: first.id, remove: doomed.id };
    puts = [];
    set(w, "2026-10-22T20:30:00Z"); // 02:00 on 23 Oct
    const res = await w.tick();
    removeWhenPut = null;
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe("ran");
    expect(puts).toEqual([nameOf(first), nameOf(last)]);
    expect(
      (await copiedRows(w.sql)).some((r) => r.photo_id === doomed.id),
    ).toBe(false);
    expect(await photosOf(w)).not.toContain(nameOf(doomed));
    expect((await backupRuns(w.sql)).at(-1)).toMatchObject({
      kind: "photo_copy",
      ok: 1,
    });
  });
});

describe("T-R04 the photo copy reads a bounded list: a slice that was cut by its row limit is not complete", () => {
  let w: TickWorld;
  beforeAll(async () => {
    w = await tickWorld("tickpcl", {
      phases: [createPhotoCopyPhase({ limit: 2 })],
    });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it("five photos and a limit of two: three ticks (2, 2, 1); only the last is complete and writes the heartbeat", async () => {
    await addPhotoObjects(w.sql, 5);
    const seen: string[] = [];
    for (const [i, t] of ["10:00", "11:00", "12:00"].entries()) {
      set(w, `2026-10-17T${t}:00Z`);
      seen.push(outcome(await w.tick())!);
      expect((await copiedRows(w.sql)).length).toBe(Math.min(5, (i + 1) * 2));
    }
    expect(seen).toEqual(["partial", "partial", "ran"]);
    expect((await w.runs("photo_copy"))[0]).toMatchObject({
      status: "ok",
      detail: { slices: 3, copied: 5 },
    });
    expect(await backupRuns(w.sql)).toHaveLength(1);
  });
});

describe('T-R04 a backup folder that is not there is never read as "nothing to copy" (B2): the phase fails, the tick answers an error, nothing is made, and the heartbeat is not written', () => {
  const cases: [
    string,
    () => Promise<{ dir: string | undefined; cleanup: () => Promise<void> }>,
    string | RegExp,
    boolean,
  ][] = [
    [
      "JV_BACKUP_DIR is not set",
      async () => ({ dir: undefined, cleanup: async () => undefined }),
      /JV_BACKUP_DIR is not set/,
      false,
    ],
    [
      "the folder does not exist (the proof's folder answered ENOENT after the domain was connected)",
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "jv-nofolder-"));
        return {
          dir: path.join(root, "gone", "jv-backup"),
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      },
      "ENOENT",
      true,
    ],
    [
      "the folder is a file",
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "jv-filefolder-"));
        await writeFile(path.join(root, "jv-backup"), "x");
        return {
          dir: path.join(root, "jv-backup"),
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      },
      "ENOTDIR",
      true,
    ],
    [
      "the folder cannot be written",
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "jv-readonly-"));
        const dir = path.join(root, "jv-backup");
        await mkdir(dir);
        await chmod(dir, 0o500);
        return {
          dir,
          cleanup: async () => {
            await chmod(dir, 0o700);
            await rm(root, { recursive: true, force: true });
          },
        };
      },
      "EACCES",
      true,
    ],
  ];
  it.each(cases)(
    "%s",
    async (label, make, expected, hasCode) => {
      if (label === "the folder cannot be written" && process.getuid?.() === 0)
        return; // root can write anywhere
      const { dir, cleanup } = await make();
      const w = await tickWorld("tickpcf", {
        phases: [createPhotoCopyPhase()],
        config: { backupDir: dir },
      });
      try {
        await addPhotoObjects(w.sql, 2);
        const bad = await w.tick();
        expect(bad.statusCode, bad.body).toBe(500);
        const [run] = await w.runs("photo_copy");
        expect(run.status).toBe("failed");
        if (hasCode) expect(run.detail.error.code).toBe(expected);
        else expect(run.detail.error.message).toMatch(expected as RegExp);
        expect(await copiedRows(w.sql)).toEqual([]); // nothing was recorded as copied
        const rows = await backupRuns(w.sql);
        // a failure is written as ok false; no ok true. Spec 5.2.2 (API34): the start-up check of the same bad folder also writes its own `db_dump` probe row (ok false), which is
        // what turns the owner's line red; the photo copy's row is the one this test is about.
        expect(
          rows
            .filter((r) => r.kind === "photo_copy")
            .map((r) => [r.kind, r.ok]),
        ).toEqual([["photo_copy", 0]]);
        expect(
          rows.filter((r) => r.kind !== "photo_copy" && r.kind !== "db_dump"),
        ).toEqual([]);
        expect(rows.some((r) => r.ok === 1)).toBe(false);
        if (dir && label.startsWith("the folder does not"))
          expect(
            existsSync(dir) || existsSync(path.dirname(dir)),
            "the check made the folder",
          ).toBe(false);
      } finally {
        await w.close();
        await cleanup();
      }
    },
    120_000,
  );
});
