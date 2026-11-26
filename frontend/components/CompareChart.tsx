import type { Comparison } from "@/lib/compare/model";

const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed"];
const W = 640;
const H = 280;
const PAD = 40;

// bigint-safe scale to [0,1] with 1e6 resolution.
function frac(v: bigint, max: bigint): number {
  return max > 0n ? Number((v * 1_000_000n) / max) / 1_000_000 : 0;
}

// Presentational overlay chart: SVG with an aria label plus a data table
// fallback for screen readers and keyboard users.
export default function CompareChart({ comparison }: { comparison: Comparison }) {
  const { results, horizon, maxDeposit } = comparison;
  if (results.length === 0) return <p>Add a stream or a hypothetical set to compare.</p>;
  const label = `Accrual curves for ${results.length} streams: ${results
    .map((r) => `${r.item.label} deposits ${r.item.deposit} over ${r.item.duration} seconds`)
    .join("; ")}.`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: "100%", maxWidth: W }}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="currentColor" />
        {results.map((r, idx) => {
          const pts = r.curve
            .map((c) => {
              const x = PAD + frac(c.t, horizon) * (W - 2 * PAD);
              const y = H - PAD - frac(c.accrued, maxDeposit) * (H - 2 * PAD);
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
          return (
            <polyline key={r.item.key} points={pts} fill="none" stroke={COLORS[idx % COLORS.length]} strokeWidth={2}>
              <title>{r.item.label}</title>
            </polyline>
          );
        })}
      </svg>
      <ul aria-label="Legend">
        {results.map((r, idx) => (
          <li key={r.item.key} style={{ color: COLORS[idx % COLORS.length] }}>{r.item.label}</li>
        ))}
      </ul>
      <details>
        <summary>Data table</summary>
        <table>
          <caption>Accrued amount (token units) by seconds since start</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              {results.map((r) => (
                <th scope="col" key={r.item.key}>{r.item.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results[0].curve.map((_, i) => (
              <tr key={i}>
                <th scope="row">{i}</th>
                {results.map((r) => (
                  <td key={r.item.key}>{r.curve[i].accrued.toString()} @ {r.curve[i].t.toString()}s</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
