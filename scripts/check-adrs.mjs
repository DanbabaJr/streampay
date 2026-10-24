#!/usr/bin/env node
/**
 * ADR Program Validator for StreamPay
 *
 * Verifies:
 * 1. docs/adr/template.md exists and contains standard placeholder structure.
 * 2. ADR files follow strict zero-padded contiguous numbering (0001, 0002, ...).
 * 3. ADR files contain all mandatory sections:
 *    - Status line (Proposed, Accepted, Rejected, Superseded by ADR-XXXX, Deprecated)
 *    - Date line (YYYY-MM-DD)
 *    - Context / Problem Statement
 *    - Decision / Decision Outcome
 *    - Consequences
 *    - Alternatives Considered
 * 4. All relative Markdown links resolve to existing files and valid anchors.
 * 5. Any "Superseded by" links resolve to an existing ADR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');

console.log('='.repeat(72));
console.log('   StreamPay ADR Integrity & Link Verification');
console.log('='.repeat(72));

let errors = [];

function error(msg) {
  errors.push(msg);
  console.error(`  ❌ ERROR: ${msg}`);
}

function success(msg) {
  console.log(`  ✓ ${msg}`);
}

// 1. Check directory & template.md
if (!fs.existsSync(ADR_DIR)) {
  error(`ADR directory not found at: ${ADR_DIR}`);
  process.exit(1);
}

const templatePath = path.join(ADR_DIR, 'template.md');
if (!fs.existsSync(templatePath)) {
  error('Missing docs/adr/template.md');
} else {
  const templateContent = fs.readFileSync(templatePath, 'utf8');
  if (!templateContent.includes('Status:') || !templateContent.includes('## Context') || !templateContent.includes('## Decision')) {
    error('docs/adr/template.md missing required template sections');
  } else {
    success('docs/adr/template.md verified');
  }
}

// 2. Discover ADR files
const adrFiles = fs.readdirSync(ADR_DIR)
  .filter(f => /^\d{4}-[\w-]+\.md$/.test(f))
  .sort();

if (adrFiles.length === 0) {
  error('No numbered ADR files found in docs/adr/');
} else {
  success(`Discovered ${adrFiles.length} numbered ADR files`);
}

// 3. Verify contiguous numbering
const numbers = adrFiles.map(f => parseInt(f.slice(0, 4), 10));
for (let i = 0; i < numbers.length; i++) {
  const expected = i + 1;
  const actual = numbers[i];
  if (actual !== expected) {
    error(`ADR numbering discontinuity: expected 000${expected} but found ${adrFiles[i]}`);
  }
}
success('Sequential numbering verified (no gaps or duplicates)');

// 4. Validate content & links in each ADR
const VALID_STATUSES = ['Proposed', 'Accepted', 'Rejected', 'Superseded', 'Deprecated'];

function extractHeadings(content) {
  const headings = new Set();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      const headingText = match[1].trim();
      // GitHub-style anchor slug: lowercase, strip punctuation except hyphen/space, collapse spaces to hyphen
      const slug = headingText
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
      headings.add(slug);
    }
  }
  return headings;
}

for (const file of adrFiles) {
  const fullPath = path.join(ADR_DIR, file);
  const content = fs.readFileSync(fullPath, 'utf8');

  // Verify Status
  // Matches:
  // - Status: Accepted
  // - Status: Accepted (backfilled)
  // - Status: Accepted-with-backfill
  // - Status: Superseded by [ADR-000X](000X-name.md)
  // - Status: Superseded by commit [8ac0d12](https://...)
  const statusMatch = content.match(/Status:\s*([A-Za-z]+)(?:-with-backfill|\s+\(backfill(?:ed)?\))?(?:\s+by\s+(?:\[ADR-(\d{4})\]\(([^)]+)\)|commit\s+\[([a-f0-9]+)\]\(([^)]+)\)))?/i);
  if (!statusMatch) {
    error(`${file}: Missing valid 'Status:' line`);
  } else {
    const rawStatus = statusMatch[1];
    if (!VALID_STATUSES.includes(rawStatus)) {
      error(`${file}: Unknown status '${rawStatus}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    if (rawStatus === 'Superseded') {
      const targetAdrNum = statusMatch[2];
      const targetAdrLink = statusMatch[3];
      const targetCommitHash = statusMatch[4];
      const targetCommitLink = statusMatch[5];
      if ((!targetAdrNum || !targetAdrLink) && (!targetCommitHash || !targetCommitLink)) {
        error(`${file}: Superseded status must include link to replacing ADR or commit, e.g. 'Superseded by [ADR-000X](000X-name.md)' or 'Superseded by commit [8ac0d12](https://...)'`);
      } else if (targetAdrLink) {
        const targetResolved = path.resolve(ADR_DIR, targetAdrLink);
        if (!fs.existsSync(targetResolved)) {
          error(`${file}: Superseded-by link '${targetAdrLink}' points to non-existent file`);
        }
      }
    }
  }

  // Verify Date
  const dateMatch = content.match(/Date:\s*(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) {
    error(`${file}: Missing valid 'Date: YYYY-MM-DD' line`);
  }

  // Verify mandatory sections
  if (!/##\s+(Context|Context and Problem Statement)/i.test(content)) {
    error(`${file}: Missing '## Context' section`);
  }
  if (!/##\s+(Decision|Decision Outcome)/i.test(content)) {
    error(`${file}: Missing '## Decision' section`);
  }
  if (!/##\s+Consequences/i.test(content)) {
    error(`${file}: Missing '## Consequences' section`);
  }
  if (!/##\s+(Alternatives Considered|Considered Options)/i.test(content)) {
    error(`${file}: Missing '## Alternatives Considered' section`);
  }

  // Verify all Markdown links [text](target)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(content)) !== null) {
    const linkText = linkMatch[1];
    const linkTarget = linkMatch[2].trim();

    // Skip example placeholder links
    if (linkTarget.includes('XXXX') || linkTarget.includes('000X')) {
      continue;
    }

    // Skip external http/https and mailto links
    if (/^(https?:|mailto:|#)/.test(linkTarget)) {
      if (linkTarget.startsWith('#')) {
        const anchor = linkTarget.slice(1);
        const headings = extractHeadings(content);
        if (!headings.has(anchor)) {
          error(`${file}: Internal anchor link '#${anchor}' not found in document`);
        }
      }
      continue;
    }

    const [targetPath, targetAnchor] = linkTarget.split('#');
    const resolvedPath = path.resolve(ADR_DIR, targetPath);

    if (!fs.existsSync(resolvedPath)) {
      error(`${file}: Broken link '[${linkText}](${linkTarget})' -> file does not exist: ${resolvedPath}`);
    } else if (targetAnchor) {
      const targetContent = fs.readFileSync(resolvedPath, 'utf8');
      const targetHeadings = extractHeadings(targetContent);
      if (!targetHeadings.has(targetAnchor)) {
        error(`${file}: Anchor '#${targetAnchor}' not found in target file: ${targetPath}`);
      }
    }
  }

  success(`${file}: format, sections, and links OK`);
}

// 5. Verify README.md index
const readmePath = path.join(ADR_DIR, 'README.md');
if (!fs.existsSync(readmePath)) {
  error('Missing docs/adr/README.md index');
} else {
  const readmeContent = fs.readFileSync(readmePath, 'utf8');
  for (const file of adrFiles) {
    if (!readmeContent.includes(file)) {
      error(`docs/adr/README.md does not reference ADR file: ${file}`);
    }
  }
  success('docs/adr/README.md contains references to all ADR files');
}

console.log('='.repeat(72));
if (errors.length > 0) {
  console.error(`❌ ADR validation failed with ${errors.length} error(s).`);
  process.exit(1);
} else {
  console.log('✅ ALL ADR CHECKS PASSED: Numbering, structure, and link integrity verified.');
  process.exit(0);
}
