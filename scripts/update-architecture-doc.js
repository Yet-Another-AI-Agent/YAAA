const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const registryPath = path.join(rootDir, 'packages/agents/src/registry.ts');
const workspacePath = path.join(rootDir, 'packages/core/src/workspace.ts');
const outputPath = path.join(rootDir, 'docs/architecture.md');

function updateArchitecture() {
  console.log('[Autodoc] Scanning YAAA codebase to update architecture.md...');

  // 1. Parse Agents from registry
  let agentsSection = '### Specialist Agents Roster\n\n';
  try {
    const registryContent = fs.readFileSync(registryPath, 'utf8');
    // Extract Agent names and descriptions/capabilities using a regex
    const agentRegex = /(\w+Agent):\s*\{[\s\S]*?role:\s*"(\w+)"[\s\S]*?capabilities:\s*\[([\s\S]*?)\]/g;
    let match;
    agentsSection += '| Agent Name | Role | Capabilities | Context Window (Tokens) |\n';
    agentsSection += '| --- | --- | --- | --- |\n';
    agentsSection += '| **YAAA Orchestrator** | `Main Agent` | `conversation, planning, orchestrate` | `1,000,000` |\n';
    while ((match = agentRegex.exec(registryContent)) !== null) {
      const name = match[1];
      const role = match[2];
      const caps = match[3].replace(/['"\s]/g, '').split(',').filter(Boolean).join(', ');
      agentsSection += `| **${name}** | \`${role}\` | \`${caps || 'none'}\` | \`1,000,000\` |\n`;
    }
  } catch (err) {
    agentsSection += '*Error parsing registry.ts*\n';
  }

  // 2. Parse Task States from workspace
  let statesSection = '### Task Workflow & States\n\n';
  try {
    const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
    const statusTypeMatch = workspaceContent.match(/type\s+TaskStatus\s*=\s*([\s\S]*?);/);
    if (statusTypeMatch) {
      const states = statusTypeMatch[1].replace(/['"\s]/g, '').split('|').filter(Boolean);
      statesSection += 'Currently supported YAAA task statuses:\n';
      statesSection += states.map(s => `- \`${s}\``).join('\n') + '\n';
    } else {
      statesSection += 'Task statuses are dynamically managed via `tasks` table in `main.db`.\n';
    }
  } catch (err) {
    statesSection += '*Error parsing workspace.ts*\n';
  }

  // 3. Construct Document
  const docContent = `# YAAA System Architecture

This document describes the high-level architecture of Yet-Another-AI-Agent (YAAA) and is automatically updated during package builds.

## Core Conceptual Flow

\`\`\`mermaid
graph TD
    A[User Input] --> B{Intent Router}
    B -->|Conversation| C[Conversational Onboarding / Reply]
    B -->|Task| D[Planner / Task Design]
    D --> E[OuterLoop Subtask Manager]
    E --> F[InnerLoop ReAct Agent Executor]
    F -->|Tool Calls| G[Local Files / Shell / Web / Browser]
    F -->|Checkpoint / Handoff| E
    E --> H[Synthesizer & Verification Pass]
    H -->|Complete| I[Final Reconciled Result]
\`\`\`

## System Components

### 1. Orchestrator
- **Intent Router** (\`packages/orchestrator/src/intent.ts\`): Analyzes user inputs using LLMs to distinguish small talk from actionable work requests.
- **Planner** (\`packages/orchestrator/src/planner.ts\`): Formulates structured, dependency-aware plans.
- **Synthesizer** (\`packages/orchestrator/src/synthesizer.ts\`): Reconciles execution outcomes and performs final verification reviews.

### 2. Runtime Execution
- **OuterLoop** (\`packages/agents/src/runtime/outer-loop.ts\`): Coordinates concurrent subtask execution, negotiate verification passes, and course-corrects worker agents.
- **InnerLoop** (\`packages/agents/src/runtime/inner-loop.ts\`): Orchestrates individual ReAct agents as LangGraph executors, managing local file access, sandboxed commands, and browser sessions.

${agentsSection}

${statesSection}

## Integration & Extension
- **MCP Integrations**: Registered and loaded dynamically to expose tools to the InnerLoop execution agent.
- **Local Filesystem**: Anchored securely to the task's jail workspace directory.
`;

  fs.writeFileSync(outputPath, docContent, 'utf8');
  console.log('[Autodoc] Successfully updated docs/architecture.md!');
}

updateArchitecture();
