# Web Access & Headless Browser Automation Skill

The Web Access Skill provides comprehensive instructions and best practices for agents and sub-agents to inspect, navigate, test, and scrape web applications using the built-in Chromium browser automation capabilities.

---

## 1. Overview of Browser Capabilities

The runtime equips agents with a full Playwright/Chromium engine supporting:
- Multi-tab browser sessions.
- Headless page rendering and DOM element interaction.
- Synchronous navigation and element waiting (`browser_navigate_and_wait`).
- Session history navigation (`browser_refresh`, `browser_go_back`, `browser_go_back_times`, `browser_go_front`, `browser_go_front_times`).
- Automatic screenshot logging under `agent-workspaces/{agentId}/logs/browser/{sessionId}/{step}.png`.

---

## 2. Tool Reference & Signatures

### Session Initialization & Navigation
```typescript
// 1. Open persistent browser session
open_browser({
  url: "https://example.com",
  headless: true,
  timeoutMs: 30000
})

// 2. Navigate to URL
browser_navigate({
  id: sessionId,
  url: "https://example.com/dashboard",
  timeoutMs: 30000
})

// 3. Navigate and wait for selector / network idle
browser_navigate_and_wait({
  id: sessionId,
  url: "https://example.com/dashboard",
  waitForSelector: "#main-content",
  waitUntil: "networkidle",
  timeoutMs: 30000
})

// 4. Page Refresh
browser_refresh({ id: sessionId })

// 5. History Navigation
browser_go_back({ id: sessionId })
browser_go_back_times({ id: sessionId, times: 3 })
browser_go_front({ id: sessionId })
browser_go_front_times({ id: sessionId, times: 2 })
```

---

## 3. Batch & Recursive Command Execution (`browser_multi` / `multi`)

Execute an array of browser actions sequentially starting from **index 0 to index N-1**. `browser_multi` enables multi-step browser workflows in a single call and supports **nested recursive `multi` calls**.

```typescript
browser_multi({
  id: sessionId,
  actions: [
    { action: "navigate_and_wait", params: { url: "https://example.com/login", waitUntil: "networkidle" } },
    { action: "fill_form", params: { values: { "#username": "admin", "#password": "secret" } } },
    { action: "click", params: { selector: "button#submit" } },
    { action: "wait", params: { selector: "#dashboard-view", timeoutMs: 5000 } },
    // Recursive nested multi call
    {
      action: "multi",
      actions: [
        { action: "hover", params: { selector: ".user-avatar" } },
        { action: "click", params: { selector: ".settings-link" } },
        { action: "screenshot", params: { outputPath: "screenshots/settings.png" } }
      ]
    }
  ]
})
```

- **Execution Order**: Strictly sequential starting from `actions[0]` index onwards.
- **Supported Sub-Actions**: `navigate`, `navigate_and_wait`, `click`, `type`, `fill`, `select`, `press`, `hover`, `refresh`, `go_back`, `go_back_times`, `go_front`, `go_front_times`, `wait`, `content`, `observe`, `evaluate`, `screenshot`, `multi`.
- **Recursive Multi**: Any element with `action: "multi"` recursively executes its nested `actions` array in index order.

---

## 3. Element Interaction & Form Filling

```typescript
// Click an element (CSS selector, text, data-testid)
browser_click({
  id: sessionId,
  selector: "button#submit-btn"
})

// Type text into an input field
browser_type({
  id: sessionId,
  selector: "input[name='username']",
  text: "admin_user",
  clear: true,
  submit: false
})

// Fill entire form in one tool call
browser_fill_form({
  id: sessionId,
  values: {
    "#email-input": "user@example.com",
    "#password-input": "Secret123!",
    "#terms-checkbox": true
  }
})

// Select dropdown option
browser_select({
  id: sessionId,
  selector: "select#role-dropdown",
  values: "developer"
})
```

---

## 4. Observation, Extraction & DOM Inspection

```typescript
// Collect structured page observation: URL, Title, Controls, Console Errors, Network Failures, Screenshot
observe_browser({ id: sessionId })

// Extract inner text or HTML content from an element
browser_content({
  id: sessionId,
  selector: ".report-container"
})

// Execute arbitrary JavaScript / IIFE script in the page context
browser_evaluate_script({
  id: sessionId,
  script: `
    (() => {
      const score = document.querySelector("#high-score")?.innerText;
      const status = window.gameState?.isRunning;
      return { score, status };
    })()
  `
})

// Capture screenshot (element or full page)
browser_screenshot({
  id: sessionId,
  outputPath: "screenshots/dashboard.png",
  fullPage: true
})
```

---

## 5. Testing Scenarios & Common Workflows

### Workflow A: Testing Single-Page Application (SPA) State Transitions
1. Open browser to the local dev server URL (e.g. `http://localhost:5173`).
2. Call `observe_browser` to extract interactive button selectors.
3. Click action buttons using `browser_click`.
4. Call `browser_refresh` to test local storage / session persistence.
5. Verify canvas rendering using `browser_evaluate_script` or `browser_screenshot`.

### Workflow B: Testing History State & Back/Forward Navigation
1. Navigate from `/` to `/dashboard` using `browser_navigate`.
2. Navigate from `/dashboard` to `/settings` using `browser_navigate`.
3. Call `browser_go_back_times({ id, times: 2 })` to return to `/`.
4. Call `browser_go_front({ id })` to step forward to `/dashboard`.
5. Verify page title and URL match expected route states.

---

## 6. Best Practices for Agents

1. **Do Not Inspect Blank Pages**: Always pass `url` into `open_browser` or call `browser_navigate` immediately after opening.
2. **Use `browser_navigate_and_wait` for SPAs**: Single-page applications require network idle or element selection before reading content.
3. **Capture Proof of Work**: Store screenshots under `screenshots/` to attach as evidence in `handOff.md`.
4. **Clean Shutdown**: Call `close_browser` when finished to free Chromium memory.

---

## 7. Advanced Reference Documentation & Links

- **Official Playwright API Reference**: [https://playwright.dev/docs/api/class-playwright](https://playwright.dev/docs/api/class-playwright)
- **Playwright Locators & Selectors**: [https://playwright.dev/docs/locators](https://playwright.dev/docs/locators)
- **Playwright Page API**: [https://playwright.dev/docs/api/class-page](https://playwright.dev/docs/api/class-page)
- **Advanced Topics & Guides**:
  - **Auto-Waiting & Navigation States**: [https://playwright.dev/docs/actionability](https://playwright.dev/docs/actionability) (understanding visible, stable, enabled, and editable element actionability checks).
  - **Network Interception & Request Mocking**: [https://playwright.dev/docs/network](https://playwright.dev/docs/network) (`page.route()`, intercepting API calls, mocking JSON payloads, and blocking heavy ad/media tracking assets).
  - **Browser Contexts & Storage State**: [https://playwright.dev/docs/auth](https://playwright.dev/docs/auth) (saving cookies and `localStorage` session snapshots to re-use authenticated sessions across test runs).
  - **Visual Comparison & Screenshots**: [https://playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots) (pixel-by-pixel visual regression testing and mask options for dynamic date elements).
  - **Chrome DevTools Protocol (CDP) Access**: [https://playwright.dev/docs/api/class-cdpsession](https://playwright.dev/docs/api/class-cdpsession) (low-level CDP commands for performance metrics, memory heap dumps, and network throttling).
