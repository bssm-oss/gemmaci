#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATEGORIES, compareSeverity, loadConfig, normalizeRepoPath, SEVERITIES, severityRank } from './config.mjs';
import { isChangedLine } from './diff-utils.mjs';
import { buildDegradedSummary, buildReviewMessages } from './prompts.mjs';

export async function reviewPullRequest(options = {}) {
  const config = options.config ?? loadConfig();
  const inputPath = options.inputPath ?? 'review-input.json';
  const outputPath = options.outputPath ?? 'review-output.json';
  const startedAt = Date.now();
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const allFindings = [];
  const summaries = [];
  let degraded = false;

  for (const chunk of input.chunks ?? []) {
    try {
      const payload = options.mockModelPath
        ? await readMockPayload(options.mockModelPath, chunk.id)
        : await callOllama({ chunk, pullRequest: input.pullRequest, config });
      const validated = validateReviewPayload(payload, chunk, config);
      if (validated.summary) {
        summaries.push(validated.summary);
      }
      allFindings.push(...validated.findings);
    } catch (error) {
      degraded = true;
      summaries.push(buildDegradedSummary(error instanceof Error ? error.message : String(error)));
    }
  }

  const findings = dedupeFindingsByLocation(allFindings)
    .sort((a, b) => compareSeverity(a.severity, b.severity))
    .slice(0, config.maxInlineComments);
  const overallSeverity = highestSeverity(findings);
  const summary = buildSummary({
    summaries,
    findings,
    reviewedFileCount: Object.keys(input.changedLines ?? {}).length,
    skippedFiles: input.skippedFiles ?? [],
    totalIncludedBytes: input.totalIncludedBytes ?? 0,
    degraded,
    minConfidence: config.minConfidence
  });

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pullRequest: input.pullRequest,
    model: config.model,
    degraded,
    elapsedMs: Date.now() - startedAt,
    summary,
    overall_severity: overallSeverity,
    findings,
    skippedFiles: input.skippedFiles ?? []
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

export function validateReviewPayload(payload, chunk, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Model response must be a JSON object');
  }

  const findings = [];
  for (const rawFinding of Array.isArray(payload.findings) ? payload.findings : []) {
    const finding = normalizeFinding(rawFinding);
    if (!finding) {
      continue;
    }

    const lineMap = Object.fromEntries(chunk.files.map((file) => [file.path, file.changedLines]));
    const lineTextMap = Object.fromEntries(chunk.files.map((file) => [file.path, file.changedLineDetails ?? []]));
    if (!isChangedLine(lineMap, finding.path, finding.line) || finding.confidence < config.minConfidence || !evidenceReferencesChangedLine(finding, lineTextMap)) {
      continue;
    }

    findings.push(finding);
  }

  return {
    summary: typeof payload.summary === 'string' ? payload.summary.slice(0, 6000) : '',
    findings: findings.slice(0, config.maxInlineComments)
  };
}

export function parseJsonObjectFromText(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Model response did not contain JSON');
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function callOllama({ chunk, pullRequest, config }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: buildReviewMessages({ chunk, pullRequest, config }),
        stream: false,
        options: { temperature: 0.1 }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const body = await response.json();
    const content = body.message?.content ?? body.response;
    if (typeof content !== 'string') {
      throw new Error('Ollama response did not include message content');
    }
    return parseJsonObjectFromText(content);
  } finally {
    clearTimeout(timeout);
  }
}

async function readMockPayload(mockModelPath, chunkId) {
  const payload = JSON.parse(await readFile(mockModelPath, 'utf8'));
  if (Array.isArray(payload)) {
    return payload[Math.max(0, chunkId - 1)] ?? { summary: '', findings: [], overall_severity: 'none' };
  }
  return payload;
}

function normalizeFinding(rawFinding) {
  if (!rawFinding || typeof rawFinding !== 'object' || Array.isArray(rawFinding)) {
    return null;
  }

  const path = normalizeRepoPath(rawFinding.path);
  const line = readPositiveInteger(rawFinding.line);
  const severity = typeof rawFinding.severity === 'string' ? rawFinding.severity.toLowerCase() : '';

  if (!path || !Number.isInteger(line) || line <= 0 || !SEVERITIES.includes(severity) || severity === 'none') {
    return null;
  }

  const category = typeof rawFinding.category === 'string' && CATEGORIES.includes(rawFinding.category)
    ? rawFinding.category
    : null;
  const confidence = readConfidence(rawFinding.confidence);
  const title = clampText(rawFinding.title, 120);
  const evidence = clampText(rawFinding.evidence, 500);
  const body = clampText(rawFinding.body, 2000);
  const recommendation = clampText(rawFinding.recommendation, 1000);
  if (!category || !title || !evidence || !body || !recommendation) {
    return null;
  }

  return {
    path,
    line,
    category,
    severity,
    confidence,
    title,
    evidence,
    body,
    recommendation,
    suggestion: sanitizeSuggestion(rawFinding.suggestion)
  };
}

function dedupeFindingsByLocation(findings) {
  const bestByLocation = new Map();
  for (const finding of findings) {
    const key = `${finding.path}:${finding.line}`;
    const existing = bestByLocation.get(key);
    if (existing && compareFindingPriority(existing, finding) >= 0) {
      continue;
    }
    bestByLocation.set(key, finding);
  }
  return [...bestByLocation.values()];
}

function highestSeverity(findings) {
  return findings.reduce((highest, finding) => (
    severityRank(finding.severity) > severityRank(highest) ? finding.severity : highest
  ), 'none');
}

function buildSummary({ summaries, findings, reviewedFileCount, skippedFiles, totalIncludedBytes, degraded, minConfidence }) {
  const lines = ['<!-- gemma-reviewer-summary -->', '# Gemma Review'];
  if (degraded) {
    lines.push('', '> 일부 청크는 구조화된 리뷰를 완료하지 못했습니다.');
  }
  if (summaries.length > 0) {
    lines.push('', ...summaries.map((summary) => summary.trim()).filter(Boolean));
  } else {
    lines.push('', '리뷰할 변경사항에서 중요한 이슈를 찾지 못했습니다.');
  }
  lines.push('', `Inline findings: ${findings.length}`);
  lines.push(`Highest severity: ${highestSeverity(findings)}`);
  lines.push(`Minimum confidence: ${Math.round(minConfidence * 100)}%`);
  const categoryCounts = countBy(findings, (finding) => finding.category);
  if (categoryCounts.size > 0) {
    lines.push(`Categories: ${[...categoryCounts.entries()].map(([category, count]) => `${category}=${count}`).join(', ')}`);
  }
  lines.push('', '## Review scope');
  lines.push(`- Files reviewed: ${reviewedFileCount}`);
  lines.push(`- Files skipped: ${skippedFiles.length}`);
  lines.push(`- Included diff bytes: ${totalIncludedBytes}`);
  if (skippedFiles.length > 0) {
    lines.push('', '<details>');
    lines.push('<summary>Skipped files</summary>');
    lines.push('');
    for (const file of skippedFiles.slice(0, 20)) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

function compareFindingPriority(left, right) {
  const severityDifference = severityRank(left.severity) - severityRank(right.severity);
  if (severityDifference !== 0) {
    return severityDifference;
  }
  return left.confidence - right.confidence;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function clampText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function readConfidence(value) {
  const confidence = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(1, confidence));
}

function readPositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return Number.NaN;
}

function sanitizeSuggestion(value) {
  const suggestion = clampText(value, 2000);
  if (!suggestion || suggestion.includes('```')) {
    return '';
  }
  return suggestion;
}

function evidenceReferencesChangedLine(finding, lineTextMap) {
  const details = lineTextMap[finding.path];
  if (!Array.isArray(details)) {
    return false;
  }
  const detail = details.find((item) => item.line === finding.line);
  if (!detail) {
    return false;
  }
  const lineText = normalizeEvidenceText(detail.text);
  const evidence = normalizeEvidenceText(finding.evidence);
  if (lineText.length === 0 || evidence.length === 0) {
    return false;
  }
  const requiredSnippet = lineText.length > 160 ? lineText.slice(0, 160) : lineText;
  return evidence.includes(requiredSnippet);
}

function normalizeEvidenceText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv) {
  const args = { inputPath: 'review-input.json', outputPath: 'review-output.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      args.inputPath = argv[++index];
    } else if (arg === '--output') {
      args.outputPath = argv[++index];
    } else if (arg === '--mock-model') {
      args.mockModelPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  reviewPullRequest(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
