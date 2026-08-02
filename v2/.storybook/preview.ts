import type { Preview } from "@storybook/react";
import React from "react";
import "../components/chat-content/create-chat.css";
import "../components/typing-bar/typing-bar.css";
import "../components/special-file-opener/special-file-opener.css";
import "../components/viewer/viewer.css";
import "../components/buttons/button.css";
import "../components/markdown-viewer/markdown-viewer.css";
import "../components/code-viewer/code-viewer.css";
import "../components/markdown-commenter/markdown-commenter.css";
import "../components/response-review/response-review.css";
import "../components/question-carousel/question-carousel.css";
import "../components/chat-shell/chat-shell.css";
import "../components/bot-holder/bot-holder.css";
import "../components/working-directory-card/working-directory-card.css";
import "../components/tabs/tabs.css";
import "../components/right-pane/right-pane.css";
import "../components/task-list/task-list.css";
import "../components/side-panel/side-panel.css";
import "../components/left-bar/left-bar.css";
import "../components/cursor-glow/cursor-glow.css";
import "../components/workspace-shell/workspace-shell.css";
import "../components/splash-screen/splash-screen.css";
import { CursorGlowBackground } from "../components/cursor-glow/CursorGlowBackground";
import "./theme.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Global theme for v2 components",
      defaultValue: "light",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: ["light", "dark"],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme ?? "light";
      document.documentElement.classList.toggle("chat-v2-light", theme === "light");
      document.documentElement.classList.toggle("chat-v2-dark", theme === "dark");
      return React.createElement(React.Fragment, null, React.createElement(CursorGlowBackground), Story());
    },
  ],
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#f7f8fa" },
        { name: "dark", value: "#17191d" },
      ],
    },
    controls: { expanded: true },
  },
};

export default preview;
