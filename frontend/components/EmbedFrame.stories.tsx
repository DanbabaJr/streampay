/**
 * Stories for the /embed/frame page (EmbedFrame component).
 *
 * These exercise the frame in isolation: the stream data comes from the
 * shared Storybook mocks (preview.tsx), and the postMessage round-trip is
 * verified by checking that the component renders the expected content
 * after the mock actions resolve.
 */

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within } from "storybook/test";

import EmbedFrame from "@/app/embed/frame/page";
import {
  readAvailableAction,
  readStreamAction,
} from "@/app/actions";
import {
  activeStream,
  cancelledStream,
} from "../.storybook/fixtures";

/**
 * EmbedFrame renders the sandboxed iframe guest page.
 *
 * The page reads its configuration from the iframe URL with `useSearchParams()`,
 * so each story sets `parameters.nextjs.navigation.query`: the framework's
 * app-directory decorator feeds that object into Next's `SearchParamsContext`
 * (`@storybook/nextjs-vite` → `AppRouterProvider`), which is what
 * `useSearchParams()` reads. `navigation.searchParams` is not a `NextRouter`
 * field and is ignored — every story then renders the loading state.
 */
const meta = {
  title: "Embed/EmbedFrame",
  component: EmbedFrame,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    nextjs: {
      appDirectory: true,
      navigation: {
        query: {
          streamId: activeStream.id,
          mode: "read",
          theme: "auto",
          widgetId: "spw-story",
          origin: "http://localhost:6006",
          allowedOrigins: "http://localhost:6006",
        },
      },
    },
  },
} satisfies Meta<typeof EmbedFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: active stream loaded in read mode. */
export const ReadMode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("table")).toBeVisible()
    );
    await expect(canvas.getByText(/Active/)).toBeVisible();
  },
};

/** Link mode: shows recipient address instead of available balance. */
export const LinkMode: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        query: {
          streamId: activeStream.id,
          mode: "link",
          theme: "auto",
          widgetId: "spw-story-link",
          origin: "http://localhost:6006",
          allowedOrigins: "http://localhost:6006",
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("table")).toBeVisible());
    await expect(canvas.getByText(/Recipient/i)).toBeVisible();
  },
};

/** Error state: stream not found. */
export const LoadError: Story = {
  beforeEach: () => {
    mocked(readStreamAction).mockRejectedValue(
      new Error("Stream not found on RPC")
    );
    mocked(readAvailableAction).mockRejectedValue(
      new Error("Stream not found on RPC")
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toBeVisible()
    );
  },
};

/** Loading state: actions never resolve. */
export const Loading: Story = {
  beforeEach: () => {
    mocked(readStreamAction).mockReturnValue(new Promise(() => {}));
    mocked(readAvailableAction).mockReturnValue(new Promise(() => {}));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toBeVisible();
  },
};

/** Cancelled stream in read mode. */
export const Cancelled: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        query: {
          streamId: cancelledStream.id,
          mode: "read",
          theme: "auto",
          widgetId: "spw-story-cancelled",
          origin: "http://localhost:6006",
          allowedOrigins: "http://localhost:6006",
        },
      },
    },
  },
  beforeEach: () => {
    mocked(readStreamAction).mockResolvedValue(cancelledStream);
    mocked(readAvailableAction).mockResolvedValue("0");
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("table")).toBeVisible());
    await expect(canvas.getByText(/Cancelled/)).toBeVisible();
  },
};
