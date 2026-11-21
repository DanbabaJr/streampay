import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import BatchStreamForm from "./BatchStreamForm";
import {
  BAD_CHECKSUM_RECIPIENT,
  BAD_CHECKSUM_TOKEN,
  BYSTANDER,
  RECIPIENT,
  TOKEN_CONTRACT,
} from "../.storybook/fixtures";

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

/** Error: a mistyped token contract id fails the checksum at the token field. */
export const InvalidToken: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/token contract id/i), BAD_CHECKSUM_TOKEN);
    await userEvent.click(canvas.getByLabelText(/csv rows/i));
    await userEvent.paste(VALID_CSV);
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /valid token contract id/
    );
    await expect(canvas.getByLabelText(/token contract id/i)).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: more rows than the contract's MAX_BATCH, at the csv field. */
export const BatchTooLarge: Story = {
  play: async ({ args, canvasElement }) => {
    const rows = Array.from({ length: 26 }, () => `${RECIPIENT},1000,2592000`);
    const canvas = await fill(
      canvasElement,
      `address,rate,duration\n${rows.join("\n")}`
    );
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/maximum 25/);
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: a row with a bad recipient checksum names the row, at the csv field. */
export const InvalidRowAddress: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = await fill(
      canvasElement,
      `address,rate,duration\n${RECIPIENT},1000,2592000\n${BAD_CHECKSUM_RECIPIENT},1000,2592000`
    );
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /Row 3: Enter a valid Stellar address/
    );
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: the contract rejects the batch; it maps to the csv field. */
export const ServerRejection: Story = {
  args: {
    onCreate: fn(async () => {
      throw new Error("simulation failed: Error(Contract, #48)");
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = await fill(canvasElement, VALID_CSV);
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/maximum 25/);
    await expect(args.onCreate).toHaveBeenCalledTimes(1);
  },
};

/** A valid batch submits the parsed rows exactly as entered. */
export const ValidSubmit: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = await fill(canvasElement, VALID_CSV);
    await userEvent.click(canvas.getByRole("button", { name: "Create batch" }));
    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(TOKEN_CONTRACT, [
        { recipient: RECIPIENT, deposit: "2592000000", duration: "2592000" },
        { recipient: BYSTANDER, deposit: "151200000", duration: "604800" },
      ], true)
    );
  },
};
