import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult, Link, Page, PageInput, PageFilters, Chunk, ChunkInput, TimelineEntry, TimelineInput, TimelineOpts, RawData, PageVersion, BrainStats, BrainHealth, IngestLogEntry, IngestLogInput, EngineConfig } from '../src/core/types.ts';
import { operationsByName } from '../src/core/operations.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

function makeSearchResult(slug: string, title: string, type: Page['type'], chunkText: string, score: number): SearchResult {
  return {
    slug,
    page_id: Math.abs(hashCode(slug)),
    title,
    type,
    chunk_text: chunkText,
    chunk_source: 'compiled_truth',
    chunk_id: Math.abs(hashCode(`${slug}:${chunkText}`)),
    chunk_index: 0,
    score,
    stale: false,
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return h | 0;
}

function makePage(slug: string, title: string, type: Page['type'], compiledTruth: string): Page {
  return {
    id: Math.abs(hashCode(slug)),
    slug,
    title,
    type,
    compiled_truth: compiledTruth,
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

class FakeEngine {
  pages = new Map<string, Page>([
    ['projects/wingate', makePage('projects/wingate', 'Wingate', 'project', 'Wingate is Chris’s family business.')],
    ['projects/lune', makePage('projects/lune', 'Lune', 'project', 'Lune is the cycle-aware fitness app.')],
    ['people/chris-winig', makePage('people/chris-winig', 'Chris Winig', 'person', 'Chris is connected to both Wingate and Lune.')],
    ['people/melissa-esposito', makePage('people/melissa-esposito', 'Melissa Esposito', 'person', 'Melissa is connected to Wingate.')],
    ['people/julia-zambuzzi', makePage('people/julia-zambuzzi', 'Julia Zambuzzi', 'person', 'Julia is connected to Lune.')],
    ['companies/shared-vendor', makePage('companies/shared-vendor', 'Shared Vendor', 'company', 'Shared Vendor sits two hops away through Chris.')],
  ]);

  outgoing = new Map<string, Link[]>([
    ['people/chris-winig', [
      { from_slug: 'people/chris-winig', to_slug: 'projects/wingate', link_type: 'works_on', context: '' },
      { from_slug: 'people/chris-winig', to_slug: 'projects/lune', link_type: 'works_on', context: '' },
      { from_slug: 'people/chris-winig', to_slug: 'companies/shared-vendor', link_type: 'connected_to', context: '' },
    ]],
    ['people/melissa-esposito', [
      { from_slug: 'people/melissa-esposito', to_slug: 'projects/wingate', link_type: 'works_on', context: '' },
    ]],
    ['people/julia-zambuzzi', [
      { from_slug: 'people/julia-zambuzzi', to_slug: 'projects/lune', link_type: 'works_on', context: '' },
    ]],
  ]);

  backlinks = new Map<string, Link[]>([
    ['projects/wingate', [
      { from_slug: 'people/chris-winig', to_slug: 'projects/wingate', link_type: 'works_on', context: '' },
      { from_slug: 'people/melissa-esposito', to_slug: 'projects/wingate', link_type: 'works_on', context: '' },
    ]],
    ['projects/lune', [
      { from_slug: 'people/chris-winig', to_slug: 'projects/lune', link_type: 'works_on', context: '' },
      { from_slug: 'people/julia-zambuzzi', to_slug: 'projects/lune', link_type: 'works_on', context: '' },
    ]],
    ['people/chris-winig', []],
    ['people/melissa-esposito', []],
    ['people/julia-zambuzzi', []],
    ['companies/shared-vendor', [
      { from_slug: 'people/chris-winig', to_slug: 'companies/shared-vendor', link_type: 'connected_to', context: '' },
    ]],
  ]);

  async searchKeyword(query: string): Promise<SearchResult[]> {
    if (query.includes('Wingate') && query.includes('Lune')) {
      return [
        makeSearchResult('projects/wingate', 'Wingate', 'project', 'Wingate result', 0.9),
        makeSearchResult('projects/lune', 'Lune', 'project', 'Lune result', 0.85),
      ];
    }
    return [];
  }

  async getLinks(slug: string): Promise<Link[]> {
    return this.outgoing.get(slug) || [];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    return this.backlinks.get(slug) || [];
  }

  async getPage(slug: string): Promise<Page | null> {
    return this.pages.get(slug) || null;
  }

  // Unused methods in these tests
  async connect(_config: EngineConfig): Promise<void> {}
  async disconnect(): Promise<void> {}
  async initSchema(): Promise<void> {}
  readonly kind = 'postgres' as const;
  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return fn(this as unknown as BrainEngine);
  }
  async withReservedConnection<T>(_fn: any): Promise<T> { throw new Error('not implemented'); }
  async putPage(_slug: string, _page: PageInput): Promise<Page> { throw new Error('not implemented'); }
  async deletePage(_slug: string): Promise<void> { throw new Error('not implemented'); }
  async listPages(_filters?: PageFilters): Promise<Page[]> { throw new Error('not implemented'); }
  async resolveSlugs(_partial: string): Promise<string[]> { throw new Error('not implemented'); }
  async getAllSlugs(): Promise<Set<string>> { return new Set(this.pages.keys()); }
  async searchVector(_embedding: Float32Array): Promise<SearchResult[]> { return []; }
  async getEmbeddingsByChunkIds(_ids: number[]): Promise<Map<number, Float32Array>> { return new Map(); }
  async upsertChunks(_slug: string, _chunks: ChunkInput[]): Promise<void> { throw new Error('not implemented'); }
  async getChunks(_slug: string): Promise<Chunk[]> { throw new Error('not implemented'); }
  async countStaleChunks(): Promise<number> { return 0; }
  async listStaleChunks(): Promise<any[]> { return []; }
  async deleteChunks(_slug: string): Promise<void> { throw new Error('not implemented'); }
  async addLink(_from: string, _to: string, _context?: string, _linkType?: string): Promise<void> { throw new Error('not implemented'); }
  async addLinksBatch(_links: any[]): Promise<number> { return 0; }
  async removeLink(_from: string, _to: string): Promise<void> { throw new Error('not implemented'); }
  async findByTitleFuzzy(_name: string, _dirPrefix?: string, _minSimilarity?: number): Promise<{ slug: string; similarity: number } | null> { return null; }
  async traverseGraph(_slug: string, _depth?: number): Promise<any[]> { return []; }
  async traversePaths(_slug: string, _opts?: any): Promise<any[]> { return []; }
  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    return new Map(slugs.map((slug) => [slug, (this.backlinks.get(slug) || []).length]));
  }
  async findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>> { return []; }
  async addTag(_slug: string, _tag: string): Promise<void> { throw new Error('not implemented'); }
  async removeTag(_slug: string, _tag: string): Promise<void> { throw new Error('not implemented'); }
  async getTags(_slug: string): Promise<string[]> { throw new Error('not implemented'); }
  async addTimelineEntry(_slug: string, _entry: TimelineInput): Promise<void> { throw new Error('not implemented'); }
  async addTimelineEntriesBatch(_entries: any[]): Promise<number> { return 0; }
  async getTimeline(_slug: string, _opts?: TimelineOpts): Promise<TimelineEntry[]> { throw new Error('not implemented'); }
  async putRawData(_slug: string, _source: string, _data: object): Promise<void> { throw new Error('not implemented'); }
  async getRawData(_slug: string, _source?: string): Promise<RawData[]> { throw new Error('not implemented'); }
  async getDreamVerdict(_filePath: string, _contentHash: string): Promise<any> { return null; }
  async putDreamVerdict(_filePath: string, _contentHash: string, _verdict: any): Promise<void> { throw new Error('not implemented'); }
  async createVersion(_slug: string): Promise<PageVersion> { throw new Error('not implemented'); }
  async getVersions(_slug: string): Promise<PageVersion[]> { throw new Error('not implemented'); }
  async revertToVersion(_slug: string, _versionId: number): Promise<void> { throw new Error('not implemented'); }
  async getStats(): Promise<BrainStats> { throw new Error('not implemented'); }
  async getHealth(): Promise<BrainHealth> { throw new Error('not implemented'); }
  async logIngest(_entry: IngestLogInput): Promise<void> { throw new Error('not implemented'); }
  async getIngestLog(_opts?: { limit?: number | undefined; }): Promise<IngestLogEntry[]> { throw new Error('not implemented'); }
  async updateSlug(_oldSlug: string, _newSlug: string): Promise<void> { throw new Error('not implemented'); }
  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> { throw new Error('not implemented'); }
  async getConfig(_key: string): Promise<string | null> { throw new Error('not implemented'); }
  async setConfig(_key: string, _value: string): Promise<void> { throw new Error('not implemented'); }
  async runMigration(_version: number, _sql: string): Promise<void> { throw new Error('not implemented'); }
  async getChunksWithEmbeddings(_slug: string): Promise<Chunk[]> { throw new Error('not implemented'); }
  async executeRaw<T = Record<string, unknown>>(_sql: string, _params?: unknown[]): Promise<T[]> { return []; }
  async addCodeEdges(_edges: any[]): Promise<number> { return 0; }
  async deleteCodeEdgesForChunks(_chunkIds: number[]): Promise<void> { throw new Error('not implemented'); }
  async getCallersOf(_qualifiedName: string, _opts?: any): Promise<any[]> { return []; }
  async getCalleesOf(_qualifiedName: string, _opts?: any): Promise<any[]> { return []; }
  async getEdgesByChunk(_chunkId: number, _opts?: any): Promise<any[]> { return []; }
  async searchKeywordChunks(_query: string, _opts?: any): Promise<SearchResult[]> { return []; }
}

describe('graph expansion contract', () => {
  test('query operation exposes graph_depth flag', () => {
    expect(operationsByName.query.params).toHaveProperty('graph_depth');
    expect(operationsByName.query.params.graph_depth.type).toBe('number');
  });

  test('search operation exposes graph_depth flag', () => {
    expect(operationsByName.search.params).toHaveProperty('graph_depth');
    expect(operationsByName.search.params.graph_depth.type).toBe('number');
  });
});

describe('hybridSearch graph expansion', () => {
  test('default query remains flat without graph depth', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const results = await hybridSearch(new FakeEngine() as unknown as BrainEngine, 'people connected to both Wingate and Lune', { limit: 10 });
      expect(results.map(r => r.slug)).toEqual(['projects/wingate', 'projects/lune']);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  test('plain search default remains flat without graph depth', async () => {
    const result = await operationsByName.search.handler({ engine: new FakeEngine() as any, config: {} as any, logger: console as any, dryRun: false }, {
      query: 'people connected to both Wingate and Lune',
      limit: 10,
    });
    expect((result as SearchResult[]).map(r => r.slug)).toEqual(['projects/wingate', 'projects/lune']);
  });

  test('plain search graph depth 1 returns shared connectors from linked pages', async () => {
    const result = await operationsByName.search.handler({ engine: new FakeEngine() as any, config: {} as any, logger: console as any, dryRun: false }, {
      query: 'people connected to both Wingate and Lune',
      limit: 10,
      graph_depth: 1,
    });
    const slugs = (result as SearchResult[]).map(r => r.slug);
    expect(slugs).toContain('people/chris-winig');
    expect(slugs).toContain('people/melissa-esposito');
    expect(slugs).toContain('people/julia-zambuzzi');
  });

  test('graph depth 1 returns shared connectors from linked pages', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const results = await hybridSearch(new FakeEngine() as unknown as BrainEngine, 'people connected to both Wingate and Lune', { limit: 10, graphDepth: 1 } as any);
      const slugs = results.map(r => r.slug);
      expect(slugs).toContain('people/chris-winig');
      expect(slugs).toContain('people/melissa-esposito');
      expect(slugs).toContain('people/julia-zambuzzi');
      expect(slugs.indexOf('people/chris-winig')).toBeLessThan(slugs.indexOf('people/melissa-esposito'));
      expect(slugs.indexOf('people/chris-winig')).toBeLessThan(slugs.indexOf('people/julia-zambuzzi'));
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  test('graph depth 2 reaches second-hop related pages', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const depth1 = await hybridSearch(new FakeEngine() as unknown as BrainEngine, 'people connected to both Wingate and Lune', { limit: 10, graphDepth: 1 } as any);
      const depth2 = await hybridSearch(new FakeEngine() as unknown as BrainEngine, 'people connected to both Wingate and Lune', { limit: 10, graphDepth: 2 } as any);
      expect(depth1.map(r => r.slug)).not.toContain('companies/shared-vendor');
      expect(depth2.map(r => r.slug)).toContain('companies/shared-vendor');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});
