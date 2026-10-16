export interface BatchStreamEntry {
  recipient: string;
  deposit: string;
  duration: string;
}

const I128_MAX = (1n << 127n) - 1n;
const MAX_DURATION_SECONDS = 3_155_760_000n;

/** Parses address,rate,duration rows; rate is smallest token units per second. */
export function parseBatchCsv(csv: string): BatchStreamEntry[] {
  const lines = csv.split(/\r?\n/);
  const entries: BatchStreamEntry[] = [];
  const firstNonEmptyLine = lines.findIndex((candidate) => candidate.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const columns = line.split(",").map((column) => column.trim());
    if (
      index === firstNonEmptyLine &&
      columns.length === 3 &&
      columns[0].toLowerCase() === "address" &&
      columns[1].toLowerCase() === "rate" &&
      columns[2].toLowerCase() === "duration"
    ) {
      continue;
    }
    if (columns.length !== 3 || columns.some((column) => !column)) {
      throw new Error(`CSV row ${index + 1}: expected address,rate,duration.`);
    }

    const [recipient, rateText, durationText] = columns;
    if (!/^\d+$/.test(rateText) || !/^\d+$/.test(durationText)) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be whole numbers.`);
    }

    const rate = BigInt(rateText);
    const duration = BigInt(durationText);
    if (rate <= 0n || duration <= 0n) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be positive.`);
    }
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`CSV row ${index + 1}: duration exceeds the 100-year stream limit.`);
    }

    const deposit = rate * duration;
    if (deposit > I128_MAX) {
      throw new Error(`CSV row ${index + 1}: rate × duration exceeds the i128 deposit limit.`);
    }
    entries.push({
      recipient,
      deposit: deposit.toString(),
      duration: duration.toString(),
    });
  }

  if (entries.length === 0) {
    throw new Error("Add at least one CSV row.");
  }
  return entries;
}
