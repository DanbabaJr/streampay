// Pure budget-gate logic (no I/O) so it can be self-tested.
// A route fails if a lab metric exceeds its absolute budget, or regresses
// more than tolerancePct against the stored baseline.
export function evaluate(measured, budgets, baseline) {
  const failures = [];
  const tol = (budgets.tolerancePct ?? 10) / 100;
  for (const [route, m] of Object.entries(measured)) {
    const budget = budgets[route] ?? budgets.default;
    const base = baseline[route];
    for (const metric of ["lcp", "tbt", "cls"]) {
      const v = m[metric];
      if (typeof v !== "number" || Number.isNaN(v)) {
        failures.push(`${route} ${metric}: no measurement`);
        continue;
      }
      if (v > budget[metric]) {
        failures.push(`${route} ${metric}: ${v} exceeds budget ${budget[metric]}`);
      }
      if (base && typeof base[metric] === "number") {
        // CLS baselines can be ~0, so allow a small absolute floor.
        const floor = metric === "cls" ? 0.02 : 0;
        const limit = Math.max(base[metric] * (1 + tol), base[metric] + floor);
        if (v > limit) {
          failures.push(`${route} ${metric}: ${v} regressed vs baseline ${base[metric]} (limit ${limit.toFixed(3)})`);
        }
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
