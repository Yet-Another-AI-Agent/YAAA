# Chart Generation Skill (Chart.js & chartjs-node-canvas Documentation)

The Chart Generation Skill enables agents and sub-agents to programmatically build data visualizations, charts (Bar, Line, Pie, Doughnut, Radar, Polar Area, Scatter), and export them as standalone image files using **Chart.js** and **chartjs-node-canvas**.

---

## 1. Overview & Setup

### Installation
```bash
npm install chart.js chartjs-node-canvas canvas
```

### Basic Initialization (Server-Side Node Export)
```typescript
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import fs from "node:fs";

const width = 800; // px
const height = 500; // px
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: "#181825" });
```

---

## 2. Bar Chart Configuration

```typescript
const barChartConfig = {
  type: "bar" as const,
  data: {
    labels: ["Phase 1: Setup", "Phase 2: Canvas", "Phase 3: Logic", "Phase 4: Test"],
    datasets: [
      {
        label: "Subtask Velocity (ms)",
        data: [1200, 2400, 1800, 950],
        backgroundColor: [
          "rgba(167, 139, 250, 0.8)",
          "rgba(137, 180, 250, 0.8)",
          "rgba(116, 199, 236, 0.8)",
          "rgba(166, 227, 161, 0.8)"
        ],
        borderColor: ["#A78BFA", "#89B4FA", "#74C7EC", "#A6E3A1"],
        borderWidth: 2,
        borderRadius: 6
      }
    ]
  },
  options: {
    responsive: false,
    plugins: {
      title: {
        display: true,
        text: "Agent Subtask Completion Latency",
        color: "#CDD6F4",
        font: { size: 20, weight: "bold" }
      },
      legend: {
        labels: { color: "#BAC2DE", font: { size: 14 } }
      }
    },
    scales: {
      x: {
        ticks: { color: "#A6ADC8", font: { size: 12 } },
        grid: { color: "rgba(69, 71, 90, 0.4)" }
      },
      y: {
        ticks: { color: "#A6ADC8", font: { size: 12 } },
        grid: { color: "rgba(69, 71, 90, 0.4)" }
      }
    }
  }
};
```

---

## 3. Line Chart Configuration (Multi-Dataset Trends)

```typescript
const lineChartConfig = {
  type: "line" as const,
  data: {
    labels: ["Turn 1", "Turn 2", "Turn 3", "Turn 4", "Turn 5"],
    datasets: [
      {
        label: "Context Window Tokens",
        data: [4200, 6800, 8900, 10500, 9200],
        borderColor: "#A78BFA",
        backgroundColor: "rgba(167, 139, 250, 0.2)",
        fill: true,
        tension: 0.4, // Smooth curved lines
        pointRadius: 6,
        pointHoverRadius: 8
      },
      {
        label: "Compaction Threshold (Ceiling)",
        data: [20000, 20000, 20000, 20000, 20000],
        borderColor: "#F38BA8",
        borderDash: [6, 6], // Dashed line
        fill: false
      }
    ]
  },
  options: {
    responsive: false,
    plugins: {
      title: { display: true, text: "Token Budget History", color: "#CDD6F4", font: { size: 18 } }
    }
  }
};
```

---

## 4. Doughnut & Pie Chart Configuration

```typescript
const doughnutChartConfig = {
  type: "doughnut" as const,
  data: {
    labels: ["Completed", "Running", "Pending"],
    datasets: [
      {
        data: [18, 3, 4],
        backgroundColor: ["#4ADE80", "#A78BFA", "#6C7086"],
        borderWidth: 0
      }
    ]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { position: "right" as const, labels: { color: "#CDD6F4" } }
    }
  }
};
```

---

## 5. Rendering & Exporting Chart PNG Image

```typescript
// Render Chart to Image Buffer (Node.js)
const imageBuffer = await chartJSNodeCanvas.renderToBuffer(barChartConfig as any);

// Save Image Buffer to Disk
fs.writeFileSync("chart_latency.png", imageBuffer);
```

---

## 6. Best Practices for Agents

1. **Dark Mode Theme**: Use dark backgrounds (`#181825`, `#1E1E2E`) and light fonts (`#CDD6F4`) for consistency with YAAA dashboard UI.
2. **Explicit Dimensions**: Set `width` and `height` explicitly in `ChartJSNodeCanvas` to ensure crisp rendering.
3. **Smooth Curvature**: Use `tension: 0.3` to `0.4` for line charts to make trend visualizations elegant.

---

## 7. Advanced Reference Documentation & Links

- **Official Chart.js Documentation**: [https://www.chartjs.org/docs/latest/](https://www.chartjs.org/docs/latest/)
- **chartjs-node-canvas GitHub Repository**: [https://github.com/Sean-Bradley/chartjs-node-canvas](https://github.com/Sean-Bradley/chartjs-node-canvas)
- **Chart.js Samples Showcase**: [https://www.chartjs.org/samples/latest/](https://www.chartjs.org/samples/latest/)
- **Advanced Topics & Guides**:
  - **Custom Chart Plugins & Hooks**: [https://www.chartjs.org/docs/latest/developers/plugins.html](https://www.chartjs.org/docs/latest/developers/plugins.html) (`beforeDraw`, `afterDraw`, `afterDatasetsDraw` lifecycle hooks for drawing custom target lines, watermark text, or status badges onto the canvas).
  - **Combo & Mixed Charts**: [https://www.chartjs.org/docs/latest/charts/mixed.html](https://www.chartjs.org/docs/latest/charts/mixed.html) (combining Bar and Line datasets within a single dual-axis chart).
  - **Custom Scales & Axes Formats**: [https://www.chartjs.org/docs/latest/axes/](https://www.chartjs.org/docs/latest/axes/) (configuring logarithmic scales, time series scales, multi-axis Y scales, and custom tick formatters).
  - **Canvas Gradient Datasets**: [https://www.chartjs.org/docs/latest/general/colors.html](https://www.chartjs.org/docs/latest/general/colors.html) (creating dynamic canvas line/bar color gradients with `ctx.createLinearGradient()`).
  - **Server-Side Node Export Options**: [https://github.com/Sean-Bradley/chartjs-node-canvas#usage](https://github.com/Sean-Bradley/chartjs-node-canvas#usage) (rendering SVG vectors, stream outputs, and JPEG buffers in headless server environments).
