import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToString } from "react-dom/server";
import {
  Skeleton,
  StreamDetailSkeleton,
  AddressExplorerSkeleton,
  DashboardSkeleton,
} from "../components/skeletons";
import StreamDetailLoading from "../app/stream/[id]/loading";
import AddressExplorerLoading from "../app/address/[addr]/loading";
import RootLoading from "../app/loading";

describe("Skeleton Primitives and Loading States", () => {
  describe("Skeleton primitive", () => {
    it("renders with default classes and aria-hidden", () => {
      const html = renderToString(React.createElement(Skeleton));
      expect(html).toContain('class="skeleton-shimmer"');
      expect(html).toContain('aria-hidden="true"');
    });

    it("applies width, height, and border-radius styles", () => {
      const html = renderToString(
        React.createElement(Skeleton, {
          width: "120px",
          height: "24px",
          borderRadius: "8px",
          className: "custom-test",
        })
      );
      expect(html).toContain("width:120px");
      expect(html).toContain("height:24px");
      expect(html).toContain("border-radius:8px");
      expect(html).toContain("skeleton-shimmer custom-test");
    });
  });

  describe("StreamDetailSkeleton", () => {
    it("renders stream detail layout with accessibility attributes", () => {
      const html = renderToString(React.createElement(StreamDetailSkeleton));
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('aria-label="Loading stream details"');
      expect(html).toContain("skeleton-shimmer");
    });

    it("renders table header placeholders matching the real stream detail view", () => {
      const html = renderToString(React.createElement(StreamDetailSkeleton));
      expect(html).toContain("Sender");
      expect(html).toContain("Recipient");
      expect(html).toContain("Token");
      expect(html).toContain("Deposit");
      expect(html).toContain("Withdrawn");
      expect(html).toContain("Available now");
      expect(html).toContain("Status");
      expect(html).toContain("Duration");
    });

    it("renders explicit streamId when passed", () => {
      const html = renderToString(
        React.createElement(StreamDetailSkeleton, { streamId: "42" })
      );
      expect(html).toContain("STREAM #42");
    });

    it("renders route loading wrapper component cleanly", () => {
      const html = renderToString(React.createElement(StreamDetailLoading));
      expect(html).toContain('aria-label="Loading stream details"');
    });
  });

  describe("AddressExplorerSkeleton", () => {
    it("renders address explorer layout with accessibility attributes", () => {
      const html = renderToString(React.createElement(AddressExplorerSkeleton));
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('aria-label="Loading address explorer"');
    });

    it("renders 4 aggregate stat boxes matching the real address view", () => {
      const html = renderToString(React.createElement(AddressExplorerSkeleton));
      expect(html).toContain("Total Streams");
      expect(html).toContain("Active Streams");
      expect(html).toContain("Total Deposited");
      expect(html).toContain("Total Claimed");
      expect(html).toContain("stats-grid");
      expect(html).toContain("filter-controls");
    });

    it("renders provided address or fallback placeholder", () => {
      const withAddr = renderToString(
        React.createElement(AddressExplorerSkeleton, {
          address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        })
      );
      expect(withAddr).toContain("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

      const withoutAddr = renderToString(React.createElement(AddressExplorerSkeleton));
      expect(withoutAddr).not.toContain("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    });

    it("renders route loading wrapper component cleanly", () => {
      const html = renderToString(React.createElement(AddressExplorerLoading));
      expect(html).toContain('aria-label="Loading address explorer"');
    });
  });

  describe("DashboardSkeleton", () => {
    it("renders dashboard skeleton layout with accessibility attributes", () => {
      const html = renderToString(React.createElement(DashboardSkeleton));
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('aria-label="Loading dashboard"');
      expect(html).toContain("card");
    });

    it("renders route loading wrapper component cleanly", () => {
      const html = renderToString(React.createElement(RootLoading));
      expect(html).toContain('aria-label="Loading dashboard"');
    });
  });

  describe("Reduced Motion & Styling Contract", () => {
    it("globals.css defines prefers-reduced-motion overrides for skeleton shimmer", () => {
      const cssPath = path.resolve(__dirname, "../app/globals.css");
      const css = fs.readFileSync(cssPath, "utf-8");

      expect(css).toContain(".skeleton-shimmer");
      expect(css).toContain("prefers-reduced-motion: reduce");
      expect(css).toMatch(/\.skeleton-shimmer\s*\{[^}]*animation:\s*none\s*!important/s);
    });
  });

  describe("Pure render contract (no data fetching)", () => {
    it("all skeletons render synchronously without asynchronous data fetching", () => {
      const t0 = performance.now();
      const s1 = renderToString(React.createElement(StreamDetailSkeleton));
      const s2 = renderToString(React.createElement(AddressExplorerSkeleton));
      const s3 = renderToString(React.createElement(DashboardSkeleton));
      const elapsed = performance.now() - t0;

      expect(s1.length).toBeGreaterThan(0);
      expect(s2.length).toBeGreaterThan(0);
      expect(s3.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(500);
    });
  });
});
