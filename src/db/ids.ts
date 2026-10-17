// S2: identifiers are native UUIDs (MariaDB 11.8 UUID type, 16 bytes), made here by crypto.randomUUID() (version 4) and never by the database, a clock or a count. There is one id type everywhere:
// a foreign key from UUID to CHAR(36) is refused by the server. A design's id may be made by the screen before create_design runs (X8, P2); every other id is made by the API, and every human number
// by src/db/numbers.ts (L3). tests/api/numbers.test.ts reads src/ and fails on any SQL that asks the database for an id (UUID(), UUID_V7(), UUID_SHORT()).
import { randomUUID } from 'node:crypto';

/** A new row id: a lower-case version-4 UUID, as the wire writes it (src/wire/format.ts UUID_TEXT). */
export const newId = (): string => randomUUID();
