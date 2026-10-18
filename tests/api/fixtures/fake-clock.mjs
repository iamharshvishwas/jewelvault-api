// A test seam for a child process (`node --import tests/api/fixtures/fake-clock.mjs scripts/job.js dump`): the clock of the process starts at the instant in JV_TEST_NOW and then runs at the
// normal speed. It exists in the tests only; the job itself reads the clock the normal way (Date.now()).
const start = Date.parse(process.env.JV_TEST_NOW ?? '');
if (Number.isFinite(start)) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  globalThis.Date = class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }

    static now() {
      return RealDate.now() + offset;
    }
  };
}
