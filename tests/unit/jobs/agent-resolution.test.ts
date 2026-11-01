import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import {
  COPILOT_AGENT_MIRROR_MARKER,
  normalizeCopilotAgentContent,
  syncCopilotAgentDirectory,
} from '../../../clients/hooks/lib/copilot-agents.mjs';
import { parseAgentMeta, stripAgentMetadata } from '#src/jobs/agent-resolution.js';

describe('stripAgentMetadata', () => {
  it('removes frontmatter and CORAL_METHODS blockquote lines', () => {
    const raw = [
      '---',
      'name: architect',
      'model: sonnet',
      '---',
      '',
      '> **CORAL_METHODS**: Use strict protocol',
      '> **CORAL_NOTE**: Keep concise',
      '# Architect',
      'Main body',
    ].join('\n');

    const stripped = stripAgentMetadata(raw);

    expect(stripped).toBe('# Architect\nMain body');
  });
});

describe('normalizeCopilotAgentContent', () => {
  it.each(['haiku', 'sonnet', 'opus', 'fable'])(
    'strips abstract tier model "%s" and effort from frontmatter',
    (tier) => {
      const raw = [
        '---',
        'name: pioneer',
        'description: "Explore designs"',
        `model: ${tier}`,
        'effort: max',
        'disallowedTools: Write, Edit',
        '---',
        '',
        '<Agent_Prompt>',
        '  model: opus in body is untouched',
        '</Agent_Prompt>',
      ].join('\n');

      const normalized = normalizeCopilotAgentContent(raw);

      expect(parseAgentMeta(raw)).toEqual({ model: tier, effort: 'max' });
      expect(parseAgentMeta(normalized)).toEqual({});
      expect(normalized).toContain('disallowedTools: Write, Edit');
      expect(normalized).toContain('model: opus in body is untouched');
    },
  );

  it('preserves explicit concrete model identifiers in frontmatter', () => {
    const raw = ['---', 'name: custom-reviewer', 'model: claude-sonnet-5.5', '---', '', 'Body'].join('\n');

    const normalized = normalizeCopilotAgentContent(raw);

    expect(parseAgentMeta(normalized)).toEqual({ model: 'claude-sonnet-5.5' });
  });

  it('strips quoted abstract tiers and effort with inline comments, preserving concrete models and body text', () => {
    const raw = [
      '---',
      'name: quoted-reviewer',
      'model: "opus" # abstract tier',
      "effort: 'max' # provider effort",
      'model: "claude-sonnet-5.5" # concrete model',
      '---',
      '',
      'Body model: opus # keep this text',
    ].join('\n');

    const normalized = normalizeCopilotAgentContent(raw);

    expect(normalized).not.toContain('model: "opus"');
    expect(normalized).not.toContain('effort:');
    expect(normalized).toContain('model: "claude-sonnet-5.5" # concrete model');
    expect(normalized).toContain('Body model: opus # keep this text');
  });
});

describe('syncCopilotAgentDirectory', () => {
  it('copies and updates owned mirrors, removes only stale owned files, and preserves unrelated targets', () => {
    const root = mkdtempSync(join(process.cwd(), '.test-copilot-agent-sync-'));
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    mkdirSync(sourceDir);
    mkdirSync(targetDir);

    try {
      writeFileSync(join(sourceDir, 'keep.md'), '---\nname: keep\n---\nFirst\n');
      writeFileSync(join(sourceDir, 'stale.md'), '---\nname: stale\n---\nOld\n');
      const firstSync = syncCopilotAgentDirectory(sourceDir, targetDir);
      expect(firstSync.copied).toEqual(['keep.md', 'stale.md']);
      expect(readFileSync(join(targetDir, 'keep.md'), 'utf8')).toContain(COPILOT_AGENT_MIRROR_MARKER);

      writeFileSync(join(sourceDir, 'keep.md'), '---\nname: keep\n---\nUpdated\n');
      rmSync(join(sourceDir, 'stale.md'));
      writeFileSync(join(sourceDir, 'new.md'), '---\nname: new\n---\nNew\n');
      writeFileSync(join(targetDir, 'custom-agent.md'), 'User-owned agent');
      writeFileSync(join(sourceDir, 'custom-agent.md'), '---\nname: custom-agent\n---\nCoral source');
      mkdirSync(join(targetDir, 'custom-directory'));
      mkdirSync(join(targetDir, 'occupied.md'));
      writeFileSync(join(sourceDir, 'occupied.md'), '---\nname: occupied\n---\nCoral source');
      writeFileSync(join(targetDir, 'legacy.md'), 'Unmanaged old agent');
      writeFileSync(join(targetDir, 'custom-directory', 'keep.txt'), 'User-owned directory');
      writeFileSync(join(targetDir, 'notes.txt'), 'User-owned file');

      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let result: { copied: string[]; updated: string[]; removed: string[]; conflicts: string[] };
      try {
        result = syncCopilotAgentDirectory(sourceDir, targetDir);
        expect(stderrWrite).toHaveBeenCalledWith(
          expect.stringContaining('Preserved unmanaged Copilot agent target(s)'),
        );
      } finally {
        stderrWrite.mockRestore();
      }

      expect(result.updated).toEqual(['keep.md']);
      expect(result.copied).toEqual(['new.md']);
      expect(result.removed).toEqual(['stale.md']);
      expect(result.conflicts).toEqual(['custom-agent.md', 'occupied.md']);
      expect(readFileSync(join(targetDir, 'keep.md'), 'utf8')).toContain('Updated');
      expect(readFileSync(join(targetDir, 'custom-agent.md'), 'utf8')).toBe('User-owned agent');
      expect(readFileSync(join(targetDir, 'custom-directory', 'keep.txt'), 'utf8')).toBe('User-owned directory');
      expect(readFileSync(join(targetDir, 'notes.txt'), 'utf8')).toBe('User-owned file');
      expect(readFileSync(join(targetDir, 'legacy.md'), 'utf8')).toBe('Unmanaged old agent');
      expect(readdirSync(join(targetDir, 'occupied.md'))).toEqual([]);
      expect(readdirSync(targetDir).sort()).toEqual([
        'custom-agent.md',
        'custom-directory',
        'keep.md',
        'legacy.md',
        'new.md',
        'notes.txt',
        'occupied.md',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
