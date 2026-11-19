import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { ToastProvider, createToastStore, useToast, type Toast } from "./toast";

// `duration: 0` disables auto-dismiss, so the stack is still there when the
// screenshot is taken no matter how long rendering took.
const SUCCESS: Toast = { id: "t1", type: "success", message: "Stream #42 created.", duration: 0 };
const INFO: Toast = { id: "t2", type: "info", message: "Waiting for Freighter to sign…", duration: 0 };
const ERROR: Toast = {
  id: "t3",
  type: "error",
  message: "AmountExceedsAvailable (code 6): withdraw less than the accrued balance.",
  duration: 0,
};

function Trigger() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.success("Withdrawal sent.", 0)}>
      Notify
    </button>
  );
}

/**
 * Toast notifications. Errors take focus (WCAG 2.4.3) and use `role="alert"`;
 * the others are polite.
 */
const meta = {
  title: "Chrome/Toast",
  component: ToastProvider,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { children: null },
} satisfies Meta<typeof ToastProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stack: Story = {
  args: { store: createToastStore([SUCCESS, INFO, ERROR]) },
};

export const ErrorToast: Story = {
  args: { store: createToastStore([ERROR]) },
};

export const TriggeredFromComponent: Story = {
  args: { store: createToastStore(), children: <Trigger /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Notify" }));
    await expect(await canvas.findByText("Withdrawal sent.")).toBeVisible();
  },
};
