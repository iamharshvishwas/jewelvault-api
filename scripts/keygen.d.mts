export const MODULUS_BITS: number;
export class KeygenError extends Error {}
/** The real path the private key will be created at; throws KeygenError for a path inside the repository, a missing folder or a file that exists. */
export function checkTarget(given: string, repo?: string): string;
/** Makes the RSA pair, writes the private key (PKCS#8 PEM, mode 0600, exclusive) to `target`; returns the one-line public key (base64 of the SPKI DER) and its SHA-256 fingerprint. */
export function generate(target: string): { publicLine: string; fingerprint: string };
export function main(argv: string[], out: (text: string) => void, err: (text: string) => void): Promise<number>;
