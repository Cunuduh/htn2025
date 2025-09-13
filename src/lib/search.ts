import Exa from 'exa-js';
import { Env, hasExaKey } from './env';

export interface SearchSource {
    url: string;
    title?: string;
    snippet?: string;
    publishedDate?: string;
}

export interface SearchResultBundle {
    query: string;
    sources: SearchSource[];
}

let exaSingleton: Exa | null = null;
function getExa(): Exa {
    if (!hasExaKey()) throw new Error('missing_EXA_API_KEY');
    if (!exaSingleton) exaSingleton = new Exa(Env.requireExaKey());
    return exaSingleton;
}

// naive heuristic: extract question-like or quoted phrases; fallback to top N nouns in future
export function extractPossibleQueries(markdown: string, max = 3): string[] {
    const lines = markdown.split(/\n+/).filter((l) => l.trim().length > 0);
    const candidates: string[] = [];
    for (const l of lines) {
        if (candidates.length >= max) break;
        if (/\b(verify|unclear|claim|allege|according)\b/i.test(l)) {
            candidates.push(
                l
                    .replace(/[*`>#_-]/g, '')
                    .trim()
                    .slice(0, 120),
            );
        }
    }
    return candidates.slice(0, max);
}

export async function runExaSearch(queries: string[]): Promise<SearchResultBundle[]> {
    if (!queries.length || !hasExaKey()) return [];
    const exa = getExa();
    const bundles: SearchResultBundle[] = [];
    for (const q of queries) {
        try {
            const res: any = await exa.search(q, { numResults: 6 });
            const sources: SearchSource[] = (res?.results || []).slice(0, 6).map((r: any) => ({
                url: r.url,
                title: r.title,
                snippet: r.highlights?.[0]?.snippet || r.text?.slice(0, 160),
                publishedDate: r.publishedDate,
            }));
            bundles.push({ query: q, sources });
        } catch (e) {
            // swallow individual query errors; continue
        }
    }
    return bundles;
}
