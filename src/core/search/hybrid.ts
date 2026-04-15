/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * Pipeline: keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Compiled truth boost: 2.0x for compiled_truth chunks after RRF normalization
 * Cosine re-score: blend 0.7*rrf + 0.3*cosine for query-specific ranking
 */

import type { BrainEngine } from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embed } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import { autoDetectDetail } from './intent.ts';

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

/** Slug-prefix score multipliers. Noise sources get penalized so curated pages surface. */
const SLUG_PREFIX_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['collectors/', 0.3],
  ['cron/', 0.2],
];
const DEFAULT_SLUG_WEIGHT = 1.0;

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  graphDepth?: number;
  /** Override default RRF K constant (default: 60). Lower values boost top-ranked results more. */
  rrfK?: number;
  /** Override dedup pipeline parameters. */
  dedupOpts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  };
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit || 20;
  const offset = opts?.offset || 0;
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);
  const graphDepth = clampGraphDepth(opts?.graphDepth);

  // Auto-detect detail level from query intent when caller doesn't specify
  const detail = opts?.detail ?? autoDetectDetail(query);
  const searchOpts: SearchOpts = { limit: innerLimit, detail };

  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  // Run keyword search (always available, no API key needed)
  const keywordResults = await engine.searchKeyword(query, searchOpts);

  // Skip vector search entirely if no OpenAI key is configured
  if (!process.env.OPENAI_API_KEY) {
    return applyGraphExpansion(engine, dedupResults(keywordResults), {
      graphDepth,
      offset,
      limit,
      innerLimit,
    });
  }

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      queries = await opts.expandFn(query);
      if (queries.length === 0) queries = [query];
    } catch {
      // Expansion failure is non-fatal
    }
  }

  // Embed all query variants and run vector search
  let vectorLists: SearchResult[][] = [];
  let queryEmbedding: Float32Array | null = null;
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q)));
    queryEmbedding = embeddings[0];
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, searchOpts)),
    );
  } catch {
    // Embedding failure is non-fatal, fall back to keyword-only
  }

  if (vectorLists.length === 0) {
    return applyGraphExpansion(engine, dedupResults(keywordResults), {
      graphDepth,
      offset,
      limit,
      innerLimit,
    });
  }

  // Collapse each list to 1 result per slug before RRF to eliminate chunk-count bias
  const allLists = [
    ...vectorLists.map(collapseToPageLevel),
    collapseToPageLevel(keywordResults),
  ];

  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  let fused = rrfFusion(allLists, opts?.rrfK ?? RRF_K, detail !== 'high');

  // Penalize noise sources (collectors/, cron/) before cosine re-scoring/dedup
  fused = applySlugWeights(fused);

  // Cosine re-scoring before dedup so semantically better chunks survive
  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding);
  }

  // Dedup
  const deduped = dedupResults(fused, opts?.dedupOpts);

  // Auto-escalate: if detail=low returned 0, retry with high
  if (deduped.length === 0 && opts?.detail === 'low') {
    return hybridSearch(engine, query, { ...opts, detail: 'high' });
  }

  return applyGraphExpansion(engine, deduped, {
    graphDepth,
    offset,
    limit,
    innerLimit,
  });
}

export async function applyGraphExpansion(
  engine: BrainEngine,
  baseResults: SearchResult[],
  opts: {
    graphDepth?: number;
    offset?: number;
    limit?: number;
    innerLimit?: number;
  } = {},
): Promise<SearchResult[]> {
  const graphDepth = clampGraphDepth(opts.graphDepth);
  const offset = opts.offset || 0;
  const limit = opts.limit || 20;
  const innerLimit = opts.innerLimit || Math.min(limit * 2, MAX_SEARCH_LIMIT);
  if (graphDepth <= 0 || baseResults.length === 0) {
    return baseResults.slice(offset, offset + limit);
  }

  const seedResults = baseResults.slice(0, innerLimit);
  const graphResults = await expandGraphResults(engine, seedResults, graphDepth);
  const merged = dedupResults([...baseResults, ...graphResults]);
  return merged.slice(offset, offset + limit);
}

function clampGraphDepth(depth: number | undefined): number {
  if (depth === undefined || depth === null || !Number.isFinite(depth) || Number.isNaN(depth)) return 0;
  if (depth <= 0) return 0;
  return Math.min(2, Math.floor(depth));
}

async function expandGraphResults(
  engine: BrainEngine,
  seedResults: SearchResult[],
  graphDepth: number,
): Promise<SearchResult[]> {
  const seedSlugs = new Set(seedResults.map(r => r.slug));
  const pageCache = new Map<string, Awaited<ReturnType<BrainEngine['getPage']>>>();
  const aggregate = new Map<string, {
    result: SearchResult;
    sourceSlugs: Set<string>;
    minDepth: number;
  }>();

  for (const seed of seedResults) {
    let frontier = [seed.slug];
    const visited = new Set<string>([seed.slug]);

    for (let depth = 1; depth <= graphDepth; depth++) {
      const nextFrontier: string[] = [];

      for (const currentSlug of frontier) {
        const [links, backlinks] = await Promise.all([
          safeGetLinks(engine, currentSlug),
          safeGetBacklinks(engine, currentSlug),
        ]);
        const neighbors = uniqueStrings([
          ...links.map(link => link.to_slug),
          ...backlinks.map(link => link.from_slug),
        ]);

        for (const neighborSlug of neighbors) {
          if (visited.has(neighborSlug)) continue;
          visited.add(neighborSlug);
          nextFrontier.push(neighborSlug);

          if (seedSlugs.has(neighborSlug)) continue;

          const page = await getCachedPage(engine, pageCache, neighborSlug);
          if (!page) continue;

          const contribution = seed.score * Math.pow(0.6, depth);
          const existing = aggregate.get(neighborSlug);
          if (existing) {
            existing.result.score += contribution;
            existing.sourceSlugs.add(seed.slug);
            existing.minDepth = Math.min(existing.minDepth, depth);
            existing.result.graph_depth = existing.minDepth;
            existing.result.graph_source_slugs = Array.from(existing.sourceSlugs).sort();
            existing.result.chunk_text = buildGraphSnippet(page.compiled_truth, existing.result.graph_source_slugs, existing.minDepth);
          } else {
            const sourceSlugs = new Set<string>([seed.slug]);
            aggregate.set(neighborSlug, {
              result: {
                slug: page.slug,
                page_id: page.id,
                title: page.title,
                type: page.type,
                chunk_text: buildGraphSnippet(page.compiled_truth, [seed.slug], depth),
                chunk_source: 'compiled_truth',
                score: contribution,
                stale: false,
                graph_depth: depth,
                graph_source_slugs: [seed.slug],
              },
              sourceSlugs,
              minDepth: depth,
            });
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
  }

  return Array.from(aggregate.values())
    .map(entry => entry.result)
    .sort((a, b) => b.score - a.score);
}

async function safeGetLinks(engine: BrainEngine, slug: string) {
  try {
    return await engine.getLinks(slug);
  } catch {
    return [];
  }
}

async function safeGetBacklinks(engine: BrainEngine, slug: string) {
  try {
    return await engine.getBacklinks(slug);
  } catch {
    return [];
  }
}

async function getCachedPage(
  engine: BrainEngine,
  cache: Map<string, Awaited<ReturnType<BrainEngine['getPage']>>>,
  slug: string,
) {
  if (!cache.has(slug)) {
    cache.set(slug, await engine.getPage(slug));
  }
  return cache.get(slug) ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildGraphSnippet(compiledTruth: string, sourceSlugs: string[], depth: number): string {
  const cleanTruth = (compiledTruth || '').replace(/\s+/g, ' ').trim();
  const snippet = cleanTruth ? cleanTruth.slice(0, 180) : 'Related through the link graph.';
  const via = sourceSlugs.join(', ');
  return `Graph connection (depth ${depth}) via ${via}. ${snippet}`;
}

/**
 * Pre-RRF page-level collapse: keep only the best-scoring chunk per slug
 * in each result list. Ensures a page with N chunks gets at most 1 RRF
 * vote per list, eliminating chunk-count bias.
 */
export function collapseToPageLevel(list: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const r of list) {
    const existing = best.get(r.slug);
    if (!existing || r.score > existing.score) {
      best.set(r.slug, r);
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score);
}

/**
 * Post-RRF slug-prefix weighting: multiply each result's fused score by a
 * weight based on slug prefix. Noise sources (collectors/, cron/) get
 * penalized. Re-sorts by adjusted score.
 */
export function applySlugWeights(results: SearchResult[]): SearchResult[] {
  return results
    .map(r => {
      const match = SLUG_PREFIX_WEIGHTS.find(([prefix]) => r.slug.startsWith(prefix));
      const weight = match ? match[1] : DEFAULT_SLUG_WEIGHT;
      return { ...r, score: r.score * weight };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  // Normalize to 0-1 by dividing by observed max
  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      const rawScore = e.score;
      e.score = e.score / maxScore;

      // Apply compiled truth boost after normalization (skip for detail=high)
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Cosine re-scoring: blend RRF score with query-chunk cosine similarity.
 * Runs before dedup so semantically better chunks survive.
 */
async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const chunkIds = results
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);

  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds);
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    const chunkEmb = r.chunk_id != null ? embeddingMap.get(r.chunk_id) : undefined;
    if (!chunkEmb) return r;

    const cosine = cosineSimilarity(queryEmbedding, chunkEmb);
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    return { ...r, score: blended };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!a?.length || !b?.length) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  const score = denom === 0 ? 0 : dot / denom;
  return Number.isFinite(score) ? score : 0;
}
