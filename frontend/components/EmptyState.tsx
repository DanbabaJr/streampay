"use client";

import Link from "next/link";

/**
 * First-run placeholder for a table, chart or list that has nothing to show:
 * a short explanation of what belongs here, plus the one link that gets the
 * newcomer to their first stream. Deliberately unlike the loading and error
 * branches around it — no spinner and no alert role — and it always offers an
 * onward link, so an empty page is never a dead end.
 */
export default function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { href: string; label: string };
}) {
  return (
    <div style={{ textAlign: "center", padding: "28px 16px" }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <p className="muted" style={{ margin: "0 0 16px" }}>
        {body}
      </p>
      <Link
        href={action.href}
        style={{
          display: "inline-block",
          padding: "8px 16px",
          border: "1px solid var(--accent)",
          borderRadius: 8,
          color: "var(--accent)",
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {action.label}
      </Link>
    </div>
  );
}
