import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import NetworkBadge from "./NetworkBadge";
import {
  PUBLIC_PASSPHRASE,
  createNetworkWarningStore,
  findNetworkMismatch,
} from "@/lib/network";

function mismatchedStore() {
  const store = createNetworkWarningStore();
  const mismatch = findNetworkMismatch({ networkPassphrase: PUBLIC_PASSPHRASE }, "testnet");
  if (mismatch) store.report({ state: "mismatch", mismatch });
  return store;
}

/**
 * Network / contract indicator. The network and contract id come from the
 * env Storybook pins in .storybook/main.ts; the wallet-mismatch warning comes
 * from the injectable store.
 */
const meta = {
  title: "Chrome/NetworkBadge",
  component: NetworkBadge,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NetworkBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { store: createNetworkWarningStore() },
};

/** Error: the connected wallet signs for mainnet, the app for testnet. */
export const WalletOnWrongNetwork: Story = {
  args: { store: mismatchedStore() },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toBeVisible();
  },
};

export const WarningDismissed: Story = {
  args: { store: mismatchedStore() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /dismiss/i }));
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
