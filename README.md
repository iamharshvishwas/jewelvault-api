# jewelvault-api

Backend of JewelVault: Node.js + MariaDB 11.8 (Hostinger Business). Local git only, no remote.

State on 16 Oct 2026 (aligned with spec draft 5.2): **steps 1, 2 and 3 are done** (`SCHEMA.md` is the draft schema, `db/` the SQL, `tests/schema` its 549 tests), the four derived reads V1 to V4 and the state reads S1 to S4 (queries in `db/queries`, not views, since spec draft 5; correlated since 5.2) and the invariants I1 to I13 (SQL half, `scripts/invariants.mjs`) are in too, and so are the health query (I12), the export as one encrypted file, the backup folder, the photo copy and the restore (`BACKUP-RESTORE.md`), the generated audit triggers (`db/optional/0910`) and the import (`IMPORT-GUIDE.md`): `SPIKE-REPORT.md` (the spike) and `PART-A-MARIADB-MAPPING.md` (which Part A rules change on MariaDB). `HOSTINGER-FACTS.md` holds the values read from Harsh's account and the photo decision (photos in MariaDB). Nothing has been applied to Hostinger. `API-00-HOSTINGER-PROOF.md` is the step-by-step proof Harsh runs in hPanel (the code is in the sibling repo `jewelvault-proof`).

```bash
npm install
npm run db:up      # throw-away MariaDB 11.8 in Docker, data in tmpfs (no volume)
npx vitest run     # everything (spike + schema), about 1 to 2 minutes
npm run test:schema # only the schema tests
npm run db:schema  # rebuild db/schema.sql and db/seed.sql after a migration changes
npm run db:down    # docker rm -fv jv-mariadb-spike
```

Never run `db:down`-style cleanup with `-v` against `keep-tourstack-and-unknown-volumes`.
