import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import StreamForm from "./StreamForm";
import { readStreamPolicyAction } from "@/app/actions";
import {
  BAD_CHECKSUM_RECIPIENT,
  BAD_CHECKSUM_TOKEN,
  RECIPIENT,
  TOKEN_CONTRACT,
  strictPolicy,
} from "../.storybook/fixtures";

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
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
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
    // The recipient is empty too, so two field alerts render — and the
    // deposit hint also mentions "decimal places": match the error text.
    await expect(await canvas.findByText(/at most 0 decimal places/i)).toBeVisible();
    await expect(deposit).toHaveAttribute("aria-invalid", "true");
  },
};

/**
 * Submitting: rendered with the wallet signature pending. The story drives the
 * real submitting code path from props (`submitting`), so a static visual
 * capture and CI both see the genuine state instead of a lookalike. The play
 * assertion locks that in: pending label, disabled submit, disabled controls.
 */
export const Submitting: Story = {
  args: { onCreate: fn(() => new Promise<void>(() => {})), submitting: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByRole("button", { name: /streaming/i });
    await expect(submit).toBeDisabled();
    await expect(canvas.getByLabelText(/recipient/i)).toBeDisabled();
    await expect(canvas.getByLabelText(/deposit/i)).toBeDisabled();
    await expect(canvas.getByLabelText(/duration/i)).toBeDisabled();
  },
};

/** Error: a mistyped recipient fails the Stellar checksum at the field. */
export const InvalidRecipient: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), BAD_CHECKSUM_RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/valid Stellar address/);
    await expect(canvas.getByLabelText(/recipient/i, { selector: "input" })).toHaveAttribute("aria-invalid", "true");
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: a mistyped token contract id fails the checksum at the field. */
export const InvalidToken: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText(/^asset/i), "contract");
    await userEvent.type(canvas.getByLabelText(/token contract/i), BAD_CHECKSUM_TOKEN);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/valid token contract id/);
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: the duration is below the policy floor, at the duration field. */
export const DurationBelowFloor: Story = {
  beforeEach: () => {
    mocked(readStreamPolicyAction).mockResolvedValue(strictPolicy);
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
    // Deposit at the floor, so the duration is the only failing field.
    const deposit = canvas.getByLabelText(/deposit/i);
    await userEvent.clear(deposit);
    await userEvent.type(deposit, "10000000000");
    const days = canvas.getByLabelText(/duration/i);
    await userEvent.clear(days);
    await userEvent.type(days, "3");
    await waitFor(() => expect(canvas.getByText(/policy/i)).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /below the governance floor/
    );
    await expect(days).toHaveAttribute("aria-invalid", "true");
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};

/** Error: the contract rejects the deposit pull; it maps to the deposit field. */
export const ServerRejection: Story = {
  args: {
    onCreate: fn(async () => {
      throw new Error("simulation failed: Error(Contract, #26)");
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /could not be pulled/
    );
    await expect(canvas.getByLabelText(/deposit/i)).toHaveAttribute("aria-invalid", "true");
    await expect(args.onCreate).toHaveBeenCalledTimes(1);
  },
};

/** Error: a rejection no field can fix stays a form-level alert. */
export const ServerRejectionUnmapped: Story = {
  args: {
    onCreate: fn(async () => {
      throw new Error("simulation failed: Error(Contract, #36)");
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/ContractFrozen/);
    await expect(args.onCreate).toHaveBeenCalledTimes(1);
  },
};

/** A valid form submits the values exactly as entered. */
export const ValidSubmit: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/recipient/i, { selector: "input" }), RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith({
        token: "native",
        recipient: RECIPIENT,
        deposit: "1000000000",
        days: "30",
        cancelable: true,
      })
    );
  },
};
