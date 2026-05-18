export const DEFAULT_EXCLUDED_PATHS = [
  '.git/**',
  'node_modules/**',
  'vendor/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/*.min.js',
  '**/*.map',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.svg',
  '**/*.pdf',
  '**/*.zip',
  '**/*.gz'
];

export const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];
export const CATEGORIES = ['correctness', 'security', 'breaking-change', 'data-loss', 'concurrency', 'test-gap', 'maintainability'];

export function loadConfig(env = process.env) {
  const config = {
    model: readString(env, 'GEMMA_REVIEW_MODEL', 'gemma3:1b'),
    ollamaVersion: readString(env, 'GEMMA_REVIEW_OLLAMA_VERSION', '0.12.10'),
    cacheVersion: readString(env, 'GEMMA_REVIEW_CACHE_VERSION', 'v1'),
    ollamaUrl: readString(env, 'GEMMA_REVIEW_OLLAMA_URL', 'http://127.0.0.1:11434'),
    maxDiffBytes: readInteger(env, 'GEMMA_REVIEW_MAX_DIFF_BYTES', 200000),
    maxFileBytes: readInteger(env, 'GEMMA_REVIEW_MAX_FILE_BYTES', 60000),
    maxChunkBytes: readInteger(env, 'GEMMA_REVIEW_MAX_CHUNK_BYTES', 24000),
    maxInlineComments: readInteger(env, 'GEMMA_REVIEW_MAX_INLINE_COMMENTS', 20),
    minConfidence: readNumber(env, 'GEMMA_REVIEW_MIN_CONFIDENCE', 0.6),
    timeoutMs: readInteger(env, 'GEMMA_REVIEW_TIMEOUT_MS', 600000),
    failOnSeverity: readSeverityList(env, 'GEMMA_REVIEW_FAIL_ON_SEVERITY', ['critical', 'high']),
    language: readString(env, 'GEMMA_REVIEW_LANGUAGE', 'ko'),
    excludedPaths: readList(env, 'GEMMA_REVIEW_EXCLUDED_PATHS', DEFAULT_EXCLUDED_PATHS)
  };

  validateConfig(config);
  return config;
}

export function normalizeRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.includes('\0')
  ) {
    return null;
  }

  return normalized;
}

export function isExcludedPath(filePath, patterns = DEFAULT_EXCLUDED_PATHS) {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) {
    return true;
  }

  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

export function compareSeverity(a, b) {
  return severityRank(b) - severityRank(a);
}

export function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

function readString(env, name, fallback) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readInteger(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNumber(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function readList(env, name, fallback) {
  const value = env[name];
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSeverityList(env, name, fallback) {
  const severities = readList(env, name, fallback);
  for (const severity of severities) {
    if (!SEVERITIES.includes(severity)) {
      throw new Error(`${name} contains unsupported severity: ${severity}`);
    }
  }
  return severities;
}

function validateConfig(config) {
  if (!config.model) {
    throw new Error('GEMMA_REVIEW_MODEL cannot be empty');
  }
  if (!config.ollamaVersion) {
    throw new Error('GEMMA_REVIEW_OLLAMA_VERSION cannot be empty');
  }
  if (config.maxChunkBytes > config.maxDiffBytes) {
    throw new Error('GEMMA_REVIEW_MAX_CHUNK_BYTES cannot exceed GEMMA_REVIEW_MAX_DIFF_BYTES');
  }
  if (config.minConfidence < 0 || config.minConfidence > 1) {
    throw new Error('GEMMA_REVIEW_MIN_CONFIDENCE must be between 0 and 1');
  }
}

function matchesPattern(filePath, pattern) {
  return globToRegExp(pattern).test(filePath);
}

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }

    if (char === '/' && next === '*' && afterNext === '*') {
      source += '(?:/.*)?';
      index += 2;
      continue;
    }

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`^${source}$`);
}

function escapeRegExp(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
