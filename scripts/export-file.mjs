// B2: the export as ONE encrypted file. The files of exportDatabase (manifest.json and data/<table>.ndjson) are written one after the other into a single stream:
//
//   container frames  ->  gzip  ->  AES-256-GCM (a fresh key per file, wrapped with the RSA public key)  ->  sha256 and size counted  ->  <name>.partial, flushed to disk
//
// so there is no separate spool and the folder holds nothing but complete files and `.partial` ones (the sweep removes those, backup-folder.mjs). The private key is held by Harsh and by
// the owner and is never on the server (O40); only unpackExport (the restore tool on the Mac, the drill) needs it.
//
// File layout (all numbers big-endian):
//   "JVE1" | wrappedKeyLength u16 | wrappedKey (RSA-OAEP, SHA-256, of the 32-byte AES key) | iv 12 bytes | AES-256-GCM ciphertext | tag 16 bytes
//   The header (everything before the ciphertext) is the GCM additional data, so a changed wrapped key or iv fails the tag.
// Plaintext of the ciphertext, after gunzip:
//   "JVC1" then frames: type u8 | length u32 | payload.  1 = begin file (utf-8 path), 2 = data, 3 = end file, 4 = end of export (a stream without it is truncated).
//
// GCM only vouches for the data at the very end: unpackExport writes into the folder it is given and throws if the tag, the framing or the end frame is wrong, so the caller must treat
// the folder as unusable unless unpackExport returned.

import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const MAGIC_FILE = Buffer.from('JVE1');
const MAGIC_CONTAINER = Buffer.from('JVC1');
const TAG_BYTES = 16;
const IV_BYTES = 12;
const MAX_FRAME = 256 * 1024;
const F_BEGIN = 1;
const F_DATA = 2;
const F_END_FILE = 3;
const F_END = 4;
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

/** The public key from the environment variable BACKUP_PUBLIC_KEY: a PEM text, the base64 of a PEM (one line, as NODE-DESIGN.md asks), or the base64 of a DER SubjectPublicKeyInfo. */
export function loadPublicKey(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('the backup public key is missing');
  const pem = text.includes('-----BEGIN') ? text : Buffer.from(text, 'base64').toString('utf8');
  try {
    if (pem.includes('-----BEGIN')) return createPublicKey(pem);
    return createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
  } catch (e) {
    throw new Error(`the backup public key cannot be read: ${e.message}`);
  }
}

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const frame = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

function encryptStream(publicKey) {
  const key = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const wrapped = publicEncrypt({ key: publicKey, ...OAEP }, key);
  const header = Buffer.concat([MAGIC_FILE, u16(wrapped.length), wrapped, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        started = true;
        this.push(header);
      }
      const out = cipher.update(chunk);
      if (out.length) this.push(out);
      cb();
    },
    flush(cb) {
      if (!started) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/** A Writable that writes to a FileHandle, flushes it to disk (fsync) when the stream ends, and closes it; a failed or destroyed stream closes it too. */
function fileSink(handle) {
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  return new Writable({
    async write(chunk, _enc, cb) {
      try {
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        cb();
      } catch (e) {
        cb(e);
      }
    },
    async final(cb) {
      try {
        await handle.sync();
        await close();
        cb();
      } catch (e) {
        cb(e);
      }
    },
    destroy(err, cb) {
      close().then(() => cb(err), () => cb(err));
    },
  });
}

/**
 * Starts the export file at `partialPath` (created new: an existing path is an error) and returns a Sink for exportDatabase. finish() ends the stream, waits for the disk
 * (fsync) and returns { sha256, size } of the encrypted bytes, which is what the folder will hold. abort() removes the partial file.
 */
export async function createExportWriter(partialPath, publicKey) {
  const handle = await open(partialPath, 'wx');
  const plain = new PassThrough();
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const done = pipeline(plain, createGzip(), encryptStream(publicKey), counter, fileSink(handle));
  let failure = null;
  done.catch((e) => {
    failure = e;
  });
  const write = async (buffer) => {
    if (failure) throw failure;
    if (!plain.write(buffer)) await Promise.race([once(plain, 'drain'), done]);
    if (failure) throw failure;
  };
  await write(MAGIC_CONTAINER);
  let open_ = false;
  let finished = false;
  const sink = {
    file(p) {
      if (open_) throw new Error('one export file is written at a time');
      if (finished) throw new Error('the export is finished');
      open_ = true;
      let begun = false;
      const begin = async () => {
        if (!begun) {
          begun = true;
          await write(frame(F_BEGIN, Buffer.from(p, 'utf8')));
        }
      };
      return {
        write: async (chunk) => {
          await begin();
          const bytes = Buffer.from(chunk, 'utf8');
          for (let i = 0; i < bytes.length; i += MAX_FRAME) await write(frame(F_DATA, bytes.subarray(i, i + MAX_FRAME)));
        },
        close: async () => {
          await begin();
          await write(frame(F_END_FILE));
          open_ = false;
        },
      };
    },
  };
  return {
    sink,
    async finish() {
      if (open_) throw new Error('an export file is still open');
      finished = true;
      await write(frame(F_END));
      plain.end();
      await done; // returns after the last byte was written, flushed to disk (fsync) and the file closed
      return { sha256: hash.digest('hex'), size };
    },
    async abort() {
      finished = true;
      plain.destroy();
      await done.catch(() => undefined);
      await unlink(partialPath).catch(() => undefined);
    },
  };
}

function decryptStream(privateKey) {
  let head = Buffer.alloc(0);
  let decipher = null;
  let held = Buffer.alloc(0);
  let header = null;
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, data]);
          if (head.length < 6) return cb();
          if (!head.subarray(0, 4).equals(MAGIC_FILE)) throw new Error('not an export file (wrong magic)');
          const wrappedLength = head.readUInt16BE(4);
          const total = 6 + wrappedLength + IV_BYTES;
          if (head.length < total) return cb();
          header = head.subarray(0, total);
          let key;
          try {
            key = privateDecrypt({ key: privateKey, ...OAEP }, head.subarray(6, 6 + wrappedLength));
          } catch {
            throw new Error('the file key cannot be unwrapped: this is not the private key of the export, or the file header was changed');
          }
          decipher = createDecipheriv('aes-256-gcm', key, head.subarray(6 + wrappedLength, total));
          decipher.setAAD(header);
          data = head.subarray(total);
          head = null;
        }
        const all = Buffer.concat([held, data]);
        const usable = Math.max(0, all.length - TAG_BYTES);
        held = all.subarray(usable);
        if (usable > 0) this.push(decipher.update(all.subarray(0, usable)));
        cb();
      } catch (e) {
        cb(e);
      }
    },
    flush(cb) {
      try {
        if (!decipher) throw new Error('the export file is truncated (no header)');
        if (held.length !== TAG_BYTES) throw new Error('the export file is truncated (no authentication tag)');
        decipher.setAuthTag(held);
        this.push(decipher.final());
        cb();
      } catch (e) {
        cb(e.message.includes('unable to authenticate') ? new Error('the export file is damaged or was changed (authentication failed)') : e);
      }
    },
  });
}

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function unpackWriter(outDir) {
  let buf = Buffer.alloc(0);
  let sawMagic = false;
  let current = null;
  let ended = false;
  const files = [];
  const handle = async (type, payload) => {
    if (ended) throw new Error('data after the end of the export');
    if (type === F_BEGIN) {
      if (current) throw new Error('a file begins before the last one ended');
      const name = payload.toString('utf8');
      if (!SAFE_PATH.test(name) || name.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error(`unsafe path in the export: ${JSON.stringify(name)}`);
      const full = path.join(outDir, name);
      mkdirSync(path.dirname(full), { recursive: true });
      current = { name, handle: await open(full, 'wx'), size: 0 };
    } else if (type === F_DATA) {
      if (!current) throw new Error('data outside a file');
      await current.handle.write(payload);
      current.size += payload.length;
    } else if (type === F_END_FILE) {
      if (!current) throw new Error('end of a file that did not begin');
      await current.handle.close();
      files.push({ name: current.name, size: current.size });
      current = null;
    } else if (type === F_END) {
      if (current) throw new Error('the export ended inside a file');
      ended = true;
    } else throw new Error(`unknown frame type ${type}`);
  };
  const writable = new Writable({
    async write(chunk, _enc, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (!sawMagic) {
          if (buf.length < 4) return cb();
          if (!buf.subarray(0, 4).equals(MAGIC_CONTAINER)) throw new Error('not an export (wrong container magic)');
          sawMagic = true;
          buf = buf.subarray(4);
        }
        while (buf.length >= 5) {
          const length = buf.readUInt32BE(1);
          if (length > MAX_FRAME) throw new Error('a frame is larger than any this tool writes');
          if (buf.length < 5 + length) break;
          const type = buf.readUInt8(0);
          const payload = buf.subarray(5, 5 + length);
          buf = buf.subarray(5 + length);
          await handle(type, payload);
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
    async final(cb) {
      try {
        if (current) await current.handle.close().catch(() => undefined);
        if (!ended) throw new Error('the export is truncated (no end frame)');
        if (buf.length > 0) throw new Error('trailing bytes after the last frame');
        cb();
      } catch (e) {
        cb(e);
      }
    },
  });
  return { writable, files };
}

/**
 * Decrypts `encPath` with the private key (a PEM text or a KeyObject) and writes its files under `outDir` (data/<table>.ndjson and manifest.json, the layout directoryStore reads).
 * Throws on a wrong key, a changed byte, a truncated file or an unsafe path; after a throw the folder holds partial data and must be thrown away.
 */
export async function unpackExport(encPath, privateKey, outDir) {
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  mkdirSync(outDir, { recursive: true });
  const { writable, files } = unpackWriter(outDir);
  try {
    await pipeline(createReadStream(encPath), decryptStream(key), createGunzip(), writable);
  } catch (e) {
    throw new Error(`cannot unpack the export: ${e.message}`, { cause: e });
  }
  return files;
}
