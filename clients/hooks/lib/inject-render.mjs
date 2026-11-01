import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coralProjectDir, resolveKbRoot, resolveProjectSource } from './hook-utils.mjs';

export const INJECT_FRAGMENT_GROUPS = {
  base: ['core.md', 'tools.md', 'cli.md', 'orchestrator.md'],
  kb: ['kb/common.md', 'kb/orchestrator.md', 'kb/session.md'],
};

export const COPILOT_HOST_BRIDGE = [
  '# Copilot Host Bridge',
  '',
  'Copilot fires no `SubagentStart`: when spawning any `coral:*` or project agent via `task`, copy the resolved `CORAL_METHODS/` and `CORAL_PROJECT/` lines from `# Tools` into the subagent `prompt`.',
  'Tool mapping: `Agent`→`task`, `Skill`→`skill` (bare name), `AskUserQuestion`→`ask_user`, `Read`/`Write`/`Edit`→`view`/`create`/`edit`, `Glob`/`Grep`/`Bash`→`glob`/`grep`/`bash`.',
].join('\n');

function readInjectBundle({ asOwner, kbEnabled }) {
  return {
    base: INJECT_FRAGMENT_GROUPS.base.filter((path) => asOwner || path !== 'orchestrator.md'),
    kb: kbEnabled
      ? INJECT_FRAGMENT_GROUPS.kb.filter((path) => asOwner || path !== 'kb/orchestrator.md')
      : [],
  };
}

// Render the equipped-tools block at the end of tools.md. Empty string
// when there are no tools (or the caller omits them), so the placeholder
// vanishes cleanly and the section stays absent.
function renderEquippedTools(equippedTools) {
  if (!Array.isArray(equippedTools) || equippedTools.length === 0) return '';
  const lines = equippedTools.flatMap((tool) => {
    const guidance = Array.isArray(tool.guidance) ? tool.guidance : [];
    return [`- ${tool.id}: ${tool.summary}`, ...guidance.map((item) => `  - ${item}`)];
  });
  // Bare block — tools.md supplies the blank lines around the `{{EQUIPPED_TOOLS}}`
  // line (it sits on its own line, blank above and below), so the rendered Tools
  // section reads one blank line per gap.
  return [
    '⚠ Equipped tools are capabilities the user explicitly installed via /equip to improve your work.',
    'You MUST use every applicable equipped tool as the highest-priority first pass, before built-in tools or manual alternatives:',
    ...lines,
  ].join('\n');
}

function renderCopilotHostBridge({ host, asOwner, group }) {
  if (host !== 'copilot' || !asOwner || group !== 'base') return '';
  return COPILOT_HOST_BRIDGE;
}

export function renderInject({
  pluginRoot,
  projectDir,
  sessionId,
  asOwner,
  group,
  kbEnabled = true,
  equippedTools,
  host,
}) {
  const fragmentPaths = readInjectBundle({ asOwner, kbEnabled })[group];
  if (fragmentPaths === undefined) throw new Error(`Unknown inject fragment group: ${group}`);
  const copilotBridge = renderCopilotHostBridge({ host, asOwner, group });
  const bundle = [
    ...fragmentPaths.map((path) => readFileSync(join(pluginRoot, 'inject', path), 'utf-8').trimEnd()),
    copilotBridge,
  ]
    .filter(Boolean)
    .join('\n\n');
  const projectRoot = projectDir ? coralProjectDir(projectDir) : undefined;
  const methodsRoot = `${join(pluginRoot, 'methods')}/`;
  return (
    bundle
      .replaceAll('{{CORAL_KB}}', resolveKbRoot())
      .replaceAll('{{CORAL_METHODS}}', methodsRoot)
      .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(equippedTools))
      .replaceAll('{{SESSION_ID}}', sessionId || '')
      .replaceAll('{{CORAL_PROJECT}}', projectRoot ?? '{{CORAL_PROJECT}}')
      .replaceAll('{{CORAL_PROJECTS}}', projectRoot ?? '{{CORAL_PROJECTS}}')
      .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}')
  );
}
