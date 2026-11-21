/**
 * Rules, mapping and valid-input tests for `lib/stream-validation.ts`.
 *
 * Every client-side rule in the issue, the server-error→field mapping for
 * every creation-relevant contract code, and the proof that a valid form
 * still validates clean (the submit path itself is covered by the
 * `Submitting` story, which asserts `onCreate` is called with the unchanged
 * values).
 */

import { describe, expect, it } from "vitest";

import {
  openPolicy,
  RECIPIENT,
  strictPolicy,
  TOKEN_CONTRACT,
} from "../.storybook/fixtures";
import { makeFormatter } from "./i18n/format";
import type { StreamPolicyView } from "./stream-types";
import {
  durationSeconds,
  mapCreationErrorToField,
  validateBatchCsv,
  validateDeposit,
  validateRecipientAddress,
  validateStreamForm,
  validateTokenContractId,
  type CreationContext,
  type ValidationOptions,
} from "./stream-validation";

const tEn = makeFormatter("en");
const tDe = makeFormatter("de");

/** `RECIPIENT` with the last character swapped: still base32, bad checksum. */
const BAD_CHECKSUM_RECIPIENT = `${RECIPIENT.slice(0, -1)}V`;
const BAD_CHECKSUM_TOKEN = `${TOKEN_CONTRACT.slice(0, -1)}V`;

function options(policy: StreamPolicyView | null = openPolicy): ValidationOptions {
  return {
    locale: "en",
    t: tEn,
    policy,
    decimals: 7,
    formatToken: (raw) => raw.toString(),
  };
}

function contractError(code: number): Error {
  return new Error(`simulation failed: Error(Contract, #${code})`);
}

describe("validateRecipientAddress", () => {
  it("requires an address", () => {
    expect(validateRecipientAddress("", tEn)).toBe("Enter a recipient address.");
    expect(validateRecipientAddress("   ", tEn)).toBe("Enter a recipient address.");
  });

  it("rejects a bad checksum instead of a mistyped prefix", () => {
    expect(validateRecipientAddress(BAD_CHECKSUM_RECIPIENT, tEn)).toBe(
      "Enter a valid Stellar address (G… with a valid checksum)."
    );
    expect(validateRecipientAddress("not-an-address", tEn)).toBe(
      "Enter a valid Stellar address (G… with a valid checksum)."
    );
  });

  it("accepts a checksummed address, in both locales", () => {
    expect(validateRecipientAddress(RECIPIENT, tEn)).toBeNull();
    expect(validateRecipientAddress(RECIPIENT, tDe)).toBeNull();
    expect(validateRecipientAddress("", tDe)).toBe("Gib eine Empfängeradresse ein.");
  });
});

describe("validateTokenContractId", () => {
  it("requires a contract id and checks its checksum", () => {
    expect(validateTokenContractId("", tEn)).toBe("Enter a token contract id.");
    expect(validateTokenContractId(BAD_CHECKSUM_TOKEN, tEn)).toBe(
      "Enter a valid token contract id (C… with a valid checksum)."
    );
    expect(validateTokenContractId(TOKEN_CONTRACT, tEn)).toBeNull();
  });
});

describe("durationSeconds", () => {
  it("converts days to seconds", () => {
    expect(durationSeconds("30", openPolicy, tEn)).toEqual({
      seconds: 2_592_000n,
      issue: null,
    });
  });

  it("rejects empty, non-numeric and non-positive durations", () => {
    for (const days of ["", "abc", "0", "-5", "0.0"]) {
      expect(durationSeconds(days, openPolicy, tEn).issue?.message).toBe(
        "Enter a duration in days greater than zero (up to 36,500 days)."
      );
    }
  });

  it("rejects durations past the shared days cap", () => {
    expect(durationSeconds("36501", openPolicy, tEn).issue?.field).toBe("duration");
  });

  it("enforces the policy duration floor and ceiling", () => {
    expect(durationSeconds("3", strictPolicy, tEn).issue?.message).toContain(
      "below the governance floor"
    );
    expect(durationSeconds("400", strictPolicy, tEn).issue?.message).toContain(
      "exceeds the governance ceiling"
    );
    expect(durationSeconds("30", strictPolicy, tEn).issue).toBeNull();
  });
});

describe("validateDeposit", () => {
  it("refuses fractions in the smallest-unit field instead of rounding", () => {
    const issue = validateDeposit("12.5", 2_592_000n, options());
    expect(issue?.field).toBe("deposit");
    expect(issue?.message).toContain("decimal places");
  });

  it("rejects empty and non-positive deposits", () => {
    expect(validateDeposit("", 2_592_000n, options())?.message).toBe("Enter an amount.");
    expect(validateDeposit("0", 2_592_000n, options())?.message).toBe(
      "The amount must be greater than zero."
    );
  });

  it("enforces the policy deposit floor", () => {
    const issue = validateDeposit("1000000000", 2_592_000n, options(strictPolicy));
    expect(issue?.field).toBe("deposit");
    expect(issue?.message).toContain("below the governance policy floor");
  });

  it("requires the deposit to fund at least one smallest unit per second", () => {
    const issue = validateDeposit("100", 2_592_000n, options());
    expect(issue?.field).toBe("deposit");
    expect(issue?.message).toContain("too small for this duration");
    expect(issue?.message).toContain("2592000");
  });

  it("enforces the policy rate floor from the derived rate", () => {
    // 10,000,000,000 stroops over 3,153,600,000s accrues 3/s < floor 100/s.
    const issue = validateDeposit("10000000000", 3_153_600_000n, options(strictPolicy));
    expect(issue?.field).toBe("deposit");
    expect(issue?.message).toContain("below the governance policy floor");
  });

  it("rejects a deposit that would overflow u128 capacity", () => {
    const huge = (1n << 128n) - 1n;
    const issue = validateDeposit(huge.toString(), 2n, options());
    expect(issue?.message).toContain("too large for this duration");
  });
});

describe("validateStreamForm", () => {
  const valid = {
    asset: "native" as const,
    token: "",
    recipient: RECIPIENT,
    deposit: "1000000000",
    days: "30",
  };

  it("accepts the default valid form unchanged", () => {
    expect(validateStreamForm(valid, options())).toEqual([]);
  });

  it("reports one issue per field, in field order", () => {
    const issues = validateStreamForm(
      { asset: "contract", token: "bogus", recipient: "", deposit: "12.5", days: "0" },
      options()
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "token",
      "recipient",
      "deposit",
      "duration",
    ]);
  });

  it("skips the token field for native XLM", () => {
    expect(
      validateStreamForm({ ...valid, token: "bogus" }, options()).map((i) => i.field)
    ).not.toContain("token");
  });

  it("maps the strict policy deposit floor to the deposit field", () => {
    const issues = validateStreamForm(valid, options(strictPolicy));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("deposit");
  });
});

describe("validateBatchCsv", () => {
  const header = "address,rate,duration";
  const validCsv = `${header}\n${RECIPIENT},1000,2592000`;

  it("accepts a valid batch", () => {
    expect(validateBatchCsv(validCsv, options())).toBeNull();
  });

  it("keeps the parser's row-named syntax errors on the csv field", () => {
    const issue = validateBatchCsv(`${RECIPIENT},10.5,600`, options());
    expect(issue?.field).toBe("csv");
    expect(issue?.message).toMatch(/whole numbers/);
  });

  it("rejects a batch over the contract's MAX_BATCH", () => {
    const rows = Array.from({ length: 26 }, () => `${RECIPIENT},1000,2592000`);
    const issue = validateBatchCsv(`${header}\n${rows.join("\n")}`, options());
    expect(issue?.field).toBe("csv");
    expect(issue?.message).toBe("The batch has too many rows (maximum 25).");
  });

  it("names the row with a bad recipient checksum", () => {
    const issue = validateBatchCsv(
      `${header}\n${RECIPIENT},1000,2592000\n${BAD_CHECKSUM_RECIPIENT},1000,2592000`,
      options()
    );
    expect(issue?.field).toBe("csv");
    expect(issue?.message).toMatch(/^Row 3: Enter a valid Stellar address/);
  });

  it("rejects a row duration over the 100-year protocol cap", () => {
    const issue = validateBatchCsv(`${RECIPIENT},1,3155760001`, options());
    expect(issue?.message).toMatch(/100-year stream limit/);
  });

  it("enforces the policy duration floor per row", () => {
    const issue = validateBatchCsv(`${RECIPIENT},1000,3600`, options(strictPolicy));
    expect(issue?.field).toBe("csv");
    expect(issue?.message).toMatch(/^Row 1: Duration \(3,600s\) is below the governance floor/);
  });

  it("reports the German row message under the de locale", () => {
    const issue = validateBatchCsv(
      `${header}\n${RECIPIENT},1000,2592000\n${BAD_CHECKSUM_RECIPIENT},1000,2592000`,
      { ...options(), t: tDe, locale: "de" }
    );
    expect(issue?.message).toMatch(/^Zeile 3: Gib eine gültige Stellar-Adresse ein/);
  });
});

describe("mapCreationErrorToField", () => {
  const single: CreationContext = {
    kind: "single",
    deposit: 1_000_000_000n,
    durationSeconds: 2_592_000n,
    policy: strictPolicy,
    decimals: 7,
    formatToken: (raw) => raw.toString(),
  };

  it.each([
    [9, "deposit"],
    [8, "duration"],
    [11, "deposit"],
    [26, "deposit"],
    [28, "recipient"],
    [31, "token"],
    [42, "deposit"],
    [43, "deposit"],
    [44, "duration"],
    [45, "duration"],
    [46, "deposit"],
  ])("maps contract error #%d to the %s field", (code, field) => {
    const mapped = mapCreationErrorToField(contractError(code), tEn, single);
    expect(mapped.field).toBe(field);
    expect(mapped.message.length).toBeGreaterThan(0);
  });

  it("renders the policy rate message with the derived rate", () => {
    const mapped = mapCreationErrorToField(contractError(42), tEn, single);
    expect(mapped.message).toContain("below the governance policy floor");
    expect(mapped.message).toContain("385");
  });

  it("maps batch codes to the csv field for batch submissions", () => {
    expect(mapCreationErrorToField(contractError(47), tEn, { kind: "batch" }).field).toBe(
      "csv"
    );
    expect(
      mapCreationErrorToField(contractError(48), tEn, { kind: "batch" }).message
    ).toBe("The batch has too many rows (maximum 25).");
  });

  it("leaves unmapped rejections form-level with the catalog remediation", () => {
    const mapped = mapCreationErrorToField(contractError(36), tEn, single);
    expect(mapped.field).toBeNull();
    expect(mapped.message).toContain("ContractFrozen");
  });

  it("leaves non-contract failures form-level with the original message", () => {
    const mapped = mapCreationErrorToField(new Error("network down"), tEn, single);
    expect(mapped).toEqual({ field: null, message: "network down" });
  });

  it("falls back to form-level when the policy never loaded", () => {
    const mapped = mapCreationErrorToField(contractError(42), tEn, {
      ...single,
      policy: null,
    });
    expect(mapped.field).toBeNull();
    expect(mapped.message).toContain("PolicyRateBelowFloor");
  });
});
