#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATEGORIES, compareSeverity, loadConfig, normalizeRepoPath, SEVERITIES, severityRank } from './config.mjs';
import { isChangedLine } from './diff-utils.mjs';

const SUMMARY_MARKER = '<!-- gemma-reviewer-summary -->';

export async function publishReview(options = {}) {
  const config = options.config ?? loadConfig();
  const reviewOutput = JSON.parse(await readFile(options.inputPath ?? 'review-output.json', 'utf8'));
  const reviewInput = JSON.parse(await readFile(options.reviewInputPath ?? 'review-input.json', 'utf8'));
  const hostileInputLineMap = validateReviewInput(reviewInput);
  const hostileInputLineTextMap = validateChangedLineTexts(reviewInput, hostileInputLineMap);
  const pullRequest = validatePullRequest(reviewInput.pullRequest);
  assertMatchingPullRequestMetadata(pullRequest, reviewOutput.pullRequest);
  if (!options.dryRun) {
    await assertEventMetadataMatches(pullRequest, options.eventPath ?? process.env.GITHUB_EVENT_PATH);
  }
  const trusted = options.dryRun
    ? { changedLines: hostileInputLineMap, changedLineTexts: hostileInputLineTextMap, headSha: pullRequest.headSha }
    : await fetchTrustedPullRequestData({ pullRequest, token: readToken() });
  if (trusted.headSha !== pullRequest.headSha) {
    const result = {
      summary: `${SUMMARY_MARKER}\n# Gemma Review\n\nSkipped publishing because the pull request head changed after review artifacts were generated.`,
      inlineComments: [],
      shouldFail: false,
      degraded: true,
      publishMode: options.dryRun ? 'dry-run' : 'stale-head'
    };
    if (options.dryRun) {
      await writeDryRun(options.outputPath, result);
    } else {
      await writeJobSummary(result.summary, [], 'pull request head changed after review');
    }
    return result;
  }
  const validated = validateReviewOutput(reviewOutput, trusted, config);
  const shouldFail = shouldFailReview(validated, config);
  const inlineComments = validated.findings.map((finding) => formatInlineComment(finding, trusted.headSha));
  const result = {
    summary: validated.summary,
    inlineComments,
    shouldFail,
    degraded: Boolean(reviewOutput.degraded),
    publishMode: options.dryRun ? 'dry-run' : 'github'
  };

  if (options.dryRun) {
    await writeDryRun(options.outputPath, result);
    if (shouldFail && !options.noFail) {
      process.exitCode = 1;
    }
    return result;
  }

  try {
    await upsertSummaryComment({ pullRequest, summary: validated.summary, token: readToken() });
    const postResult = await postInlineComments({ pullRequest, inlineComments, token: readToken() });
    if (postResult.stale.length > 0) {
      await upsertSummaryComment({
        pullRequest,
        summary: appendStaleInlineFallback(validated.summary, postResult.stale),
        token: readToken()
      });
    }
  } catch (error) {
    if (isPermissionError(error)) {
      result.degraded = true;
      await writeJobSummary(validated.summary, inlineComments, error.message);
    } else {
      throw error;
    }
  }

  if (shouldFail) {
    process.exitCode = 1;
  }
  return result;
}

export function validateReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('review-input.json must be an object');
  }
  if (!input.changedLines || typeof input.changedLines !== 'object' || Array.isArray(input.changedLines)) {
    throw new Error('review-input.json missing changedLines object');
  }

  const lineMap = {};
  for (const [rawPath, rawLines] of Object.entries(input.changedLines)) {
    const path = normalizeRepoPath(rawPath);
    if (!path) {
      throw new Error(`Invalid changedLines path: ${rawPath}`);
    }
    if (!Array.isArray(rawLines)) {
      throw new Error(`changedLines for ${path} must be an array`);
    }
    lineMap[path] = [...new Set(rawLines.map(readPositiveInteger).filter((line) => Number.isInteger(line) && line > 0))]
      .sort((a, b) => a - b);
  }
  return lineMap;
}

function validateChangedLineTexts(input, lineMap) {
  const textMap = {};
  const rawTexts = input.changedLineTexts;
  if (!rawTexts || typeof rawTexts !== 'object' || Array.isArray(rawTexts)) {
    return textMap;
  }

  for (const [rawPath, rawDetails] of Object.entries(rawTexts)) {
    const path = normalizeRepoPath(rawPath);
    if (!path || !Array.isArray(lineMap[path]) || !Array.isArray(rawDetails)) {
      continue;
    }
    textMap[path] = rawDetails
      .map((detail) => normalizeLineDetail(detail, lineMap[path]))
      .filter(Boolean);
  }
  return textMap;
}

export function validateReviewOutput(output, trustedLineMap, config) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('review-output.json must be an object');
  }
  if (typeof output.summary !== 'string') {
    throw new Error('review-output.json missing summary');
  }

  const trusted = normalizeTrustedReviewData(trustedLineMap);
  const findings = [];
  for (const rawFinding of Array.isArray(output.findings) ? output.findings : []) {
    const finding = normalizeFinding(rawFinding);
    if (!finding) {
      continue;
    }
    if (!isChangedLine(trusted.changedLines, finding.path, finding.line) || finding.confidence < config.minConfidence || !evidenceReferencesChangedLine(finding, trusted.changedLineTexts)) {
      continue;
    }
    findings.push(finding);
  }

  return {
    summary: output.summary.includes(SUMMARY_MARKER)
      ? output.summary.slice(0, 65000)
      : `${SUMMARY_MARKER}\n${output.summary.slice(0, 65000)}`,
    findings: dedupeFindingsByLocation(findings).sort((a, b) => compareSeverity(a.severity, b.severity)).slice(0, config.maxInlineComments),
    overallSeverity: highestSeverity(findings)
  };
}

export function parsePatchChangedLines(patch) {
  return parsePatchChangedLineDetails(patch).map((detail) => detail.line);
}

export function parsePatchChangedLineDetails(patch) {
  const changedLines = [];
  let currentNewLine = 0;

  for (const line of String(patch ?? '').split('\n')) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[2], 10);
      continue;
    }
    if (currentNewLine === 0) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({ line: currentNewLine, text: line.slice(1) });
      currentNewLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }
    currentNewLine += 1;
  }

  return dedupeLineDetails(changedLines);
}

async function fetchTrustedPullRequestData({ pullRequest, token }) {
  const pr = await githubRequest({
    method: 'GET',
    path: `/repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    token
  });
  const files = await githubPaginatedRequest({
    path: `/repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files`,
    token
  });
  const changedLines = {};
  const changedLineTexts = {};
  for (const file of files) {
    const path = normalizeRepoPath(file.filename);
    if (!path || file.status === 'removed') {
      continue;
    }
    changedLineTexts[path] = parsePatchChangedLineDetails(file.patch);
    changedLines[path] = changedLineTexts[path].map((detail) => detail.line);
  }
  return { changedLines, changedLineTexts, headSha: pr.head?.sha ?? pullRequest.headSha };
}

async function upsertSummaryComment({ pullRequest, summary, token }) {
  const comments = await githubPaginatedRequest({
    path: `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/${pullRequest.number}/comments`,
    token
  });
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(SUMMARY_MARKER));
  if (existing) {
    await githubRequest({
      method: 'PATCH',
      path: `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/comments/${existing.id}`,
      token,
      body: { body: summary }
    });
    return;
  }
  await githubRequest({
    method: 'POST',
    path: `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/${pullRequest.number}/comments`,
    token,
    body: { body: summary }
  });
}

async function postInlineComments({ pullRequest, inlineComments, token }) {
  const existing = await githubPaginatedRequest({
    path: `/repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
    token
  });
  const existingMarkers = new Set(existing.map((comment) => extractInlineMarker(comment.body)).filter(Boolean));
  const result = { posted: 0, stale: [] };

  for (const comment of inlineComments) {
    if (existingMarkers.has(comment.marker)) {
      continue;
    }
    try {
      await githubRequest({
        method: 'POST',
        path: `/repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
        token,
        body: {
          body: comment.body,
          commit_id: comment.commitId,
          path: comment.path,
          line: comment.line,
          side: 'RIGHT'
        }
      });
      result.posted += 1;
    } catch (error) {
      if (error.status === 422) {
        result.stale.push(comment);
        continue;
      }
      throw error;
    }
  }

  return result;
}

async function githubPaginatedRequest({ path, token }) {
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const pageResults = await githubRequest({ method: 'GET', path: `${path}${separator}per_page=100&page=${page}`, token });
    results.push(...pageResults);
    if (!Array.isArray(pageResults) || pageResults.length < 100) {
      break;
    }
  }
  return results;
}

async function githubRequest({ method, path, token, body }) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${method} ${path} failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function validatePullRequest(rawPullRequest) {
  if (!rawPullRequest || typeof rawPullRequest !== 'object') {
    throw new Error('pullRequest metadata is missing');
  }
  const { owner, repo, number, headSha } = rawPullRequest;
  if (!owner || !repo || !number || !headSha) {
    throw new Error('pullRequest metadata must include owner, repo, number, and headSha');
  }
  if (!isSafeRepoComponent(owner) || !isSafeRepoComponent(repo)) {
    throw new Error('pullRequest owner and repo contain unsupported characters');
  }
  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new Error('pullRequest number must be a positive integer');
  }
  return { ...rawPullRequest, owner, repo, number: parsedNumber, headSha: String(headSha) };
}

function assertMatchingPullRequestMetadata(inputPullRequest, outputPullRequest) {
  if (!outputPullRequest || typeof outputPullRequest !== 'object') {
    throw new Error('review-output.json missing pullRequest metadata');
  }

  const output = validatePullRequest(outputPullRequest);
  for (const key of ['owner', 'repo', 'number', 'headSha']) {
    if (inputPullRequest[key] !== output[key]) {
      throw new Error(`Pull request metadata mismatch for ${key}`);
    }
  }
}

async function assertEventMetadataMatches(pullRequest, eventPath) {
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required outside dry-run mode');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const repositoryFullName = event.repository?.full_name;
  const [owner, repo] = typeof repositoryFullName === 'string' ? repositoryFullName.split('/') : [];
  const eventPullRequest = event.pull_request;

  if (!owner || !repo || !eventPullRequest) {
    throw new Error('GitHub event metadata is missing repository or pull_request');
  }

  const eventHeadSha = eventPullRequest.head?.sha;
  const eventNumber = Number.parseInt(eventPullRequest.number, 10);
  if (
    pullRequest.owner !== owner ||
    pullRequest.repo !== repo ||
    pullRequest.number !== eventNumber ||
    pullRequest.headSha !== eventHeadSha
  ) {
    throw new Error('Artifact pull request metadata does not match GitHub event metadata');
  }
}

function isSafeRepoComponent(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
}

function normalizeFinding(rawFinding) {
  if (!rawFinding || typeof rawFinding !== 'object' || Array.isArray(rawFinding)) {
    return null;
  }
  const path = normalizeRepoPath(rawFinding.path);
  const line = readPositiveInteger(rawFinding.line);
  const severity = typeof rawFinding.severity === 'string' ? rawFinding.severity.toLowerCase() : '';
  const category = typeof rawFinding.category === 'string' && CATEGORIES.includes(rawFinding.category)
    ? rawFinding.category
    : null;
  const confidence = readConfidence(rawFinding.confidence);
  const title = clampText(rawFinding.title, 120);
  const evidence = clampText(rawFinding.evidence, 500);
  const body = clampText(rawFinding.body, 2000);
  const recommendation = clampText(rawFinding.recommendation, 1000);
  const suggestion = sanitizeSuggestion(rawFinding.suggestion);

  if (!path || !Number.isInteger(line) || line <= 0 || !category || !SEVERITIES.includes(severity) || severity === 'none' || !title || !evidence || !body || !recommendation) {
    return null;
  }
  return { path, line, category, severity, confidence, title, evidence, body, recommendation, suggestion };
}

function normalizeTrustedReviewData(trustedLineMap) {
  if (trustedLineMap?.changedLines && trustedLineMap?.changedLineTexts) {
    return trustedLineMap;
  }
  return { changedLines: trustedLineMap, changedLineTexts: {} };
}

function normalizeLineDetail(detail, allowedLines) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return null;
  }
  const line = readPositiveInteger(detail.line);
  const text = clampText(detail.text, 2000);
  if (!Number.isInteger(line) || !allowedLines.includes(line) || !text) {
    return null;
  }
  return { line, text };
}

function formatInlineComment(finding, commitId) {
  const marker = inlineMarker(finding);
  const suggestion = finding.suggestion ? `\n\nSuggestion:\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`` : '';
  return {
    marker,
    commitId,
    path: finding.path,
    line: finding.line,
    body: [
      `**${finding.severity.toUpperCase()}: ${finding.title}**`,
      '',
      `Category: ${finding.category} | Confidence: ${Math.round(finding.confidence * 100)}%`,
      '',
      `Evidence: ${finding.evidence}`,
      '',
      finding.body,
      '',
      `Recommendation: ${finding.recommendation}`,
      suggestion,
      '',
      marker
    ].join('\n')
  };
}

function appendStaleInlineFallback(summary, staleComments) {
  const lines = [summary, '', '## Inline comments not posted'];
  for (const comment of staleComments.slice(0, 20)) {
    lines.push(`- ${comment.path}:${comment.line} could not be posted, likely because the diff line became stale.`);
  }
  return lines.join('\n');
}

function inlineMarker(finding) {
  const hash = createHash('sha256')
    .update(`${finding.path}:${finding.line}:${finding.title}`)
    .digest('hex')
    .slice(0, 16);
  return `<!-- gemma-reviewer:${finding.path}:${finding.line}:${hash} -->`;
}

function extractInlineMarker(body) {
  const match = String(body ?? '').match(/<!-- gemma-reviewer:[^>]+ -->/);
  return match?.[0];
}

function shouldFailReview(review, config) {
  return review.findings.some((finding) => config.failOnSeverity.includes(finding.severity));
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

function dedupeLineDetails(details) {
  const byLine = new Map();
  for (const detail of details) {
    if (!byLine.has(detail.line)) {
      byLine.set(detail.line, detail);
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
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

function compareFindingPriority(left, right) {
  const severityDifference = severityRank(left.severity) - severityRank(right.severity);
  if (severityDifference !== 0) {
    return severityDifference;
  }
  return left.confidence - right.confidence;
}

function highestSeverity(findings) {
  return findings.reduce((highest, finding) => (
    severityRank(finding.severity) > severityRank(highest) ? finding.severity : highest
  ), 'none');
}

function isPermissionError(error) {
  return error?.status === 401 || error?.status === 403;
}

function readToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required unless --dry-run is used');
  }
  return token;
}

async function writeJobSummary(summary, inlineComments, reason) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    return;
  }
  const markdown = [
    summary,
    '',
    `> PR comments were not published: ${reason}`,
    '',
    `Inline comments that would have been posted: ${inlineComments.length}`
  ].join('\n');
  await writeFile(path, markdown, { flag: 'a' });
}

async function writeDryRun(outputPath, result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized);
    return;
  }
  process.stdout.write(serialized);
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

function parseArgs(argv) {
  const args = { inputPath: 'review-output.json', reviewInputPath: 'review-input.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      args.inputPath = argv[++index];
    } else if (arg === '--review-input') {
      args.reviewInputPath = argv[++index];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--no-fail') {
      args.noFail = true;
    } else if (arg === '--output') {
      args.outputPath = argv[++index];
    } else if (arg === '--event') {
      args.eventPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  publishReview(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
