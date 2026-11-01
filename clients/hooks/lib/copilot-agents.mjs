import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CORAL_ABSTRACT_MODEL_TIERS = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);
export const COPILOT_AGENT_MIRROR_MARKER = '# coral-agent-mirror: v1';

const ABSTRACT_TIER_SET = new Set(CORAL_ABSTRACT_MODEL_TIERS);
const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?\r?\n)(---\r?\n?)/u;

function yamlScalarValue(value) {
  const withoutComment = value.replace(/\s+#.*$/u, '').trim();
  const quoted = /^(?:"([^"]*)"|'([^']*)')$/u.exec(withoutComment);
  return quoted?.[1] ?? quoted?.[2] ?? withoutComment;
}

export function normalizeCopilotAgentContent(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return content;

  const [, open, body, close] = match;
  const filteredLines = body
    .split(/(?<=\n)/u)
    .filter((line) => {
      const trimmed = line.trim();
      const modelMatch = /^model:\s*(.*?)\s*$/u.exec(trimmed);
      if (modelMatch !== null) {
        return !ABSTRACT_TIER_SET.has(yamlScalarValue(modelMatch[1]));
      }
      if (/^effort\s*:/u.test(trimmed)) {
        return false;
      }
      return true;
    });

  return `${open}${filteredLines.join('')}${close}${content.slice(match[0].length)}`;
}

function isOwnedMirror(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (match !== null) {
    return match[2].split(/\r?\n/u).includes(COPILOT_AGENT_MIRROR_MARKER);
  }
  return content.startsWith(`<!-- ${COPILOT_AGENT_MIRROR_MARKER.slice(2)} -->`);
}

export function markAsOwnedMirror(content) {
  if (isOwnedMirror(content)) return content;
  const match = FRONTMATTER_RE.exec(content);
  if (match !== null) {
    const newline = match[1].endsWith('\r\n') ? '\r\n' : '\n';
    return `${match[1]}${COPILOT_AGENT_MIRROR_MARKER}${newline}${match[2]}${match[3]}${content.slice(match[0].length)}`;
  }
  return `<!-- ${COPILOT_AGENT_MIRROR_MARKER.slice(2)} -->\n${content}`;
}

export function syncCopilotAgentDirectory(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const sourceFiles = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  const expected = new Set(sourceFiles);
  const removed = [];
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!expected.has(entry.name) && entry.isFile() && entry.name.endsWith('.md')) {
      const targetPath = join(targetDir, entry.name);
      if (isOwnedMirror(readFileSync(targetPath, 'utf8'))) {
        unlinkSync(targetPath);
        removed.push(entry.name);
      }
    }
  }

  const copied = [];
  const updated = [];
  const conflicts = [];
  for (const file of sourceFiles) {
    const sourceContent = readFileSync(join(sourceDir, file), 'utf8');
    const normalized = normalizeCopilotAgentContent(sourceContent);
    const targetPath = join(targetDir, file);
    let stat;
    try {
      stat = lstatSync(targetPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat !== undefined) {
      const current = stat.isFile() ? readFileSync(targetPath, 'utf8') : null;
      if (current === null || !isOwnedMirror(current)) {
        conflicts.push(file);
        continue;
      }
      const mirrored = markAsOwnedMirror(normalized);
      if (current !== mirrored) {
        writeFileSync(targetPath, mirrored, 'utf8');
        updated.push(file);
      }
      continue;
    }
    writeFileSync(targetPath, markAsOwnedMirror(normalized), 'utf8');
    copied.push(file);
  }

  if (conflicts.length > 0) {
    process.stderr.write(
      `[coral] Preserved unmanaged Copilot agent target(s) in ${targetDir}: ${conflicts.join(', ')}\n`,
    );
  }

  return { copied, updated, removed, conflicts };
}
