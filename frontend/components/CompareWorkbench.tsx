"use client";

import { useEffect, useMemo, useState } from "react";
import { compare, addItem, removeItem, MAX_ITEMS, type CompareItem } from "@/lib/compare/model";
import { decodeState, encodeState } from "@/lib/compare/url";
import { FORECAST_CAVEATS } from "@/lib/compare/forecast";
import { DEFAULT_FEES } from "@/lib/compare/fees";
import CompareChart from "./CompareChart";

const DAY = 86_400n;

export default function CompareWorkbench() {
  const [items, setItems] = useState<CompareItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [deposit, setDeposit] = useState("1000000");
  const [days, setDays] = useState("30");
  const [shareUrl, setShareUrl] = useState("");
  const [error, setError] = useState("");

  // Load shared state from the URL once, on the client.
  useEffect(() => {
    const s = decodeState(window.location.search);
    setItems(s.items); // eslint-disable-line react-hooks/set-state-in-effect
    setLoaded(true);
  }, []);

  const comparison = useMemo(() => compare(items, DEFAULT_FEES), [items]);

  function addHypothetical() {
    setError("");
    if (!/^[0-9]{1,30}$/.test(deposit) || BigInt(deposit) < 1n) return setError("Deposit must be a positive whole number.");
    if (!/^[0-9]{1,5}$/.test(days) || BigInt(days) < 1n) return setError("Days must be a positive whole number.");
    if (items.length >= MAX_ITEMS) return setError(`You can compare up to ${MAX_ITEMS}.`);
    const n = items.filter((i) => i.kind === "hypothetical").length + 1;
    setItems(
      addItem(items, {
        key: `h:${Date.now().toString(36)}`,
        label: `Hypothetical ${n}`,
        kind: "hypothetical",
        deposit: BigInt(deposit),
        duration: BigInt(days) * DAY,
      }),
    );
  }

  function share() {
    const q = encodeState({ items, fees: DEFAULT_FEES });
    const url = `${window.location.origin}${window.location.pathname}?${q}`;
    window.history.replaceState(null, "", `?${q}`);
    setShareUrl(url);
  }

  return (
    <main>
      <h1>Stream comparison workbench</h1>
      <p>Simulated entirely in your browser. No transactions are sent.</p>
      <fieldset>
        <legend>Add a hypothetical stream</legend>
        <label>Deposit (token units) <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="numeric" /></label>{" "}
        <label>Days <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>{" "}
        <button type="button" onClick={addHypothetical}>Add</button>
        {error && <p role="alert">{error}</p>}
      </fieldset>

      {!loaded ? <p>Loading...</p> : <CompareChart comparison={comparison} />}

      {comparison.results.length > 0 && (
        <table>
          <caption>Forecast and fee estimates</caption>
          <thead>
            <tr><th>Stream</th><th>Rate / sec</th><th>Exhaustion (days)</th><th>Estimated fees (stroops)</th><th /></tr>
          </thead>
          <tbody>
            {comparison.results.map((r) => (
              <tr key={r.item.key}>
                <td>{r.item.label}</td>
                <td>{r.rate.toString()}</td>
                <td>{(Number(r.forecast.exhaustionSeconds) / 86400).toFixed(2)}</td>
                <td>{r.fees.total.toString()}</td>
                <td><button type="button" onClick={() => setItems(removeItem(items, r.item.key))}>Remove {r.item.label}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button type="button" onClick={share} disabled={items.length === 0}>Copy shareable link</button>
      {shareUrl && <p><output>{shareUrl}</output></p>}

      <section aria-label="Caveats">
        <h2>Tolerance and rounding</h2>
        <ul>{FORECAST_CAVEATS.map((c) => <li key={c}>{c}</li>)}</ul>
      </section>
    </main>
  );
}
