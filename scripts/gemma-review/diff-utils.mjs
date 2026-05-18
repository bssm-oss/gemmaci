import { isExcludedPath, normalizeRepoPath } from './config.mjs';

export function parseUnifiedDiff(diffText, config) {
  const files = [];
  let current = null;
  let currentNewLine = 0;
  let totalIncludedBytes = 0;
  const skippedFiles = [];

  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);

    if (diffMatch) {
      current = {
        oldPath: diffMatch[1],
        path: diffMatch[2],
        diffLines: [line],
        changedLines: [],
        changedLineDetails: [],
        binary: false,
        deleted: false
      };
      files.push(current);
      currentNewLine = 0;
      continue;
    }

    if (!current) {
      continue;
    }

    current.diffLines.push(line);

    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }

    if (line === '+++ /dev/null') {
      current.deleted = true;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      current.path = line.slice('+++ b/'.length);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[2], 10);
      continue;
    }

    if (currentNewLine === 0) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.changedLines.push(currentNewLine);
      current.changedLineDetails.push({ line: currentNewLine, text: line.slice(1) });
      currentNewLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    currentNewLine += 1;
  }

  const includedFiles = [];
  for (const file of files) {
    const normalizedPath = normalizeRepoPath(file.path);
    const diff = `${file.diffLines.join('\n')}\n`;
    const bytes = Buffer.byteLength(diff, 'utf8');

    if (!normalizedPath) {
      skippedFiles.push({ path: file.path, reason: 'invalid-path' });
      continue;
    }
    if (file.binary) {
      skippedFiles.push({ path: normalizedPath, reason: 'binary' });
      continue;
    }
    if (file.deleted || file.changedLines.length === 0) {
      skippedFiles.push({ path: normalizedPath, reason: 'no-added-lines' });
      continue;
    }
    if (isExcludedPath(normalizedPath, config.excludedPaths)) {
      skippedFiles.push({ path: normalizedPath, reason: 'excluded-path' });
      continue;
    }
    if (bytes > config.maxFileBytes) {
      skippedFiles.push({ path: normalizedPath, reason: 'file-too-large', bytes });
      continue;
    }
    if (bytes > config.maxChunkBytes) {
      skippedFiles.push({ path: normalizedPath, reason: 'chunk-too-large', bytes });
      continue;
    }
    if (totalIncludedBytes + bytes > config.maxDiffBytes) {
      skippedFiles.push({ path: normalizedPath, reason: 'diff-budget-exceeded', bytes });
      continue;
    }

    totalIncludedBytes += bytes;
    includedFiles.push({
      path: normalizedPath,
      oldPath: normalizeRepoPath(file.oldPath) ?? normalizedPath,
      diff,
      bytes,
      changedLines: [...new Set(file.changedLines)].sort((a, b) => a - b),
      changedLineDetails: dedupeLineDetails(file.changedLineDetails)
    });
  }

  return { files: includedFiles, skippedFiles, totalIncludedBytes };
}

export function createChunks(files, maxChunkBytes) {
  const chunks = [];
  let current = newChunk(1);

  for (const file of files) {
    if (current.files.length > 0 && current.bytes + file.bytes > maxChunkBytes) {
      chunks.push(finalizeChunk(current));
      current = newChunk(chunks.length + 1);
    }

    current.files.push({ path: file.path, changedLines: file.changedLines, changedLineDetails: file.changedLineDetails, bytes: file.bytes });
    current.diffParts.push(file.diff);
    current.bytes += file.bytes;
  }

  if (current.files.length > 0) {
    chunks.push(finalizeChunk(current));
  }

  return chunks;
}

export function buildChangedLineTextMap(files) {
  const map = {};
  for (const file of files) {
    map[file.path] = file.changedLineDetails;
  }
  return map;
}

export function buildChangedLineMap(files) {
  const map = {};
  for (const file of files) {
    map[file.path] = file.changedLines;
  }
  return map;
}

export function isChangedLine(lineMap, filePath, line) {
  const normalizedPath = normalizeRepoPath(filePath);
  if (!normalizedPath || !Number.isInteger(line)) {
    return false;
  }

  return Array.isArray(lineMap[normalizedPath]) && lineMap[normalizedPath].includes(line);
}

function newChunk(id) {
  return { id, files: [], diffParts: [], bytes: 0 };
}

function dedupeLineDetails(details) {
  const byLine = new Map();
  for (const detail of details) {
    if (!byLine.has(detail.line)) {
      byLine.set(detail.line, detail);
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

function finalizeChunk(chunk) {
  return {
    id: chunk.id,
    files: chunk.files,
    bytes: chunk.bytes,
    diff: chunk.diffParts.join('\n')
  };
}
