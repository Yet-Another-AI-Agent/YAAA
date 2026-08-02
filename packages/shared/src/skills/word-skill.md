# Word Document Generation Skill (docx npm Package Documentation)

The Word Document Generation Skill enables agents and sub-agents to programmatically generate Microsoft Word `.docx` documents using the **docx** npm package.

---

## 1. Overview & Setup

`docx` is a feature-rich, object-oriented JavaScript/TypeScript library for generating real `.docx` files with headings, tables, borders, headers, footers, images, and custom styles.

### Installation
```bash
npm install docx
```

### Basic Setup & Imports
```typescript
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  AlignmentType,
  Header,
  Footer,
  PageNumber
} from "docx";
import fs from "node:fs";
```

---

## 2. Document Creation & Structure

```typescript
const doc = new Document({
  creator: "YAAA AI System",
  title: "Technical Execution Ledger",
  sections: [
    {
      properties: {
        page: {
          margin: { top: 720, bottom: 720, left: 720, right: 720 } // 0.5 inch margins (720 dxa)
        }
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({
                  text: "YAAA Technical Audit Log",
                  italics: true,
                  color: "6C7086",
                  size: 18 // 9pt (size is in half-points)
                })
              ]
            })
          ]
        })
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun("Page "),
                PageNumber.CURRENT,
                new TextRun(" of "),
                PageNumber.TOTAL_PAGES
              ]
            })
          ]
        })
      },
      children: [
        // Content Paragraphs go here
      ]
    }
  ]
});
```

---

## 3. Paragraphs, Headings & Text Styling

```typescript
const children = [
  // Document Title
  new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.LEFT,
    spacing: { after: 300 },
    children: [
      new TextRun({
        text: "SYSTEM SPECIFICATION & VERIFICATION",
        bold: true,
        size: 48, // 24pt
        color: "1E1E2E"
      })
    ]
  }),

  // Section Heading
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 150 },
    children: [
      new TextRun({
        text: "1. Executive Summary",
        bold: true,
        size: 32, // 16pt
        color: "A78BFA"
      })
    ]
  }),

  // Formatted Body Paragraph
  new Paragraph({
    spacing: { after: 200, line: 276 }, // 1.15 line spacing
    children: [
      new TextRun({
        text: "The YAAA multi-agent system uses a ",
        size: 22 // 11pt
      }),
      new TextRun({
        text: "two-tier orchestration loop ",
        bold: true,
        size: 22,
        color: "89B4FA"
      }),
      new TextRun({
        text: "with SQLite WAL persistence and sub-second WebSocket synchronization.",
        size: 22
      })
    ]
  })
];
```

---

## 4. Tables, Borders & Layout Grid

```typescript
const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: "45475A" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "45475A" },
    left: { style: BorderStyle.NONE, size: 0, color: "AUTO" },
    right: { style: BorderStyle.NONE, size: 0, color: "AUTO" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "313244" },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: "AUTO" }
  },
  rows: [
    // Header Row
    new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          shading: { fill: "313244" },
          children: [new Paragraph({ children: [new TextRun({ text: "Subtask ID", bold: true, color: "FFFFFF" })] })]
        }),
        new TableCell({
          shading: { fill: "313244" },
          children: [new Paragraph({ children: [new TextRun({ text: "Description", bold: true, color: "FFFFFF" })] })]
        }),
        new TableCell({
          shading: { fill: "313244" },
          children: [new Paragraph({ children: [new TextRun({ text: "Status", bold: true, color: "FFFFFF" })] })]
        })
      ]
    }),
    // Data Row
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph("subtask-1")] }),
        new TableCell({ children: [new Paragraph("Setup Canvas engine and game loop")] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "COMPLETED", color: "4ADE80", bold: true })] })] })
      ]
    })
  ]
});
```

---

## 5. Export & Saving File to Disk

```typescript
// Generate Buffer & Write File
const buffer = await Packer.toBuffer(doc);
await fs.promises.writeFile("documentation.docx", buffer);
```

---

## 6. Best Practices for Agents

1. **Size Conversion**: Note that `docx` text `size` property is specified in **half-points** (e.g. `size: 24` = 12pt font).
2. **Margin Conversion**: Margins are specified in **dxa** ($1\text{ inch} = 1440\text{ dxa}$).
3. **Structured Flow**: Combine Headings, Paragraphs, Tables, and Header/Footer for clean corporate doc formatting.

---

## 7. Advanced Reference Documentation & Links

- **Official docx Documentation**: [https://docx.js.org/](https://docx.js.org/)
- **docx GitHub Repository**: [https://github.com/dolanmiu/docx](https://github.com/dolanmiu/docx)
- **Advanced Topics & Guides**:
  - **Styles & Document Defaults**: [https://docx.js.org/api/classes/Document.html](https://docx.js.org/api/classes/Document.html) (setting global paragraph, heading, and default character font styles).
  - **Images & Drawings**: [https://docx.js.org/api/classes/ImageRun.html](https://docx.js.org/api/classes/ImageRun.html) (embedding PNG, JPEG, SVG image runs with width/height scaling).
  - **Section Breaks & Page Orientations**: [https://docx.js.org/api/classes/SectionProperties.html](https://docx.js.org/api/classes/SectionProperties.html) (mixing portrait and landscape pages within the same `.docx` document).
  - **Custom Footnotes & Endnotes**: [https://docx.js.org/api/classes/Footnote.html](https://docx.js.org/api/classes/Footnote.html) (adding automated numbered footnotes and endnote references).
  - **Raw OpenXML Customization**: [https://docx.js.org/api/classes/RawXmlElement.html](https://docx.js.org/api/classes/RawXmlElement.html) (injecting custom Word OpenXML tags for unsupported OOXML elements).
