import type { Meta, StoryObj } from "@storybook/react";
import { Checkbox } from "sparkle";

const meta = {
  title: "Atoms/Checkbox",
  component: Checkbox,
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Checked: Story = {
  args: {
    checked: true,
  },
};

export const Unchecked: Story = {
  args: {
    checked: false,
  },
};
