import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, spyOn, within } from "storybook/test";

import DiscoveryConsentModal from "./DiscoveryConsentModal";
import { FIXED_NOW_SECONDS } from "../.storybook/fake-clock";
import { BYSTANDER, RECIPIENT, SENDER, activeStream } from "../.storybook/fixtures";

/**
 * The modal asks `/api/listings/propose` for a pending proposal on open.
 * Storybook has no API routes, so answer it here: `null` means "nothing
 * pending", a proposal object means the counterparty already signed.
 */
function stubProposal(initiator: string | null) {
  return () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(async () =>
      initiator === null
        ? new Response(null, { status: 404 })
        : Response.json({
            proposal: {
              streamId: activeStream.id,
              nonce: "prop-storybook",
              expiry: FIXED_NOW_SECONDS + 3600,
              initiatorConsent: { address: initiator, signature: "sig", shareAddress: false },
            },
          })
    );
    return () => spy.mockRestore();
  };
}

/**
 * Opt-in discovery listing: previews exactly which (bucketed) fields would be
 * published and collects the signer's consent.
 */
const meta = {
  title: "Streams/DiscoveryConsentModal",
  component: DiscoveryConsentModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    stream: activeStream,
    currentUserAddress: SENDER,
    isOpen: true,
    onClose: fn(),
    onSuccess: fn(),
  },
  beforeEach: stubProposal(null),
} satisfies Meta<typeof DiscoveryConsentModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SenderProposes: Story = {};

/** The counterparty signed first; this party co-signs to publish. */
export const CounterpartySigned: Story = {
  beforeEach: stubProposal(RECIPIENT),
  args: { currentUserAddress: SENDER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Co-Sign & Publish" })).toBeEnabled();
  },
};

/** Neither sender nor recipient: preview only, signing disabled. */
export const NotAParty: Story = {
  args: { currentUserAddress: BYSTANDER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Sign Consent with Freighter" })).toBeDisabled();
  },
};
