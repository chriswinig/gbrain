import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const scriptPath = join(repoRoot, 'scripts', 'email-collector', 'email-collector.mjs');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-email-collector-'));
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

  test('enrich creates a person page and raw sidecar from collected email messages', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
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
    expect(person).toContain('## State');
    expect(person).toContain('Last touched via email on 2026-04-12');
    expect(person).toContain('2026-04-12 | Email from Jane Doe <jane@example.com>: Design review tomorrow');
    expect(person).toContain('[Source: Gmail, 2026-04-12T09:00:00Z]');

    const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
    expect(raw.messages).toHaveLength(1);
    expect(raw.messages[0].id).toBe('m-1');
  });

  test('enrich updates existing person page by alias email without overwriting earlier timeline', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    const peopleDir = join(brainDir, 'people');
    const rawDir = join(peopleDir, '.raw');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(peopleDir, 'jane-doe.md'), `---
aliases: ["Jane Doe", "jane@example.com"]
---
# Jane Doe

> Executive summary.

## State
- Existing note

## Open Threads
- None

## See Also
- None

---
2026-04-10 | Existing timeline entry [Source: Manual, 2026-04-10]
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
    expect(person).toContain('2026-04-10 | Existing timeline entry');
    expect(person).toContain('2026-04-12 | Email from Jane Doe <jane@example.com>: Following up');
  });

  test('enrich updates mentioned people and companies, not just the sender', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
    const companyDir = join(brainDir, 'companies');
    mkdirSync(companyDir, { recursive: true });
    writeFileSync(join(companyDir, 'acme-corp.md'), `---
aliases: ["Acme Corp"]
---
# Acme Corp

> Existing company note.

## State
- Existing company state

---
2026-04-10 | Existing company timeline [Source: Manual, 2026-04-10]
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

    expect(senderPage).toContain('Email from Jane Doe <jane@example.com>: Loop in Sarah Chen');
    expect(mentionedPerson).toContain('Mentioned in email from Jane Doe <jane@example.com>: Sarah Chen — Loop in Sarah Chen');
    expect(companyPage).toContain('> Existing company note.');
    expect(companyPage).toContain('2026-04-10 | Existing company timeline');
    expect(companyPage).toContain('Mentioned in email from Jane Doe <jane@example.com>: Acme Corp — Loop in Sarah Chen');
    expect(companyRaw.messages).toHaveLength(1);
    expect(companyRaw.messages[0].id).toBe('m-mention');
  });

  test('enrich can sync the brain via gbrain import and optional stale embeddings', async () => {
    const dir = makeTempDir();
    const brainDir = join(dir, 'brain');
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
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['import', brainDir, '--no-embed']);
    expect(calls[1].args).toEqual(['embed', '--stale']);
  });
});
