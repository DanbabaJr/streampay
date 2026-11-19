import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import StreamForm from "./StreamForm";
import { readStreamPolicyAction } from "@/app/actions";
import { RECIPIENT, TOKEN_CONTRACT, strictPolicy } from "../.storybook/fixtures";

/**
 * The single-stream create form: asset choice, locale-aware deposit parsing,
 * a live rate preview, and client-side checks against the contract's
 * governance policy before anything is signed.
 */
const meta = {
  title: "Streams/StreamForm",
  component: StreamForm,
  tags: ["autodocs"],
  args: { onCreate: fn() },
} satisfies Meta<typeof StreamForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Native XLM with the default deposit and an open (no-floor) policy. */
export const Default: Story = {};

/** Loading: the policy read has not answered yet, so no policy line shows. */
export const PolicyLoading: Story = {
  beforeEach: () => {
    mocked(readStreamPolicyAction).mockReturnValue(new Promise(() => {}));
  },
};

export const TokenContract: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText(/^asset/i), "contract");
    await userEvent.type(canvas.getByLabelText(/token contract/i), TOKEN_CONTRACT);
    // Metadata comes from the session cache the preview seeds.
    await waitFor(() => expect(canvas.getAllByText(/USDC/).length).toBeGreaterThan(0));
  },
};

/** Error: the governance floor rejects the deposit before signing. */
export const PolicyViolation: Story = {
  beforeEach: () => {
    mocked(readStreamPolicyAction).mockResolvedValue(strictPolicy);
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i), RECIPIENT);
    await waitFor(() => expect(canvas.getByText(/policy/i)).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toBeVisible();
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: a fractional amount in a smallest-unit field is refused, not rounded. */
export const InvalidDeposit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const deposit = canvas.getByLabelText(/deposit/i);
    await userEvent.clear(deposit);
    await userEvent.type(deposit, "12.5");
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toBeVisible();
    await expect(deposit).toHaveAttribute("aria-invalid", "true");
  },
};

/** Loading: submitted, waiting on the wallet signature. */
export const Submitting: Story = {
  args: { onCreate: fn(() => new Promise<void>(() => {})) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i), RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(canvas.getByRole("button", { name: /streaming/i })).toBeDisabled());
  },
};
