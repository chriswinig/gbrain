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
const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'labs', 'lab', 'ai', 'ventures', 'capital', 'group', 'studio', 'studios', 'systems', 'technologies', 'technology', 'partners', 'health', 'fitness']);
const ENTITY_STOPWORDS = new Set(['Need', 'Review', 'Please', 'Thanks', 'Thank', 'Tomorrow', 'Today', 'Team', 'Brain', 'Email', 'Sync', 'This', 'That', 'Message', 'Messages', 'Page', 'Pages', 'Open', 'Threads', 'Executive', 'Summary', 'Last', 'Touched', 'Design', 'Kick', 'Import', 'Real']);
const GENERIC_SENDER_LOCAL_PARTS = [/noreply/i, /no-reply/i, /notification/i, /support/i, /billing/i, /invoice/i, /statement/i, /receipt/i, /team/i, /info/i, /contact/i, /mail/i, /system/i, /security/i, /account/i, /acct_/i, /hello/i, /jobs/i, /careers/i];
const PERSONAL_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com']);

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

  if (looksLikePersonName(displayName)) return 'person';
  if (displayName.includes(' ')) {
    if (hasGenericLocal || domainMatchesDisplay || looksLikeCompanyName(displayName)) return 'company';
    return 'person';
  }
  if (isPersonalDomain && localMatchesDisplay) return 'person';
  if (hasGenericLocal || domainMatchesDisplay || looksLikeCompanyName(displayName)) return 'company';
  if (localMatchesDisplay && !hasGenericLocal) return 'person';
  return sender.email ? 'company' : 'person';
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

function extractTitle(content) {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function normalizeEntityName(text) {
  const tokens = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
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
  return tokens.every(token => /^[A-Z][a-z'’-]+$/.test(token));
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

function readResolver(brainDir) {
  const resolverPath = join(resolve(brainDir), 'RESOLVER.md');
  if (!existsSync(resolverPath)) {
    throw new Error(`RESOLVER.md not found in brain root: ${resolve(brainDir)}`);
  }
  return readFileSync(resolverPath, 'utf8');
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
  const text = [message.subject, message.snippet, message.body].filter(Boolean).join('\n');
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

  const companyPattern = /\b([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3}\s(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|Labs|Lab|AI|Ventures|Capital|Group|Studio|Studios|Systems|Technologies|Technology|Partners|Health|Fitness))\b/g;
  for (const match of text.matchAll(companyPattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!candidate || isStopwordEntity(candidate)) continue;
    matches.set(`companies:${slugify(candidate)}`, { kind: 'company', dir: 'companies', name: candidate, aliases: [candidate] });
  }

  const personCuePattern = /\b(?:with|to|cc|include|loop in|introduce|met|meet|spoke with|talked to)\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2})\b/g;
  for (const match of text.matchAll(personCuePattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!looksLikePersonName(candidate) || senderNames.has(candidate.toLowerCase())) continue;
    matches.set(`people:${slugify(candidate)}`, { kind: 'person', dir: 'people', name: candidate, aliases: [candidate] });
  }

  const companyCuePattern = /\b(?:at|via|from)\s+([A-Z][A-Za-z0-9&.-]*)\b/g;
  for (const match of text.matchAll(companyCuePattern)) {
    const candidate = normalizeEntityName(match[1]);
    if (!candidate || isStopwordEntity(candidate) || senderNames.has(candidate.toLowerCase()) || !looksLikeCompanyName(candidate)) continue;
    matches.set(`companies:${slugify(candidate)}`, { kind: 'company', dir: 'companies', name: candidate, aliases: [candidate] });
  }

  return Array.from(matches.values());
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
  return findEntityPage(peopleDir, [sender.email, sender.displayName].filter(Boolean));
}

function buildCompiledContent(sender, aliases, date) {
  return `---\naliases: [${aliases.map(alias => `"${alias}"`).join(', ')}]\n---\n# ${sender.displayName}\n\n> Executive summary.\n\n## State\n- Last touched via email on ${date}\n\n## Open Threads\n- None\n\n## See Also\n- None`;
}

function upsertAliasesFrontmatter(compiled, aliases) {
  const aliasLine = `aliases: [${aliases.map(alias => `"${alias}"`).join(', ')}]`;
  if (compiled.startsWith('---\n')) {
    const end = compiled.indexOf('\n---\n', 4);
    if (end !== -1) {
      let frontmatter = compiled.slice(4, end).trimEnd();
      if (/^aliases:\s*\[.*\]$/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(/^aliases:\s*\[.*\]$/m, aliasLine);
      } else {
        frontmatter = `${frontmatter}\n${aliasLine}`.trim();
      }
      const rest = compiled.slice(end + 5).trimStart();
      return `---\n${frontmatter}\n---\n${rest}`.trim();
    }
  }
  return `---\n${aliasLine}\n---\n${compiled.trim()}`.trim();
}

function upsertLastTouched(compiled, date) {
  const touchedLine = `- Last touched via email on ${date}`;
  if (/^- Last touched via email on .*$/m.test(compiled)) {
    return compiled.replace(/^- Last touched via email on .*$/m, touchedLine);
  }
  if (/## State\s*\n/m.test(compiled)) {
    return compiled.replace(/## State\s*\n/m, `## State\n${touchedLine}\n`);
  }
  return `${compiled.trim()}\n\n## State\n${touchedLine}`.trim();
}

function mergeCompiledContent(existingCompiled, sender, aliases, date) {
  let compiled = existingCompiled && existingCompiled.trim()
    ? existingCompiled.trim()
    : buildCompiledContent(sender, aliases, date);

  compiled = upsertAliasesFrontmatter(compiled, aliases);
  compiled = upsertLastTouched(compiled, date);
  return compiled.trim();
}

function appendUniqueTimelineEntry(existingTimeline, entry) {
  if (!existingTimeline) return entry;
  if (existingTimeline.includes(entry)) return existingTimeline;
  return `${existingTimeline.trim()}\n${entry}`;
}

function appendTimelineEntry(existingTimeline, message) {
  const entry = `${normalizeDate(message.date)} | Email from ${message.from}: ${message.subject} [Source: Gmail, ${message.date}]`;
  return appendUniqueTimelineEntry(existingTimeline, entry);
}

function appendMentionTimelineEntry(existingTimeline, message, entityName) {
  const entry = `${normalizeDate(message.date)} | Mentioned in email from ${message.from}: ${entityName} — ${message.subject} [Source: Gmail, ${message.date}]`;
  return appendUniqueTimelineEntry(existingTimeline, entry);
}

function upsertEntityPage(brainDir, dirName, entityName, aliases, date, message, mode) {
  const entityDir = join(resolve(brainDir), dirName);
  const rawDir = join(entityDir, '.raw');
  ensureDir(entityDir);
  ensureDir(rawDir);

  const existing = findEntityPage(entityDir, [entityName].concat(aliases).filter(Boolean));
  const slug = existing?.slug || slugify(entityName);
  const entityPath = join(entityDir, `${slug}.md`);
  const rawPath = join(rawDir, `${slug}.json`);
  const existingContent = existing?.content || '';
  const page = splitPage(existingContent);
  const mergedAliases = Array.from(new Set([entityName]
    .concat(aliases)
    .concat(existing ? [extractTitle(existing.content)] : [])
    .concat(existing ? parseAliases(existing.content) : [])
    .filter(Boolean)
    .map(normalizeEntityName)));
  const compiled = mergeCompiledContent(page.compiled, { displayName: entityName }, mergedAliases, date);
  const timeline = mode === 'sender'
    ? appendTimelineEntry(page.timeline, message)
    : appendMentionTimelineEntry(page.timeline, message, entityName);
  atomicWrite(entityPath, `${compiled}\n\n---\n${timeline}\n`);

  const raw = readJson(rawPath, { messages: [] });
  if (!raw.messages.some(entry => entry.id === message.id)) {
    raw.messages.push(message);
  }
  atomicWrite(rawPath, JSON.stringify(raw, null, 2));
  return { slug, path: entityPath };
}

function runCommand(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function syncBrain(brainDir, gbrainBin, embedStale) {
  const binary = gbrainBin || 'gbrain';
  const output = {
    import: runCommand(binary, ['import', resolve(brainDir), '--no-embed'], resolve(brainDir)),
  };
  if (embedStale) {
    output.embed = runCommand(binary, ['embed', '--stale'], resolve(brainDir));
  }
  return output;
}

function enrich(baseDir, brainDir, dateArg, syncAfterEnrich, gbrainBin, embedStale) {
  if (!brainDir) throw new Error('--brain-dir is required for enrich');
  // Hard requirement: enrich is resolver-driven, not hardcoded routing.
  readResolver(brainDir);

  const date = normalizeDate(dateArg || latestCollectedDate(baseDir));
  const records = readJson(messagesPath(baseDir, date), []);

  let updated = 0;
  for (const message of records.filter(msg => !msg.is_noise)) {
    const sender = parseSender(message.from);
    const senderKind = classifySenderEntityKind(sender);
    const senderDir = resolveEntityDir(brainDir, senderKind);
    validateEntityAgainstLocalResolver(brainDir, senderDir, senderKind);
    upsertEntityPage(brainDir, senderDir, sender.displayName, [sender.displayName, sender.email].filter(Boolean), date, message, 'sender');
    updated += 1;

    const mentions = detectMentionedEntities(message, brainDir, sender).filter(entity => normalizeEntityName(entity.name).toLowerCase() !== normalizeEntityName(sender.displayName).toLowerCase());
    for (const entity of mentions) {
      const entityKind = entity.kind || (entity.dir === 'people' ? 'person' : 'company');
      const resolvedDir = resolveEntityDir(brainDir, entityKind);
      validateEntityAgainstLocalResolver(brainDir, resolvedDir, entityKind);
      upsertEntityPage(brainDir, resolvedDir, entity.name, entity.aliases || [entity.name], date, message, 'mention');
      updated += 1;
    }
  }

  const syncResult = syncAfterEnrich ? syncBrain(brainDir, gbrainBin, embedStale) : null;
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
