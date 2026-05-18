#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { buildChangedLineMap, buildChangedLineTextMap, createChunks, parseUnifiedDiff } from './diff-utils.mjs';

export async function prepareDiff(options = {}) {
  const config = options.config ?? loadConfig();
  const eventPath = options.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH or --event is required');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequest = extractPullRequest(event);
  const diffText = options.diffPath
    ? await readFile(options.diffPath, 'utf8')
    : readDiffFromGit(pullRequest);

  const parsed = parseUnifiedDiff(diffText, config);
  const chunks = createChunks(parsed.files, config.maxChunkBytes);
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pullRequest,
    limits: {
      maxDiffBytes: config.maxDiffBytes,
      maxFileBytes: config.maxFileBytes,
      maxChunkBytes: config.maxChunkBytes,
      maxInlineComments: config.maxInlineComments,
      failOnSeverity: config.failOnSeverity
    },
    changedLines: buildChangedLineMap(parsed.files),
    changedLineTexts: buildChangedLineTextMap(parsed.files),
    chunks,
    skippedFiles: parsed.skippedFiles,
    totalIncludedBytes: parsed.totalIncludedBytes
  };

  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  return output;
}

export function extractPullRequest(event) {
  const pr = event.pull_request;
  if (!pr) {
    throw new Error('Event payload does not contain pull_request');
  }

  const repositoryFullName = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  if (!repositoryFullName || !repositoryFullName.includes('/')) {
    throw new Error('Repository full name is missing from event payload');
  }

  const [owner, repo] = repositoryFullName.split('/');
  const headRepoFullName = pr.head?.repo?.full_name ?? repositoryFullName;

  return {
    owner,
    repo,
    number: pr.number,
    baseSha: pr.base?.sha,
    headSha: pr.head?.sha,
    baseRef: pr.base?.ref,
    headRef: pr.head?.ref,
    headRepoFullName,
    isFork: headRepoFullName !== repositoryFullName
  };
}

export function readDiffFromGit(pullRequest) {
  if (!pullRequest.baseSha || !pullRequest.headSha || !pullRequest.number) {
    throw new Error('Pull request baseSha, headSha, and number are required to read git diff');
  }

  const prHeadRef = 'refs/remotes/gemma-review/pr-head';
  const fetchArgs = [
    ...gitAuthArgs(process.env.GITHUB_TOKEN),
    'fetch',
    '--no-tags',
    'origin',
    `+refs/pull/${pullRequest.number}/head:${prHeadRef}`
  ];
  execFileSync('git', fetchArgs, { stdio: 'inherit' });

  const mergeBase = execFileSync('git', [
    'merge-base',
    pullRequest.baseSha,
    prHeadRef
  ], { encoding: 'utf8' }).trim();

  return execFileSync('git', [
    'diff',
    '--unified=0',
    '--no-ext-diff',
    buildDiffRange(mergeBase, prHeadRef)
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

export function buildDiffRange(mergeBase, headRef) {
  if (!mergeBase || !headRef) {
    throw new Error('mergeBase and headRef are required');
  }

  return `${mergeBase}..${headRef}`;
}

export function gitAuthArgs(token) {
  if (!token) {
    return [];
  }

  const credentials = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${credentials}`];
}

function parseArgs(argv) {
  const args = { outputPath: 'review-input.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--event') {
      args.eventPath = argv[++index];
    } else if (arg === '--output') {
      args.outputPath = argv[++index];
    } else if (arg === '--diff') {
      args.diffPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareDiff(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
