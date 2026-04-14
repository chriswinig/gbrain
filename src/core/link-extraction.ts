import { posix } from 'path';

interface PageLike {
  slug: string;
  title?: string;
  frontmatter?: Record<string, unknown>;
}

export interface ResolvedLinkTarget {
  slug: string;
  name: string;
  dir: string;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .replace(/\.md$/i, '')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function slugDir(slug: string): string {
  return slug.split('/')[0] || '';
}

function slugName(slug: string, title?: string): string {
  if (title?.trim()) return title.trim();
  const base = slug.split('/').pop() || slug;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function extractAliases(frontmatter?: Record<string, unknown>): string[] {
  if (!frontmatter) return [];
  const raw = frontmatter.aliases ?? frontmatter.alias;
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export function buildPageResolver(pages: PageLike[]): Map<string, ResolvedLinkTarget> {
  const staged = new Map<string, ResolvedLinkTarget | null>();

  const register = (key: string, target: ResolvedLinkTarget) => {
    const normalized = normalizeKey(key);
    if (!normalized) return;
    const existing = staged.get(normalized);
    if (!existing) {
      staged.set(normalized, target);
      return;
    }
    if (existing.slug !== target.slug) staged.set(normalized, null);
  };

  for (const page of pages || []) {
    if (!page?.slug) continue;
    const target: ResolvedLinkTarget = {
      slug: page.slug,
      name: slugName(page.slug, page.title),
      dir: slugDir(page.slug),
    };
    register(page.slug, target);
    register(page.slug.split('/').pop() || page.slug, target);
    register(target.name, target);
    for (const alias of extractAliases(page.frontmatter)) register(alias, target);
  }

  return new Map(Array.from(staged.entries()).filter(([, value]) => value !== null) as [string, ResolvedLinkTarget][]);
}

function resolveMarkdownHref(href: string, sourceSlug: string, resolver: Map<string, ResolvedLinkTarget>): string | null {
  if (!href || /^[a-z]+:/i.test(href)) return null;
  const cleanHref = href.split('#')[0]?.trim();
  if (!cleanHref || !cleanHref.endsWith('.md')) return null;

  const sourceDir = posix.dirname(`${sourceSlug}.md`);
  const normalizedPath = cleanHref.startsWith('/')
    ? cleanHref.replace(/^\//, '')
    : posix.normalize(posix.join(sourceDir, cleanHref));
  const slug = normalizedPath.replace(/\.md$/i, '');

  return resolver.get(normalizeKey(slug))?.slug || null;
}

function resolveWikiTarget(target: string, resolver: Map<string, ResolvedLinkTarget>): string | null {
  const cleanTarget = target.split('|')[0]?.split('#')[0]?.split('^')[0]?.trim();
  if (!cleanTarget) return null;

  const pathLike = cleanTarget.replace(/\.md$/i, '').replace(/^\//, '').replace(/^\.\//, '');
  return resolver.get(normalizeKey(pathLike))?.slug || resolver.get(normalizeKey(cleanTarget))?.slug || null;
}

export function extractResolvedLinks(content: string, sourceSlug: string, resolver: Map<string, ResolvedLinkTarget>): string[] {
  const targets = new Set<string>();
  const markdownPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  const wikiPattern = /\[\[([^\]]+)\]\]/g;

  let match: RegExpExecArray | null;
  while ((match = markdownPattern.exec(content)) !== null) {
    const slug = resolveMarkdownHref(match[1], sourceSlug, resolver);
    if (slug && slug !== sourceSlug) targets.add(slug);
  }

  while ((match = wikiPattern.exec(content)) !== null) {
    const slug = resolveWikiTarget(match[1], resolver);
    if (slug && slug !== sourceSlug) targets.add(slug);
  }

  return Array.from(targets).sort();
}

export function resolvedEntityRefs(
  content: string,
  sourceSlug: string,
  resolver: Map<string, ResolvedLinkTarget>,
): { name: string; slug: string; dir: string }[] {
  return extractResolvedLinks(content, sourceSlug, resolver)
    .map(slug => resolver.get(normalizeKey(slug)))
    .filter((target): target is ResolvedLinkTarget => Boolean(target) && ['people', 'companies'].includes(target.dir))
    .map(target => ({
      name: target.name,
      slug: target.slug.replace(/^(people|companies)\//, ''),
      dir: target.dir,
    }));
}
