import { createHmac, randomBytes } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  COMMON_PASSWORDS,
  type Kdf,
  MAX_CONCURRENT_HASHES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordSchemeUnavailableError,
  SCRYPT_PARAMS,
  checkNewPassword,
  chooseScheme,
  createPasswordService,
  nodeKdf,
} from '../../src/auth/password';
import { secret } from './support';

// T-D25 (U1, U9): the password side of the login test. The HTTP side (cookie, new ticket, same answer for a wrong e-mail and a wrong password) is tests/api/auth.test.ts.
//
// crypto.argon2 exists from Node 24.7. This machine's Node may be older (the repository says >=24.7), so the code behind the password service has two paths: Argon2id where crypto.argon2 exists and
// the scrypt fallback of U1 where it does not. The tests below prove BOTH: the scrypt path with Node's real scrypt, the Argon2id path with an injected stand-in for the primitive (the string format,
// the parameters, the verification, the choice between the two) and, on a Node that has crypto.argon2, with the real primitive too (the last block, skipped with its reason on an older Node).

const nodeHasArgon2 = typeof (nodeCrypto as { argon2?: unknown }).argon2 === 'function';
const scryptAsync = promisify(nodeCrypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: nodeCrypto.ScryptOptions) => Promise<Buffer>;

/** A stand-in for the Argon2id primitive: deterministic, keyed by the salt, and it remembers what it was asked. */
function fakeArgon2() {
  const calls: { memoryKiB: number; passes: number; parallelism: number; tagLength: number; saltBytes: number }[] = [];
  const argon2id: NonNullable<Kdf['argon2id']> = async (input) => {
    calls.push({ memoryKiB: input.memoryKiB, passes: input.passes, parallelism: input.parallelism, tagLength: input.tagLength, saltBytes: input.salt.length });
    return createHmac('sha256', input.salt).update(input.password).digest().subarray(0, input.tagLength);
  };
  return { calls, argon2id };
}

const realScrypt = (): Kdf['scrypt'] => nodeKdf().scrypt;

describe('T-D25 passwords: the rules of U9 (10 to 128 characters, a short list of very common passwords, not the part of the e-mail before the @)', () => {
  const email = 'jaishri.counter@example.test';
  const good = () => secret('Gd9!').slice(0, 24);

  it('9 characters are refused, 10 are accepted, 128 are accepted, 129 are refused', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    const base = randomBytes(120).toString('base64url'); // 160 characters
    expect(checkNewPassword(base.slice(0, 9), email)).toMatch(/at least 10/);
    expect(checkNewPassword(base.slice(0, 10), email)).toBeNull();
    expect(checkNewPassword(base.slice(0, 128), email)).toBeNull();
    expect(checkNewPassword(base.slice(0, 129), email)).toMatch(/at most 128/);
    expect(checkNewPassword('', email)).toMatch(/at least 10/);
  });

  it('length counts characters, not bytes (ten letters with accents are ten)', () => {
    expect(checkNewPassword('éééééééééé', email)).toBeNull();
    expect(checkNewPassword('ééééééééé', email)).toMatch(/at least 10/);
  });

  it('every password on the built-in list is refused, in any letter case; the list is short and holds nothing the length rule refuses anyway', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(50);
    expect(COMMON_PASSWORDS.size).toBeLessThanOrEqual(500);
    for (const p of COMMON_PASSWORDS) {
      expect(p.length, p).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH); // a shorter entry is dead weight: the length rule refuses it first
      expect(p, p).toBe(p.toLowerCase());
      expect(checkNewPassword(p, email), p).toMatch(/too common/);
      expect(checkNewPassword(p.toUpperCase(), email), `${p} upper`).toMatch(/too common/);
    }
  });

  it('a password that contains the part of the e-mail before the @ is refused, in any letter case, at the start, in the middle or at the end', () => {
    const pad = randomBytes(8).toString('hex');
    for (const p of [`jaishri.counter${pad}`, `${pad}JAISHRI.counter${pad}`, `${pad}Jaishri.Counter`]) expect(checkNewPassword(p, email), p).toMatch(/e-?mail/i);
    // control: the same shape without the local part passes
    expect(checkNewPassword(`${pad}${pad}`, email)).toBeNull();
    expect(checkNewPassword(`jaishri${pad}`, email)).toBeNull(); // only part of it
  });

  it('a local part of fewer than 3 characters does not count (it would refuse nearly every password): documented clarification of U9', () => {
    expect(checkNewPassword(`xx-ab-${randomBytes(8).toString('hex')}`, 'ab@example.test')).toBeNull();
    expect(checkNewPassword(`xx-abc-${randomBytes(8).toString('hex')}`, 'abc@example.test')).toMatch(/e-?mail/i);
  });

  it('a made-up good password passes (control)', () => {
    expect(checkNewPassword(good(), email)).toBeNull();
  });

  it('the answers never repeat the password', () => {
    const p = `jaishri.counter-${randomBytes(6).toString('hex')}`;
    expect(checkNewPassword(p, email)).not.toContain(p);
  });
});

describe('T-D25 password hashes: a self-describing string, Argon2id where crypto.argon2 exists and the scrypt fallback where it does not', () => {
  it('the numbers of U1: Argon2id 64 MiB, 3 passes, parallelism 1; scrypt N=2^17, r=8, p=1 with maxmem 256 MiB; at most 2 hashes at once', () => {
    expect(ARGON2_PARAMS).toMatchObject({ memoryKiB: 64 * 1024, passes: 3, parallelism: 1 });
    expect(SCRYPT_PARAMS).toMatchObject({ logN: 17, r: 8, p: 1, maxmemBytes: 256 * 1024 * 1024 });
    expect(MAX_CONCURRENT_HASHES).toBe(2);
  });

  it('the choice: Argon2id when the primitive is there, scrypt when it is not; Node reports its own primitive honestly', () => {
    const fake = fakeArgon2();
    expect(chooseScheme({ argon2id: fake.argon2id, scrypt: realScrypt() })).toBe('argon2id');
    expect(chooseScheme({ argon2id: null, scrypt: realScrypt() })).toBe('scrypt');
    expect(typeof nodeKdf().argon2id).toBe(nodeHasArgon2 ? 'function' : 'object'); // null on an older Node
    expect(chooseScheme(nodeKdf())).toBe(nodeHasArgon2 ? 'argon2id' : 'scrypt');
    expect(createPasswordService().scheme).toBe(nodeHasArgon2 ? 'argon2id' : 'scrypt');
  });

  it('the Argon2id path (stand-in primitive): the stored string is $argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>, the primitive gets 64 MiB, 3 passes, 1 lane, a 16-byte salt, a 32-byte tag', async () => {
    const fake = fakeArgon2();
    const service = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    expect(service.scheme).toBe('argon2id');
    const pw = secret('pw');
    const stored = await service.hash(pw);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(fake.calls).toEqual([{ memoryKiB: 65536, passes: 3, parallelism: 1, tagLength: 32, saltBytes: 16 }]);
    expect(stored).not.toContain(pw);
    expect(await service.verify(pw, stored)).toBe(true);
    expect(await service.verify(`${pw}x`, stored)).toBe(false);
    // a new salt every time
    expect(await service.hash(pw)).not.toBe(stored);
  });

  it('a string made with other parameters verifies with ITS parameters (they are in the string, so they can be raised later)', async () => {
    const fake = fakeArgon2();
    const service = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    const pw = secret('pw');
    const salt = randomBytes(16);
    const tag = createHmac('sha256', salt).update(pw).digest();
    const old = `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`;
    fake.calls.length = 0;
    expect(await service.verify(pw, old)).toBe(true);
    expect(fake.calls).toEqual([{ memoryKiB: 19456, passes: 2, parallelism: 1, tagLength: 32, saltBytes: 16 }]);
  });

  it('the scrypt fallback (Node real scrypt): $scrypt$ln=17,r=8,p=1$<salt>$<key>, hashes and verifies a password with maxmem 256 MiB', async () => {
    const service = createPasswordService({ kdf: { argon2id: null, scrypt: realScrypt() } });
    expect(service.scheme).toBe('scrypt');
    const pw = secret('pw');
    const stored = await service.hash(pw);
    expect(stored).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(stored).not.toContain(pw);
    expect(await service.verify(pw, stored)).toBe(true);
    expect(await service.verify(`${pw}x`, stored)).toBe(false);
  }, 30_000);

  it('maxmem: scrypt N=2^17, r=8 works with 256 MiB, and a maxmem of exactly 128 MiB (134,217,728) fails, which is why the number is not 128 (U1); Node default of 32 MiB fails too', async () => {
    const salt = randomBytes(16);
    const pw = secret('pw');
    const key = await scryptAsync(pw, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    expect(key.length).toBe(32);
    await expect(scryptAsync(pw, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })).rejects.toThrow(/memory limit|maxmem|Invalid scrypt/i);
    await expect(scryptAsync(pw, salt, 32, { N: 2 ** 17, r: 8, p: 1 })).rejects.toThrow(/memory limit|maxmem|Invalid scrypt/i);
    // the service's own scrypt is the one with 256 MiB: it gives the same key as the direct call above
    const viaService = await realScrypt()({ password: pw, salt, N: 2 ** 17, r: 8, p: 1, keyLength: 32, maxmem: SCRYPT_PARAMS.maxmemBytes });
    expect(viaService.equals(key)).toBe(true);
  }, 30_000);

  it('the same service verifies a scrypt string while it hashes with Argon2id (a hash made on the old Node still works after the move to Node 24)', async () => {
    const old = createPasswordService({ kdf: { argon2id: null, scrypt: realScrypt() } });
    const pw = secret('pw');
    const stored = await old.hash(pw);
    const fake = fakeArgon2();
    const now = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    expect(await now.verify(pw, stored)).toBe(true);
    expect(await now.verify(`${pw}x`, stored)).toBe(false);
    expect(fake.calls).toEqual([]);
  }, 30_000);

  it('an Argon2id string on a Node without crypto.argon2 is not "a wrong password": it throws, loudly, and says why', async () => {
    const fake = fakeArgon2();
    const made = await createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } }).hash(secret('pw'));
    const without = createPasswordService({ kdf: { argon2id: null, scrypt: realScrypt() } });
    await expect(without.verify(secret('pw'), made)).rejects.toBeInstanceOf(PasswordSchemeUnavailableError);
    await expect(without.verify(secret('pw'), made)).rejects.toThrow(/crypto\.argon2/);
  });

  it('a stored value that is not a hash at all is a wrong password, not a crash, and it costs the same work as a real one (one dummy verification)', async () => {
    const fake = fakeArgon2();
    const service = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    await service.dummyHash();
    fake.calls.length = 0;
    for (const junk of ['', 'not-a-hash', '$argon2id$v=19$m=x,t=3,p=1$AAAA$BBBB', '$argon2id$v=19$m=65536,t=3,p=1$only-three', '$scrypt$ln=99,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA', '$bcrypt$12$abc']) {
      expect(await service.verify(secret('pw'), junk), junk).toBe(false);
    }
    expect(fake.calls.length).toBe(6); // one derivation each, never zero: the time does not say "no such hash"
  });

  it('the stored parameters are bounded: a string that asks for a gigabyte-sized hash is refused, not run', async () => {
    const fake = fakeArgon2();
    const service = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    await service.dummyHash();
    fake.calls.length = 0;
    const huge = `$argon2id$v=19$m=4194304,t=3,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`;
    expect(await service.verify(secret('pw'), huge)).toBe(false);
    expect(fake.calls.every((c) => c.memoryKiB <= 1024 * 1024)).toBe(true);
  });

  it('the dummy hash for an unknown e-mail is made once, in the current scheme, and one verification of it does the work of one real verification', async () => {
    const fake = fakeArgon2();
    const service = createPasswordService({ kdf: { argon2id: fake.argon2id, scrypt: realScrypt() } });
    const dummy = await service.dummyHash();
    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await service.dummyHash()).toBe(dummy);
    expect(fake.calls.length).toBe(1);
    expect(await service.verify(secret('pw'), dummy)).toBe(false); // nobody knows its password
    expect(fake.calls.length).toBe(2);
  });
});

describe('T-D25 at most 2 hashes run at the same time', () => {
  /** A primitive that takes a moment and counts how many are running. */
  function slowPrimitive() {
    const state = { running: 0, peak: 0, total: 0 };
    const run = async (length: number) => {
      state.running++;
      state.total++;
      state.peak = Math.max(state.peak, state.running);
      await new Promise((r) => setTimeout(r, 20));
      state.running--;
      return Buffer.alloc(length, 7);
    };
    const kdf: Kdf = { argon2id: null, scrypt: (i) => run(i.keyLength) };
    return { state, kdf };
  }

  it('twelve verifications started together never run more than two at once, and all of them finish', async () => {
    const { state, kdf } = slowPrimitive();
    const service = createPasswordService({ kdf });
    const stored = await service.hash(secret('pw'));
    state.peak = 0;
    const results = await Promise.all(Array.from({ length: 12 }, () => service.verify(secret('pw'), stored)));
    expect(results.every((r) => r === true)).toBe(true); // the stand-in derives the same key for everything
    expect(state.peak).toBe(2);
    expect(service.stats()).toMatchObject({ inFlight: 0, waiting: 0, peak: 2 });
  });

  it('control: with the limit raised to 5 the same twelve do run more than two at once (the test can see a breach)', async () => {
    const { state, kdf } = slowPrimitive();
    const service = createPasswordService({ kdf, maxConcurrent: 5 });
    const stored = await service.hash(secret('pw'));
    state.peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => service.verify(secret('pw'), stored)));
    expect(state.peak).toBeGreaterThan(2);
    expect(state.peak).toBeLessThanOrEqual(5);
  });

  it('a primitive that fails gives its place back (the next hash still runs)', async () => {
    let fail = true;
    const kdf: Kdf = {
      argon2id: null,
      scrypt: async (i) => {
        if (fail) throw new Error('boom');
        return Buffer.alloc(i.keyLength, 1);
      },
    };
    const service = createPasswordService({ kdf, maxConcurrent: 1 });
    await expect(service.hash(secret('pw'))).rejects.toThrow('boom');
    await expect(service.hash(secret('pw'))).rejects.toThrow('boom');
    fail = false;
    expect(await service.hash(secret('pw'))).toMatch(/^\$scrypt\$/);
    expect(service.stats()).toMatchObject({ inFlight: 0, waiting: 0 });
  });
});

describe.skipIf(!nodeHasArgon2)('T-D25 the real crypto.argon2 of Node 24.7+ (SKIPPED on a Node older than 24.7: crypto.argon2 does not exist there; run this on the plan\'s Node)', () => {
  it('the primitive is Argon2id version 1.3: the known-answer vector of RFC 9106 section 5.3', () => {
    const tag = (nodeCrypto as unknown as { argon2Sync: (a: string, p: object) => Buffer }).argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('the wrapper hands the primitive 64 MiB, 3 passes and 1 lane: it gives what a direct call with those numbers gives', async () => {
    const salt = randomBytes(16);
    const pw = secret('pw');
    const viaWrapper = await nodeKdf().argon2id!({ password: pw, salt, memoryKiB: 65536, passes: 3, parallelism: 1, tagLength: 32 });
    const direct = (nodeCrypto as unknown as { argon2Sync: (a: string, p: object) => Buffer }).argon2Sync('argon2id', { message: pw, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 });
    expect(viaWrapper.equals(direct)).toBe(true);
  }, 30_000);

  it('the default service makes a self-describing Argon2id string and verifies it', async () => {
    const service = createPasswordService();
    expect(service.scheme).toBe('argon2id');
    const pw = secret('pw');
    const stored = await service.hash(pw);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await service.verify(pw, stored)).toBe(true);
    expect(await service.verify(`${pw}x`, stored)).toBe(false);
  }, 30_000);
});
