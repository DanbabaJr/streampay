import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";

import StreamDetailClient from "./StreamDetailClient";
import {
  readAvailableAction,
  readRefundTargetAction,
  readStreamAction,
} from "@/app/actions";
import {
  ACTIVE_AVAILABLE,
  REFUND_TARGET,
  RECIPIENT,
  SENDER,
  activeStream,
  cancelledStream,
} from "../.storybook/fixtures";

const AS_RECIPIENT = {
  connectionState: "connected",
  walletName: "Freighter",
  address: RECIPIENT,
} as const;
const AS_SENDER = { ...AS_RECIPIENT, address: SENDER } as const;

/** Waits until the live-accrual engine has its first simulate answer. */
async function accrualLoaded(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() =>
    expect(canvas.getByLabelText(/^Available balance:/)).not.toHaveTextContent("…")
  );
  return canvas;
}

/**
 * The stream detail page body. It runs the live-accrual engine — a 15 s
 * simulate refresh plus a 1 s local ticker — so these stories are where the
 * frozen clock in .storybook/fake-clock.ts earns its keep: every tick lands on
 * the same instant, and the "Available now" counter renders the same digits
 * on every run.
 */
const meta = {
  title: "Pages/StreamDetail",
  component: StreamDetailClient,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { initialStream: activeStream },
} satisfies Meta<typeof StreamDetailClient>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Loading: the first simulate has not answered; the counter shows "…". */
export const Loading: Story = {
  parameters: { wallet: AS_RECIPIENT },
  beforeEach: () => {
    mocked(readStreamAction).mockReturnValue(new Promise(() => {}));
    mocked(readAvailableAction).mockReturnValue(new Promise(() => {}));
  },
};

/** Connected as the recipient: live counter plus the withdraw panel. */
export const ConnectedRecipient: Story = {
  parameters: { wallet: AS_RECIPIENT },
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Withdraw accrued funds" })).toBeVisible();
  },
};

/** Connected as the sender: no withdraw panel, a cancel card instead. */
export const ConnectedSender: Story = {
  parameters: { wallet: AS_SENDER },
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Cancel stream" })).toBeVisible();
  },
};

/** The refund of a cancel is routed away from the sender: warn before cancel. */
export const RefundRouted: Story = {
  parameters: { wallet: AS_SENDER },
  beforeEach: () => {
    mocked(readRefundTargetAction).mockResolvedValue(REFUND_TARGET);
  },
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    await expect(await canvas.findByRole("note")).toHaveTextContent(REFUND_TARGET);
  },
};

/** Error (client-side): an amount over the accrued balance is refused early. */
export const OverWithdrawal: Story = {
  parameters: { wallet: AS_RECIPIENT },
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    const over = (BigInt(ACTIVE_AVAILABLE) + 1n).toString();
    await userEvent.type(canvas.getByLabelText(/withdrawal amount/i), over);
    await expect(await canvas.findByText(/would reject it with AmountExceedsAvailable/)).toBeVisible();
  },
};

/** Error: the RPC read failed; the decoded error is announced. */
export const ReadError: Story = {
  parameters: { wallet: AS_RECIPIENT },
  beforeEach: () => {
    mocked(readStreamAction).mockRejectedValue(new Error("RPC node unreachable"));
    mocked(readAvailableAction).mockRejectedValue(new Error("RPC node unreachable"));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toBeVisible();
  },
};

/** No wallet: everything readable, nothing actionable. */
export const ReadOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/** A cancelled stream renders without live accrual or actions. */
export const Cancelled: Story = {
  parameters: { wallet: AS_RECIPIENT },
  args: { initialStream: cancelledStream },
  beforeEach: () => {
    mocked(readAvailableAction).mockResolvedValue("0");
  },
  play: async ({ canvasElement }) => {
    const canvas = await accrualLoaded(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Cancelled");
  },
};
