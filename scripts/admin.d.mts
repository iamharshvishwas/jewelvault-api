export const COMMANDS: string[];
/** Everything the command talks to; the keys of the questions are token, api, email, name, role, file and sha256. */
export interface AdminIo {
  env: Record<string, string | undefined>;
  ask(key: string): Promise<string>;
  askSecret(key: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
  fetch: typeof fetch;
}
/** Runs one command of `npm run admin -- <command>` against the admin door; returns the exit code. */
export function runAdmin(argv: string[], io: AdminIo): Promise<number>;
