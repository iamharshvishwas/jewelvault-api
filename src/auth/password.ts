// U1, U9: passwords. A password is stored as a self-describing hash string; the rules for a new one are here too.
//
// THE HASH. Argon2id through Node's own crypto.argon2 (Node 24.7 and later): 64 MiB of memory, 3 passes, 1 lane, a 16-byte random salt, a 32-byte tag, written as the usual PHC string
//   $argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>          (base64 without padding)
// because crypto.argon2 gives only the raw bytes. Where crypto.argon2 does not exist (an older Node) the fallback of U1 is scrypt, N = 2^17, r = 8, p = 1, with `maxmem` of 256 MiB (Node's default
// of 32 MiB is too small, and exactly 128 MiB is refused too: the cost is a little more than 128 MiB), written as
//   $scrypt$ln=17,r=8,p=1$<salt>$<key>
// The string carries its own parameters, so they can be raised later and the old hashes still verify, and a string made by either scheme verifies on a service that now hashes with the other
// one (when the primitive it needs is there; an Argon2id string on a Node without crypto.argon2 THROWS: it is not "a wrong password").
//
// The primitives are behind a small interface (Kdf), so the tests can put a stand-in in place of Argon2id on a Node that has none, and so the choice between the two is one function (chooseScheme).
//
// AT MOST 2 HASHES AT A TIME (a limiter in front of the primitives; both hashing and verifying count): Node runs them on libuv's four threads, and every one of them holds 64 to 128 MiB.
// The throttle of A13 (API08) limits how many logins may wait for a place. A connection of the pool is never held while a hash runs (the login takes a short checkout, gives it back, then hashes).
//
// AN UNKNOWN E-MAIL still runs one verification, against a dummy hash made once in the current scheme: the time does not say whether the e-mail exists. So does a stored value that is not a hash.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const MAX_CONCURRENT_HASHES = 2;

/** U1: the starting figures, to be tuned on Hostinger to roughly 150 to 400 ms a hash (the proof measured 159 ms). */
export const ARGON2_PARAMS = Object.freeze({ memoryKiB: 64 * 1024, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 });
export const SCRYPT_PARAMS = Object.freeze({ logN: 17, r: 8, p: 1, maxmemBytes: 256 * 1024 * 1024, keyLength: 32, saltLength: 16 });

// ------------------------------------------------------------------ the primitives

export interface Argon2idInput {
  password: string;
  salt: Buffer;
  /** in KiB, as crypto.argon2 takes it */
  memoryKiB: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}
export interface ScryptInput {
  password: string;
  salt: Buffer;
  N: number;
  r: number;
  p: number;
  keyLength: number;
  maxmem: number;
}
export interface Kdf {
  /** null where Node has no crypto.argon2 */
  argon2id: ((input: Argon2idInput) => Promise<Buffer>) | null;
  scrypt: (input: ScryptInput) => Promise<Buffer>;
}
export type Scheme = 'argon2id' | 'scrypt';

type Argon2Function = (algorithm: 'argon2id', parameters: { message: string; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }, callback: (err: Error | null, key: Buffer) => void) => void;

/** Node's own primitives. `crypto.argon2` is looked up at run time: on a Node before 24.7 it is not there, and a named import of it would stop the program from loading. */
export function nodeKdf(): Kdf {
  const found = (nodeCrypto as unknown as { argon2?: unknown }).argon2;
  const argon2 = typeof found === 'function' ? (found as Argon2Function) : null;
  return {
    argon2id: argon2
      ? (i) =>
          new Promise<Buffer>((resolve, reject) => {
            argon2('argon2id', { message: i.password, nonce: i.salt, parallelism: i.parallelism, tagLength: i.tagLength, memory: i.memoryKiB, passes: i.passes }, (err, key) => (err ? reject(err) : resolve(key)));
          })
      : null,
    scrypt: (i) =>
      new Promise<Buffer>((resolve, reject) => {
        nodeCrypto.scrypt(i.password, i.salt, i.keyLength, { N: i.N, r: i.r, p: i.p, maxmem: i.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
      }),
  };
}

/** The scheme new hashes are made with: Argon2id where the primitive exists, scrypt where it does not (U1). */
export const chooseScheme = (kdf: Kdf): Scheme => (kdf.argon2id ? 'argon2id' : 'scrypt');

/** A stored Argon2id string needs crypto.argon2 and this Node has none: the program cannot tell the people who hold such hashes from strangers, so it says so instead of refusing them. */
export class PasswordSchemeUnavailableError extends Error {
  constructor() {
    super('a stored password hash was made with Argon2id and this Node has no crypto.argon2 (it exists from Node 24.7): run the API on the Node of the plan');
    this.name = 'PasswordSchemeUnavailableError';
  }
}

// ------------------------------------------------------------------ the strings

const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
const B64_TEXT = '[A-Za-z0-9+/]+';
const ARGON2_STRING = new RegExp(`^\\$argon2id\\$v=19\\$m=(\\d{1,8}),t=(\\d{1,4}),p=(\\d{1,4})\\$(${B64_TEXT})\\$(${B64_TEXT})$`);
const SCRYPT_STRING = new RegExp(`^\\$scrypt\\$ln=(\\d{1,3}),r=(\\d{1,4}),p=(\\d{1,4})\\$(${B64_TEXT})\\$(${B64_TEXT})$`);

type Parsed =
  | { scheme: 'argon2id'; memoryKiB: number; passes: number; parallelism: number; salt: Buffer; tag: Buffer }
  | { scheme: 'scrypt'; logN: number; r: number; p: number; salt: Buffer; key: Buffer };

/**
 * The parameters in a stored string, or null when it is not a hash this code could have made. The parameters are bounded: the string comes from the database, but a value that asks for a gigabyte
 * of memory or a thousand passes would be run by the next login, so it is refused as "not a hash" instead.
 */
function parseStored(stored: string): Parsed | null {
  let m = ARGON2_STRING.exec(stored);
  if (m) {
    const [memoryKiB, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const salt = Buffer.from(m[4], 'base64');
    const tag = Buffer.from(m[5], 'base64');
    const sane = parallelism >= 1 && parallelism <= 16 && memoryKiB >= 8 * parallelism && memoryKiB <= 1024 * 1024 && passes >= 1 && passes <= 20 && salt.length >= 8 && tag.length >= 16 && tag.length <= 64;
    return sane ? { scheme: 'argon2id', memoryKiB, passes, parallelism, salt, tag } : null;
  }
  m = SCRYPT_STRING.exec(stored);
  if (m) {
    const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const salt = Buffer.from(m[4], 'base64');
    const key = Buffer.from(m[5], 'base64');
    // the memory scrypt needs is 128 * N * r bytes (plus a little): it must fit under the maxmem of 256 MiB with room to spare
    const sane = logN >= 10 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16 && 128 * 2 ** logN * r < SCRYPT_PARAMS.maxmemBytes && salt.length >= 8 && key.length >= 16 && key.length <= 64;
    return sane ? { scheme: 'scrypt', logN, r, p, salt, key } : null;
  }
  return null;
}

// ------------------------------------------------------------------ at most N at a time

/** A first-come-first-served limiter: `max` jobs run, the rest wait in order. A job that fails gives its place back. */
class Limiter {
  inFlight = 0;
  peak = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new TypeError('the limit is a whole number of at least 1');
  }
  get waiting(): number {
    return this.queue.length;
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve)); // the finishing job hands its place over, so inFlight stays as it is
    else this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      return await job();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.inFlight--;
    }
  }
}

// ------------------------------------------------------------------ the service

export interface PasswordService {
  /** the scheme new hashes are made with */
  readonly scheme: Scheme;
  /** A new self-describing hash string for the password. */
  hash(password: string): Promise<string>;
  /**
   * Whether the password matches the stored string, with the parameters in the string. A value that is not a hash is a wrong password, after the same work as a real one. An Argon2id string where
   * this Node has no crypto.argon2 throws PasswordSchemeUnavailableError.
   */
  verify(password: string, stored: string): Promise<boolean>;
  /** The hash of a password nobody knows, made once: what a login for an unknown e-mail verifies against. */
  dummyHash(): Promise<string>;
  /** How many hashes run now, how many wait, and the most that ever ran at once. */
  stats(): { inFlight: number; waiting: number; peak: number };
}

export interface PasswordServiceOptions {
  kdf?: Kdf;
  maxConcurrent?: number;
}

export function createPasswordService(options: PasswordServiceOptions = {}): PasswordService {
  const kdf = options.kdf ?? nodeKdf();
  const scheme = chooseScheme(kdf);
  const limiter = new Limiter(options.maxConcurrent ?? MAX_CONCURRENT_HASHES);

  async function hash(password: string): Promise<string> {
    if (scheme === 'argon2id') {
      const { memoryKiB, passes, parallelism, tagLength, saltLength } = ARGON2_PARAMS;
      const salt = randomBytes(saltLength);
      const tag = await limiter.run(() => kdf.argon2id!({ password, salt, memoryKiB, passes, parallelism, tagLength }));
      return `$argon2id$v=19$m=${memoryKiB},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
    }
    const { logN, r, p, maxmemBytes, keyLength, saltLength } = SCRYPT_PARAMS;
    const salt = randomBytes(saltLength);
    const key = await limiter.run(() => kdf.scrypt({ password, salt, N: 2 ** logN, r, p, keyLength, maxmem: maxmemBytes }));
    return `$scrypt$ln=${logN},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
  }

  /** Derives with the parameters of the string and compares in constant time. */
  async function check(password: string, parsed: Parsed): Promise<boolean> {
    if (parsed.scheme === 'argon2id') {
      if (!kdf.argon2id) throw new PasswordSchemeUnavailableError();
      const derive = kdf.argon2id;
      const tag = await limiter.run(() => derive({ password, salt: parsed.salt, memoryKiB: parsed.memoryKiB, passes: parsed.passes, parallelism: parsed.parallelism, tagLength: parsed.tag.length }));
      return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
    }
    const key = await limiter.run(() => kdf.scrypt({ password, salt: parsed.salt, N: 2 ** parsed.logN, r: parsed.r, p: parsed.p, keyLength: parsed.key.length, maxmem: SCRYPT_PARAMS.maxmemBytes }));
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  }

  let dummy: Promise<string> | undefined;
  const dummyHash = (): Promise<string> => {
    dummy ??= hash(randomBytes(24).toString('base64url')).catch((e: unknown) => {
      dummy = undefined; // a failure is not remembered
      throw e;
    });
    return dummy;
  };

  return {
    scheme,
    hash,
    async verify(password, stored) {
      const parsed = parseStored(stored);
      if (parsed) return check(password, parsed);
      // not a hash: do the work of a real verification, against the dummy, and say no
      const against = parseStored(await dummyHash());
      if (against) await check(password, against);
      return false;
    },
    dummyHash,
    stats: () => ({ inFlight: limiter.inFlight, waiting: limiter.waiting, peak: limiter.peak }),
  };
}

/** The one service of the running API: one limiter for the whole process. */
export const passwords: PasswordService = createPasswordService();

// ------------------------------------------------------------------ the rules for a new password (U9)

/**
 * A short built-in list of very common passwords of at least the minimum length (a shorter one is refused by the length rule first), in lower case; a password is looked up in lower case.
 * There is no lookup against an outside service (it would send data to a third party; O29 is closed by this rule).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password12', 'password123', 'password1234', 'password12345', 'password123456', 'password@123', 'password#123', 'password!123', 'password@1234', 'password1!', 'password1@', 'passw0rd123',
  'passw0rd1234', 'p@ssw0rd123', 'p@ssword123', 'p@ssw0rd1234', 'p@ssw0rd@123', 'p@55w0rd123', 'mypassword', 'mypassword1', 'mypassword12', 'mypassword123', 'mypassword@123', 'newpassword',
  'newpassword1', 'newpassword123', 'changeme123', 'changeme1234', 'letmein123', 'letmein1234', 'letmein12345', 'welcome123', 'welcome1234', 'welcome12345', 'welcome@123',
  'welcome@1234', 'welcome123!', 'admin12345', 'admin123456', 'admin@12345', 'admin@123456', 'administrator', 'administrator1', 'administrator123', 'superuser1', 'superadmin1', 'root123456',
  '1234567890', '12345678901', '123456789012', '1234567890123', '12345678910', '0123456789', '1029384756', '9876543210', '0987654321', '1122334455', '1234512345', '1212121212', '1231231231',
  '123123123123', '1111111111', '11111111111', '000000000000', '0000000000', '2222222222', '5555555555', '9999999999', '1q2w3e4r5t', '1q2w3e4r5t6y', '1qaz2wsx3edc', '1qazxsw23edc',
  'qwertyuiop', 'qwertyuiop1', 'qwertyuiop123', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'qwerty@123', 'qwertyuiopasdf', 'qwertyuiopasdfghjkl', 'asdfghjkl1', 'asdfghjkl123',
  'zxcvbnm123', 'zxcvbnmasdf', 'qazwsxedc123', 'abcdefghij', 'abcdefghijk', 'abcd123456', 'abcd1234567', 'abc1234567', 'abc12345678', 'abc123456789', 'abcdef1234', 'abcdef123456',
  'iloveyou12', 'iloveyou123', 'iloveyou1234', 'iloveyou@123', 'ilovemyself', 'sunshine123', 'princess123', 'football123', 'baseball123', 'superman123', 'trustno1234', 'monkey1234',
  'dragon1234', 'master1234', 'shadow1234', 'michael123', 'charlie123', 'jennifer123', 'hello12345', 'hello123456', 'helloworld', 'helloworld1', 'helloworld123', 'testtest12',
  'test123456', 'test1234567', 'testing123', 'testing1234', 'default123', 'secret1234', 'secret12345', 'login12345', 'user123456', 'guest12345', 'computer123', 'internet123', 'business123',
  'company123', 'shopkeeper1', 'jewelvault', 'jewelvault1', 'jewelvault12', 'jewelvault123', 'jewelvault@123', 'jewelry123', 'jewellery123', 'jaishri123', 'jaishri1234', 'jaishrigoldpalace',
  'jaishree123', 'goldpalace123', 'goldpalace@123', 'gold1234567', 'silver12345', 'billing123', 'billing1234', 'jaishreeram', 'jaishreeram1', 'jaishreeram123', 'jaishreekrishna',
  'radhakrishna', 'radhakrishna1', 'radhakrishna123', 'shreeganesh', 'shreeganesh1', 'ganesh1234', 'ganesh12345', 'krishna123', 'krishna1234', 'harharmahadev', 'omnamahshivay', 'omnamahshivaya',
  'ram1234567', 'sairam1234', 'india123456', 'india@12345', 'india@123456', 'indiaindia', 'bharat1234', 'mumbai12345', 'mumbai@123', 'delhi12345', 'jaipur12345', 'rajasthan123', 'rajkot12345',
]);

/** A local part shorter than this does not count in the rule below: with one or two letters it would refuse nearly every password (a clarification of U9). */
const MIN_LOCAL_PART_LENGTH = 3;

/**
 * U9. The reason a new password is refused, in words that never repeat it, or null when it is acceptable: 10 to 128 characters, not on the list of very common passwords, and not containing the part
 * of the e-mail before the @ (any letter case). Characters are counted, not bytes.
 */
export function checkNewPassword(password: string, email: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `must be at most ${PASSWORD_MAX_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'is too common: choose one that is not on the list of very common passwords';
  const at = email.indexOf('@');
  const local = (at < 0 ? '' : email.slice(0, at)).toLowerCase();
  if (local.length >= MIN_LOCAL_PART_LENGTH && lower.includes(local)) return 'must not contain the part of your email before the @';
  return null;
}
