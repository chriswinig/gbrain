#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import YAML from 'yaml';

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
const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'labs', 'lab', 'ai', 'ventures', 'capital', 'group', 'studio', 'studios', 'systems', 'technologies', 'technology', 'partners', 'health', 'fitness']);
const ENTITY_STOPWORDS = new Set(['Need', 'Review', 'Please', 'Thanks', 'Thank', 'Tomorrow', 'Today', 'Team', 'Brain', 'Email', 'Sync', 'This', 'That', 'Message', 'Messages', 'Page', 'Pages', 'Open', 'Threads', 'Executive', 'Summary', 'Last', 'Touched', 'Design', 'Kick', 'Import', 'Real']);
const GENERIC_SENDER_LOCAL_PARTS = [/noreply/i, /no-reply/i, /notification/i, /support/i, /billing/i, /invoice/i, /statement/i, /receipt/i, /team/i, /info/i, /contact/i, /mail/i, /system/i, /security/i, /account/i, /acct_/i, /hello/i, /jobs/i, /careers/i, /feedback/i];
const PERSONAL_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com']);
const NOISE_ENTITY_BLOCKLIST = new Set(['notification', 'support', 'us', 'noreply', 'info', 'alerts', 'admin', 'team', 'hello', 'contact', 'help', 'sales', 'billing', 'feedback', 'system', 'security', 'account', 'service', 'mail', 'update', 'updates', 'news', 'newsletter', 'marketing', 'promotions', 'no-reply', 'do-not-reply', 'donotreply']);
const WEAK_ALIAS_BLOCKLIST = new Set(['x', 'us', 'support', 'notification', 'billing', 'feedback', 'info', 'team', 'admin', 'help', 'sales', 'contact', 'service', 'mail', 'system', 'security', 'account', 'hello', 'news', 'update', 'alerts', 'hr', 'it', 'ops', 'dev', 'qa', 'api', 'app', 'web', 'go', 'do', 'ai', 'io', 'me', 'my', 'to', 'at', 'up', 'no', 'on', 'or', 'so', 'ok']);
const MATCH_THRESHOLD = 0.3;
const SENDER_MERGE_THRESHOLD = 0.3;
const MENTION_MERGE_THRESHOLD = 0.5;
const MENTION_CREATE_THRESHOLD = 0.6;

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

function latestCollectedDate(baseDir) {
  const dir = join(baseDir, 'data', 'messages');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  return files.length ? files[files.length - 1].replace(/\.json$/, '') : null;
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

function coerceDateIso(rawDate, internalDate) {
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (internalDate) {
    const millis = Number(internalDate);
    if (!Number.isNaN(millis) && millis > 0) return new Date(millis).toISOString();
  }
  return new Date().toISOString();
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
  const dateIso = coerceDateIso(message.date, message.internal_date);
  return {
    id: message.id,
    from: message.from || '',
    to: message.to || '',
    cc: message.cc || '',
    reply_to: message.reply_to || '',
    delivered_to: message.delivered_to || '',
    subject: message.subject || '',
    snippet: message.snippet || '',
    body: message.body || '',
    thread_id: message.thread_id || '',
    date: message.date || dateIso,
    date_iso: dateIso,
    internal_date: message.internal_date || '',
    history_id: message.history_id || '',
    label_ids: Array.isArray(message.label_ids) ? message.label_ids : [],
    message_id_header: message.message_id_header || '',
    in_reply_to: message.in_reply_to || '',
    references: message.references || '',
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

function buildGwsQuery(state) {
  const lastCollectAt = Date.parse(state?.last_collect_at || '');
  if (!Number.isNaN(lastCollectAt)) {
    const overlapSeconds = 5 * 60;
    const afterSeconds = Math.max(0, Math.floor(lastCollectAt / 1000) - overlapSeconds);
    return `after:${afterSeconds}`;
  }
  return 'newer_than:1d';
}

function listGwsMessages(gwsBin, query) {
  const messages = [];
  let pageToken = null;
  do {
    const params = { userId: 'me', q: query, maxResults: 100 };
    if (pageToken) params.pageToken = pageToken;
    const listed = runGws(gwsBin || '/opt/homebrew/bin/gws', 'users', 'messages', 'list', '--params', JSON.stringify(params));
    messages.push(...(listed.messages || []));
    pageToken = listed.nextPageToken || null;
  } while (pageToken);
  return messages;
}

function loadInputMessages({ provider, inputPath, gwsBin, account, state }) {
  if (provider === 'gws') {
    const ids = listGwsMessages(gwsBin, buildGwsQuery(state));
    return ids.map(item => {
      const full = runGws(gwsBin || '/opt/homebrew/bin/gws', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id: item.id, format: 'full' }));
      const headers = full.payload?.headers || [];
      return {
        id: full.id,
        thread_id: full.threadId || '',
        history_id: full.historyId || '',
        internal_date: full.internalDate || '',
        label_ids: full.labelIds || [],
        from: extractHeader(headers, 'From'),
        to: extractHeader(headers, 'To'),
        cc: extractHeader(headers, 'Cc'),
        reply_to: extractHeader(headers, 'Reply-To'),
        delivered_to: extractHeader(headers, 'Delivered-To'),
        subject: extractHeader(headers, 'Subject'),
        date: extractHeader(headers, 'Date') || new Date().toISOString(),
        message_id_header: extractHeader(headers, 'Message-Id') || extractHeader(headers, 'Message-ID'),
        in_reply_to: extractHeader(headers, 'In-Reply-To'),
        references: extractHeader(headers, 'References'),
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
  const rawMessages = loadInputMessages({ provider, inputPath, gwsBin, account, state });
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
  const records = Array.from(existingById.values()).sort((a, b) => String(a.date_iso || a.date).localeCompare(String(b.date_iso || b.date)));
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
  const date = normalizeDate(dateArg || latestCollectedDate(baseDir));
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

function stripWrappingQuotes(text) {
  const value = String(text || '').trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function sanitizeSenderDisplayName(raw) {
  let name = String(raw || '').trim();
  name = stripWrappingQuotes(name);
  // Handle pipe-delimited names like "2020 | Cyncly" → "Cyncly"
  if (name.includes('|')) {
    const parts = name.split('|').map(p => p.trim()).filter(Boolean);
    const best = parts.find(p => !/^\d{4}$/.test(p) && p.length > 1) || parts[parts.length - 1];
    name = best;
  }
  // Strip leading/trailing punctuation
  name = name.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return name.trim() || 'Unknown Sender';
}

function parseSender(fromHeader) {
  const match = String(fromHeader || '').match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { displayName: sanitizeSenderDisplayName(match[1]), email: match[2].trim().toLowerCase() };
  }
  const value = String(fromHeader || '').trim();
  if (value.includes('@')) {
    const name = value.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return { displayName: name.split(/\s+/).map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' '), email: value.toLowerCase() };
  }
  return { displayName: sanitizeSenderDisplayName(value), email: '' };
}

function senderEmailParts(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized.includes('@')) return { local: '', domain: '', domainBase: '' };
  const [local, domain] = normalized.split('@');
  const domainParts = domain.split('.').filter(Boolean);
  const domainBase = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : domainParts[0] || '';
  return { local, domain, domainBase };
}

function normalizeNameKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function classifySenderEntityKind(sender) {
  const displayName = normalizeEntityName(sender.displayName || '');
  const { local, domain, domainBase } = senderEmailParts(sender.email);
  const displayKey = normalizeNameKey(displayName);
  const localKey = normalizeNameKey(local.split('+')[0] || '');
  const domainKey = normalizeNameKey(domainBase);
  const isPersonalDomain = PERSONAL_EMAIL_DOMAINS.has(domain);
  const hasGenericLocal = GENERIC_SENDER_LOCAL_PARTS.some(pattern => pattern.test(local));
  const domainMatchesDisplay = Boolean(displayKey && domainKey && domainKey === displayKey);
  const localMatchesDisplay = Boolean(displayKey && localKey && localKey === displayKey);
  const companySignals = hasGenericLocal || domainMatchesDisplay || looksLikeCompanyName(displayName);

  if (isPersonalDomain && looksLikePersonName(displayName)) return 'person';
  if (companySignals) return 'company';
  if (looksLikePersonName(displayName)) return 'person';
  if (displayName.includes(' ')) return 'person';
  if (isPersonalDomain && localMatchesDisplay) return 'person';
  if (localMatchesDisplay && !hasGenericLocal) return 'person';
  return sender.email ? 'company' : 'person';
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown-sender';
}

function parseInlineArray(body) {
  const values = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;

    const quote = body[i] === '"' || body[i] === "'" ? body[i] : null;
    let value = '';

    if (quote && body[i + 1] === quote) {
      i += 2;
      const end = body.indexOf(`${quote}${quote}`, i);
      if (end === -1) {
        value = body.slice(i);
        i = body.length;
      } else {
        value = body.slice(i, end);
        i = end + 2;
      }
    } else if (quote) {
      i += 1;
      while (i < body.length) {
        const char = body[i];
        if (char === '\\' && i + 1 < body.length) {
          value += body[i + 1];
          i += 2;
          continue;
        }
        if (char === quote) {
          i += 1;
          break;
        }
        value += char;
        i += 1;
      }
    } else {
      const nextComma = body.indexOf(',', i);
      if (nextComma === -1) {
        value = body.slice(i);
        i = body.length;
      } else {
        value = body.slice(i, nextComma);
        i = nextComma;
      }
    }

    const normalized = stripWrappingQuotes(value).replace(/\\([\\"])/g, '$1').trim();
    if (normalized) values.push(normalized);
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (body[i] === ',') i += 1;
  }
  return values;
}

function parseFrontmatterRaw(raw) {
  try {
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const frontmatter = {};
    for (const line of String(raw || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(':')) continue;
      const idx = trimmed.indexOf(':');
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if ((key === 'aliases' || key === 'tags') && value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = parseInlineArray(value.slice(1, -1));
      } else {
        frontmatter[key] = stripWrappingQuotes(value);
      }
    }
    return frontmatter;
  }
}

function parseAliases(content) {
  const text = String(content || '');
  if (!text.startsWith('---\n')) return [];
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return [];
  const raw = text.slice(4, end).trim();
  const frontmatter = parseFrontmatterRaw(raw);
  const aliases = frontmatter.aliases;
  if (Array.isArray(aliases)) return aliases.map(a => String(a)).map(normalizeEntityName).filter(Boolean);
  if (typeof aliases === 'string') return parseInlineArray(String(aliases).replace(/^\[|\]$/g, '')).map(normalizeEntityName).filter(Boolean);
  return [];
}

function extractTitle(content) {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  return match ? stripWrappingQuotes(match[1]) : '';
}

function normalizeEntityName(text) {
  const tokens = stripWrappingQuotes(String(text || '')).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const collapsed = [];
  for (const token of tokens) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1].toLowerCase() !== token.toLowerCase()) {
      collapsed.push(token);
    }
  }
  return collapsed.join(' ').trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isStopwordEntity(name) {
  return normalizeEntityName(name).split(' ').some(token => ENTITY_STOPWORDS.has(token));
}

function looksLikeCompanyName(name) {
  const normalized = normalizeEntityName(name).replace(/[.,]+$/g, '');
  if (!normalized) return false;
  const tokens = normalized.split(' ');
  const last = tokens[tokens.length - 1].toLowerCase();
  if (COMPANY_SUFFIXES.has(last)) return true;
  return tokens.length === 1 && /[A-Z].*[A-Z]|[a-z][A-Z]/.test(normalized);
}

function looksLikePersonName(name) {
  const normalized = normalizeEntityName(name).replace(/[.,]+$/g, '');
  const tokens = normalized.split(' ');
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (isStopwordEntity(normalized) || looksLikeCompanyName(normalized)) return false;
  return tokens.every(token => /^[A-Z][a-z''-]+$/.test(token));
}

function containsEntityMention(text, alias) {
  const normalized = normalizeEntityName(alias);
  if (!normalized) return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(normalized)}(?=$|[^A-Za-z0-9])`, 'i');
  return pattern.test(text);
}

function listEntityPages(entityDir) {
  if (!existsSync(entityDir)) return [];
  return readdirSync(entityDir)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .map(file => {
      const path = join(entityDir, file);
      const content = readFileSync(path, 'utf8');
      const title = extractTitle(content);
      const aliases = Array.from(new Set([title].concat(parseAliases(content)).filter(Boolean).map(normalizeEntityName)));
      return {
        slug: file.replace(/\.md$/, ''),
        path,
        content,
        title,
        aliases,
      };
    });
}

function findEntityPage(entityDir, candidates) {
  const wanted = new Set(candidates.filter(Boolean).map(candidate => normalizeEntityName(candidate).toLowerCase()));
  if (wanted.size === 0) return null;
  for (const page of listEntityPages(entityDir)) {
    if (page.aliases.some(alias => wanted.has(alias.toLowerCase()))) {
      return page;
    }
  }
  return null;
}

function significantTokens(text) {
  return String(text || '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !COMPANY_SUFFIXES.has(t) && !WEAK_ALIAS_BLOCKLIST.has(t));
}

function isWeakAlias(alias) {
  const normalized = String(alias || '').trim().toLowerCase();
  if (!normalized) return true;
  if (WEAK_ALIAS_BLOCKLIST.has(normalized)) return true;
  if (normalized.length <= 1) return true;
  if (NOISE_ENTITY_BLOCKLIST.has(normalized)) return true;
  return false;
}

function isViableSenderEntity(name) {
  const normalized = normalizeEntityName(name);
  if (!normalized) return false;
  if (NOISE_ENTITY_BLOCKLIST.has(normalized.toLowerCase())) return false;
  if (normalized.length <= 1 && !/[A-Z]/.test(normalized)) return false;
  return true;
}

function scoreEntityMatch(candidateName, candidateAliases, page) {
  const candidateNorm = normalizeEntityName(candidateName).toLowerCase();
  const pageTitle = normalizeEntityName(page.title).toLowerCase();

  // Exact title match
  if (candidateNorm && pageTitle && candidateNorm === pageTitle) return 1.0;

  // Exact alias match
  const pageAliasesLower = page.aliases.map(a => normalizeEntityName(a).toLowerCase());
  if (candidateNorm && pageAliasesLower.includes(candidateNorm)) {
    if (isWeakAlias(candidateNorm)) return 0.1; // weak alias match — too risky to trust
    return 0.8;
  }

  // Email alias match — check if any candidate alias (email) matches a page alias exactly
  for (const ca of candidateAliases || []) {
    const caNorm = String(ca || '').trim().toLowerCase();
    if (caNorm && caNorm.includes('@') && pageAliasesLower.includes(caNorm)) return 0.95;
  }

  // Slug match
  const candidateSlug = slugify(candidateName);
  if (candidateSlug && candidateSlug === page.slug) return 0.9;

  // Normalized key match
  const candidateKey = normalizeNameKey(candidateName);
  const pageKey = normalizeNameKey(page.title);
  if (candidateKey && pageKey && candidateKey === pageKey) return 0.85;

  // Token overlap (Jaccard similarity)
  const candidateTokens = significantTokens(candidateName);
  const pageTokens = significantTokens(page.title);
  if (candidateTokens.length === 0 || pageTokens.length === 0) return 0;

  const candidateSet = new Set(candidateTokens);
  const pageSet = new Set(pageTokens);
  let intersection = 0;
  for (const t of candidateSet) {
    if (pageSet.has(t)) intersection++;
  }
  const union = new Set([...candidateTokens, ...pageTokens]).size;
  if (union === 0) return 0;
  return (intersection / union) * 0.8;
}

function findBestEntityPageWithScore(entityDir, candidates, candidateAliases) {
  const pages = listEntityPages(entityDir);
  let bestPage = null;
  let bestScore = 0;

  for (const page of pages) {
    for (const candidate of candidates.filter(Boolean)) {
      const score = scoreEntityMatch(candidate, candidateAliases, page);
      if (score > bestScore) {
        bestScore = score;
        bestPage = page;
      }
    }
  }

  if (bestScore < MATCH_THRESHOLD || !bestPage) return null;
  return { page: bestPage, score: bestScore };
}

function findBestEntityPage(entityDir, candidates, candidateAliases) {
  return findBestEntityPageWithScore(entityDir, candidates, candidateAliases)?.page || null;
}

function findBestEntityPageAcrossTypes(brainDir, candidates, candidateAliases) {
  const matches = [];
  for (const dirName of ['people', 'companies']) {
    const entityDir = join(resolve(brainDir), dirName);
    if (!existsSync(entityDir)) continue;
    const result = findBestEntityPageWithScore(entityDir, candidates, candidateAliases);
    if (result) matches.push({ ...result, dirName });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);
  const [best, second] = matches;
  const ambiguous = Boolean(
    second &&
    (best.dirName !== second.dirName || best.page.slug !== second.page.slug) &&
    Math.abs(best.score - second.score) < 0.05
  );
  return {
    page: best.page,
    score: best.score,
    dirName: best.dirName,
    ambiguous,
    candidates: matches.map(match => ({ slug: match.page.slug, title: match.page.title, dirName: match.dirName, score: match.score })),
  };
}

function isPlausibleAliasMatch(newName, existingTitle) {
  const newTokens = new Set(significantTokens(newName));
  const existingTokens = new Set(significantTokens(existingTitle));

  // If either side has zero tokens, reject the merge
  if (newTokens.size === 0 && existingTokens.size > 0) return false;
  if (existingTokens.size === 0 && newTokens.size > 0) return false;
  if (newTokens.size === 0 && existingTokens.size === 0) return false;

  for (const token of newTokens) {
    if (existingTokens.has(token)) return true;
  }
  return false;
}

function sanitizeAliases(aliases) {
  return aliases.filter(alias => !isWeakAlias(alias));
}

function writeUnresolvedCandidate(baseDir, record) {
  const date = record.date || new Date().toISOString().slice(0, 10);
  const reportDir = join(resolve(baseDir), 'data', 'reports', 'unresolved-entities');
  ensureDir(reportDir);
  const reportPath = join(reportDir, `${date}.json`);
  const existing = readJson(reportPath, []);
  const key = JSON.stringify([
    record.message_id || '',
    record.candidate_name || '',
    record.source || '',
    record.reason || '',
  ]);
  const deduped = existing.filter(entry => JSON.stringify([
    entry.message_id || '',
    entry.candidate_name || '',
    entry.source || '',
    entry.reason || '',
  ]) !== key);
  deduped.push(record);
  atomicWrite(reportPath, JSON.stringify(deduped, null, 2));
}

function readResolver(brainDir) {
  const resolverPath = join(resolve(brainDir), 'RESOLVER.md');
  if (!existsSync(resolverPath)) {
    throw new Error(`RESOLVER.md not found in brain root: ${resolve(brainDir)}`);
  }
  return readFileSync(resolverPath, 'utf8');
}

function readCompiledTruthTemplate(brainDir) {
  const templatePath = join(resolve(brainDir), '_templates', 'compiled-truth-timeline.md');
  if (!existsSync(templatePath)) {
    throw new Error(`compiled-truth-timeline.md not found under ${resolve(brainDir)}/_templates`);
  }
  const content = readFileSync(templatePath, 'utf8');
  for (const required of ['## Compiled Truth', '### Summary', '### Current State', '### Open Threads', '### See Also', '## Timeline']) {
    if (!content.includes(required)) {
      throw new Error(`compiled-truth-timeline.md missing required section: ${required}`);
    }
  }
  return content;
}

function parseResolverRules(content) {
  const blockMatch = String(content || '').match(/## Directory Decision Tree[\s\S]*?```([\s\S]*?)```/i);
  const source = blockMatch ? blockMatch[1] : String(content || '');
  const lines = source.split('\n');
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const question = lines[i].trim();
    if (!question || !question.endsWith('?')) continue;
    const next = lines[i + 1] ? lines[i + 1].trim() : '';
    const targetMatch = next.match(/^→\s*([^\s]+)/);
    if (!targetMatch) continue;
    rules.push({
      question,
      target: targetMatch[1].replace(/\/+$/g, ''),
    });
  }
  return rules;
}

function resolverRuleMatches(question, entityKind) {
  const lower = String(question || '').toLowerCase();
  if (entityKind === 'person') {
    return lower.includes('specific human') || lower.includes('human being') || lower.includes('human') || lower.includes('person');
  }
  if (entityKind === 'company') {
    return lower.includes('company') || lower.includes('organization');
  }
  return false;
}

function resolveEntityDir(brainDir, entityKind) {
  const rules = parseResolverRules(readResolver(brainDir));
  for (const rule of rules) {
    if (resolverRuleMatches(rule.question, entityKind)) {
      return rule.target;
    }
  }
  throw new Error(`RESOLVER.md in ${resolve(brainDir)} does not define a target for entity kind: ${entityKind}`);
}

function readLocalResolver(brainDir, dirName) {
  const readmePath = join(resolve(brainDir), dirName, 'README.md');
  if (!existsSync(readmePath)) {
    throw new Error(`Local resolver README.md not found for ${dirName}/ in brain root: ${resolve(brainDir)}`);
  }
  return readFileSync(readmePath, 'utf8');
}

function classifyLocalResolverKind(content) {
  const lines = String(content || '').split('\n').map(line => line.trim()).filter(Boolean);
  const descriptor = lines.find(line => /^one page per /i.test(line));
  const lower = String(descriptor || '').toLowerCase();
  if (lower.includes('one page per company or organization')) {
    return 'company';
  }
  if (lower.includes('one page per human being')) {
    return 'person';
  }
  return null;
}

function validateEntityAgainstLocalResolver(brainDir, dirName, entityKind) {
  const readme = readLocalResolver(brainDir, dirName);
  const localKind = classifyLocalResolverKind(readme);
  if (!localKind) {
    throw new Error(`Could not determine local resolver type for ${dirName}/ from README.md`);
  }
  if (localKind !== entityKind) {
    throw new Error(`Local resolver mismatch: ${dirName}/ README.md expects ${localKind}, got ${entityKind}`);
  }
}

function loadEntityCatalog(brainDir) {
  const root = resolve(brainDir);
  return ['people', 'companies'].flatMap(dirName => listEntityPages(join(root, dirName)).map(page => ({
    dir: dirName,
    kind: dirName === 'people' ? 'person' : 'company',
    slug: page.slug,
    title: page.title,
    aliases: page.aliases,
  })));
}

function detectMentionedEntities(message, brainDir, sender) {
  // Limit catalog matching to same scope as new-entity extraction (subject + first 500 chars)
  // to prevent self-reinforcing junk entities from matching in footers/boilerplate
  const text = [message.subject, (message.snippet || '').slice(0, 500)].filter(Boolean).join('\n');
  const catalog = loadEntityCatalog(brainDir);
  const matches = new Map();
  const senderNames = new Set([sender.displayName, sender.email].filter(Boolean).map(value => normalizeEntityName(value).toLowerCase()));

  for (const entity of catalog) {
    if (entity.aliases.some(alias => senderNames.has(alias.toLowerCase()))) continue;
    if (entity.aliases.some(alias => containsEntityMention(text, alias))) {
      matches.set(`${entity.dir}:${entity.slug}`, {
        kind: entity.kind,
        dir: entity.dir,
        name: entity.title || entity.aliases[0] || entity.slug,
        aliases: entity.aliases,
      });
    }
  }

  // Only create new entities from regex when evidence is strong (Task 3: existing-first, create-last)
  const companyPattern = /\b([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3}\s(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|Labs|Lab|AI|Ventures|Capital|Group|Studio|Studios|Systems|Technologies|Technology|Partners|Health|Fitness))\b/g;
  for (const match of text.matchAll(companyPattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!candidate || isStopwordEntity(candidate)) continue;
    if (NOISE_ENTITY_BLOCKLIST.has(candidate.toLowerCase())) continue;
    matches.set(`companies:${slugify(candidate)}`, { kind: 'company', dir: 'companies', name: candidate, aliases: [candidate], source: 'mention' });
  }

  const personCuePattern = /\b(?:with|to|cc|include|loop in|introduce|met|meet|spoke with|talked to)\s+([A-Z][a-z''-]+(?:\s+[A-Z][a-z''-]+){1,2})\b/g;
  for (const match of text.matchAll(personCuePattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!looksLikePersonName(candidate) || senderNames.has(candidate.toLowerCase())) continue;
    if (NOISE_ENTITY_BLOCKLIST.has(candidate.toLowerCase())) continue;
    matches.set(`people:${slugify(candidate)}`, { kind: 'person', dir: 'people', name: candidate, aliases: [candidate], source: 'mention' });
  }

  // companyCuePattern disabled for single-word generic mentions (Task 3)
  // Only allow if the candidate has explicit company suffix or strong brand-casing
  const companyCuePattern = /\b(?:at|via|from)\s+([A-Z][A-Za-z0-9&.-]*)\b/g;
  for (const match of text.matchAll(companyCuePattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!candidate || isStopwordEntity(candidate) || senderNames.has(candidate.toLowerCase())) continue;
    if (NOISE_ENTITY_BLOCKLIST.has(candidate.toLowerCase())) continue;
    // Require explicit company suffix for companyCuePattern — single-word brand-casing alone is too risky
    if (!looksLikeCompanyName(candidate)) continue;
    const tokens = candidate.split(' ');
    const lastToken = tokens[tokens.length - 1].toLowerCase();
    if (tokens.length === 1 && !COMPANY_SUFFIXES.has(lastToken)) continue; // single-word without suffix: skip
    matches.set(`companies:${slugify(candidate)}`, { kind: 'company', dir: 'companies', name: candidate, aliases: [candidate], source: 'mention' });
  }

  return Array.from(matches.values());
}

function parseFrontmatter(content) {
  const text = String(content || '');
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text.trim() };
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: text.trim() };
  }
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 5).trim();
  return { frontmatter: parseFrontmatterRaw(raw), body };
}

function splitPage(content) {
  const parsed = parseFrontmatter(content);
  const body = parsed.body || '';
  const timelineMatch = body.match(/([\s\S]*?)\n---\n\s*(## Timeline[\s\S]*)$/);
  if (timelineMatch) {
    return {
      frontmatter: parsed.frontmatter,
      compiled: timelineMatch[1].trim(),
      timeline: timelineMatch[2].trim(),
    };
  }
  const idx = body.indexOf('\n## Timeline');
  if (idx !== -1) {
    return {
      frontmatter: parsed.frontmatter,
      compiled: body.slice(0, idx).trim(),
      timeline: body.slice(idx + 1).trim(),
    };
  }
  return { frontmatter: parsed.frontmatter, compiled: body.trim(), timeline: '' };
}

function findPersonPage(peopleDir, sender) {
  return findEntityPage(peopleDir, [sender.email, sender.displayName].filter(Boolean));
}

function yamlScalar(value) {
  const escaped = String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function yamlArray(values) {
  return `[${values.map(value => yamlScalar(value)).join(', ')}]`;
}

function serializeFrontmatter(frontmatter) {
  const lines = [];
  if (Array.isArray(frontmatter.aliases)) lines.push(`aliases: ${yamlArray(frontmatter.aliases)}`);
  if (Array.isArray(frontmatter.tags)) lines.push(`tags: ${yamlArray(frontmatter.tags)}`);
  if (frontmatter.status) lines.push(`status: ${frontmatter.status}`);
  if (frontmatter.created) lines.push(`created: ${frontmatter.created}`);
  return `---\n${lines.join('\n')}\n---`;
}

function extractSubsection(compiled, heading) {
  const pattern = new RegExp(`### ${escapeRegex(heading)}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`);
  const match = String(compiled || '').match(pattern);
  return match ? match[1].trim() : '';
}

function normalizeBulletBlock(text, fallback) {
  const value = String(text || '').trim();
  return value || fallback;
}

function mergeBulletBlocks(existingText, generatedLines) {
  const existingLines = String(existingText || '').split('\n').map(line => line.trim()).filter(Boolean);
  const generated = generatedLines.map(line => String(line || '').trim()).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const line of existingLines.concat(generated)) {
    if (seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  return merged.join('\n');
}

function parseSeeAlsoEntries(compiled) {
  const section = extractSubsection(compiled, 'See Also');
  const names = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    const wiki = trimmed.match(/\[\[(.*?)\]\]/);
    if (wiki) names.push(normalizeEntityName(wiki[1]));
  }
  return names.filter(Boolean);
}

function buildSeeAlsoBlock(existingCompiled, relatedNames) {
  const names = Array.from(new Set(parseSeeAlsoEntries(existingCompiled).concat(relatedNames.map(normalizeEntityName)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return '- None';
  return names.map(name => `- [[${name}]]`).join('\n');
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function extractActionItems(message) {
  const text = [message.body, message.snippet, message.subject].filter(Boolean).join('\n');
  if (!text.trim()) return [];
  const cleaned = text
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[•·]+/g, ' ')
    .trim();
  const parts = cleaned.split(/(?<=[.!?])\s+/);
  const items = [];
  const seen = new Set();
  for (let part of parts) {
    part = part.trim().replace(/[.!?]+$/g, '');
    const lower = part.toLowerCase();
    if (!part) continue;
    if (part.length < 12 || part.length > 180) continue;
    if (/header logo|unread notifications|member sign in|^sign in$|^log in$|^login$/.test(lower)) continue;
    if (!/(please|reply|review|confirm|send|update|schedule|call|follow up|check|share|sign|complete|continue|verify|ask|include|loop in|meet)/i.test(part)) continue;
    let bullet = `- [ ] ${part}`;
    if (/before tomorrow|by tomorrow|tomorrow/.test(lower)) {
      const due = addDays(message.date || new Date().toISOString(), 1);
      if (due) bullet += ` (due ${due})`;
    }
    if (seen.has(bullet)) continue;
    seen.add(bullet);
    items.push(bullet);
  }
  return items;
}

function buildTemplateCompiledContent(title, existingCompiled, relatedNames, date, message) {
  const summary = normalizeBulletBlock(
    extractSubsection(existingCompiled, 'Summary'),
    `- Auto-created from email collector.\n- Tracks email-derived context for ${title}.`
  );
  const openThreads = mergeBulletBlocks(
    extractSubsection(existingCompiled, 'Open Threads'),
    Array.isArray(message.action_items) && message.action_items.length > 0
      ? message.action_items
      : ['- [ ] Review latest email context if action is needed']
  );
  const currentState = mergeBulletBlocks(
    extractSubsection(existingCompiled, 'Current State'),
    [
      `- Last touched via email on ${date}`,
      `- Latest email subject: ${message.subject || '(no subject)'}`,
      `- Latest sender: ${message.from || 'Unknown sender'}`,
    ]
  );
  const seeAlso = buildSeeAlsoBlock(existingCompiled, relatedNames);
  return `# ${title}\n\n## Compiled Truth\n\n### Summary\n${summary}\n\n### Current State\n${currentState}\n\n### Open Threads\n${openThreads}\n\n### See Also\n${seeAlso}`.trim();
}

function ensureTimelineSection(existingTimeline) {
  const timeline = String(existingTimeline || '').trim();
  return timeline || '## Timeline';
}

function appendStructuredTimelineEntry(existingTimeline, date, messageId, sourceLine, whatHappened, whyItMatters) {
  const timeline = ensureTimelineSection(existingTimeline);
  const marker = `Message ID: ${messageId}`;
  if (timeline.includes(marker)) return timeline;
  const entry = `### ${date}\n- Source: ${sourceLine} | Message ID: ${messageId}\n- What happened: ${whatHappened}\n- Why it matters: ${whyItMatters}`;
  return `${timeline.trim()}\n\n${entry}`.trim();
}

function appendTimelineEntry(existingTimeline, entityName, message) {
  return appendStructuredTimelineEntry(
    existingTimeline,
    normalizeDate(message.date),
    message.id,
    `Gmail — ${message.date}`,
    `Received email "${message.subject || '(no subject)'}" from ${message.from}.`,
    `Updates the current state for ${entityName}.`
  );
}

function appendMentionTimelineEntry(existingTimeline, entityName, message) {
  return appendStructuredTimelineEntry(
    existingTimeline,
    normalizeDate(message.date),
    `${message.id}:${slugify(entityName)}`,
    `Gmail — ${message.date}`,
    `${entityName} was mentioned in email "${message.subject || '(no subject)'}" from ${message.from}.`,
    `Keeps ${entityName} linked to the surrounding email context.`
  );
}

function buildManagedFrontmatter(existingFrontmatter, aliases, date) {
  return {
    aliases,
    tags: Array.isArray(existingFrontmatter.tags) ? existingFrontmatter.tags : [],
    status: existingFrontmatter.status || 'active',
    created: existingFrontmatter.created || date,
  };
}

function upsertEntityPage(brainDir, dirName, entityName, aliases, relatedNames, date, message, mode, collectorBaseDir) {
  let currentDirName = dirName;
  let entityDir = join(resolve(brainDir), currentDirName);
  let rawDir = join(entityDir, '.raw');
  ensureDir(entityDir);
  ensureDir(rawDir);

  if (collectorBaseDir && mode === 'sender' && isWeakAlias(entityName)) {
    writeUnresolvedCandidate(collectorBaseDir, {
      message_id: message.id,
      date,
      kind: 'sender',
      candidate_name: entityName,
      candidate_aliases: aliases,
      source: mode,
      reason: 'Weak sender alias requires manual review',
      top_matches: [],
    });
  }

  // Task 1+6: Use scored matching instead of first-match-wins
  const allCandidates = [entityName, ...aliases].filter(Boolean);
  const mergeThreshold = mode === 'sender' ? SENDER_MERGE_THRESHOLD : MENTION_MERGE_THRESHOLD;
  let existingMatch = findBestEntityPageWithScore(entityDir, allCandidates, aliases);

  // Sender-only cross-type check: if classification points at the wrong dir,
  // try the other type before creating a new page. Also bail out when the same
  // sender matches equally well in both people/ and companies/.
  if (mode === 'sender') {
    const crossTypeResult = findBestEntityPageAcrossTypes(brainDir, allCandidates, aliases);
    if (crossTypeResult?.ambiguous) {
      if (collectorBaseDir) {
        writeUnresolvedCandidate(collectorBaseDir, {
          message_id: message.id,
          date,
          kind: 'sender',
          candidate_name: entityName,
          candidate_aliases: aliases,
          source: mode,
          reason: 'Cross-type sender match is ambiguous',
          top_matches: crossTypeResult.candidates,
        });
      }
      return null;
    }
    if (!existingMatch && crossTypeResult && crossTypeResult.dirName !== currentDirName) {
      if (crossTypeResult.score >= 0.8 && isPlausibleAliasMatch(entityName, crossTypeResult.page.title)) {
        currentDirName = crossTypeResult.dirName;
        entityDir = join(resolve(brainDir), currentDirName);
        rawDir = join(entityDir, '.raw');
        ensureDir(entityDir);
        ensureDir(rawDir);
        existingMatch = { page: crossTypeResult.page, score: crossTypeResult.score };
      }
    }
  }

  const existing = existingMatch?.page || null;

  // Task 6: Score-based merge guard with secondary token overlap check
  if (existing) {
    let bestScore = existingMatch?.score || 0;
    if (!bestScore) {
      for (const candidate of allCandidates) {
        const s = scoreEntityMatch(candidate, aliases, existing);
        if (s > bestScore) bestScore = s;
      }
    }

    if (bestScore < mergeThreshold) {
      // Below merge threshold — write unresolved record instead of merging (Task 4)
      if (collectorBaseDir) {
        writeUnresolvedCandidate(collectorBaseDir, {
          message_id: message.id,
          date,
          kind: mode === 'sender' ? classifySenderEntityKind({ displayName: entityName, email: aliases.find(a => a.includes('@')) || '' }) : 'unknown',
          candidate_name: entityName,
          candidate_aliases: aliases,
          source: mode,
          reason: `Score ${bestScore.toFixed(2)} below ${mode} merge threshold ${mergeThreshold}`,
          top_matches: [{ slug: existing.slug, title: existing.title, score: bestScore }],
        });
      }
      // Fall through to create separate page
    } else if (bestScore < 0.8 && !isPlausibleAliasMatch(entityName, existing.title)) {
      // Secondary guard: token overlap check to prevent contamination
      if (collectorBaseDir) {
        writeUnresolvedCandidate(collectorBaseDir, {
          message_id: message.id,
          date,
          kind: mode === 'sender' ? 'sender' : 'mention',
          candidate_name: entityName,
          candidate_aliases: aliases,
          source: mode,
          reason: `Token overlap guard rejected merge with "${existing.title}" despite score ${bestScore.toFixed(2)}`,
          top_matches: [{ slug: existing.slug, title: existing.title, score: bestScore }],
        });
      }
      // Fall through to create separate page
    } else {
      // Merge into existing page
      const slug = existing.slug;
      const entityPath = join(entityDir, `${slug}.md`);
      const rawPath = join(rawDir, `${slug}.json`);
      const page = splitPage(existing.content);
      // Task 5: Sanitize aliases before persisting
      const mergedAliases = sanitizeAliases(Array.from(new Set([entityName]
        .concat(aliases)
        .concat([extractTitle(existing.content)])
        .concat(parseAliases(existing.content))
        .filter(Boolean)
        .map(normalizeEntityName))));
      const compiled = buildTemplateCompiledContent(entityName, page.compiled, relatedNames, date, message);
      const timeline = mode === 'sender'
        ? appendTimelineEntry(page.timeline, entityName, message)
        : appendMentionTimelineEntry(page.timeline, entityName, message);
      const frontmatter = buildManagedFrontmatter(page.frontmatter || {}, mergedAliases, date);
      atomicWrite(entityPath, `${serializeFrontmatter(frontmatter)}\n\n${compiled}\n\n---\n\n${timeline}\n`);

      const raw = readJson(rawPath, { messages: [] });
      if (!raw.messages.some(entry => entry.id === message.id)) {
        raw.messages.push(message);
      }
      atomicWrite(rawPath, JSON.stringify(raw, null, 2));
      return { slug, path: entityPath, title: entityName, dir: currentDirName };
    }
  }

  // Task 2: For mentions without an existing page match, require higher confidence to create
  if (mode === 'mention' && !existing) {
    // Only create mention pages for catalog matches or strong regex evidence
    // Catalog matches come with pre-existing pages, so if we're here it's a regex-only candidate
    // Check if we have enough evidence to create
    const candidateTokens = significantTokens(entityName);
    if (candidateTokens.length === 0) {
      if (collectorBaseDir) {
        writeUnresolvedCandidate(collectorBaseDir, {
          message_id: message.id, date, kind: 'mention', candidate_name: entityName,
          candidate_aliases: aliases, source: mode,
          reason: 'Mention candidate has zero significant tokens — skipped creation',
          top_matches: [],
        });
      }
      return null;
    }
  }

  // Create new page
  const slug = slugify(entityName);
  const entityPath = join(entityDir, `${slug}.md`);
  const rawPath = join(rawDir, `${slug}.json`);
  const page = splitPage('');
  // Task 5: Sanitize aliases for new pages too
  const cleanAliases = sanitizeAliases([entityName, ...aliases].filter(Boolean).map(normalizeEntityName));
  const uniqueAliases = Array.from(new Set(cleanAliases));
  const compiled = buildTemplateCompiledContent(entityName, page.compiled, relatedNames, date, message);
  const timeline = mode === 'sender'
    ? appendTimelineEntry(page.timeline, entityName, message)
    : appendMentionTimelineEntry(page.timeline, entityName, message);
  const frontmatter = buildManagedFrontmatter(page.frontmatter || {}, uniqueAliases, date);
  atomicWrite(entityPath, `${serializeFrontmatter(frontmatter)}\n\n${compiled}\n\n---\n\n${timeline}\n`);

  const raw = readJson(rawPath, { messages: [] });
  if (!raw.messages.some(entry => entry.id === message.id)) {
    raw.messages.push(message);
  }
  atomicWrite(rawPath, JSON.stringify(raw, null, 2));
  return { slug, path: entityPath, title: entityName, dir: currentDirName };
}

function runCommand(bin, args, cwd, input) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    input,
  });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function putBrainPage(brainDir, gbrainBin, slug, filePath) {
  const binary = gbrainBin || 'gbrain';
  const content = readFileSync(filePath, 'utf8');
  return runCommand(binary, ['put', slug], resolve(brainDir), content);
}

function syncBrain(brainDir, gbrainBin, updatedPages, embedStale) {
  const dedupedPages = Array.from(new Map((updatedPages || []).map(page => [`${page.dir}/${page.slug}`, page])).values());
  const output = {
    puts: dedupedPages.map(page => ({
      slug: `${page.dir}/${page.slug}`,
      output: putBrainPage(brainDir, gbrainBin, `${page.dir}/${page.slug}`, page.path),
    })),
  };
  if (embedStale) {
    output.embed = 'handled by gbrain put per updated page';
  }
  return output;
}

function enrich(baseDir, brainDir, dateArg, syncAfterEnrich, gbrainBin, embedStale) {
  if (!brainDir) throw new Error('--brain-dir is required for enrich');
  // Hard requirement: enrich is contract-driven, not hardcoded routing.
  readResolver(brainDir);
  readCompiledTruthTemplate(brainDir);

  const date = normalizeDate(dateArg || latestCollectedDate(baseDir));
  const records = readJson(messagesPath(baseDir, date), []);

  let updated = 0;
  const updatedPages = [];
  for (const message of records.filter(msg => !msg.is_noise)) {
    const enrichedMessage = { ...message, action_items: extractActionItems(message) };
    const sender = parseSender(enrichedMessage.from);
    const senderKind = classifySenderEntityKind(sender);
    const senderDir = resolveEntityDir(brainDir, senderKind);
    validateEntityAgainstLocalResolver(brainDir, senderDir, senderKind);

    // Task 2: Sender quality gate — skip junk sender names
    if (!isViableSenderEntity(sender.displayName)) {
      continue;
    }

    const mentions = detectMentionedEntities(enrichedMessage, brainDir, sender).filter(entity => normalizeEntityName(entity.name).toLowerCase() !== normalizeEntityName(sender.displayName).toLowerCase());
    const entitiesForMessage = [
      {
        name: sender.displayName,
        aliases: [sender.displayName, sender.email].filter(Boolean),
        dir: senderDir,
        mode: 'sender',
      },
      ...mentions.map(entity => {
        const entityKind = entity.kind || (entity.dir === 'people' ? 'person' : 'company');
        const resolvedDir = resolveEntityDir(brainDir, entityKind);
        validateEntityAgainstLocalResolver(brainDir, resolvedDir, entityKind);
        return {
          name: entity.name,
          aliases: entity.aliases || [entity.name],
          dir: resolvedDir,
          mode: 'mention',
        };
      }),
    ];

    for (const entity of entitiesForMessage) {
      const relatedNames = entitiesForMessage
        .filter(other => normalizeEntityName(other.name).toLowerCase() !== normalizeEntityName(entity.name).toLowerCase())
        .map(other => other.name);
      const result = upsertEntityPage(brainDir, entity.dir, entity.name, entity.aliases, relatedNames, date, enrichedMessage, entity.mode, baseDir);
      if (!result) continue;
      updatedPages.push(result);
      updated += 1;
    }
  }

  const syncResult = syncAfterEnrich ? syncBrain(brainDir, gbrainBin, updatedPages, embedStale) : null;
  return { date, updated, sync: syncResult };
}

function printHelp() {
  console.log(`email-collector.mjs

USAGE
  node email-collector.mjs init --dir <path>
  node email-collector.mjs collect --dir <path> --input <file.json> --account <email> [--date YYYY-MM-DD]
  node email-collector.mjs collect --dir <path> --provider gws --gws-bin /opt/homebrew/bin/gws --account <email> [--date YYYY-MM-DD]
  node email-collector.mjs digest --dir <path> [--date YYYY-MM-DD]
  node email-collector.mjs enrich --dir <collector-path> --brain-dir <brain-root-with-RESOLVER.md> [--date YYYY-MM-DD] [--sync] [--gbrain-bin /path/to/gbrain] [--embed-stale]
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
      const result = enrich(baseDir, args.brain_dir, args.date, Boolean(args.sync), args.gbrain_bin, Boolean(args.embed_stale));
      const suffix = result.sync ? ` + synced brain${result.sync.embed !== undefined ? ' + embedded stale chunks' : ''}` : '';
      console.log(`enriched ${result.updated} entity pages for ${result.date}${suffix}`);
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
