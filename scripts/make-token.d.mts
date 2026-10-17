export const VARIABLES: Readonly<{ admin: 'JV_ADMIN_TOKEN_HASH'; job: 'JV_JOB_TOKEN_HASH' }>;
/** The SHA-256 of the token's text, in hex: what JV_ADMIN_TOKEN_HASH and JV_JOB_TOKEN_HASH hold. */
export function hashToken(token: string): string;
/** A new random token (43 base64url characters) and its hash. */
export function makeToken(): { token: string; hash: string };
/** Prints a token and its hash; returns the exit code. */
export function main(argv: string[], out: (text: string) => void, err: (text: string) => void): number;
