import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = "/tmp/yaaa-demo-voiceover";
fs.mkdirSync(root, { recursive: true });

const chunks = [
  [10, "This is YAAA, pronounced Yeah. YAAA is a mission driven workspace where one goal becomes coordinated work, visible evidence, and a real deliverable."],
  [10, "AIFiesta is the model foundation underneath this idea. It brings many capable AI models under one roof, so the workflow can choose the right model without making the user manage separate tools."],
  [10, "YAAA also brings together the strengths of Codex and Claude Cowork: software engineering, computer use, browsing, file creation, and collaborative review."],
  [10, "The architecture is intentionally simple. A mission enters through the workspace, the orchestrator plans it, workers act inside a shared task folder, and evidence comes back for supervision."],
  [10, "This is an adaptive team. The first plan is a hypothesis. As each agent reports its result, YAAA can change the next role, model, hands on assignment, and verification path."],
  [10, "Now we move into the live demo. I will show what the user sees while YAAA turns a presentation request into a working team and a real PowerPoint file."],
  [10, "The finish line is not a Markdown outline. The finish line is a real presentation with visual assets, speaker notes, and a proof trail that another agent can inspect."],

  [31, "The demo begins with a natural language goal: create a five slide presentation about the solar system for a class ten student, and make it visually appealing. YAAA records the goal as a mission instead of treating it as a one off chat answer. The task is initialized, and the event stream becomes the running audit trail."],
  [31, "At the top of the center pane is the public mission conversation. This is where the user sees the original request, clarification questions, plan messages, agent updates, and final responses. The center pane is the narrative of the mission, while the execution details live alongside it rather than replacing it."],
  [31, "The thought row shows the orchestrator working through the next decision. It is deliberately compact: the user does not need the entire hidden reasoning transcript. Instead, YAAA surfaces useful milestones such as planning, routing, artifact inspection, and verification."],
  [31, "On the right is Mission Details. The mission team lists the orchestrator and every worker currently attached to this task. Each worker has a role, a model, and a status. This makes it clear who is working, what kind of specialist they are, and whether the task is still running or has completed."],
  [31, "The same side pane also exposes artifacts and the working folder. Artifacts are the concrete outputs: images, scripts, Markdown evidence, and the final PowerPoint. The working folder is the shared source of truth that lets a later agent inspect what an earlier agent actually produced."],
  [31, "When an agent starts, it receives an initial goal immediately. Before the model begins its first real turn, YAAA writes a hands on assignment. That assignment is specific to the current subtask and includes the success criteria, the available evidence, and the files the agent must inspect or produce."],
  [31, "This is important because a generic agent prompt is not enough for production work. The orchestrator can say: continue from the existing deck, fix alignment on slide three, create the missing images, or verify the speaker notes. The assignment changes with the evidence instead of repeating the original chat."],
  [31, "The agent space is the operational view. It shows the named agents, their models, their current assignment, their tool activity, and their artifact trail. The public chat tells the story for the user; Agent Space shows the team actually doing the work."],
  [31, "Notice the distinction between a plan and a running team. The initial plan may contain one broad document subtask because the work can start with one capable creator. If that agent returns only an outline or discovers a blocker, the supervisor can spawn a new continuation agent with a different role and a different model."],
  [31, "Model selection is cost aware. Bounded file operations and verification use a lower cost model. Research, presentation generation, difficult debugging, and visual work can use a stronger model. The reason for the choice is shown in the interface so model use is not mysterious."],
  [31, "The handoff and proof of work files make the transition explicit. A handoff records what was done, what remains, what failed, and what the next agent should not repeat. Proof of work records concrete paths and checks. This prevents the next agent from searching the web or rebuilding a file that already exists."],
  [31, "The artifact gate is another important part of the architecture. If the mission asks for a PowerPoint, a Markdown outline does not count as completion. YAAA checks the workspace for the real PPTX and for image assets before allowing the task to pass verification."],
  [31, "Shell-created files are included too. If an agent runs a script with pptxgenjs and the script writes the presentation directly, YAAA scans the workspace before publishing the result. The final file is therefore visible to the verifier even when it was not created through a text file tool."],
  [31, "At this point the worker is creating the actual deck. The images are written into the task workspace, the PowerPoint is compiled, and the proof and handoff documents are generated beside it. The user can inspect the work without reading the entire model conversation."],
  [31, "The supervisor then compares the result against the mission goal and success criteria. If the presentation is complete, the work can finish. If alignment, assets, slide count, or notes are missing, the supervisor redirects the next agent with a concrete correction instead of accepting a confident but incomplete summary."],
  [31, "That is the main idea of YAAA: the plan starts the work, but evidence changes the next step. A later agent can become a document specialist, a designer, a browser researcher, or a visual tester. The role is chosen for the problem that exists now, not only for the problem we imagined at the beginning."],
  [31, "The first recording ends with the mission workspace showing the accumulated work. We now move to the refinement pass, where a user correction is treated as a new instruction inside the same mission rather than as a brand new unrelated conversation."],

  [27, "In this second part, I ask YAAA to correct the presentation alignment. The request goes back to the orchestrator, which keeps the existing files and routes the correction to the active work. The agent should inspect the current deck first, then change only what the evidence says needs changing."],
  [27, "This is where hands on instructions matter most. The next agent is not told to start over. It is told which artifact to open, what visual issue to correct, and what success would look like. If the previous role is not the best fit, YAAA can change the next role or model before spawning the continuation."],
  [27, "The side pane continues to show the team and artifacts while the center pane shows the user-facing progress. That separation makes the workflow understandable: one surface explains the mission, another explains who is doing the work, and the files remain the durable evidence."],
  [27, "YAAA can also run functional and visual tests on the generated presentation. I have kept that verification step off in this demo to save tokens, but the architecture supports a verifier agent that can inspect the PPTX, render slides, check alignment, and report concrete findings."],
  [24, "Finally, the presentation is shown as the real deliverable. The point of the demo is not that an agent can write a description of a deck. The point is that YAAA can coordinate the work, preserve the evidence, adapt the team, and deliver a file that is ready to open and present."],
  [10, "This concludes the YAAA demo. YAAA, pronounced Yeah, is the layer that turns model capability into an observable, adaptive mission workflow."],
];

const voice = "Karen";
const concat = [];
for (let index = 0; index < chunks.length; index += 1) {
  const [seconds, text] = chunks[index];
  const stem = path.join(root, String(index).padStart(2, "0"));
  const speech = `${stem}.aiff`;
  const padded = `${stem}.wav`;
  execFileSync("say", ["-v", voice, "-r", "175", "-o", speech, text], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", speech, "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=22050", "-filter_complex", "[0:a]apad[a]", "-map", "[a]", "-t", String(seconds), "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", padded], { stdio: "inherit" });
  concat.push(`file '${padded}'`);
}
fs.writeFileSync(path.join(root, "concat.txt"), `${concat.join("\n")}\n`, "utf8");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(root, "concat.txt"), "-c:a", "pcm_s16le", "/tmp/yaaa-demo-voiceover.wav"], { stdio: "inherit" });
