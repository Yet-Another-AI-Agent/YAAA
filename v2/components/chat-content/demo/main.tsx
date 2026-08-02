import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CreateChat } from "../CreateChat";
import { createDemoMessages } from "../models/demo-messages";
import "../create-chat.css";
import "./showcase.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="chat-v2-showcase"><CreateChat initialMessages={createDemoMessages()} /></main>
  </StrictMode>,
);
