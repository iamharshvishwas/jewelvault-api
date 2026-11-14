// The reason a void (X4), a cancel (X5) or a re-issue (X10) is given: D13 `void_reason` and D11 `cancel_reason` are VARCHAR(500). One definition for the three.
// FB-D1 (Siddhi's feedback of 6 Nov 2026, #3): the reason is OPTIONAL. A missing, empty or blank reason is stored as the text `No reason given`, so the column is never empty and the books still say
// that nobody gave one. A reason that is typed keeps the old rule: trimmed first (so "  ab " is 2 characters), then 3 to 500 characters; the message never repeats the text. Anything that is not
// text (a number, null) is still refused.
import { z } from 'zod';

export const REASON_MIN = 3;
export const REASON_MAX = 500;
/** What is stored when no reason is given (FB-D1). */
export const NO_REASON_GIVEN = 'No reason given';
const message = `must be ${REASON_MIN} to ${REASON_MAX} characters`;

export const reasonText = z
  .string({ error: () => message })
  .optional()
  .transform((input, ctx) => {
    const trimmed = (input ?? '').trim();
    if (trimmed === '') return NO_REASON_GIVEN;
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return trimmed;
  });
