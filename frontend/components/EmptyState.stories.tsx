import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import EmptyState from "./EmptyState";

/**
 * The three first-run empty states — one for each page that can otherwise
 * render a blank table or chart. Each carries a single onward link, asserted in
 * `play`, so a changed route fails here rather than shipping a dead end.
 */
const meta = {
  title: "Chrome/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dashboard: Story = {
  args: {
    title: "No streams yet",
    body: "Your payment streams will appear here. Create your first stream above, or browse the discovery directory for inspiration.",
    action: { href: "/listings", label: "Browse the directory" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/no streams yet/i)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Browse the directory" })).toHaveAttribute(
      "href",
      "/listings"
    );
  },
};

export const Listings: Story = {
  args: {
    title: "No listings found",
    body: "No public streams match the current filters yet.",
    action: { href: "/", label: "Create a stream" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/no listings found/i)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Create a stream" })).toHaveAttribute(
      "href",
      "/"
    );
  },
};

export const Analytics: Story = {
  args: {
    title: "No streams to analyse",
    body: "Enter a Stellar address above, or create your first stream to see accrual history and income forecasts.",
    action: { href: "/", label: "Create a stream" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/no streams to analyse/i)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Create a stream" })).toHaveAttribute(
      "href",
      "/"
    );
  },
};
