export type SkillCategory =
  | "ppt"
  | "pdf"
  | "web-access"
  | "word"
  | "canvas"
  | "3d-graphics"
  | "chart"
  | "code-generation";

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  markdownPath: string;
  content: string;
}

// Embedded Skill Definitions with comprehensive markdown documentation
const PPT_SKILL_DOC = `# PowerPoint Generation Skill (PptxGenJS Documentation)
... (PptxGenJS layout, text, tables, charts, slides, export) ...

## Advanced Reference Documentation & Links
- Official Site: https://gitbrent.github.io/PptxGenJS/`;

const PDF_SKILL_DOC = `# PDF Document Generation Skill (PDFKit & jsPDF Documentation)
... (PDFKit & jsPDF layout, styling, text, tables, images, buffer output) ...

## Advanced Reference Documentation & Links
- Official Site: https://pdfkit.org/`;

const WEB_ACCESS_SKILL_DOC = `# Web Access & Headless Browser Automation Skill
... (browser_navigate_and_wait, refresh, go_back, go_back_times, go_front, go_front_times, browser_multi, forms, DOM) ...

## Advanced Reference Documentation & Links
- Official Site: https://playwright.dev/docs/api/class-playwright`;

const WORD_SKILL_DOC = `# Word Document Generation Skill (docx npm Package Documentation)
... (docx Paragraphs, TextRuns, Tables, TableRows, TableCells, Headings, Styles, .docx file export) ...

## Advanced Reference Documentation & Links
- Official Site: https://docx.js.org/`;

const CANVAS_SKILL_DOC = `# Canvas 2D Generation Skill (HTML5 Canvas & node-canvas Documentation)
... (2D rendering context, path drawing, shapes, gradients, image compositing, text, PNG export, crop/resize, alpha/background removal, format conversion, and image layering with sharp) ...

## Advanced Reference Documentation & Links
- Official Site: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API`;

const THREE_D_SKILL_DOC = `# 3D Graphics Skill (Three.js Documentation)
... (Three.js Scene, PerspectiveCamera, WebGLRenderer, Geometries, Materials, Lighting, Meshes, Animation) ...

## Advanced Reference Documentation & Links
- Official Site: https://threejs.org/docs/`;

const CHART_SKILL_DOC = `# Chart Generation Skill (Chart.js & chartjs-node-canvas Documentation)
... (Bar, Line, Pie, Doughnut, Radar charts, dataset config, scales, tooltips, Node canvas rendering, PNG export) ...

## Advanced Reference Documentation & Links
- Official Site: https://www.chartjs.org/docs/latest/`;

const CODE_GENERATION_SKILL_DOC = `# Bounded Code Generation Skill
Use a graph-guided, scope-bounded workflow for repository code changes. Prefer exact symbols and line ranges, use targeted read/write operations, batch only scoped file work with file_multi, and consolidate final evidence in one handOff.md.

Full-write contract: a successful write_file creates a path once. After created or unchanged, continue to the next file or verification; never regenerate that path with write_file. Use read_file_lines followed by write_file_lines for targeted corrections. Complete matching implementation sub-subtasks when concrete artifacts are created, but leave verification steps pending until evidence exists.

## Advanced Reference Documentation & Links
- Official Site: https://tree-sitter.github.io/tree-sitter/`;

function loadMarkdownContent(fileName: string, fallback: string): string {
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      const getReq = new Function("moduleName", "return require(moduleName)");
      const fs = getReq("node:fs");
      const path = getReq("node:path");
      const url = getReq("node:url");
      const filename = url.fileURLToPath(import.meta.url);
      const dirname = path.dirname(filename);
      const filePath = path.join(dirname, fileName);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    }
  } catch {
    // Fall back to embedded content in browser / Vite / virtual bundlers
  }
  return fallback;
}

function resolveMarkdownPath(fileName: string): string {
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      const getReq = new Function("moduleName", "return require(moduleName)");
      const path = getReq("node:path");
      const url = getReq("node:url");
      const filename = url.fileURLToPath(import.meta.url);
      const dirname = path.dirname(filename);
      return path.join(dirname, fileName);
    }
  } catch {
    // Fall back
  }
  return `skills/${fileName}`;
}

export const SKILL_REGISTRY: Record<SkillCategory, Skill> = {
  ppt: {
    id: "ppt-skill",
    name: "PowerPoint Generation Skill",
    category: "ppt",
    description: "Generate styled Microsoft PowerPoint (.pptx) presentations using PptxGenJS with custom themes, tables, and charts.",
    markdownPath: resolveMarkdownPath("ppt-skill.md"),
    content: loadMarkdownContent("ppt-skill.md", PPT_SKILL_DOC),
  },
  pdf: {
    id: "pdf-skill",
    name: "PDF Document Generation Skill",
    category: "pdf",
    description: "Generate structured PDF reports, invoices, and audit documents using PDFKit and jsPDF.",
    markdownPath: resolveMarkdownPath("pdf-skill.md"),
    content: loadMarkdownContent("pdf-skill.md", PDF_SKILL_DOC),
  },
  "web-access": {
    id: "web-access-skill",
    name: "Web Access & Browser Skill",
    category: "web-access",
    description: "Inspect, navigate, test, and scrape websites using built-in Chromium browser automation, refresh, and history tools.",
    markdownPath: resolveMarkdownPath("web-access-skill.md"),
    content: loadMarkdownContent("web-access-skill.md", WEB_ACCESS_SKILL_DOC),
  },
  word: {
    id: "word-skill",
    name: "Word Document Skill",
    category: "word",
    description: "Generate styled Word (.docx) documents with paragraphs, tables, headings, headers, and footers using the docx package.",
    markdownPath: resolveMarkdownPath("word-skill.md"),
    content: loadMarkdownContent("word-skill.md", WORD_SKILL_DOC),
  },
  canvas: {
    id: "canvas-skill",
    name: "Canvas 2D Generation Skill",
    category: "canvas",
    description: "Create and manipulate 2D images: draw sprites and diagrams, crop/resize, remove backgrounds, composite layers, add text, and export verified PNG/JPEG/WebP assets using Canvas, node-canvas, and sharp.",
    markdownPath: resolveMarkdownPath("canvas-skill.md"),
    content: loadMarkdownContent("canvas-skill.md", CANVAS_SKILL_DOC),
  },
  "3d-graphics": {
    id: "3d-graphics-skill",
    name: "3D Graphics Skill",
    category: "3d-graphics",
    description: "Create WebGL 3D scenes, camera controls, lighting, geometries, materials, and GLTF models using Three.js.",
    markdownPath: resolveMarkdownPath("3d-graphics-skill.md"),
    content: loadMarkdownContent("3d-graphics-skill.md", THREE_D_SKILL_DOC),
  },
  chart: {
    id: "chart-skill",
    name: "Chart Generation Skill",
    category: "chart",
    description: "Render and export Bar, Line, Pie, Doughnut, and Radar data visualization charts using Chart.js and chartjs-node-canvas.",
    markdownPath: resolveMarkdownPath("chart-skill.md"),
    content: loadMarkdownContent("chart-skill.md", CHART_SKILL_DOC),
  },
  "code-generation": {
    id: "code-generation-skill",
    name: "Bounded Code Generation Skill",
    category: "code-generation",
    description: "Generate and modify repository code with graph-guided scope, targeted line operations, bounded context, and evidence-backed handoff.",
    markdownPath: resolveMarkdownPath("code-generation-skill.md"),
    content: loadMarkdownContent("code-generation-skill.md", CODE_GENERATION_SKILL_DOC),
  },
};

export function getSkill(idOrCategory: string): Skill | undefined {
  if (idOrCategory in SKILL_REGISTRY) {
    return SKILL_REGISTRY[idOrCategory as SkillCategory];
  }
  return Object.values(SKILL_REGISTRY).find((s) => s.id === idOrCategory || s.category === idOrCategory);
}

export function getMatchingSkills(taskOrCapability: string): Skill[] {
  const query = taskOrCapability.toLowerCase();
  const matched: Skill[] = [];

  if (query.includes("ppt") || query.includes("powerpoint") || query.includes("presentation") || query.includes("slide")) {
    matched.push(SKILL_REGISTRY.ppt);
  }
  if (/\b(?:pdf|report|invoice|document|documentation)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY.pdf);
  }
  if (query.includes("web") || query.includes("browser") || query.includes("scrape") || query.includes("navigate") || query.includes("site")) {
    matched.push(SKILL_REGISTRY["web-access"]);
  }
  if (/\b(?:word|docx?|\.docx)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY.word);
  }
  // A game/2D task commonly uses Canvas for sprites or programmatic art. Keep
  // this intentionally explicit: generic words such as "graphics" must not
  // imply Three.js, and generic chart words such as "line" must not imply
  // Chart.js.
  if (/\b(?:canvas|2d|drawing|sprite|pixel\s*art|game|phaser|pixi)\b/i.test(query) || /\b(?:image\s+manipulation|remove\s+(?:the\s+)?background|background\s+removal|crop(?:ping)?|resize|composite|merge\s+images?|text\s+overlay|watermark|transparent\s+(?:png|background)|image\s+asset)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY.canvas);
  }
  if (/\b(?:3d|webgl|three(?:\.js)?|three-dimensional|gltf)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY["3d-graphics"]);
  }
  if (/\b(?:chart|chart\.js|data\s+visuali[sz]ation|bar\s+chart|line\s+chart|pie\s+chart|doughnut|radar\s+chart)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY.chart);
  }
  if (/\b(?:code|coding|program|programming|implement|implementation|repository|repo|software|application|typescript|javascript|python|bug|refactor|function|class|api|game|phaser|ui)\b/i.test(query)) {
    matched.push(SKILL_REGISTRY["code-generation"]);
  }

  return matched;
}
