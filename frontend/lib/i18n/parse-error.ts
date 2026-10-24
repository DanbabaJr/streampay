/**
 * Turning a parse failure into something a user can act on.
 *
 * `parseTokenAmount` refuses rather than guesses (see amounts.ts), so every
 * rejection reason needs a message that names the separators *of the reader's
 * locale* — "use a comma here" is wrong advice in German. Keeping the mapping
 * in one function means the switch is exhaustive over `ParseFailure`, so adding
 * a reason to the parser is a compile error until it has a message.
 */

import { decimalSeparatorFor, groupingSeparatorFor, type ParseFailure } from "./amounts";
import type { Formatter } from "./format";
import type { Locale } from "./locales";

export interface ParseMessageContext {
  /** The raw text the user typed, quoted back in the ambiguous-separator case. */
  readonly input: string;
  readonly locale: Locale | string;
  /** Decimal places the target field accepts; 0 for smallest-unit fields. */
  readonly decimals: number;
}

export function describeParseFailure(
  t: Formatter,
  reason: ParseFailure,
  ctx: ParseMessageContext
): string {
  const group = groupingSeparatorFor(ctx.locale);
  switch (reason) {
    case "empty":
      return t("form.amountEmpty");
    case "invalid-character":
      return t("form.amountInvalid");
    case "negative-not-allowed":
      return t("form.amountNegative");
    case "too-precise":
      return t("form.amountTooPrecise", { decimals: ctx.decimals });
    case "bad-grouping":
      return t("form.amountGroupedOnly", { separator: group });
    case "ambiguous-separator":
      return t("form.amountAmbiguous", {
        input: ctx.input,
        group,
        decimal: decimalSeparatorFor(ctx.locale),
      });
  }
}
