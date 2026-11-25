import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import { AgentListPanel } from "./AgentListPanel";
import { AmendmentPanel } from "./AmendmentPanel";
import { BYSTANDER, REFUND_TARGET } from "../.storybook/fixtures";

/**
 * Two small panels that are not wired into a route yet. They are written
 * against Tailwind class names the app does not ship, so what renders here is
 * exactly what they would look like if mounted today — which is the point of
 * keeping a baseline for them.
 */
const meta = {
  title: "Streams/Panels",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const AgentListEmpty: StoryObj<typeof AgentListPanel> = {
  render: (args) => <AgentListPanel {...args} />,
  args: { streamId: "42", agents: [], onAddAgent: fn(), onRemoveAgent: fn() },
};

export const AgentListPopulated: StoryObj<typeof AgentListPanel> = {
  render: (args) => <AgentListPanel {...args} />,
  args: {
    streamId: "42",
    agents: [BYSTANDER, REFUND_TARGET],
    onAddAgent: fn(),
    onRemoveAgent: fn(),
  },
};

export const Amendment: StoryObj<typeof AmendmentPanel> = {
  render: (args) => <AmendmentPanel {...args} />,
  args: {
    streamId: "42",
    currentRate: "11574",
    currentEndTime: "1770206400",
    onApplyAmendment: fn(),
    onPartialCancel: fn(),
  },
};
