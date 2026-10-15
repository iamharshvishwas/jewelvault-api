# jewelvault-api

Backend of JewelVault: Node.js + MariaDB 11.8 (Hostinger Business). Local git only, no remote.

State on 15 Oct 2026: **steps 1, 2 and 3 are done** (`SCHEMA.md` is the draft schema, `db/` the SQL, `tests/schema` its 199 tests): `SPIKE-REPORT.md` (the spike) and `PART-A-MARIADB-MAPPING.md` (which Part A rules change on MariaDB). `HOSTINGER-FACTS.md` holds the values read from Harsh's account and the photo decision (photos in MariaDB). Nothing has been applied to Hostinger.

```bash
npm install
npm run db:up      # throw-away MariaDB 11.8 in Docker, data in tmpfs (no volume)
npx vitest run     # everything (spike + schema), about 1 minute
npm run test:schema # only the schema tests
npm run db:schema  # rebuild db/schema.sql and db/seed.sql after a migration changes
npm run db:down    # docker rm -fv jv-mariadb-spike
```

Never run `db:down`-style cleanup with `-v` against `keep-tourstack-and-unknown-volumes`.
