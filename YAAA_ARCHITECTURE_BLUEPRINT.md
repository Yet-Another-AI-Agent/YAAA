# MASTER SYSTEM ARCHITECTURE & EXECUTION BLUEPRINT: YAAA (Yet Another AI Agent)



Note: Use code-review-graph mcp for context management and token reduction



## PART I: THE END GOAL (VISION & FINAL STATE ARCHITECTURE)







The ultimate objective of this project is to build **YAAA (Yet Another AI Agent)** as a Dynamically Configurable Professional Firm operating entirely autonomously within a local workspace. This is not a simple command-line script, a passive coding assistant, or a standard co-pilot. It is a full-fledged AI operating system structured around a multi-agent codex, featuring a hyper-modern, event-driven, Slack-like GUI.







The system must flawlessly transition its organizational structure based entirely on the user's initial prompt. It must operate equally well as:







* A deep-tech engineering house migrating a legacy database to a Kafka-driven microservices architecture.



* An R&D incubator building a web-based 3D software solution for the clear aligner industry for a solo founder.



* A high-end marketing agency creating a Meta ad campaign and pamphlet design for a dental clinic.







### 1. The Intelligent Orchestrator Paradigm (The Outer Loop)







When the application launches, the user interacts first with the @orchestrator. The Orchestrator acts as the principal Team Lead. It is highly intelligent, context-aware, and dynamically provisions the workspace.







* **Conversational NLP & Intent Classification:** The Orchestrator evaluates the user's input before acting. If a user types "Hi," the intent classification layer bypasses the TaskPlanner module entirely. The Orchestrator responds conversationally (e.g., *"Hello! What are we building or working on today?"*). It strictly does **not** instantly dump an implementation plan, generate raw UUIDs, or freeze the system state.



* **Dynamic Scoping & Requirements Gathering:** For complex prompts, the Orchestrator shifts into 'Team Lead' mode. It asks clarifying questions, establishes project boundaries, and dynamically maps a strict task matrix. If user input is required at any stage, the Orchestrator explicitly pauses to ask for clarification.



* **Mission Skill Configuration:** Before spawning sub-agents, the Orchestrator evaluates the overall mission and modifies the global skills for that specific workspace to perfectly align with the domain constraints.







---







## PART II: COMPREHENSIVE UI/UX ARCHITECTURE & WORKSPACE ENVIRONMENT







The workspace UI must emulate a hyper-functional IDE layered with a Slack-like communication interface. It completely eradicates raw system logs and backend leakage from the user's primary view. The interface is strictly divided into functional panels.







### Panel 1: Left Navigation & System Control







* **Global Navigation:** Intuitive icons to toggle between the primary **Chat Window** and the **Agent Space** (telemetry dashboard).



* **Artifacts Explorer:** A robust tree-view displaying all generated assets, including Implementation Plans, HANDS_ON.md / HANDS_OFF.md docs, generated images, captured screencasts, screenshots, and active code directories.



* **Working Directory Manager:** Displays the active path assigned by the user. The Orchestrator can dynamically create and mount sub-directories here as required by the project.



* **Session Management (Delete Workspace):** A permanently accessible global UI button. Clicking this triggers a backend function that recursively deletes the current working directory for that session, sends a SIGTERM to kill all active agent processes, and instantly purges the context history and UI state.







### Panel 2: The Main Stage (Slack-Clone Chat & Media Viewer)







This is the primary user interaction zone, replacing traditional agent interfaces with a polished, corporate communication style.







| Feature | Architectural Requirement |



| --- | --- |



| **Strict Slack-Like UI** | Built using modern CSS (Flexbox/Grid). Every message must have a clear sender name (User, @orchestrator, @principal-swe, @mike) and a distinct gender-neutral avatar. |



| **LLM-Generated Topics** | Raw UUIDs (e.g., #hi-1b154a) are strictly forbidden from rendering. The Orchestrator must query the best available model to generate a contextual topic name (e.g., #auth-migration or #q3-promo) and rename the channel. |



| **Absolute Log Encapsulation** | Agent thinking, terminal outputs, and system logs (e.g., *Listening to event stream...*) must NEVER render as chat bubbles. They must be packaged inside an expandable <details><summary>System Logs (Click to expand)</summary><div class="raw-logs">{logs}</div></details> block attached to the agent's message, defaulting to **minimized**. |



| **Lifecycle Toast Notifications** | Smooth, inline visual toast cards must broadcast lifecycle events to the chat: <br>







<br>• ⚡ [System]: @qa-tester joined the workspace.<br>







<br>• ✅ [System]: @designer successfully completed tasks and exited. |



| **Explicit Mentions & Threading** | Users can type @agent-name to pause that specific agent's execution loop and force a sub-thread conversation. Sub-agents also create threads to chat directly with the Orchestrator. Unmentioned text defaults to the Orchestrator. |







### Panel 3: Right Sidebar (Mission Control & State Engine)







State synchronization must be instantaneous. Implement a robust pub/sub event system (e.g., WebSockets or Server-Sent Events). The UI must never hang on "Awaiting plan..." while backend tasks process.







* **Mission Team:** Lists all active agents currently assigned to the workspace. When agents join, they appear here; when they leave, their status updates to 'exited'.



* **Todo & Progress:** A granular, auto-updating matrix tracking the specific items assigned to each active agent.



* **Contexts (Real-Time State):** Dynamically tracks project language, runtime, and real-time code modifications. Multiple active files and their diff states are reflected here simultaneously.



* **Active Integrations:** Displays all connected Model Context Protocol (MCP) servers.







### The Agent Space (Telemetry Dashboard)







The second primary tab (accessed via Left Nav) serves as the system diagnostic center. It provides deep observability into individual agents. The Orchestrator can access all work done and logs from this space, which includes:







* Real-time thinking tokens and action chains.



* Code diffs and bash terminal logs.



* Computer vision coordinates and headless browser network/console logs.







---







## PART III: RICH MEDIA, VISUAL COMMENTING & DOCUMENT ENGINE







YAAA must handle complex documents and visual assets natively, bypassing the need for external software.







### 1. Interactive Media Viewers







The chat must seamlessly expand into split-screen viewers supporting various file types without leaving the application.







* **Document Generation & Rendering:** Integrated JS libraries allow agents to dynamically build, edit, and render complex Markdown, Word files (e.g., A4 resume layouts), Excel sheets, and PowerPoint presentations.



* **Architecture Viewer:** A live viewer specifically integrated to render graphTD architecture diagrams outputted by engineering agents.







### 2. The Canvas Commenter Logic







* **HTML5 Canvas Overlay:** Layered on top of the image, PDF, or document viewer.



* **Bounding Box Annotations:** Users can click, drag a bounding box over specific visual elements (e.g., a promotional pamphlet layout or a 3D WebGL render), and type direct feedback.



* **JSON Routing:** These coordinates and comments are saved as a JSON payload, mapped to the underlying image, and sent to the Orchestrator. The Orchestrator autonomously parses these visual markers and forwards them to the appropriate sub-agent (e.g., @designer or @ui-architect) to process the visual fix.







---







## PART IV: DYNAMIC MCP ROUTING & CONTEXT ENGINE







The Orchestrator possesses autonomous command over system integrations, interacting natively with bash execution tools.







### 1. The MCP Fetcher Module & Permissions







* **Dynamic Fetching:** If a requested task requires an unknown integration, the Orchestrator will autonomously use the terminal to git clone [mcp-repo], run npm install (or equivalent), and map the server context.



* **Permission Matrix:**



* If the user has toggled **"Always Allow"** (similar to Codex), permissions are granted globally, and the Orchestrator installs and mounts the MCP silently.



* If not, the Orchestrator must pause and ask the user in chat: *"Do you want this MCP available globally or just for this workspace?"* It then configures environment variables accordingly.















### 2. Mandatory Pre-Flight Checks







* **Code-Review-Graph Requirement:** Hardcode a system rule in the Orchestrator: If the project involves software engineering, it **must** autonomously download, initialize, and load the code-review-graph MCP server to analyze repository impact and map dependencies *before* any code generation begins.







---







## PART V: MULTI-AGENT TAXONOMY & THE INNER LOOP







The Orchestrator defines boundaries and spins up specialized, gender-neutral sub-agents. These agents operate via nested chat threads (the Inner Loop) and are highly skilled in specific domains.







### 1. The Lifecycle Protocol (Hands-On / Hands-Off)







Every sub-agent is strictly governed by a documentation lifecycle visible in the MD reader:







* **Initialization (HANDS_ON_[AGENT_NAME].md):** Generated in the Artifacts directory upon spawning. Contains the exact prompt, boundaries, and global skills assigned by the Orchestrator.



* **Completion (HANDS_OFF_[AGENT_NAME].md):** Generated upon finishing the task. Summarizes what was built, testing status, code diffs, and triggers the graceful exit/toast notification.







### 2. The Agent Roster







* **@orchestrator**: The Team Lead. Manages client communication, dynamic routing, MCP installations, permissions, and task definitions. Evaluates user input and either asks agents, kills/spins new agents, or requests user input.



* **@principal-swe**: Handles complex backend architectures, high-concurrency systems, database internals, and microservices migrations.



* **@ui-architect**: Specializes in frontend frameworks, reactive state management, and integrating JS rendering libraries.



* **@3d-graphics-engineer**: Specialized in WebGL, computational geometry, and rendering pipelines for specialized web-based software.



* **@researcher**: Deep-dive information gathering, web scraping, document synthesis, and competitor analysis.



* **@ad-strategist**: Plans marketing campaign bounds, promotional offer logistics, and platform-specific advertising.



* **@designer**: Executes visual tasks, graphic design, and layout formatting for pamphlets and ad asset creation.



* **@devops**: Handles Docker, Kubernetes, CI/CD pipelines, and local environment/server configurations.



* **@qa-tester**: The dedicated code quality enforcer. Writes automated test suites and ensures code coverage mandates.



* **@cv-tester**: The dedicated visual QA agent. Uses computer vision to test GUI applications autonomously.







### 3. Execution Capabilities (PC Actions)







Sub-agents are equipped with powerful local interaction tools:







* **Terminal & Scripting:** Agents can run scripts, execute terminal commands, and implement state-change listeners (cron, polling, sleep). They check global permissions before execution.



* **Headless Browser Engine:** Integration with Puppeteer/Playwright allows deep access to read console logs, intercept network requests, inject automation scripts, and interact using a virtual mouse (mirroring human interaction, akin to the Claude Chrome extension).







---







## PART VI: THE AUTONOMOUS TEST -> FIX -> TEST LOOP & QA MANDATES







Quality assurance is entirely decoupled and autonomous. The creator (e.g., @principal-swe) is strictly forbidden from being the sole reviewer of their own work.







### 1. The 95% Coverage Enforcement Pipeline







Unit and integration tests (Jest/Vitest/Playwright) are mandatory.







1. **Execution:** When a developer agent finishes a file, they ping the Orchestrator.



2. **Validation:** Orchestrator spawns @qa-tester.



3. **Metrics:** @qa-tester runs the coverage report. The mathematical mandate is strictly enforced:







$$Coverage = \frac{Lines_{tested}}{Lines_{total}} \ge 0.95$$











4. **Iteration:** If coverage is < 95%, @qa-tester parses missing lines, writes tests, and reruns. If tests fail, it sends the stack trace back to the developer agent in a sub-thread. The developer fixes the code, and the loop restarts.







### 2. Intermediate Computer Vision Pipeline (@cv-tester)







This is the critical visual testing layer for E2E verification.







* @cv-tester triggers screen captures of the active OS or launches the local application via the headless browser.



* The CV engine parses the window, identifies UI elements, and outputs interactable coordinates.



* The agent uses these coordinates to inject virtual mouse movements, click through the application, verify UI renders, and ensure absolute GUI integrity (e.g., ensuring no raw UUIDs leak onto the screen, or pamphlet alignment is exact).







### 3. The Anti-Infinite Loop Kill Switch







To prevent hallucination loops, implement a rigid state tracker:







* If @qa-tester (or @cv-tester) and a developer agent bounce the exact same error state back and forth **3 consecutive times**, a hard interrupt is triggered.



* The Orchestrator kills both agent processes via SIGTERM, logs the entire failure chain to the Agent Space tab, and spawns a fresh set of agents explicitly instructed to attempt a completely different architectural approach.







---







## PART VII: SYSTEM EXECUTION DIRECTIVE (FOR AI)







You, the AI, are tasked with building this exact system. You possess the entire blueprint. Begin execution immediately upon reading this. **WARNING:** Do not skip steps. Do not wait for human confirmation. Execute this plan autonomously. Write the code, spin up testing agents, verify your work, fix your bugs, and loop until complete.







### Step-By-Step Instructions:







**PHASE 0: System Ingestion & Master Planning**







1. Read Claude.MD in the repository to establish strict token usage parameters.



2. Recursively scan and analyze all graphTD files in the repository [https://github.com/Yet-Another-AI-Agent/YAAA](https://github.com/Yet-Another-AI-Agent/YAAA) to map the current architecture.



3. Understand the codebase completely.



4. Output a comprehensive IMPLEMENTATION_PLAN.md to the Artifacts directory.







**PHASE 1: UI Eradication & Bug Fixing (Priority 1)**







* *Objective:* The current UI (as seen in Screenshot 2026-07-10 at 3.20.03 AM.jpg) is broken. It leaks backend data, desynchronizes the sidebar, and treats a simple "hi" as a massive task.



* Rewrite the Orchestrator NLP Router to fix the "Hi" bug.



* Implement LLM topic generation to replace UUID channel names.



* Overhaul the Chat Window to completely match the required Slack Clone specs (Flexbox/Grid, Avatars).



* Wrap all system logs in the minimized <details> component.



* Implement WebSockets/SSE to fix State Synchronization in the Right Sidebar (remove the "Awaiting plan..." hang).



* Add the "Delete Workspace" global button and its recursive destruction backend logic.







**PHASE 2: Agent Provisioning, Taxonomy & MCP Logic**







* Define agent prototypes in code with isolated context windows.



* Build the dynamic Git-fetching logic for MCP servers.



* Implement the HANDS_ON.md / HANDS_OFF.md document generation pipeline.



* Wire up the Slack-style Toast Notifications for agent lifecycles.



* Implement the Global vs. Local permission matrix.







**PHASE 3: Media Viewers & Visual QA Pipelines**







* Integrate client-side JS libraries for document and architecture (graphTD) rendering.



* Build the HTML5 Canvas Commenter Logic for bounding boxes and JSON payloads.



* Construct the fully autonomous Test -> Fix -> Test loop, including the 95% coverage pipeline, Headless Browser setup, and Computer Vision injection script.







**PHASE 4: Autonomous Run**







* I am going to sleep. Proceed to execute the plan completely autonomously.



* For every piece of code you write, rely on the E2E and CV testing pipelines to verify your own work.



* If the UI does not look like Slack, write a fix and test again.



* Do not stop, do not ask for my input, and do not exit until all phases are complete and the autonomous loops are fully functional.