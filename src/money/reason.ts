// The reason a void (X4) or a cancel (X5) is given: D13 `void_reason` and D11 `cancel_reason` are VARCHAR(500) and the spec asks for at least 3 characters. Trimmed first, so "  ab " is 2 characters;
// the message never repeats the text. One definition for both (and for the reasons of the functions that follow: X10, X11).
import { z } from 'zod';

export const REASON_MIN = 3;
export const REASON_MAX = 500;
const message = `must be ${REASON_MIN} to ${REASON_MAX} characters`;

export const reasonText = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : message) })
  .trim()
  .min(REASON_MIN, message)
  .max(REASON_MAX, message);
