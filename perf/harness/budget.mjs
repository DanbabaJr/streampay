export function evaluateUpperBudget(measured, config) {
  const maxAllowed = config.budget * (1 + (config.tolerance_percent || 0) / 100);
  return { maxAllowed, passed: measured <= maxAllowed };
}
