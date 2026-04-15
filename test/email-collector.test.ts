import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const scriptPath = join(repoRoot, 'scripts', 'email-collector', 'email-collector.mjs');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-email-collector-'));
}

const TEST_RESOLVER = `# Knowledge Resolver

## Directory Decision Tree

\`\`\`
Is it about a specific human being?
  → people/

Is it about a company or organization (not a person)?
  → companies/
\`\`\`
`;

const TEST_PEOPLE_README = `# people/

One page per human being.

## What goes here
- Anyone Chris has a relationship with

## What does NOT go here
- Companies or organizations → companies/
`;

const TEST_COMPANIES_README = `# companies/

One page per company or organization.

## What goes here
- Any company or organization Chris interacts with

## What does NOT go here
- Individual people at a company → people/
`;

const TEST_TEMPLATE = `---
aliases: []
tags: []
status: active
created: YYYY-MM-DD
---

# Title

## Compiled Truth

### Summary
- What this note is about in 2-5 bullets

### Current State
- What is true now
- What has been decided
- What is still uncertain

### Open Threads
- [ ] Thread 1
- [ ] Thread 2

### See Also
- [[Related Note 1]]
- [[Related Note 2]]

---

## Timeline

### YYYY-MM-DD
- Source:
- What happened:
- Why it matters:
`;

function writeResolver(brainDir: string) {
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  mkdirSync(join(brainDir, 'companies'), { recursive: true });
  mkdirSync(join(brainDir, '_templates'), { recursive: true });
  writeFileSync(join(brainDir, 'RESOLVER.md'), TEST_RESOLVER);
  writeFileSync(join(brainDir, 'people', 'README.md'), TEST_PEOPLE_README);
  writeFileSync(join(brainDir, 'companies', 'README.md'), TEST_COMPANIES_README);
  writeFileSync(join(brainDir, '_templates', 'compiled-truth-timeline.md'), TEST_TEMPLATE);
}

describe('email collector scaffold', () => {
  test('init creates expected directory structure and default state', async () => {
    const dir = makeTempDir();
    const proc = Bun.spawn(['node', scriptPath, 'init', '--dir', dir], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(join(dir, 'data'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'messages'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'digests'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'state.json'))).toBe(true);

    const state = JSON.parse(readFileSync(join(dir, 'data', 'state.json'), 'utf-8'));
    expect(state.last_collect_at).toBeNull();
    expect(state.known_message_ids).toEqual({});
  });

  test('collect writes structured messages with gmail links and deterministic flags', async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify([
      {
        id: 'msg-1',
        from: 'friend@example.com',
        subject: 'Need your thoughts',
        snippet: 'Can you review this?',
        date: '2026-04-12T10:00:00Z'
      },
      {
        id: 'msg-2',
        from: 'noreply@service.com',
        subject: 'Weekly digest',
        snippet: 'Your update',
        date: '2026-04-12T10:05:00Z'
      },
      {
        id: 'msg-3',
        from: 'docs@docusign.net',
        subject: 'Please sign the agreement',
        snippet: 'Signature needed',
        date: '2026-04-12T10:06:00Z'
      }
    ], null, 2));

    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const proc = Bun.spawn(['node', scriptPath, 'collect', '--dir', dir, '--input', fixturePath, '--account', 'me@gmail.com', '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    expect(existsSync(outPath)).toBe(true);
    const messages = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(messages).toHaveLength(3);
    expect(messages[0].gmail_link).toBe('https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/msg-1');
    expect(messages[0].gmail_markdown).toContain('[Open in Gmail]');
    expect(messages[0].is_noise).toBe(false);
    expect(messages[1].is_noise).toBe(true);
    expect(messages[2].is_signature).toBe(true);
    expect(messages.every((m: any) => m.is_new === true)).toBe(true);
  });

  test('collect deduplicates previously seen message ids via state.json', async () => {
    const dir = makeTempDir();
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify([
      {
        id: 'dup-1',
        from: 'friend@example.com',
        subject: 'Hello',
        snippet: 'hi',
        date: '2026-04-12T10:00:00Z'
      }
    ], null, 2));

    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    await Bun.$`node ${scriptPath} collect --dir ${dir} --input ${fixturePath} --account me@gmail.com --date 2026-04-12`;
    await Bun.$`node ${scriptPath} collect --dir ${dir} --input ${fixturePath} --account me@gmail.com --date 2026-04-12`;

    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    const messages = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(messages).toHaveLength(1);

    const state = JSON.parse(readFileSync(join(dir, 'data', 'state.json'), 'utf-8'));
    expect(state.known_message_ids['dup-1']).toBe(true);
    expect(typeof state.last_collect_at).toBe('string');
  });

  test('collect refreshes existing message flags when a rerun changes classification', async () => {
    const dir = makeTempDir();
    const fixturePath = join(dir, 'refresh.json');
    await Bun.$`node ${scriptPath} init --dir ${dir}`;

    writeFileSync(fixturePath, JSON.stringify([
      {
        id: 'refresh-1',
        from: 'Google <no-reply@accounts.google.com>',
        subject: 'Weekly digest',
        snippet: 'Old non-actionable version',
        date: '2026-04-14T09:00:00Z'
      }
    ], null, 2));
    await Bun.$`node ${scriptPath} collect --dir ${dir} --input ${fixturePath} --account me@gmail.com --date 2026-04-14`;

    writeFileSync(fixturePath, JSON.stringify([
      {
        id: 'refresh-1',
        from: 'Google <no-reply@accounts.google.com>',
        subject: 'Security alert',
        snippet: 'You allowed Lune access to some of your Google Account data.',
        date: '2026-04-14T09:00:00Z'
      }
    ], null, 2));
    await Bun.$`node ${scriptPath} collect --dir ${dir} --input ${fixturePath} --account me@gmail.com --date 2026-04-14`;

    const messages = JSON.parse(readFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), 'utf-8'));
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('Security alert');
    expect(messages[0].is_noise).toBe(false);
  });

  test('digest groups signatures, triage, and noise with baked-in links', async () => {
    const dir = makeTempDir();
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'a',
        from: 'docs@docusign.net',
        subject: 'Please sign',
        snippet: 'sign this',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/a',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/a)',
        is_signature: true,
        is_noise: false,
        is_new: true
      },
      {
        id: 'b',
        from: 'person@example.com',
        subject: 'Real email',
        snippet: 'hello there',
        date: '2026-04-12T09:10:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/b',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/b)',
        is_signature: false,
        is_noise: false,
        is_new: true
      },
      {
        id: 'c',
        from: 'noreply@service.com',
        subject: 'Receipt',
        snippet: 'thanks',
        date: '2026-04-12T09:15:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/c',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/c)',
        is_signature: false,
        is_noise: true,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'digest', '--dir', dir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const digestPath = join(dir, 'data', 'digests', '2026-04-12.md');
    expect(existsSync(digestPath)).toBe(true);
    const digest = readFileSync(digestPath, 'utf-8');
    expect(digest).toContain('## Signatures pending');
    expect(digest).toContain('## Messages to triage');
    expect(digest).toContain('## Noise');
    expect(digest).toContain('Please sign');
    expect(digest).toContain('Real email');
    expect(digest).toContain('Receipt');
    expect(digest).toContain('[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/a)');
  });

  test('digest and enrich default to the latest collected date when --date is omitted', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-11.json'), JSON.stringify([
      {
        id: 'latest-1',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Default date path',
        snippet: 'Use the latest file',
        body: 'Digest and enrich should use the latest collected date by default.',
        date: '2026-04-11T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/latest-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/latest-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const digestProc = Bun.spawn(['node', scriptPath, 'digest', '--dir', dir], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const digestStdout = await new Response(digestProc.stdout).text();
    const digestStderr = await new Response(digestProc.stderr).text();
    expect(await digestProc.exited).toBe(0);
    expect(digestStderr).toBe('');
    expect(digestStdout).toContain('2026-04-11');
    expect(existsSync(join(dir, 'data', 'digests', '2026-04-11.md'))).toBe(true);

    const enrichProc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const enrichStdout = await new Response(enrichProc.stdout).text();
    const enrichStderr = await new Response(enrichProc.stderr).text();
    expect(await enrichProc.exited).toBe(0);
    expect(enrichStderr).toBe('');
    expect(enrichStdout).toContain('2026-04-11');
    expect(existsSync(join(brainDir, 'people', 'jane-doe.md'))).toBe(true);
  });

  test('collect with provider gws paginates list calls and writes richer gmail metadata', async () => {
    const dir = makeTempDir();
    await Bun.$`node ${scriptPath} init --dir ${dir}`;

    const fakeGws = join(dir, 'fake-gws.py');
    writeFileSync(fakeGws, `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
params = {}
if '--params' in args:
    params = json.loads(args[args.index('--params') + 1])
if args[:4] == ['gmail', 'users', 'messages', 'list']:
    if params.get('pageToken') == 'page-2':
        print(json.dumps({'messages': [{'id': 'gws-2'}]}))
    else:
        print(json.dumps({'messages': [{'id': 'gws-1'}], 'nextPageToken': 'page-2'}))
elif args[:4] == ['gmail', 'users', 'messages', 'get']:
    if params.get('id') == 'gws-2':
        print(json.dumps({
            'id': 'gws-2',
            'threadId': 'thread-2',
            'historyId': 'hist-2',
            'internalDate': '1775988600000',
            'labelIds': ['UNREAD'],
            'snippet': 'Second page message',
            'payload': {
                'headers': [
                    {'name': 'From', 'value': 'second@example.com'},
                    {'name': 'Subject', 'value': 'Page two'},
                    {'name': 'Date', 'value': 'Sat, 12 Apr 2026 10:10:00 +0000'}
                ],
                'mimeType': 'text/plain',
                'body': {'data': 'U2Vjb25kIHBhZ2UgbWVzc2FnZS4='}
            }
        }))
    else:
        print(json.dumps({
            'id': 'gws-1',
            'threadId': 'thread-1',
            'historyId': 'hist-1',
            'internalDate': '1775988000000',
            'labelIds': ['UNREAD', 'INBOX'],
            'snippet': 'Need your review',
            'payload': {
                'headers': [
                    {'name': 'From', 'value': 'person@example.com'},
                    {'name': 'To', 'value': 'me@gmail.com'},
                    {'name': 'Cc', 'value': 'team@example.com'},
                    {'name': 'Reply-To', 'value': 'reply@example.com'},
                    {'name': 'Delivered-To', 'value': 'me@gmail.com'},
                    {'name': 'Subject', 'value': 'Review this'},
                    {'name': 'Date', 'value': 'Sat, 12 Apr 2026 10:00:00 +0000'},
                    {'name': 'Message-ID', 'value': '<msg-1@example.com>'},
                    {'name': 'In-Reply-To', 'value': '<older@example.com>'},
                    {'name': 'References', 'value': '<older@example.com>'}
                ],
                'mimeType': 'text/plain',
                'body': {'data': 'UGxlYXNlIHJldmlldyB0aGlzLg=='}
            }
        }))
else:
    print(json.dumps({}))
`);
    await Bun.$`chmod +x ${fakeGws}`;

    const proc = Bun.spawn(['node', scriptPath, 'collect', '--dir', dir, '--provider', 'gws', '--gws-bin', fakeGws, '--account', 'me@gmail.com', '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    const messages = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('gws-1');
    expect(messages[0].from).toBe('person@example.com');
    expect(messages[0].to).toBe('me@gmail.com');
    expect(messages[0].cc).toBe('team@example.com');
    expect(messages[0].reply_to).toBe('reply@example.com');
    expect(messages[0].delivered_to).toBe('me@gmail.com');
    expect(messages[0].subject).toBe('Review this');
    expect(messages[0].snippet).toBe('Need your review');
    expect(messages[0].body).toContain('Please review this.');
    expect(messages[0].thread_id).toBe('thread-1');
    expect(messages[0].history_id).toBe('hist-1');
    expect(messages[0].internal_date).toBe('1775988000000');
    expect(messages[0].label_ids).toEqual(['UNREAD', 'INBOX']);
    expect(messages[0].message_id_header).toBe('<msg-1@example.com>');
    expect(messages[0].in_reply_to).toBe('<older@example.com>');
    expect(messages[0].references).toBe('<older@example.com>');
    expect(messages[0].date_iso).toBe('2026-04-12T10:00:00.000Z');
    expect(messages[0].gmail_link).toBe('https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/gws-1');
    expect(messages[1].id).toBe('gws-2');
    expect(messages[1].body).toContain('Second page message.');
  });

  test('enrich routes obvious company senders into companies instead of people', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'company-1',
        from: 'X <invoice+statements+acct_123@stripe.com>',
        subject: 'Your receipt from X',
        snippet: 'Receipt attached',
        body: 'Your receipt from X for April.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/company-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/company-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      },
      {
        id: 'company-2',
        from: 'Figma <no-reply@figma.com>',
        subject: 'Explore dev mode in Figma',
        snippet: 'Try the latest feature',
        body: 'Explore dev mode in Figma today.',
        date: '2026-04-12T10:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/company-2',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/company-2)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(join(brainDir, 'companies', 'x.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies', 'figma.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'people', 'x.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'people', 'figma.md'))).toBe(false);
  });

  test('enrich fails fast when brain root is missing RESOLVER.md', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'missing-resolver',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Should fail',
        snippet: 'No resolver',
        body: 'No resolver present.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/missing-resolver',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/missing-resolver)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain('RESOLVER.md not found');
  });

  test('enrich fails fast when local directory README conflicts with resolver output', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    writeFileSync(join(brainDir, 'companies', 'README.md'), `# companies/\n\nOne page per human being.\n`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'bad-local-resolver',
        from: 'X <invoice+statements+acct_123@stripe.com>',
        subject: 'Your receipt from X',
        snippet: 'Receipt attached',
        body: 'Your receipt from X for April.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/bad-local-resolver',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/bad-local-resolver)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Local resolver mismatch');
  });

  test('enrich fails fast when compiled-truth template is missing', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`rm ${join(brainDir, '_templates', 'compiled-truth-timeline.md')}`;
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'missing-template',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Should fail',
        snippet: 'No template',
        body: 'No template present.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/missing-template',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/missing-template)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain('compiled-truth-timeline.md not found');
  });

  test('enrich creates a person page and raw sidecar from collected email messages', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'm-1',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Design review tomorrow',
        snippet: 'Can you review the deck?',
        body: 'Please review the deck before tomorrow.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const personPath = join(brainDir, 'people', 'jane-doe.md');
    const rawPath = join(brainDir, 'people', '.raw', 'jane-doe.json');
    expect(existsSync(personPath)).toBe(true);
    expect(existsSync(rawPath)).toBe(true);

    const person = readFileSync(personPath, 'utf-8');
    expect(person).toContain('aliases: ["Jane Doe", "jane@example.com"]');
    expect(person).toContain('status: active');
    expect(person).toContain('created: 2026-04-12');
    expect(person).toContain('# Jane Doe');
    expect(person).toContain('## Compiled Truth');
    expect(person).toContain('### Current State');
    expect(person).toContain('Latest email subject: Design review tomorrow');
    expect(person).toContain('### Open Threads');
    expect(person).toContain('- [ ] Please review the deck before tomorrow (due 2026-04-13)');
    expect(person).toContain('## Timeline');
    expect(person).toContain('### 2026-04-12');
    expect(person).toContain('Source: Gmail — 2026-04-12T09:00:00Z | Message ID: m-1');
    expect(person).toContain('What happened: Received email "Design review tomorrow" from Jane Doe <jane@example.com>.');

    const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
    expect(raw.messages).toHaveLength(1);
    expect(raw.messages[0].id).toBe('m-1');
    expect(raw.messages[0].action_items).toContain('- [ ] Please review the deck before tomorrow (due 2026-04-13)');
  });

  test('enrich updates existing person page by alias email without overwriting earlier timeline', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    const rawDir = join(peopleDir, '.raw');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(peopleDir, 'jane-doe.md'), `---
aliases: ["Jane Doe", "jane@example.com"]
tags: []
status: active
created: 2026-04-10
---

# Jane Doe

## Compiled Truth

### Summary
- Existing note

### Current State
- Previously touched

### Open Threads
- [ ] Existing thread

### See Also
- None

---

## Timeline

### 2026-04-10
- Source: Manual
- What happened: Existing timeline entry
- Why it matters: Preserved context
`);

    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'm-2',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Following up',
        snippet: 'Checking in',
        body: 'Just following up.',
        date: '2026-04-12T11:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-2',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-2)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const person = readFileSync(join(peopleDir, 'jane-doe.md'), 'utf-8');
    expect(person).toContain('aliases: ["Jane Doe", "jane@example.com"]');
    expect(person).toContain('- Existing note');
    expect(person).toContain('- [ ] Existing thread');
    expect(person).toContain('### 2026-04-10');
    expect(person).toContain('What happened: Existing timeline entry');
    expect(person).toContain('Source: Gmail — 2026-04-12T11:00:00Z | Message ID: m-2');
    expect(person).toContain('What happened: Received email "Following up" from Jane Doe <jane@example.com>.');
  });

  test('enrich updates existing mentioned people and companies, not just the sender', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    const companyDir = join(brainDir, 'companies');
    mkdirSync(peopleDir, { recursive: true });
    mkdirSync(companyDir, { recursive: true });
    writeFileSync(join(peopleDir, 'sarah-chen.md'), `---
aliases: ["Sarah Chen"]
tags: []
status: active
created: 2026-04-10
---

# Sarah Chen

## Compiled Truth

### Summary
- Existing person note.

### Current State
- Existing person state

### Open Threads
- [ ] Existing person thread

### See Also
- None

---

## Timeline

### 2026-04-10
- Source: Manual
- What happened: Existing person timeline
- Why it matters: Preserved context
`);
    writeFileSync(join(companyDir, 'acme-corp.md'), `---
aliases: ["Acme Corp"]
tags: []
status: active
created: 2026-04-10
---

# Acme Corp

## Compiled Truth

### Summary
- Existing company note.

### Current State
- Existing company state

### Open Threads
- [ ] Existing company thread

### See Also
- None

---

## Timeline

### 2026-04-10
- Source: Manual
- What happened: Existing company timeline
- Why it matters: Preserved context
`);

    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'm-mention',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Loop in Sarah Chen',
        snippet: 'Please include Sarah Chen at Acme Corp',
        body: 'Please include Sarah Chen at Acme Corp before tomorrow.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-mention',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-mention)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('enriched 3 entity pages');

    const senderPage = readFileSync(join(brainDir, 'people', 'jane-doe.md'), 'utf-8');
    const mentionedPerson = readFileSync(join(brainDir, 'people', 'sarah-chen.md'), 'utf-8');
    const companyPage = readFileSync(join(brainDir, 'companies', 'acme-corp.md'), 'utf-8');
    const companyRaw = JSON.parse(readFileSync(join(brainDir, 'companies', '.raw', 'acme-corp.json'), 'utf-8'));

    expect(senderPage).toContain('## Compiled Truth');
    expect(senderPage).toContain('- [[Acme Corp]]');
    expect(senderPage).toContain('- [[Sarah Chen]]');
    expect(senderPage).toContain('What happened: Received email "Loop in Sarah Chen" from Jane Doe <jane@example.com>.');

    expect(mentionedPerson).toContain('## Compiled Truth');
    expect(mentionedPerson).toContain('- [[Acme Corp]]');
    expect(mentionedPerson).toContain('- [[Jane Doe]]');
    expect(mentionedPerson).toContain('What happened: Sarah Chen was mentioned in email "Loop in Sarah Chen" from Jane Doe <jane@example.com>.');

    expect(companyPage).toContain('- Existing company note.');
    expect(companyPage).toContain('What happened: Existing company timeline');
    expect(companyPage).toContain('- [[Jane Doe]]');
    expect(companyPage).toContain('- [[Sarah Chen]]');
    expect(companyPage).toContain('What happened: Acme Corp was mentioned in email "Loop in Sarah Chen" from Jane Doe <jane@example.com>.');
    expect(companyRaw.messages).toHaveLength(1);
    expect(companyRaw.messages[0].id).toBe('m-mention');
  });

  test('enrich can sync touched pages via gbrain put without re-importing the whole brain', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const fakeGbrain = join(dir, 'fake-gbrain.py');
    const gbrainLog = join(dir, 'gbrain-log.jsonl');
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const outPath = join(dir, 'data', 'messages', '2026-04-12.json');
    writeFileSync(outPath, JSON.stringify([
      {
        id: 'm-sync',
        from: 'Jane Doe <jane@example.com>',
        subject: 'Sync this brain',
        snippet: 'Kick import',
        body: 'Please sync the brain after enrichment.',
        date: '2026-04-12T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-sync',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/m-sync)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));
    writeFileSync(fakeGbrain, `#!/usr/bin/env python3
import json, sys
from pathlib import Path
log_path = Path(${JSON.stringify(gbrainLog)})
with log_path.open('a') as f:
    f.write(json.dumps({'args': sys.argv[1:]}) + '\\n')
print('ok')
`);
    await Bun.$`chmod +x ${fakeGbrain}`;

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12', '--sync', '--gbrain-bin', fakeGbrain, '--embed-stale'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('synced brain + embedded stale chunks');

    const calls = readFileSync(gbrainLog, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('put');
    expect(calls[0].args[1]).toBe('people/jane-doe');
  });

  // === Task 7: Regression tests for known failure shapes ===

  test('enrich does not merge unrelated entity into page with broad alias "X"', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    // Pre-seed twitter.md with alias "X"
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(companiesDir, 'twitter.md'), `---
aliases: ["Twitter", "X"]
tags: []
status: active
created: 2026-04-01
---

# Twitter

## Compiled Truth

### Summary
- Social media platform

### Current State
- Rebranded to X

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'elegant-1',
      from: 'Elegant Themes, Inc. <newsletter@elegantthemes.com>',
      subject: 'New Divi features',
      snippet: 'Check out what is new in Divi',
      body: 'Elegant Themes newsletter about Divi features.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/elegant-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/elegant-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // Twitter page must NOT contain Elegant Themes
    const twitter = readFileSync(join(companiesDir, 'twitter.md'), 'utf-8');
    expect(twitter).not.toContain('Elegant Themes');
    // Elegant Themes should get its own page
    expect(existsSync(join(companiesDir, 'elegant-themes-inc.md'))).toBe(true);
  });

  test('enrich does not create pages for generic noise words from snippets', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'noise-1',
      from: 'Jane Doe <jane@example.com>',
      subject: 'Update from Support about Billing',
      snippet: 'Notification from the team about account updates via Support',
      body: 'Generic noise test.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/noise-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/noise-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // None of these noise words should become standalone pages
    expect(existsSync(join(brainDir, 'companies', 'support.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'companies', 'notification.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'companies', 'billing.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'people', 'support.md'))).toBe(false);
    // Sender page should still be created
    expect(existsSync(join(brainDir, 'people', 'jane-doe.md'))).toBe(true);
  });

  test('enrich skips junk sender names like Feedback or Notification', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'junk-sender-1',
      from: 'Feedback <feedback@service.com>',
      subject: 'Your feedback was received',
      snippet: 'Thanks for your feedback',
      body: 'Feedback confirmation.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/junk-sender-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/junk-sender-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // Feedback should not become an entity page
    expect(existsSync(join(brainDir, 'companies', 'feedback.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'people', 'feedback.md'))).toBe(false);
  });

  test('enrich sanitizes pipe-delimited sender names like "2020 | Cyncly"', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'cyncly-1',
      from: '2020 | Cyncly <info@cyncly.com>',
      subject: 'Product update',
      snippet: 'Latest from Cyncly',
      body: 'Cyncly product update.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/cyncly-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/cyncly-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // Should create cyncly.md, NOT "2020---cyncly.md" or "2020-cyncly.md"
    expect(existsSync(join(brainDir, 'companies', 'cyncly.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies', '2020---cyncly.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'companies', '2020-cyncly.md'))).toBe(false);
    const page = readFileSync(join(brainDir, 'companies', 'cyncly.md'), 'utf-8');
    expect(page).toContain('# Cyncly');
  });

  test('enrich writes unresolved candidate report when token overlap guard rejects merge', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    // Pre-seed twitter.md with alias "X"
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(companiesDir, 'twitter.md'), `---
aliases: ["Twitter", "X"]
tags: []
status: active
created: 2026-04-01
---

# Twitter

## Compiled Truth

### Summary
- Social media platform

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    // Send mail from sender "X" at stripe — should NOT merge into Twitter
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'ambig-x-1',
      from: 'X <invoice+statements+acct_123@stripe.com>',
      subject: 'Your invoice',
      snippet: 'Invoice attached',
      body: 'Your invoice from Stripe.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/ambig-x-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/ambig-x-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // Twitter should NOT be contaminated
    const twitter = readFileSync(join(companiesDir, 'twitter.md'), 'utf-8');
    expect(twitter).not.toContain('invoice');
    expect(twitter).not.toContain('stripe');
    // Unresolved report should exist OR a separate x.md should be created
    const unresolvedDir = join(dir, 'data', 'reports', 'unresolved-entities');
    const hasUnresolved = existsSync(join(unresolvedDir, '2026-04-12.json'));
    const hasSeparatePage = existsSync(join(companiesDir, 'x.md'));
    expect(hasUnresolved || hasSeparatePage).toBe(true);
  });

  test('enrich sender with strong domain evidence still creates correct company page', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'domain-1',
      from: 'Stripe <notifications@stripe.com>',
      subject: 'Your invoice is ready',
      snippet: 'Invoice for April',
      body: 'Your April invoice from Stripe.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/domain-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/domain-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(existsSync(join(brainDir, 'companies', 'stripe.md'))).toBe(true);
    const page = readFileSync(join(brainDir, 'companies', 'stripe.md'), 'utf-8');
    expect(page).toContain('# Stripe');
    expect(page).toContain('## Timeline');
  });

  test('existing catalog match with strong alias still works for mentions', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(companiesDir, 'acme-corp.md'), `---
aliases: ["Acme Corp"]
tags: []
status: active
created: 2026-04-10
---

# Acme Corp

## Compiled Truth

### Summary
- Existing company

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'catalog-1',
      from: 'Jane Doe <jane@example.com>',
      subject: 'Meeting with Acme Corp',
      snippet: 'Discussed partnership with Acme Corp',
      body: 'Met with Acme Corp to discuss partnership.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/catalog-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/catalog-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // Acme Corp page should be updated (not duplicated)
    const page = readFileSync(join(companiesDir, 'acme-corp.md'), 'utf-8');
    expect(page).toContain('Acme Corp was mentioned');
    expect(page).toContain('- [[Jane Doe]]');
  });

  test('article-title snippets do not emit junk unresolved mention candidates', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'mention-freeze-1',
      from: 'Thomas Frank <thomas@collegeinfogeek.com>',
      subject: 'Friday Tools and Tips',
      snippet: 'How to Improve Your Memory: A Comprehensive, Science-Backed Guide',
      body: 'Article - How to Improve Your Memory: A Comprehensive, Science-Backed Guide',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/mention-freeze-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/mention-freeze-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(existsSync(join(brainDir, 'people', 'improve-your-memory.md'))).toBe(false);
    const senderPage = readFileSync(join(brainDir, 'people', 'thomas-frank.md'), 'utf-8');
    expect(senderPage).not.toContain('Improve Your Memory');

    const unresolvedPath = join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-12.json');
    if (existsSync(unresolvedPath)) {
      const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'));
      expect(unresolved.some((r: any) => r.message_id === 'mention-freeze-1' && r.candidate_name === 'Improve Your Memory')).toBe(false);
    } else {
      expect(existsSync(unresolvedPath)).toBe(false);
    }
  });

  test('shared inbox with human display name is held for manual review instead of creating a sender page', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'shared-inbox-1',
      from: 'Maria Schriber <help@walla.by>',
      subject: 'Welcome to the Wallaby Family!',
      snippet: 'Welcome to the Wallaby Family!',
      body: 'Welcome to the Wallaby Family!',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/shared-inbox-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/shared-inbox-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(existsSync(join(brainDir, 'people', 'maria-schriber.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'companies', 'maria-schriber.md'))).toBe(false);

    const unresolved = JSON.parse(readFileSync(join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-12.json'), 'utf-8'));
    expect(unresolved.some((r: any) => r.message_id === 'shared-inbox-1' && /manual review/.test(r.reason))).toBe(true);
  });

  test('weak aliases like "X" are not persisted into frontmatter for new pages', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'weak-alias-1',
      from: 'X <invoice+statements+acct_123@stripe.com>',
      subject: 'Your receipt',
      snippet: 'Receipt attached',
      body: 'Your receipt for April.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/weak-alias-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/weak-alias-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    // X is a weak alias and should be filtered from frontmatter
    const files = existsSync(join(brainDir, 'companies', 'x.md'))
      ? readFileSync(join(brainDir, 'companies', 'x.md'), 'utf-8')
      : '';
    if (files) {
      // If a page was created, the alias "X" should not be in frontmatter
      const aliasMatch = files.match(/aliases:\s*\[(.*?)\]/s);
      if (aliasMatch) {
        const aliases = aliasMatch[1].split(',').map(a => a.trim().replace(/^"|"$/g, ''));
        expect(aliases).not.toContain('X');
        expect(aliases).not.toContain('x');
      }
    }
  });

  test('enrich repairs aliases containing commas and quoted titles without splitting them', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'merch-method-inc.md'), `---
aliases: [""Merch Method, Inc"", "customerservice@merchmethod.com"]
tags: []
status: active
created: 2026-04-10
---

# "Merch Method, Inc"

## Compiled Truth

### Summary
- Existing note

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'merch-1',
      from: 'Jane Doe <jane@example.com>',
      subject: 'Merch update',
      snippet: 'Merch Method, Inc is ready',
      body: 'Please review the update from Merch Method, Inc.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/merch-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/merch-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const person = readFileSync(join(peopleDir, 'merch-method-inc.md'), 'utf-8');
    expect(person).toContain('aliases: ["Merch Method, Inc", "customerservice@merchmethod.com"]');
    expect(person).not.toContain('""Merch Method, Inc""');
    expect(person).toContain('# Merch Method, Inc');
  });

  test('enrich routes Experian Alerts support sender into companies not people', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'experian-1',
      from: 'Experian Alerts <support@s.usa.experian.com>',
      subject: 'Your FICO® Score changed',
      snippet: 'See where your Experian credit file stands.',
      body: 'Sign in to review the latest alert from Experian.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/experian-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/experian-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(existsSync(join(brainDir, 'companies', 'experian-alerts.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'people', 'experian-alerts.md'))).toBe(false);
  });

  test('enrich preserves existing Current State bullets instead of overwriting them', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'jane-doe.md'), `---
aliases: ["Jane Doe", "jane@example.com"]
tags: []
status: active
created: 2026-04-10
---

# Jane Doe

## Compiled Truth

### Summary
- Existing note

### Current State
- Previously touched
- Waiting on reply from Jane

### Open Threads
- [ ] Existing thread

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'state-1',
      from: 'Jane Doe <jane@example.com>',
      subject: 'Following up',
      snippet: 'Checking in',
      body: 'Just following up.',
      date: '2026-04-12T11:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/state-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/state-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const person = readFileSync(join(peopleDir, 'jane-doe.md'), 'utf-8');
    expect(person).toContain('- Previously touched');
    expect(person).toContain('- Waiting on reply from Jane');
    expect(person).toContain('- Latest email subject: Following up');
  });

  test('enrich deduplicates unresolved candidate records across reruns', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(companiesDir, 'twitter.md'), `---
aliases: ["Twitter", "X"]
tags: []
status: active
created: 2026-04-01
---

# Twitter

## Compiled Truth

### Summary
- Social media platform

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'ambig-x-dedupe',
      from: 'X <invoice+statements+acct_123@stripe.com>',
      subject: 'Your invoice',
      snippet: 'Invoice attached',
      body: 'Your invoice from Stripe.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/ambig-x-dedupe',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/ambig-x-dedupe)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    for (let i = 0; i < 2; i++) {
      const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
        cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await proc.exited).toBe(0);
    }

    const unresolvedPath = join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-12.json');
    if (existsSync(unresolvedPath)) {
      const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'));
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].message_id).toBe('ambig-x-dedupe');
    } else {
      expect(existsSync(join(brainDir, 'companies', 'x.md'))).toBe(true);
    }
  });

  test('enrich merges sender into existing opposite-type page instead of creating cross-type duplicate', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(join(companiesDir, '.raw'), { recursive: true });
    writeFileSync(join(companiesDir, 'the-woolshire.md'), `---
aliases: ["The Woolshire", "orders@thewoolshire.com"]
tags: []
status: active
created: 2026-04-01
---

# The Woolshire

## Compiled Truth

### Summary
- Existing company note

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'woolshire-1',
      from: 'The Woolshire <hello@thewoolshire.com>',
      subject: 'Order update',
      snippet: 'Your order update',
      body: 'The Woolshire order update.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/woolshire-1',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/woolshire-1)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(existsSync(join(brainDir, 'companies', 'the-woolshire.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'people', 'the-woolshire.md'))).toBe(false);
    const page = readFileSync(join(companiesDir, 'the-woolshire.md'), 'utf-8');
    expect(page).toContain('Order update');
  });

  test('enrich writes unresolved record when both people and companies have equally strong cross-type matches', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(peopleDir, { recursive: true });
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(peopleDir, 'the-woolshire.md'), `---
aliases: ["The Woolshire", "hello@thewoolshire.com"]
status: active
created: 2026-04-01
---

# The Woolshire

## Compiled Truth

### Summary
- Person version

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    writeFileSync(join(companiesDir, 'the-woolshire.md'), `---
aliases: ["The Woolshire", "hello@thewoolshire.com"]
status: active
created: 2026-04-01
---

# The Woolshire

## Compiled Truth

### Summary
- Company version

### Current State
- Active

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-12.json'), JSON.stringify([{
      id: 'woolshire-ambig',
      from: 'The Woolshire <hello@thewoolshire.com>',
      subject: 'Order update',
      snippet: 'Your order update',
      body: 'The Woolshire order update.',
      date: '2026-04-12T09:00:00Z',
      gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/woolshire-ambig',
      gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/woolshire-ambig)',
      is_signature: false, is_noise: false, is_new: true
    }], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-12'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const unresolved = JSON.parse(readFileSync(join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-12.json'), 'utf-8'));
    expect(unresolved.some((r: any) => r.message_id === 'woolshire-ambig' && /Cross-type sender match is ambiguous/.test(r.reason))).toBe(true);
  });

  test('actionable noreply security mail is not classified as noise', async () => {
    const dir = makeTempDir();
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    const fixturePath = join(dir, 'fixture-security.json');
    writeFileSync(fixturePath, JSON.stringify([
      {
        id: 'google-security-1',
        from: 'Google <no-reply@accounts.google.com>',
        subject: 'You allowed Lune access to some of your Google Account data',
        snippet: 'Security alert: You allowed Lune access to some of your Google Account data.',
        date: '2026-04-14T09:00:00Z'
      }
    ], null, 2));

    await Bun.$`node ${scriptPath} collect --dir ${dir} --input ${fixturePath} --account me@gmail.com --date 2026-04-14`;
    const messages = JSON.parse(readFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), 'utf-8'));
    expect(messages).toHaveLength(1);
    expect(messages[0].is_noise).toBe(false);
  });

  test('generic alias pages do not absorb unrelated messages via weak single-word titles', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(companiesDir, { recursive: true });
    writeFileSync(join(companiesDir, 'welcome.md'), `---
aliases: ["Welcome", "cs@bookmaker.eu"]
tags: []
status: active
created: 2026-04-10
---

# Welcome

## Compiled Truth

### Summary
- Existing generic page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    writeFileSync(join(companiesDir, 'store.md'), `---
aliases: ["Arcadian Shop", "store@arcadian.com", "Store"]
tags: []
status: active
created: 2026-04-10
---

# Arcadian Shop

## Compiled Truth

### Summary
- Existing generic page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), JSON.stringify([
      {
        id: 'delphica-1',
        from: 'Delphica Society <delphica@calendar.luma-mail.com>',
        subject: 'Gotham Noir Salon surprise guest artist announcement',
        snippet: 'Welcome to tonight\'s Luma event.',
        body: 'Delphica Society has a surprise guest artist tonight.',
        date: '2026-04-14T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/delphica-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/delphica-1)',
        is_signature: false, is_noise: false, is_new: true
      },
      {
        id: 'expo-1',
        from: 'Jon Samp <jonsamp@expo.dev>',
        subject: 'OTA updates is about more than hot fixes',
        snippet: 'Instant updates without App Store delays.',
        body: 'EAS Update lets you push JavaScript and asset changes instantly.',
        date: '2026-04-14T10:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/expo-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/expo-1)',
        is_signature: false, is_noise: false, is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-14'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const welcome = readFileSync(join(companiesDir, 'welcome.md'), 'utf-8');
    const store = readFileSync(join(companiesDir, 'store.md'), 'utf-8');
    expect(welcome).not.toContain('Delphica Society');
    expect(store).not.toContain('Jon Samp');
    expect(store).not.toContain('OTA updates is about more than hot fixes');
  });

  test('CVN73 stale self-page does not absorb modern Valerie/iCloud contamination', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'christopher-winig.md'), `---
aliases: ["Christopher Winig", "chris.winig@gmail.com"]
tags: []
status: active
created: 2026-04-10
---

# Christopher Winig

## Compiled Truth

### Summary
- Canonical Chris page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    writeFileSync(join(peopleDir, 'winig-christopher-at3-cvn73-im2-div.md'), `---
aliases: ["Winig, Christopher AT3 (CVN73 IM2 Div)", "Winig", "Christopher AT3 (CVN73 IM2 Div)", "christopher.winig@cvn73.navy.mil"]
tags: []
status: active
created: 2011-12-31
---

# Winig, Christopher AT3 (CVN73 IM2 Div)

## Compiled Truth

### Summary
- Stale military self-page

### Current State
- Last touched via email on 2011-12-31

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), JSON.stringify([
      {
        id: 'cvn73-pollution-1',
        from: 'Valerie Winig <valeriewinig@gmail.com>',
        subject: 'Re: Your iCloud storage is full.',
        snippet: 'Christopher Winig - Chris On Tue, Apr 14, 2026 at 7:21 AM Valerie Winig wrote: ---------- Forwarded message --------- From: iCloud <noreply@email.apple>',
        body: 'Christopher Winig\n\nChris On Tue, Apr 14, 2026 at 7:21 AM Valerie Winig wrote:\n---------- Forwarded message ---------\nFrom: iCloud <noreply@email.apple>\nTake a moment now to check your account activity and secure your account.',
        date: '2026-04-14T12:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/cvn73-pollution-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/cvn73-pollution-1)',
        is_signature: false, is_noise: false, is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-14'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const canonical = readFileSync(join(peopleDir, 'christopher-winig.md'), 'utf-8');
    const stale = readFileSync(join(peopleDir, 'winig-christopher-at3-cvn73-im2-div.md'), 'utf-8');
    expect(canonical).toContain('Christopher Winig was mentioned');
    expect(stale).not.toContain('Re: Your iCloud storage is full.');
    expect(stale).not.toContain('Valerie Winig');
    expect(stale).not.toContain('Take a moment now to check your account activity');
  });

  test('quoted self-thread does not update a second duplicate self page', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'chris-winig.md'), `---
aliases: ["Chris Winig", "chris.winig@gmail.com"]
tags: []
status: active
created: 2026-04-10
---

# Chris Winig

## Compiled Truth

### Summary
- Canonical self page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    writeFileSync(join(peopleDir, 'christopher-winig.md'), `---
aliases: ["Christopher Winig"]
tags: []
status: active
created: 2026-04-10
---

# Christopher Winig

## Compiled Truth

### Summary
- Duplicate self page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-15.json'), JSON.stringify([
      {
        id: 'dup-self-1',
        from: 'Christopher Winig <chris.winig@gmail.com>',
        subject: 'Re: Your iCloud storage is full.',
        snippet: 'I just checked. Your icloud storage has plenty of storage. Not sure why they sent you that. - Chris On Tue, Apr 14, 2026 at 9:16 AM Valerie Winig <valeriewinig@gmail.com> wrote: I have no idea. On Tue, Apr 14, 2026, 7:37 AM Christopher Winig <chris.winig@gmail.com> wrote:',
        body: 'I just checked. Your icloud storage has plenty of storage. Not sure why they sent you that.\n\n- Chris\n\nOn Tue, Apr 14, 2026 at 9:16 AM Valerie Winig <valeriewinig@gmail.com> wrote:\n> I have no idea.\n> On Tue, Apr 14, 2026, 7:37 AM Christopher Winig <chris.winig@gmail.com> wrote:',
        date: '2026-04-15T00:10:22Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me#inbox/dup-self-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me#inbox/dup-self-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-15'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const canonical = readFileSync(join(peopleDir, 'chris-winig.md'), 'utf-8');
    const duplicate = readFileSync(join(peopleDir, 'christopher-winig.md'), 'utf-8');
    expect(canonical).toContain('Re: Your iCloud storage is full.');
    expect(duplicate).not.toContain('Re: Your iCloud storage is full.');
    expect(duplicate).not.toContain('Valerie Winig');
  });

  test('bare surname aliases do not trigger person-page updates from surname-only overlap', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'christopher-winig.md'), `---
aliases: ["Christopher Winig", "Winig"]
tags: []
status: active
created: 2026-04-10
---

# Christopher Winig

## Compiled Truth

### Summary
- Canonical Chris page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), JSON.stringify([
      {
        id: 'surname-only-1',
        from: 'Valerie Winig <valeriewinig@gmail.com>',
        subject: 'Checking in',
        snippet: 'Hey Chris, Valerie Winig here. Just checking in.',
        body: 'Valerie Winig here. Just checking in.',
        date: '2026-04-14T13:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/surname-only-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/surname-only-1)',
        is_signature: false, is_noise: false, is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-14'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const canonical = readFileSync(join(peopleDir, 'christopher-winig.md'), 'utf-8');
    expect(canonical).not.toContain('Checking in');
    expect(canonical).not.toContain('Valerie Winig here');
  });

  test('military-qualified human sender normalizes to canonical Chris page instead of creating a qualified company/person variant', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'christopher-winig.md'), `---
aliases: ["Christopher Winig", "chris.winig@gmail.com", "christopher.winig@cvn73.navy.mil"]
tags: []
status: active
created: 2026-04-10
---

# Christopher Winig

## Compiled Truth

### Summary
- Canonical Chris page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), JSON.stringify([
      {
        id: 'military-qualified-1',
        from: '"Winig, Christopher AT3 (CVN73 IM2 Div)" <christopher.winig@cvn73.navy.mil>',
        subject: 'Flight itinerary',
        snippet: 'Sharing the flight itinerary.',
        body: 'Sharing the flight itinerary.',
        date: '2026-04-14T14:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/military-qualified-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/military-qualified-1)',
        is_signature: false, is_noise: false, is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-14'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const canonical = readFileSync(join(peopleDir, 'christopher-winig.md'), 'utf-8');
    expect(canonical).toContain('Flight itinerary');
    expect(canonical).toContain('# Christopher Winig');
    expect(existsSync(join(brainDir, 'people', 'winig-christopher-at3-cvn73-im2-div.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'companies', 'winig-christopher-at3-cvn73-im2-div.md'))).toBe(false);
  });

  test('merch royalty terms email does not emit junk unresolved mention candidates', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(join(companiesDir, '.raw'), { recursive: true });
    writeFileSync(join(companiesDir, 'merch-on-demand.md'), `---
aliases: ["Merch on Demand", "noreply-merch-on-demand@amazon.com"]
tags: []
status: active
created: 2026-04-10
---

# Merch on Demand

## Compiled Truth

### Summary
- Existing company note.

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-15.json'), JSON.stringify([
      {
        id: 'merch-royalty-1',
        from: 'Merch on Demand <noreply-merch-on-demand@amazon.com>',
        to: 'chris.winig@gmail.com',
        reply_to: 'Merch on Demand <merch-events@amazon.com>',
        delivered_to: 'chris.winig@gmail.com',
        subject: 'Merch on Demand Update to Royalty Terms',
        snippet: 'Merch on Demand Update to Royalty Terms Hello, Thank you for being a Merch on Demand content creator. With our introduction of royalty incentive groups, your performance driving sales with non-organic',
        body: '',
        date: '2026-04-15T01:13:12Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me#inbox/merch-royalty-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me#inbox/merch-royalty-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-15'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const merchPage = readFileSync(join(companiesDir, 'merch-on-demand.md'), 'utf-8');
    expect(merchPage).not.toContain('Thank you for being a Merch on Demand content creator');
    expect(merchPage).not.toContain('Update to Royalty Terms Hello');

    const unresolvedPath = join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-15.json');
    if (existsSync(unresolvedPath)) {
      const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'));
      expect(unresolved).toEqual([]);
    } else {
      expect(existsSync(unresolvedPath)).toBe(false);
    }
  });

  test('contaminated company page aliases do not block canonical self-page sender matches', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    const peopleDir = join(brainDir, 'people');
    const companiesDir = join(brainDir, 'companies');
    mkdirSync(join(peopleDir, '.raw'), { recursive: true });
    mkdirSync(join(companiesDir, '.raw'), { recursive: true });
    writeFileSync(join(peopleDir, 'chris-winig.md'), `---
aliases: ["Chris Winig", "chris.winig@gmail.com"]
tags: []
status: active
created: 2026-04-10
---

# Chris Winig

## Compiled Truth

### Summary
- Canonical self page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    writeFileSync(join(companiesDir, 'clearsky-pharmacy.md'), `---
aliases: ["cwinig", "chris.winig@gmail.com", "ClearSky Pharmacy", "info@clearskypharmacy.biz"]
tags: []
status: active
created: 2022-12-31
---

# cwinig

## Compiled Truth

### Summary
- Contaminated company page

### Current State
- Existing state

### Open Threads
- None

### See Also
- None

---

## Timeline
`);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-15.json'), JSON.stringify([
      {
        id: 'contaminated-self-1',
        from: 'Christopher Winig <chris.winig@gmail.com>',
        subject: 'Re: Your iCloud storage is full.',
        snippet: 'I just checked. Your icloud storage has plenty of storage. Not sure why they sent you that.',
        body: 'I just checked. Your icloud storage has plenty of storage. Not sure why they sent you that.',
        date: '2026-04-15T00:10:22Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me#inbox/contaminated-self-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me#inbox/contaminated-self-1)',
        is_signature: false,
        is_noise: false,
        is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-15'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const person = readFileSync(join(peopleDir, 'chris-winig.md'), 'utf-8');
    const company = readFileSync(join(companiesDir, 'clearsky-pharmacy.md'), 'utf-8');
    expect(person).toContain('Re: Your iCloud storage is full.');
    expect(company).not.toContain('Re: Your iCloud storage is full.');

    const unresolvedPath = join(dir, 'data', 'reports', 'unresolved-entities', '2026-04-15.json');
    if (existsSync(unresolvedPath)) {
      const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'));
      expect(unresolved.some((r: any) => r.message_id === 'contaminated-self-1' && /ambiguous/.test(r.reason))).toBe(false);
    }
  });

  test('bank email chrome is filtered out of Open Threads', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    writeResolver(brainDir);
    await Bun.$`node ${scriptPath} init --dir ${dir}`;
    writeFileSync(join(dir, 'data', 'messages', '2026-04-14.json'), JSON.stringify([
      {
        id: 'bank-1',
        from: 'U.S. Bank Alerts <usbank@notifications.usbank.com>',
        subject: 'Your credit card payment is complete',
        snippet: 'You are receiving this email because you signed up for U.S. Bank alerts. To ensure continued delivery, please add usbank@notifications.usbank.com to your address book. Log in Your payment is complete.',
        body: '',
        date: '2026-04-14T09:00:00Z',
        gmail_link: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/bank-1',
        gmail_markdown: '[Open in Gmail](https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/bank-1)',
        is_signature: false, is_noise: false, is_new: true
      }
    ], null, 2));

    const proc = Bun.spawn(['node', scriptPath, 'enrich', '--dir', dir, '--brain-dir', brainDir, '--date', '2026-04-14'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const page = readFileSync(join(brainDir, 'companies', 'u-s-bank-alerts.md'), 'utf-8');
    expect(page).toContain('### Open Threads');
    expect(page).not.toContain('You are receiving this email because');
    expect(page).not.toContain('address book');
    expect(page).not.toContain('Log in Your payment is complete');
    expect(page).toContain('- [ ] Review latest email context if action is needed');
  });
});
