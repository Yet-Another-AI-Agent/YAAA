# PowerPoint Generation Skill (PptxGenJS Documentation)

The PowerPoint Generation Skill enables agents and sub-agents to programmatically generate modern, styled Microsoft PowerPoint `.pptx` presentations using **PptxGenJS**.

---

## 1. Overview & Setup

`pptxgenjs` is a standalone JavaScript library that produces real `.pptx` files compatible with Microsoft PowerPoint, Google Slides, and Apple Keynote.

### Installation
```bash
npm install pptxgenjs
```

### Basic Initialization
```typescript
import PptxGenJS from "pptxgenjs";

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_16x9"; // Supported: LAYOUT_16x9, LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE
pptx.title = "Executive Summary";
pptx.author = "YAAA AI Agent System";
```

---

## 2. Slide Creation & Layouts

### Adding Slides & Masters
```typescript
// Define a Master Slide Template for consistent theme
pptx.defineSlideMaster({
  title: "MASTER_SLIDE",
  background: { color: "1E1E2E" },
  objects: [
    { rect: { x: 0, y: 0, w: "100%", h: 0.8, fill: { color: "2D2B42" } } },
    { text: { text: "YAAA Technical Brief", options: { x: 0.5, y: 0.2, fontFace: "Helvetica", fontSize: 18, color: "FFFFFF", bold: true } } },
    { line: { x: 0, y: 7.0, w: "100%", h: 0, line: { color: "A78BFA", width: 2 } } }
  ],
  slideNumber: { x: 12.0, y: 7.1, fontFace: "Courier", fontSize: 10, color: "A6ADC8" }
});

// Add slide using master
const slide = pptx.addSlide({ masterName: "MASTER_SLIDE" });
```

---

## 3. Text & Typography

### Adding Styled Text Blocks
```typescript
slide.addText("Building Autonomous AI Agent Architectures", {
  x: 0.8,
  y: 1.5,
  w: 11.5,
  h: 1.0,
  fontFace: "Arial",
  fontSize: 32,
  color: "F5E0DC",
  bold: true,
  align: "left",
  margin: 5
});

// Bullet List Paragraphs
slide.addText([
  { text: "Multi-loop orchestration architecture\n", options: { bullet: true, fontSize: 18, color: "CDD6F4" } },
  { text: "Durable SQLite event sourcing and WAL logging\n", options: { bullet: true, fontSize: 18, color: "CDD6F4" } },
  { text: "Sub-second event bus notification layer", options: { bullet: true, fontSize: 18, color: "CDD6F4" } }
], {
  x: 0.8,
  y: 2.8,
  w: 11.0,
  h: 3.5
});
```

---

## 4. Tables & Data Presentation

### Creating Styled Tables
```typescript
const rows = [
  [
    { text: "Component", options: { bold: true, color: "FFFFFF", fill: { color: "585B70" } } },
    { text: "Role", options: { bold: true, color: "FFFFFF", fill: { color: "585B70" } } },
    { text: "Performance", options: { bold: true, color: "FFFFFF", fill: { color: "585B70" } } }
  ],
  ["OuterLoop", "Orchestration & Task Planning", "< 50ms dispatch"],
  ["InnerLoop", "ReAct Tool Execution", "Parallel worker threads"],
  ["Supervisor", "Real-time Course Correction", "Sub-subtask validation"]
];

slide.addTable(rows, {
  x: 0.8,
  y: 2.5,
  w: 11.5,
  colW: [2.5, 6.0, 3.0],
  border: { pt: 1, color: "45475A" },
  fontFace: "Helvetica",
  fontSize: 14,
  color: "BAC2DE",
  align: "left"
});
```

---

## 5. Charts & Visual Graphs

### Adding Charts (Bar, Line, Pie)
```typescript
const chartData = [
  {
    name: "Task Velocity",
    labels: ["Phase 1", "Phase 2", "Phase 3", "Phase 4"],
    values: [12, 28, 45, 60]
  }
];

slide.addChart(pptx.ChartType.bar, chartData, {
  x: 0.8,
  y: 2.2,
  w: 11.5,
  h: 4.5,
  barDir: "col",
  chartColors: ["A78BFA", "89B4FA", "74C7EC", "A6E3A1"],
  showLegend: true,
  legendPos: "r",
  showTitle: true,
  title: "Subtask Completion Rates"
});
```

---

## 6. Shapes, Cards, & Layout Containers

```typescript
// Background Card Container
slide.addShape(pptx.ShapeType.roundRect, {
  x: 0.8,
  y: 2.0,
  w: 5.5,
  h: 4.5,
  rectRadius: 0.1,
  fill: { color: "181825" },
  line: { color: "313244", width: 1.5 }
});
```

---

## 7. Export & File Saving

### Saving Presentation to Disk
```typescript
// Save to file (Node.js environment)
await pptx.writeFile({ fileName: "presentation.pptx" });
```

---

## 8. Best Practices for Agents

1. **Use Aspect Ratio 16:9** (`LAYOUT_16x9`).
2. **Harmonious Palette**: Use modern dark palette (`#1E1E2E`, `#A78BFA`, `#CDD6F4`, `#181825`).
3. **Structured Content**: Keep slide text concise; use cards, tables, and charts rather than wall-of-text paragraphs.
4. **Clean Margins**: Maintain 0.8 inch padding from left and top edges.

---

## 9. Advanced Reference Documentation & Links

- **Official PptxGenJS Documentation**: [https://gitbrent.github.io/PptxGenJS/](https://gitbrent.github.io/PptxGenJS/)
- **GitHub Repository & Releases**: [https://github.com/gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS)
- **Advanced Topics & Guides**:
  - **Master Slides & Templates**: [https://gitbrent.github.io/PptxGenJS/docs/masters.html](https://gitbrent.github.io/PptxGenJS/docs/masters.html) (defining re-usable slide layouts, header bars, and slide number placeholders).
  - **Native Chart API Reference**: [https://gitbrent.github.io/PptxGenJS/docs/api-charts.html](https://gitbrent.github.io/PptxGenJS/docs/api-charts.html) (configuring Bar, Line, Pie, Doughnut, Area, Radar, and Scatter charts).
  - **Table Formatting & Cell Spanning**: [https://gitbrent.github.io/PptxGenJS/docs/api-tables.html](https://gitbrent.github.io/PptxGenJS/docs/api-tables.html) (colspan, rowspan, background fills, borders, font alignments).
  - **Shape Vectors & Drawing**: [https://gitbrent.github.io/PptxGenJS/docs/api-shapes.html](https://gitbrent.github.io/PptxGenJS/docs/api-shapes.html) (custom geometry shapes, callouts, arrows, process flow diagrams).
  - **Media & Audio/Video Embeds**: [https://gitbrent.github.io/PptxGenJS/docs/api-media.html](https://gitbrent.github.io/PptxGenJS/docs/api-media.html) (embedding MP4 videos, MP3 audio, and web video links directly inside slides).
  - **Node.js Stream & Base64 Output**: [https://gitbrent.github.io/PptxGenJS/docs/output.html](https://gitbrent.github.io/PptxGenJS/docs/output.html) (`pptx.stream()`, `pptx.write("base64")`, and `pptx.writeFile()` for serverless and agent pipe environments).
