import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import WalletButton from "./WalletButton";
import { RECIPIENT } from "../.storybook/fixtures";

/**
 * The connect / disconnect control. Its three states map one-to-one onto the
 * wallet context's `connectionState`.
 */
const meta = {
  title: "Wallet/WalletButton",
  component: WalletButton,
  tags: ["autodocs"],
} satisfies Meta<typeof WalletButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {
  parameters: { wallet: { connectionState: "idle" } },
};

/** Loading: the adapter is waiting on the wallet's approval prompt. */
export const Connecting: Story = {
  parameters: { wallet: { connectionState: "connecting" } },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: /connecting/i });
    await expect(button).toBeDisabled();
  },
};

export const Connected: Story = {
  parameters: {
    wallet: {
      connectionState: "connected",
      walletId: "freighter",
      walletName: "Freighter",
      address: RECIPIENT,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("GCATS5…I55U")).toBeVisible();
  },
};
