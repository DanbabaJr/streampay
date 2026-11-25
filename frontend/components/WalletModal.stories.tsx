import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";

import WalletModal from "./WalletModal";

/** Pretends the Freighter extension injected itself (lib/adapters/freighter.ts). */
function withFreighterInstalled() {
  const host = window as unknown as Record<string, unknown>;
  host.freighter = {};
  return () => {
    delete host.freighter;
  };
}

/**
 * Wallet picker dialog. Freighter's row depends on whether the extension
 * injected `window.freighter`; Albedo needs no extension.
 */
const meta = {
  title: "Wallet/WalletModal",
  component: WalletModal,
  tags: ["autodocs"],
  args: { open: true, onClose: fn() },
  play: async ({ canvasElement }) => {
    // The <dialog> is in the top layer, outside the story root.
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole("dialog")).toBeVisible();
  },
} satisfies Meta<typeof WalletModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No extension detected: Freighter shows an install link. */
export const FreighterMissing: Story = {};

export const FreighterInstalled: Story = {
  beforeEach: withFreighterInstalled,
};

/** Loading: a connect attempt is waiting on the wallet; choices are disabled. */
export const Connecting: Story = {
  beforeEach: withFreighterInstalled,
  parameters: { wallet: { connectionState: "connecting" } },
};

/** Error: the last connect attempt was rejected. */
export const ConnectError: Story = {
  beforeEach: withFreighterInstalled,
  parameters: { wallet: { lastError: "User declined access" } },
};
