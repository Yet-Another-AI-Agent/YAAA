# Canvas 2D Generation Skill (HTML5 Canvas & node-canvas Documentation)

The Canvas 2D Generation Skill provides full documentation for agents and sub-agents to generate 2D graphics, illustrations, game sprites, diagrams, and images using the **HTML5 Canvas API** and **node-canvas**.

---

## 1. Overview & Setup

### Installation
```bash
npm install canvas
```

### Basic Initialization (Node.js)
```typescript
import { createCanvas, loadImage } from "canvas";
import fs from "node:fs";

const width = 800;
const height = 600;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
```

---

## 2. Drawing Paths, Shapes & Polygons

```typescript
// Background Fill
ctx.fillStyle = "#1E1E2E";
ctx.fillRect(0, 0, width, height);

// Draw Grid Lines
ctx.strokeStyle = "rgba(167, 139, 250, 0.15)";
ctx.lineWidth = 1;
for (let x = 0; x < width; x += 40) {
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

// Rounded Rectangle Container
function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke: string) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

drawRoundedRect(ctx, 50, 50, 700, 500, 16, "#181825", "#A78BFA");
```

---

## 3. Gradients, Shadows & Glow Effects

```typescript
// Linear Gradient Header Text
const gradient = ctx.createLinearGradient(100, 0, 700, 0);
gradient.addColorStop(0, "#A78BFA");
gradient.addColorStop(0.5, "#89B4FA");
gradient.addColorStop(1, "#A6E3A1");

ctx.fillStyle = gradient;
ctx.font = "bold 36px 'Helvetica Neue', Arial, sans-serif";
ctx.textAlign = "center";

// Glow Effect
ctx.shadowColor = "rgba(167, 139, 250, 0.6)";
ctx.shadowBlur = 12;

ctx.fillText("Snake Game Canvas Engine", width / 2, 110);
ctx.shadowBlur = 0; // Reset shadow
```

---

## 4. Game Rendering (Snake Sprite & Grid Rendering)

```typescript
interface Point { x: number; y: number; }

function renderSnake(ctx: CanvasRenderingContext2D, snake: Point[], bodySize = 20) {
  snake.forEach((segment, idx) => {
    const isHead = idx === 0;
    ctx.fillStyle = isHead ? "#A6E3A1" : "#94E2D5";

    // Glow for head
    if (isHead) {
      ctx.shadowColor = "#A6E3A1";
      ctx.shadowBlur = 15;
    }

    ctx.beginPath();
    ctx.arc(segment.x * bodySize + bodySize / 2, segment.y * bodySize + bodySize / 2, bodySize / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}
```

---

## 5. Exporting Image to PNG/JPEG Buffer & File

```typescript
// Export Canvas to PNG File
const buffer = canvas.toBuffer("image/png");
fs.writeFileSync("canvas_preview.png", buffer);

// Export to JPEG with Quality Setting
const jpegBuffer = canvas.toBuffer("image/jpeg", { quality: 0.95 });
fs.writeFileSync("canvas_preview.jpg", jpegBuffer);
```

---

## 6. Image Manipulation and Asset Preparation

Use the smallest appropriate tool and preserve the original input. For Node.js image processing, prefer `sharp` for deterministic crop, resize, format conversion, compositing, alpha, and text-overlay workflows:

```bash
npm install sharp
```

Use `@imgly/background-removal-node` when an actual subject cutout is required and the environment allows model assets to be downloaded. For a local command-line workflow, ImageMagick (`magick`) is an acceptable fallback. Use `jimp` only when a pure-JavaScript fallback is needed. Check that the selected package or binary is available before relying on it; do not claim background removal succeeded without reopening the output and inspecting its alpha channel.

### Crop, resize, rotate, and convert

```typescript
import sharp from "sharp";

await sharp("input.jpg")
  .rotate() // respect EXIF orientation
  .resize({ width: 1200, height: 800, fit: "cover", position: "attention" })
  .extract({ left: 40, top: 20, width: 1120, height: 760 })
  .png({ compressionLevel: 9 })
  .toFile("output.png");
```

Use `fit: "contain"` when the full image must remain visible, `cover` when a fixed frame must be filled, and an explicit `extract` rectangle for reproducible crops. Never upscale a small source without recording that quality risk.

### Remove a background and preserve transparency

1. Read the source dimensions and format.
2. Run the approved background-removal library or segmentation tool.
3. Ensure the result is RGBA/PNG, not JPEG, so transparent pixels survive.
4. Reopen the result and verify it has an alpha channel and the subject is not clipped.

```typescript
// After a background-removal library returns a transparent PNG/blob:
await sharp(transparentPng)
  .ensureAlpha()
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile("subject-cutout.png");
```

### Merge images, layers, masks, and backgrounds

```typescript
const foreground = await sharp("subject-cutout.png")
  .resize({ width: 480 })
  .png()
  .toBuffer();

await sharp({ create: { width: 1200, height: 800, channels: 4, background: "#ffffff" } })
  .composite([
    { input: "background.jpg", blend: "over", gravity: "center" },
    { input: foreground, blend: "over", gravity: "center" },
  ])
  .png()
  .toFile("composite.png");
```

Use `blend: "over"` for normal layers, `multiply` for shading, `screen` for light effects, and an alpha mask when the merge boundary must be controlled. Keep layer order explicit and verify the final dimensions.

### Add text, labels, and watermarks

For robust text rendering, create an SVG text layer and composite it with `sharp`; this avoids relying on platform-specific Canvas font availability:

```typescript
const label = Buffer.from(`<svg width="1200" height="120"><text x="60" y="78" fill="white" font-size="48" font-family="Arial" font-weight="700">Sample label</text></svg>`);
await sharp("input.png").composite([{ input: label, top: 30, left: 30 }]).png().toFile("labeled.png");
```

Escape user-provided text before embedding it in SVG. For watermarks, use a semi-transparent fill, place the layer explicitly, and ensure the watermark does not cover required content.

### Image operations checklist

- Preserve the original file and write a new output artifact.
- Inspect dimensions, color space, format, and alpha before and after processing.
- Use PNG for transparency, JPEG/WebP for opaque photographic output, and SVG for vector text or shapes.
- Confirm crop bounds, orientation, and aspect ratio; do not silently stretch images.
- Reopen or render every produced asset and record the exact output path and verification evidence in `handOff.md`.
- For sensitive or copyrighted images, use only assets the task author is authorized to process.

## 7. Best Practices for Agents

1. **State Preservation**: Use `ctx.save()` before applying clip, rotate, or scale, and `ctx.restore()` afterwards.
2. **High DPI Crispness**: Scale canvas dimensions ($2\times$) for retina rendering when exporting preview assets.
3. **Shadow Reset**: Always reset `ctx.shadowBlur = 0` after text glow to avoid bleeding into vector shapes.

---

## 8. Advanced Reference Documentation & Links

- **MDN HTML5 Canvas API Reference**: [https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- **MDN Canvas 2D Context Documentation**: [https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D)
- **node-canvas GitHub Repository**: [https://github.com/Automattic/node-canvas](https://github.com/Automattic/node-canvas)
- **Advanced Topics & Guides**:
  - **Pixel Manipulation & ImageData**: [https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Pixel_manipulation_with_canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Pixel_manipulation_with_canvas) (`ctx.getImageData()`, `ctx.putImageData()`, custom image filters, thresholding, grayscale).
  - **Compositing & Blend Modes**: [https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation) (`source-over`, `destination-out`, `multiply`, `screen`, `overlay` composition modes).
  - **Transformations & Matrix Math**: [https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/transform](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/transform) (`ctx.scale()`, `ctx.rotate()`, `ctx.translate()`, `ctx.setTransform()` affine matrix manipulation).
  - **SVG Path Parsing on Canvas**: [https://developer.mozilla.org/en-US/docs/Web/API/Path2D](https://developer.mozilla.org/en-US/docs/Web/API/Path2D) (using `new Path2D("M10 10 h 80 v 80 h -80 Z")` to draw complex SVG vector icons directly onto canvas).
  - **Sharp**: [https://sharp.pixelplumbing.com/](https://sharp.pixelplumbing.com/) (resize, crop, composite, alpha, format conversion, and metadata).
  - **ImageMagick**: [https://imagemagick.org/](https://imagemagick.org/) (CLI image conversion and composition fallback).
  - **IMG.LY Background Removal**: [https://github.com/imgly/background-removal-js](https://github.com/imgly/background-removal-js) (subject cutouts with transparency).
