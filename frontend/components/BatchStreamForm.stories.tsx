import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import BatchStreamForm from "./BatchStreamForm";
import { BYSTANDER, RECIPIENT, TOKEN_CONTRACT } from "../.storybook/fixtures";

const VALID_CSV = `address,rate,duration\n${RECIPIENT},1000,2592000\n${BYSTANDER},250,604800`;

async function fill(canvasElement: HTMLElement, csv: string) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(/token contract id/i), TOKEN_CONTRACT);
  await userEvent.click(canvas.getByLabelText(/csv rows/i));
  await userEvent.paste(csv);
  return canvas;
}

/**
 * Payroll batch creation: one token, many recipients from CSV, created in a
 * single transaction.
 */
const meta = {
  title: "Streams/BatchStreamForm",
  component: BatchStreamForm,
  tags: ["autodocs"],
  args: { onCreate: fn(async () => true) },
} satisfies Meta<typeof BatchStreamForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

/** A parsed batch with its per-row totals in the token's own units. */
export const ValidCsv: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement, VALID_CSV);
    await waitFor(() => expect(canvas.getAllByText(/USDC/).length).toBeGreaterThan(0));
  },
};

/** Error: a malformed row is named, and nothing is submitted. */
export const InvalidRow: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = await fill(canvasElement, `${RECIPIENT},10.5,600`);
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/whole numbers/);
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Loading: submitted, waiting on the wallet signature. */
export const Submitting: Story = {
  args: { onCreate: fn(() => new Promise<boolean>(() => {})) },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement, VALID_CSV);
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("button", { name: /creating batch/i })).toBeDisabled();
  },
};
