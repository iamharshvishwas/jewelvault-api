import type { KeyObject } from 'node:crypto';
import type { Sink } from './backup.mjs';

/** BACKUP_PUBLIC_KEY: a PEM text, the base64 of a PEM (one line), or the base64 of a DER SubjectPublicKeyInfo. */
export function loadPublicKey(value: string): KeyObject;
export interface ExportWriter {
  sink: Sink;
  /** Ends the stream, waits for the disk (fsync) and returns the sha256 (hex) and size of the encrypted bytes. */
  finish(): Promise<{ sha256: string; size: number }>;
  /** Stops and removes the partial file. */
  abort(): Promise<void>;
}
/** B2: the export as one encrypted file: container, gzip, AES-256-GCM with a fresh key wrapped by the RSA public key, written to `partialPath` (must not exist). */
export function createExportWriter(partialPath: string, publicKey: KeyObject): Promise<ExportWriter>;
/** Decrypts an export file with the private key (PEM text or KeyObject) and writes manifest.json and data/<table>.ndjson under outDir. Throws on a wrong key, a changed or truncated file. */
export function unpackExport(encPath: string, privateKey: string | Buffer | KeyObject, outDir: string): Promise<{ name: string; size: number }[]>;
