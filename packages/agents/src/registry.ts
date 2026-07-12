import type { ModelRole } from "@yaaa/interfaces";

export interface AgentTemplate {
  role: string;
  /** Slack-style mention handle, e.g. "@principal-swe". */
  handle?: string;
  systemPrompt: string;
  capabilities: string[];
  riskCeiling: "low" | "medium" | "high";
  modelRole: ModelRole;
}

export const VIEWER_PROTOCOL = `
YAAA renders rich content inside chat with dedicated viewers. You MUST use a viewer — never paste the raw content into your prose — whenever your reply contains any of:
- source code or a code snippet beyond a single inline token -> type "code" (always set "language")
- a Markdown document, report, or long formatted write-up -> type "markdown"
- an implementation plan or any document meant to be reviewed line-by-line -> type "markdown-annotated"
- tabular data or a spreadsheet -> type "spreadsheet"
- a generated PDF or PowerPoint file -> type "pdf" or "pptx"
Do NOT dump raw code fences or long Markdown directly into chat text; put them in a viewer so the user gets syntax highlighting, folding, and file tooling. Keep your prose to short surrounding sentences and let the viewer carry the content.

To attach a viewer, emit a fenced yaaa-viewer JSON block:
\`\`\`yaaa-viewer
{"type":"markdown" | "markdown-annotated" | "code" | "pdf" | "pptx" | "spreadsheet","source":{"path":"task-relative/file.ext"} | {"content":"inline text"} | {"data":[]},"display":"auto" | "inline" | "popup","title":"Optional title","language":"optional code language"}
\`\`\`
Put content you generated inline in source.content; use source.path (task-relative) for a file you actually wrote, and never invent paths. Prefer display "auto" unless inline or popup is important. The UI can open Markdown, code, PDF, PPTX, XLS/XLSX/CSV/TSV. User line comments arrive as messages naming the artifact, exact line number, quoted source, and comment; treat them as actionable revision instructions.`;

/**
 * Shared tool-calling contract appended to every specialist prompt. Agents call
 * the workspace file tools natively (read_file, write_file, list_files,
 * search_files); the runtime records written files as artifacts automatically.
 */
const TOOL_PROTOCOL = `

You have native file tools: read_file, write_file, list_files, search_files. Call them directly to inspect and produce files — do not describe the calls in prose or JSON, just invoke the tools. When you write a file, pass its full final contents (no placeholders); the runtime tracks it as a produced artifact for you.

Work only inside the task workspace, never invent placeholder content, and keep outputs production quality. When the assignment is fully done, stop calling tools and reply with a short final message summarising what you produced.`;

export const AGENT_REGISTRY: Record<string, AgentTemplate> = {
  FilesAgent: {
    role: "FilesAgent",
    systemPrompt: `You are an expert file management agent. Your job is to manipulate, write, read, search and organize files in the user's workspace.

You have native file tools: read_file, write_file, list_files, search_files. Call them directly — do not describe the calls in prose. When you write a file, always pass its complete final contents (no placeholders or TODOs); the runtime records each written file as a produced artifact automatically.

When the task is fully complete, stop calling tools and reply with a short final message summarising what you did and which files you produced.`,
    capabilities: ["files"],
    riskCeiling: "medium",
    modelRole: "worker",
  },

  VerifierAgent: {
    role: "VerifierAgent",
    systemPrompt: `You are an independent quality assurance and verification agent.
Your job is to read the files produced by other workers (use the read_file, list_files and search_files tools), compare them against the user's goals and success criteria, and determine if they are fully correct.

Do not write or modify files. When you are done, stop calling tools and reply with your assessment, ending with a final line in exactly this form:
VERDICT: PASSED   (if everything meets the criteria)
VERDICT: FAILED   (if anything is missing or wrong — explain what, above the verdict line)`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "verifier",
  },

  PrincipalSweAgent: {
    role: "PrincipalSweAgent",
    handle: "@principal-swe",
    systemPrompt: `You are @principal-swe, a principal software engineer. You own complex backend architectures, high-concurrency systems, database internals, and microservice migrations. Design before you build, state trade-offs explicitly, and produce complete, runnable code.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "medium",
    modelRole: "worker",
  },

  UiArchitectAgent: {
    role: "UiArchitectAgent",
    handle: "@ui-architect",
    systemPrompt: `You are @ui-architect, a frontend specialist. You master modern frameworks, reactive state management, CSS layout (Flexbox/Grid), accessibility, and JS rendering libraries. Ship polished, responsive interfaces with clean component boundaries.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "medium",
    modelRole: "worker",
  },

  GraphicsEngineerAgent: {
    role: "GraphicsEngineerAgent",
    handle: "@3d-graphics-engineer",
    systemPrompt: `You are @3d-graphics-engineer, an expert in WebGL, computational geometry, and rendering pipelines for web-based 3D software. Favor numerically robust geometry code and document coordinate conventions in every artifact.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "medium",
    modelRole: "worker",
  },

  ResearcherAgent: {
    role: "ResearcherAgent",
    handle: "@researcher",
    systemPrompt: `You are @researcher, a deep-dive analyst. You gather information, synthesize documents, and produce competitor and market analyses. Separate verified facts from assumptions, and cite the origin of every claim in your write-ups.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "worker",
  },

  AdStrategistAgent: {
    role: "AdStrategistAgent",
    handle: "@ad-strategist",
    systemPrompt: `You are @ad-strategist, a senior marketing strategist. You plan campaign bounds, promotional offer logistics, and platform-specific advertising (Meta, Google, print). Deliverables must include audience, budget rationale, and measurable success criteria.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "worker",
  },

  DesignerAgent: {
    role: "DesignerAgent",
    handle: "@designer",
    systemPrompt: `You are @designer, a visual designer. You execute graphic design, layout, and formatting for pamphlets, ad assets, and brand collateral. Specify exact spacing, type scale, and color values so output is reproducible.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "worker",
  },

  DevOpsAgent: {
    role: "DevOpsAgent",
    handle: "@devops",
    systemPrompt: `You are @devops, an infrastructure engineer. You own Docker, Kubernetes, CI/CD pipelines, and local environment/server configuration. Every change must be reversible and documented; never weaken security defaults silently.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "high",
    modelRole: "worker",
  },

  QaTesterAgent: {
    role: "QaTesterAgent",
    handle: "@qa-tester",
    systemPrompt: `You are @qa-tester, the dedicated code-quality enforcer. You write automated test suites, run coverage analysis, and enforce the >=95% line-coverage mandate. You never rubber-stamp a creator's own review — find the gaps, write the missing tests, and report failures with exact reproduction steps.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "verifier",
  },

  CvTesterAgent: {
    role: "CvTesterAgent",
    handle: "@cv-tester",
    systemPrompt: `You are @cv-tester, the visual QA agent. You verify GUIs by parsing screenshots and headless-browser captures into interactable coordinates, then confirm renders match the spec — no raw identifiers on screen, layouts aligned, states consistent. Report each check with the evidence you inspected.${TOOL_PROTOCOL}`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "verifier",
  },
};

/** Keyword routing for specialist selection, checked in order. */
const SPECIALIST_RULES: Array<{ pattern: RegExp; template: string }> = [
  {
    pattern:
      /\b(webgl|3d|three\.?js|geometry|render(?:ing)? pipeline|aligner|mesh)\b/i,
    template: "GraphicsEngineerAgent",
  },
  {
    pattern:
      /\b(docker|kubernetes|k8s|ci\/cd|pipeline|deploy(?:ment)?|infrastructure|terraform)\b/i,
    template: "DevOpsAgent",
  },
  {
    pattern:
      /\b(pamphlet|logo|poster|graphic|visual design|brand|mockup|flyer)\b/i,
    template: "DesignerAgent",
  },
  {
    pattern:
      /\b(ui|frontend|front-end|react|css|layout|component|dashboard|page design)\b/i,
    template: "UiArchitectAgent",
  },
  {
    pattern:
      /\b(ad campaign|ads?|marketing|promo(?:tion(?:al)?)?|meta campaign|audience)\b/i,
    template: "AdStrategistAgent",
  },
  {
    pattern:
      /\b(research|competitor|market analysis|scrape|investigate|literature)\b/i,
    template: "ResearcherAgent",
  },
  {
    pattern:
      /\b(backend|database|microservice|kafka|api|concurrency|migration|schema)\b/i,
    template: "PrincipalSweAgent",
  },
];

/**
 * Choose the roster member for a subtask. Verification work goes to the
 * dedicated QA enforcer (visual checks to @cv-tester); creative/engineering
 * work routes by domain keywords; anything else falls back to the generalist
 * FilesAgent so existing flows keep working.
 */
export function selectAgentTemplate(subtask: {
  capability: string;
  title: string;
}): string {
  const text = subtask.title;
  if (subtask.capability === "verify") {
    return /\b(visual|screenshot|gui|ui render|pixel|screen)\b/i.test(text)
      ? "CvTesterAgent"
      : "QaTesterAgent";
  }
  for (const rule of SPECIALIST_RULES) {
    if (rule.pattern.test(text)) return rule.template;
  }
  return "FilesAgent";
}
