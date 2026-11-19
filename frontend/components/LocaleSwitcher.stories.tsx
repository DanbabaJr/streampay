import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import LocaleSwitcher from "./LocaleSwitcher";

/**
 * Language picker. The active locale comes from the `LocaleProvider` the
 * preview wraps every story in — switch it with the toolbar's Locale menu.
 */
const meta = {
  title: "Chrome/LocaleSwitcher",
  component: LocaleSwitcher,
  tags: ["autodocs"],
} satisfies Meta<typeof LocaleSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  globals: { locale: "en" },
};

export const German: Story = {
  globals: { locale: "de" },
};
