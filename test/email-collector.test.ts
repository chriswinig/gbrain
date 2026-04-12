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

  test('collect with provider gws pulls list/get via gws cli and writes normalized messages', async () => {
    const dir = makeTempDir();
    await Bun.$`node ${scriptPath} init --dir ${dir}`;

    const fakeGws = join(dir, 'fake-gws.py');
    writeFileSync(fakeGws, `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args[:4] == ['gmail', 'users', 'messages', 'list']:
    print(json.dumps({'messages': [{'id': 'gws-1'}]}))
elif args[:4] == ['gmail', 'users', 'messages', 'get']:
    print(json.dumps({
        'id': 'gws-1',
        'threadId': 'thread-1',
        'snippet': 'Need your review',
        'payload': {
            'headers': [
                {'name': 'From', 'value': 'person@example.com'},
                {'name': 'Subject', 'value': 'Review this'},
                {'name': 'Date', 'value': 'Sat, 12 Apr 2026 10:00:00 +0000'}
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
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('gws-1');
    expect(messages[0].from).toBe('person@example.com');
    expect(messages[0].subject).toBe('Review this');
    expect(messages[0].snippet).toBe('Need your review');
    expect(messages[0].body).toContain('Please review this.');
    expect(messages[0].gmail_link).toBe('https://mail.google.com/mail/u/?authuser=me@gmail.com#inbox/gws-1');
  });
});
