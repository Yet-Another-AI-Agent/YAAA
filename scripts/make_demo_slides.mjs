import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] || "/tmp/yaaa-demo-assets";
fs.mkdirSync(out, { recursive: true });
const yaaaLogo = `data:image/jpeg;base64,${fs.readFileSync("/Users/krishnarajk/Documents/projects/yaaa/apps/ui/src/assets/logo.jpg").toString("base64")}`;

const slides = [
  ["YAAA", "One workspace for ambitious work", "A mission-driven workspace where an orchestrator turns a goal into real, verifiable deliverables.", "MISSION → AGENTS → EVIDENCE → RESULT"],
  ["AIFIESTA", "Every model under one roof", "AIFiesta makes the model layer flexible: compare capabilities, route work deliberately, and keep the experience in one place.", "ONE ROOF  /  MANY MODELS  /  ONE WORKFLOW"],
  ["THE TOOLKIT", "Codex + Claude Cowork", "YAAA brings together the best parts of agentic development and collaborative computer work: coding, browsing, files, and review.", "BUILD  /  RESEARCH  /  CREATE  /  VERIFY"],
  ["ARCHITECTURE", "A simple mission loop", "The orchestrator plans the mission, agents work inside a shared task workspace, and artifacts, handoffs, and proof flow back into the mission.", "ORCHESTRATOR → WORKERS → ARTIFACTS → SUPERVISOR"],
  ["ADAPTIVE TEAMS", "Agents are chosen for the work", "Models are selected by capability, risk, and cost. After each result, YAAA can change the next agent’s role, model, and hands-on assignment.", "PLAN FIRST  /  OBSERVE  /  REDIRECT  /  VERIFY"],
  ["LIVE DEMO", "From request to finished presentation", "Now watch the mission in action: the goal becomes a plan, agents create the deck and visual assets, and the workspace keeps the evidence visible.", "SCREEN RECORDING 01 → SCREEN RECORDING 02"],
  ["THE RESULT", "A presentation ready to show", "The final step is the artifact itself: a real PowerPoint file, with visual assets, notes, and a clear proof trail.", "REAL FILE  /  REAL ASSETS  /  READY TO PRESENT"],
];

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function svg([eyebrow, title, body, footer]) {
  const brand = eyebrow === "AIFIESTA"
    ? `<g transform="translate(1510 150)"><circle cx="55" cy="55" r="48" fill="none" stroke="#57d7ff" stroke-width="5"/><circle cx="55" cy="55" r="18" fill="#8b5cf6"/><path d="M55 7v30M55 73v30M7 55h30M73 55h30M21 21l22 22M67 67l22 22M89 21L67 43M43 67L21 89" stroke="#57d7ff" stroke-width="5" stroke-linecap="round"/><text x="120" y="48" fill="#f7f8ff" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="700">AI FIESTA</text><text x="120" y="82" fill="#8d91b4" font-family="Arial,Helvetica,sans-serif" font-size="18" letter-spacing="3">MESH API</text></g>`
    : `<image href="${yaaaLogo}" x="1510" y="90" width="190" height="190" preserveAspectRatio="xMidYMid slice"/><text x="1730" y="210" fill="#8d91b4" font-family="Arial,Helvetica,sans-serif" font-size="22" letter-spacing="2">YAAA</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#090d1a"/><stop offset="1" stop-color="#171449"/></linearGradient><linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#36d4ff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#bg)"/><circle cx="1680" cy="130" r="260" fill="#4f46e5" opacity=".13"/><circle cx="220" cy="970" r="360" fill="#06b6d4" opacity=".08"/>
  <rect x="100" y="110" width="12" height="860" rx="6" fill="url(#glow)"/>${brand}<text x="170" y="190" fill="#57d7ff" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="700" letter-spacing="8">${escapeXml(eyebrow)}</text>
  <text x="170" y="405" fill="#f7f8ff" font-family="Arial,Helvetica,sans-serif" font-size="88" font-weight="700">${escapeXml(title)}</text>
  <foreignObject x="175" y="490" width="1300" height="220"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial,Helvetica,sans-serif;color:#c8cbe0;font-size:38px;line-height:1.35">${escapeXml(body)}</div></foreignObject>
  <text x="175" y="900" fill="#8d91b4" font-family="Arial,Helvetica,sans-serif" font-size="25" font-weight="700" letter-spacing="5">${escapeXml(footer)}</text><text x="1745" y="920" fill="#ffffff" opacity=".7" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="700">YAAA</text>
  </svg>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (let i = 0; i < slides.length; i++) {
  await page.setContent(`<body style="margin:0;background:#090d1a">${svg(slides[i])}</body>`);
  await page.screenshot({ path: path.join(out, `slide-${String(i + 1).padStart(2, "0")}.png`) });
}
await browser.close();
