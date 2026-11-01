import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { CORAL_ABSTRACT_MODEL_TIERS, markAsOwnedMirror, normalizeCopilotAgentContent } from '../../clients/hooks/lib/copilot-agents.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { ALL_SHIPPED_SKILLS } from '../../clients/hooks/lib/coral-skills.mjs';
import { parseAgentMeta } from '#src/jobs/agent-resolution.js';

const CLIENT_MANIFESTS = [
  { path: 'clients/.claude-plugin/plugin.json', expectedAgents: undefined },
  { path: 'clients/.codex-plugin/plugin.json', expectedAgents: undefined },
  { path: 'clients/.github/plugin/plugin.json', expectedAgents: './.github/agents/' },
] as const;

const SKILLS_DIR = join(process.cwd(), 'clients', 'skills');
const AGENTS_DIR = join(process.cwd(), 'clients', 'agents');
const COPILOT_PLUGIN_AGENTS_DIR = join(process.cwd(), 'clients', '.github', 'agents');
const CLAUDE_PROJECT_AGENTS_DIR = join(process.cwd(), '.claude', 'agents');
const COPILOT_PROJECT_AGENTS_DIR = join(process.cwd(), '.github', 'agents');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function skillBodies(): Array<{ skill: string; text: string }> {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ skill: entry.name, path: join(SKILLS_DIR, entry.name, 'SKILL.md') }))
    .filter(({ path }) => existsSync(path))
    .map(({ skill, path }) => ({ skill, text: readFileSync(path, 'utf-8') }));
}

/**
 * `coral:<name>` references that must resolve to an agent file.
 *
 * The `[a-z]` anchor drops the literal placeholder `coral:<agent>`, and skills are
 * subtracted because `Skill({ skill: "coral:ralph" })` names a skill, not an agent.
 * The whole file is scanned rather than only `Agent(`/`subagent_type:` sites so that
 * workflow expressions like `"(coral:architect, coral:critic) -> coral:resolver"` —
 * the reference class this invariant most needs to cover — are included.
 */
function referencedAgents(): Map<string, string[]> {
  const shipped = new Set<string>(ALL_SHIPPED_SKILLS as string[]);
  const byAgent = new Map<string, string[]>();
  for (const { skill, text } of skillBodies()) {
    for (const [, name] of text.matchAll(/coral:([a-z][a-z-]*)/gu)) {
      if (shipped.has(name)) continue;
      byAgent.set(name, [...(byAgent.get(name) ?? []), skill]);
    }
  }
  return byAgent;
}

describe('coral agent exposure', () => {
  it.each(CLIENT_MANIFESTS)('$path exposes the expected agent directory to its client', ({ path, expectedAgents }) => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), path), 'utf-8')) as {
      agents?: unknown;
    };
    expect(manifest.agents).toBe(expectedAgents);
  });

  it('every coral:<agent> a skill spawns has an agent file in both canonical and Copilot directories', () => {
    const referenced = referencedAgents();
    expect(referenced.size).toBeGreaterThan(0);

    const missingCanonical = [...referenced.entries()]
      .filter(([name]) => !existsSync(join(AGENTS_DIR, `${name}.md`)))
      .map(([name, skills]) => `${name} (referenced by ${skills.join(', ')})`);
    const missingCopilot = [...referenced.entries()]
      .filter(([name]) => !existsSync(join(COPILOT_PLUGIN_AGENTS_DIR, `${name}.md`)))
      .map(([name, skills]) => `${name} (referenced by ${skills.join(', ')})`);

    expect(missingCanonical).toEqual([]);
    expect(missingCopilot).toEqual([]);
  });

  it.each([
    { label: 'bundled plugin agents', sourceDir: AGENTS_DIR, targetDir: COPILOT_PLUGIN_AGENTS_DIR },
    { label: 'project reviewer agents', sourceDir: CLAUDE_PROJECT_AGENTS_DIR, targetDir: COPILOT_PROJECT_AGENTS_DIR },
  ])(
    'keeps Copilot $label in lockstep with canonical agents while stripping abstract model tiers',
    ({ sourceDir, targetDir }) => {
      const sourceFiles = markdownFiles(sourceDir);
      expect(sourceFiles.length).toBeGreaterThan(0);
      expect(markdownFiles(targetDir)).toEqual(sourceFiles);

      const abstractTiers = new Set<string>(CORAL_ABSTRACT_MODEL_TIERS as readonly string[]);
      for (const file of sourceFiles) {
        const sourceContent = readFileSync(join(sourceDir, file), 'utf-8');
        const targetContent = readFileSync(join(targetDir, file), 'utf-8');
        expect(targetContent).toBe(markAsOwnedMirror(normalizeCopilotAgentContent(sourceContent)));

        const sourceMeta = parseAgentMeta(sourceContent);
        expect(sourceMeta.model).toBeDefined();
        expect(abstractTiers.has(sourceMeta.model!)).toBe(true);

        const targetMeta = parseAgentMeta(targetContent);
        expect(targetMeta.model).toBeUndefined();
        expect(targetMeta.effort).toBeUndefined();
      }
    },
  );
});
