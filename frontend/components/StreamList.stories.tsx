import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import StreamList from "./StreamList";
import {
  activeStream,
  cancelledStream,
  completedStream,
  tokenStream,
} from "../.storybook/fixtures";

/**
 * The dashboard's stream table: one row per stream with per-row withdraw /
 * top-up / cancel actions, and an optional batch-claim selection column.
 */
const meta = {
  title: "Streams/StreamList",
  component: StreamList,
  tags: ["autodocs"],
  args: {
    streams: [activeStream, tokenStream, cancelledStream, completedStream],
    onWithdraw: fn(),
    onWithdrawMax: fn(),
    onTopUp: fn(),
    onCancel: fn(),
    onRefresh: fn(),
  },
} satisfies Meta<typeof StreamList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { streams: [] },
};

/** Native XLM and token streams across every status badge. */
export const Populated: Story = {};

/** With `onClaimBatch` the list grows a selection column and a batch claim. */
export const BatchClaimSelection: Story = {
  args: { onClaimBatch: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select stream #42 for a batch claim"));
    await userEvent.click(canvas.getByLabelText("Select stream #43 for a batch claim"));
    await expect(canvas.getByRole("button", { name: /claim the 2 selected/i })).toBeEnabled();
  },
};

export const WithdrawClicked: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Amount for stream #42"), "2500");
    await userEvent.click(canvas.getByRole("button", { name: "Withdraw from stream #42" }));
    await expect(args.onWithdraw).toHaveBeenCalledWith("42", "2500");
  },
};
