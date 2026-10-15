# jewelvault-api

Backend of JewelVault: Node.js + MariaDB 11.8 (Hostinger Business). Local git only, no remote.

State on 15 Oct 2026: **steps 1 and 2 are done**: `SPIKE-REPORT.md` (the spike) and `PART-A-MARIADB-MAPPING.md` (which Part A rules change on MariaDB). The schema (step 3) starts only after Harsh says go.

```bash
npm install
npm run db:up      # throw-away MariaDB 11.8 in Docker, data in tmpfs (no volume)
npx vitest run     # the spike suite
npm run db:down    # docker rm -fv jv-mariadb-spike
```

Never run `db:down`-style cleanup with `-v` against `keep-tourstack-and-unknown-volumes`.
