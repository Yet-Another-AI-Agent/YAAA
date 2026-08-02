import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-essentials", "@storybook/addon-interactions"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  typescript: {
    reactDocgen: "react-docgen-typescript",
  },
  refs: {},
  core: {
    disableTelemetry: true,
  },
  storySort: {
    method: "configure",
    order: [["Chat", "Code", "Content", "Interaction", "Files", "Foundations"]],
  },
};

export default config;
