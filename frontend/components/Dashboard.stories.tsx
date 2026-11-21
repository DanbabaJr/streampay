import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, userEvent, within } from "storybook/test";

import Dashboard from "./Dashboard";
import { fetchStreamIdsPageAction, readStreamAction } from "@/app/actions";
import { RECIPIENT } from "../.storybook/fixtures";

const CONNECTED = {
  connectionState: "connected",
  walletId: "freighter",
  walletName: "Freighter",
  address: RECIPIENT,
} as const;

/** Waits for both lazily-loaded panels (create form + stream list). */
async function panelsLoaded(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole("button", { name: "Create stream" });
  await canvas.findByRole("heading", { name: "Your streams" });
  return canvas;
}

/**
 * The home-page composite: landing state until a wallet connects, then the
 * create form, lookup-by-id, on-chain discovery and the stream list.
 */
const meta = {
  title: "Pages/Dashboard",
  component: Dashboard,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Dashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

/** Loading: waiting on the wallet's approval prompt. */
export const Connecting: Story = {
  parameters: { wallet: { connectionState: "connecting" } },
};

export const ConnectedEmpty: Story = {
  parameters: { wallet: CONNECTED },
  play: async ({ canvasElement }) => {
    const canvas = await panelsLoaded(canvasElement);
    await expect(canvas.getByText(/no streams loaded yet/i)).toBeVisible();
  },
};

/** Stream ids cached for this address are re-read on connect. */
export const ConnectedWithStreams: Story = {
  parameters: { wallet: CONNECTED },
  beforeEach: () => {
    localStorage.setItem(
      `streampay:testnet:${RECIPIENT}:streamIds`,
      JSON.stringify(["9", "17", "42"])
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = await panelsLoaded(canvasElement);
    await canvas.findByRole("link", { name: "#42" });
    await expect(canvas.getAllByRole("row")).toHaveLength(4);
  },
};

export const DiscoveredOnChain: Story = {
  parameters: { wallet: CONNECTED },
  beforeEach: () => {
    mocked(fetchStreamIdsPageAction).mockImplementation(async (_address, role) => ({
      ids: role === "recipient" ? ["42", "43"] : ["17"],
      hasMore: false,
    }));
  },
  play: async ({ canvasElement }) => {
    const canvas = await panelsLoaded(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Discover on-chain" }));
    await expect(await canvas.findByText("Discovered 3 stream(s) on-chain.")).toBeVisible();
  },
};

/** Loading: a lookup by id is in flight. */
export const LookupLoading: Story = {
  parameters: { wallet: CONNECTED },
  beforeEach: () => {
    mocked(readStreamAction).mockReturnValue(new Promise(() => {}));
  },
  play: async ({ canvasElement }) => {
    const canvas = await panelsLoaded(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Stream ID"), "42");
    await userEvent.click(canvas.getByRole("button", { name: "Fetch stream" }));
    await expect(await canvas.findByRole("button", { name: "Fetching..." })).toBeDisabled();
  },
};

/** Error: the id does not resolve on-chain. */
export const LookupError: Story = {
  parameters: { wallet: CONNECTED },
  play: async ({ canvasElement }) => {
    const canvas = await panelsLoaded(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Stream ID"), "999");
    await userEvent.click(canvas.getByRole("button", { name: "Fetch stream" }));
    await expect(await canvas.findByText(/stream not found/i)).toBeVisible();
  },
};
