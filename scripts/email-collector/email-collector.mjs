#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

const NOISE_PATTERNS = ['noreply', 'no-reply', 'notifications@', 'calendar-notification', 'mailer-daemon', 'postmaster', 'donotreply'];
const SIGNATURE_PATTERNS = [
  /docusign/i,
  /dropbox sign/i,
  /hellosign/i,
  /pandadoc/i,
  /please sign/i,
  /signature needed/i,
  /ready for your signature/i,
  /everyone has signed/i,
  /you just signed/i,
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function atomicWrite(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function statePath(baseDir) {
  return join(baseDir, 'data', 'state.json');
}

function messagesPath(baseDir, date) {
  return join(baseDir, 'data', 'messages', `${date}.json`);
}

function digestPath(baseDir, date) {
  return join(baseDir, 'data', 'digests', `${date}.md`);
}

function defaultState() {
  return {
    last_collect_at: null,
    known_message_ids: {},
    pending_signatures: {},
  };
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function initCollector(baseDir) {
  ensureDir(join(baseDir, 'data', 'messages'));
  ensureDir(join(baseDir, 'data', 'digests'));
  if (!existsSync(statePath(baseDir))) {
    atomicWrite(statePath(baseDir), JSON.stringify(defaultState(), null, 2));
  }
}

function normalizeDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date(raw).toISOString().slice(0, 10);
}

function gmailLink(messageId, authuser) {
  return `https://mail.google.com/mail/u/?authuser=${authuser}#inbox/${messageId}`;
}

function isNoise(message) {
  const from = String(message.from || '').toLowerCase();
  return NOISE_PATTERNS.some(pattern => from.includes(pattern));
}

function isSignature(message) {
  const subject = String(message.subject || '');
  const from = String(message.from || '');
  return SIGNATURE_PATTERNS.some(pattern => pattern.test(subject) || pattern.test(from));
}

function normalizeMessage(message, account, knownIds) {
  const link = gmailLink(message.id, account);
  return {
    id: message.id,
    from: message.from || '',
    subject: message.subject || '',
    snippet: message.snippet || '',
    body: message.body || '',
    thread_id: message.thread_id || '',
    date: message.date || new Date().toISOString(),
    gmail_link: link,
    gmail_markdown: `[Open in Gmail](${link})`,
    is_signature: isSignature(message),
    is_noise: isNoise(message),
    is_new: !knownIds[message.id],
  };
}

function extractHeader(headers, name) {
  for (const header of headers || []) {
    if (String(header.name || '').toLowerCase() === name.toLowerCase()) return header.value || '';
  }
  return '';
}

function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const text = extractBodyText(part);
    if (text) return text;
  }
  return '';
}

function runGws(gwsBin, ...args) {
  const result = spawnSync(gwsBin, ['gmail', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`gws error: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function loadInputMessages({ provider, inputPath, gwsBin, account }) {
  if (provider === 'gws') {
    const listed = runGws(gwsBin || '/opt/homebrew/bin/gws', 'users', 'messages', 'list', '--params', JSON.stringify({ userId: 'me', q: 'is:unread newer_than:1d', maxResults: 50 }));
    const ids = listed.messages || [];
    return ids.map(item => {
      const full = runGws(gwsBin || '/opt/homebrew/bin/gws', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id: item.id, format: 'full' }));
      const headers = full.payload?.headers || [];
      return {
        id: full.id,
        thread_id: full.threadId || '',
        from: extractHeader(headers, 'From'),
        subject: extractHeader(headers, 'Subject'),
        date: extractHeader(headers, 'Date') || new Date().toISOString(),
        snippet: full.snippet || '',
        body: extractBodyText(full.payload),
      };
    });
  }

  if (!inputPath) throw new Error('--input is required for collect unless --provider gws is used');
  return readJson(resolve(inputPath), []);
}

function collect(baseDir, inputPath, account, dateArg, provider, gwsBin) {
  if (!account) throw new Error('--account is required for collect');

  initCollector(baseDir);
  const state = readJson(statePath(baseDir), defaultState());
  const rawMessages = loadInputMessages({ provider, inputPath, gwsBin, account });
  const date = normalizeDate(dateArg || rawMessages[0]?.date);
  const outPath = messagesPath(baseDir, date);
  const existing = readJson(outPath, []);
  const existingById = new Map(existing.map(msg => [msg.id, msg]));
  let changed = false;

  for (const raw of rawMessages) {
    const normalized = normalizeMessage(raw, account, state.known_message_ids || {});
    if (existingById.has(normalized.id)) continue;
    existingById.set(normalized.id, normalized);
    state.known_message_ids[normalized.id] = true;
    if (normalized.is_signature) state.pending_signatures[normalized.id] = true;
    changed = true;
  }

  state.last_collect_at = new Date().toISOString();
  const records = Array.from(existingById.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  atomicWrite(outPath, JSON.stringify(records, null, 2));
  atomicWrite(statePath(baseDir), JSON.stringify(state, null, 2));
  return { date, count: records.length, changed };
}

function formatSection(title, items) {
  const lines = [`## ${title}`, ''];
  if (items.length === 0) {
    lines.push('- None', '');
    return lines;
  }
  for (const item of items) {
    lines.push(`- **${item.subject || '(no subject)'}** — ${item.from}`);
    if (item.snippet) lines.push(`  - ${item.snippet}`);
    lines.push(`  - ${item.gmail_markdown}`);
    lines.push(`  - ${item.date}`);
    lines.push('');
  }
  return lines;
}

function digest(baseDir, dateArg) {
  initCollector(baseDir);
  const date = normalizeDate(dateArg);
  const records = readJson(messagesPath(baseDir, date), []);

  const signatures = records.filter(msg => msg.is_signature);
  const triage = records.filter(msg => !msg.is_signature && !msg.is_noise);
  const noise = records.filter(msg => msg.is_noise);

  const lines = [
    `# Email Digest — ${date}`,
    '',
    ...formatSection('Signatures pending', signatures),
    ...formatSection('Messages to triage', triage),
    ...formatSection('Noise', noise),
  ];

  atomicWrite(digestPath(baseDir, date), `${lines.join('\n').trim()}\n`);
  return { date, total: records.length };
}

function parseSender(fromHeader) {
  const match = String(fromHeader || '').match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { displayName: match[1].trim(), email: match[2].trim().toLowerCase() };
  }
  const value = String(fromHeader || '').trim();
  if (value.includes('@')) {
    const name = value.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return { displayName: name.split(/\s+/).map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' '), email: value.toLowerCase() };
  }
  return { displayName: value || 'Unknown Sender', email: '' };
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown-sender';
}

function parseAliases(content) {
  const match = content.match(/aliases:\s*\[(.*?)\]/s);
  if (!match) return [];
  return match[1]
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/^"|"$/g, ''));
}

function splitPage(content) {
  const marker = '\n---\n';
  const idx = content.indexOf(marker);
  if (idx === -1) return { compiled: content.trim(), timeline: '' };
  return {
    compiled: content.slice(0, idx).trim(),
    timeline: content.slice(idx + marker.length).trim(),
  };
}

function findPersonPage(peopleDir, sender) {
  if (!existsSync(peopleDir)) return null;
  const files = readdirSync(peopleDir).filter(name => name.endsWith('.md'));
  for (const file of files) {
    const fullPath = join(peopleDir, file);
    const content = readFileSync(fullPath, 'utf8');
    const aliases = parseAliases(content);
    if (aliases.includes(sender.email) || aliases.includes(sender.displayName)) {
      return { slug: file.replace(/\.md$/, ''), path: fullPath, content };
    }
  }
  return null;
}

function buildCompiledContent(sender, aliases, date) {
  return `---\naliases: [${aliases.map(alias => `"${alias}"`).join(', ')}]\n---\n# ${sender.displayName}\n\n> Executive summary.\n\n## State\n- Last touched via email on ${date}\n\n## Open Threads\n- None\n\n## See Also\n- None`;
}

function appendTimelineEntry(existingTimeline, message, sender) {
  const entry = `${normalizeDate(message.date)} | Email from ${message.from}: ${message.subject} [Source: Gmail, ${message.date}]`;
  if (!existingTimeline) return entry;
  if (existingTimeline.includes(entry)) return existingTimeline;
  return `${existingTimeline.trim()}\n${entry}`;
}

function enrich(baseDir, brainDir, dateArg) {
  if (!brainDir) throw new Error('--brain-dir is required for enrich');
  const date = normalizeDate(dateArg);
  const records = readJson(messagesPath(baseDir, date), []);
  const peopleDir = join(resolve(brainDir), 'people');
  const rawDir = join(peopleDir, '.raw');
  ensureDir(peopleDir);
  ensureDir(rawDir);

  let updated = 0;
  for (const message of records.filter(msg => !msg.is_noise)) {
    const sender = parseSender(message.from);
    const existing = findPersonPage(peopleDir, sender);
    const slug = existing?.slug || slugify(sender.displayName);
    const personPath = join(peopleDir, `${slug}.md`);
    const rawPath = join(rawDir, `${slug}.json`);

    const aliases = Array.from(new Set([sender.displayName, sender.email].filter(Boolean).concat(existing ? parseAliases(existing.content) : [])));
    const existingContent = existing?.content || '';
    const page = splitPage(existingContent);
    const compiled = buildCompiledContent(sender, aliases, date);
    const timeline = appendTimelineEntry(page.timeline, message, sender);
    atomicWrite(personPath, `${compiled}\n\n---\n${timeline}\n`);

    const raw = readJson(rawPath, { messages: [] });
    if (!raw.messages.some(entry => entry.id === message.id)) {
      raw.messages.push(message);
    }
    atomicWrite(rawPath, JSON.stringify(raw, null, 2));
    updated += 1;
  }

  return { date, updated };
}

function printHelp() {
  console.log(`email-collector.mjs

USAGE
  node email-collector.mjs init --dir <path>
  node email-collector.mjs collect --dir <path> --input <file.json> --account <email> [--date YYYY-MM-DD]
  node email-collector.mjs collect --dir <path> --provider gws --gws-bin /opt/homebrew/bin/gws --account <email> [--date YYYY-MM-DD]
  node email-collector.mjs digest --dir <path> [--date YYYY-MM-DD]
  node email-collector.mjs enrich --dir <collector-path> --brain-dir <brain-path> [--date YYYY-MM-DD]
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const baseDir = resolve(args.dir || process.cwd());

  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      printHelp();
      return;
    }

    if (command === 'init') {
      initCollector(baseDir);
      console.log(`initialized ${baseDir}`);
      return;
    }

    if (command === 'collect') {
      const result = collect(baseDir, args.input, args.account, args.date, args.provider, args.gws_bin);
      console.log(`collected ${result.count} messages for ${result.date}`);
      return;
    }

    if (command === 'digest') {
      const result = digest(baseDir, args.date);
      console.log(`wrote digest for ${result.date} (${result.total} messages)`);
      return;
    }

    if (command === 'enrich') {
      const result = enrich(baseDir, args.brain_dir, args.date);
      console.log(`enriched ${result.updated} people for ${result.date}`);
      return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
