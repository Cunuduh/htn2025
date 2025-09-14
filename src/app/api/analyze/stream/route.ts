import { NextRequest } from 'next/server';
import { anthropic } from '@ai-sdk/anthropic';
import { cerebras } from '@ai-sdk/cerebras';
import { streamText, generateObject, generateText } from 'ai';
import {
    AGENT_SPECS,
    DEFAULT_URL,
    buildAgentSystem,
    buildSummarySystem,
    ReadingLevel,
} from '@/lib/agents';
import { hasCerebrasKey, hasExaKey } from '@/lib/env';
import { extractPossibleQueries, runExaSearch } from '@/lib/search';
import { XMLParser } from 'fast-xml-parser';
import { fetchFirecrawlMarkdown } from '@/lib/firecrawl';
import { z } from 'zod';

// node runtime (firecrawl)
export const runtime = 'nodejs';
// sse helper
function sseEncoder() {
    const encoder = new TextEncoder();
    return {
        encode(data: Record<string, unknown>) {
            return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
        },
    };
}

// trust object schema
const TRUST_SCHEMA = z.object({
    trustLevel: z.enum(['high', 'medium', 'low', 'uncertain']),
    plainVerdict: z.string(),
    mainConcerns: z.array(z.string()).max(5),
    toVerify: z.array(z.string()).max(6),
    notes: z.string().optional(),
});
type TrustObject = z.infer<typeof TRUST_SCHEMA>;

export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const url = (body?.url as string) || DEFAULT_URL;
    const readingLevel: ReadingLevel = body?.readingLevel === 'simple' ? 'simple' : 'standard';
    const apiKeyPresent = hasCerebrasKey();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const enc = sseEncoder();
            function send(obj: Record<string, unknown>) {
                controller.enqueue(enc.encode(obj));
            }

            send({ type: 'start', url, hasKey: apiKeyPresent, readingLevel });

            // fetch article markdown
            let articleMarkdown = '';
            try {
                articleMarkdown = await fetchFirecrawlMarkdown(url);
                send({ type: 'article', bytes: articleMarkdown.length, source: 'firecrawl' });
            } catch (e) {
                send({ type: 'articleError', message: (e as Error).message, source: 'firecrawl' });
                send({ type: 'done', aborted: true, reason: 'article_fetch_failed' });
                controller.close();
                return;
            }

            // agent outputs collection
            const agentOutputs: { id: string; name: string; markdown: string }[] = [];

            // xml wrap article
            const xmlWrappedArticle = `<article_markdown><![CDATA[\n${articleMarkdown}\n]]></article_markdown>`;

            const agentPromises = AGENT_SPECS.map((spec) =>
                (async () => {
                    send({ type: 'agentStart', id: spec.id });
                    let full = '';
                    let searchHeaderMarkdown: string | undefined;
                    try {
                        // throttle search agents
                        if (spec.allowSearch) {
                            await new Promise((res) => setTimeout(res, 500));
                        }
                        // two phase search
                        let searchContext = '';
                        searchHeaderMarkdown = '';
                        if (spec.allowSearch && hasExaKey()) {
                            try {
                                // phase 1 query generation
                                const queryGen = await generateText({
                                    model: cerebras('qwen-3-235b-a22b-instruct-2507'),
                                    maxRetries: 0,
                                    prompt: `You are a news fact extraction assistant. Given the article markdown below, output ONLY XML of the form <queries><q>query 1</q><q>query 2</q><q>query 3</q></queries> with up to 3 short DISTINCT fact-check queries (5-10 words each).\nRules:\n- Output ONLY the XML. No commentary.\n- Each <q> must be unique and concise.\n---ARTICLE START---\n${articleMarkdown.slice(0, 8000)}\n---ARTICLE END---`,
                                });
                                let queries: string[] = [];
                                try {
                                    const xmlMatch = queryGen.text.match(/<queries[\s\S]*?<\/queries>/i);
                                    if (xmlMatch) {
                                        const parser = new XMLParser({ ignoreAttributes: true });
                                        const parsed: any = parser.parse(xmlMatch[0]);
                                        let qNodes = parsed?.queries?.q;
                                        if (typeof qNodes === 'string') qNodes = [qNodes];
                                        if (Array.isArray(qNodes)) {
                                            queries = qNodes
                                                .map((q: any) => String(q).trim())
                                                .filter(Boolean);
                                        }
                                    }
                                } catch {}
                                queries = Array.from(new Set(queries.map((q) => q.toLowerCase().trim())))
                                    .slice(0, 3)
                                    .map((q) => q.replace(/^["'`]|["'`]$/g, ''));
                                if (!queries.length) {
                                    queries = extractPossibleQueries(articleMarkdown, 3);
                                }
                                if (queries.length) {
                                    send({ type: 'searchQueries', agent: spec.id, queries });
                                    await new Promise((r) => setTimeout(r, 300));
                                    const bundles = await runExaSearch(queries);
                                    if (bundles.length) {
                                        searchContext = bundles
                                            .map(
                                                (b) =>
                                                    `\n<search query="${b.query}">\n${b.sources.map((s) => `<source url="${s.url}"><![CDATA[${s.title || ''}\n${s.snippet || ''}]]></source>`).join('\n')}\n</search>`,
                                            )
                                            .join('');
                                        for (const b of bundles) {
                                            send({
                                                type: 'searchResult',
                                                agent: spec.id,
                                                query: b.query,
                                                sources: b.sources.slice(0, 5),
                                            });
                                        }
                                        // no visible search header
                                    }
                                }
                            } catch (searchErr) {
                                console.warn('[analyze/stream] exa search error', searchErr);
                            }
                        }
                        const system = buildAgentSystem(spec.system, readingLevel);
                        const prompt = [
                            `Date: ${new Date().toISOString().split('T')[0]}`,
                            `You will output XML with root <agentOutput> containing exactly one <markdown><![CDATA[ ...markdown... ]]></markdown>.</agentOutput>`,
                            'Rules: Only produce required markdown (GitHub flavored). No analysis outside your role. No extra XML nodes. Do NOT list search queries or headings like "Search 1". Ignore and omit search enumeration; integrate evidence silently.',
                            xmlWrappedArticle,
                            searchContext || '<search />',
                        ].join('\n');
                        const agentModel = cerebras('qwen-3-235b-a22b-instruct-2507');
                        console.log('[analyze/stream] agent begin', {
                            agent: spec.id,
                            model: 'cerebras-qwen-235b',
                        });
                        const result = await streamText({
                            model: agentModel,
                            system,
                            messages: [{ role: 'user', content: prompt }],
                            maxRetries: 1,
                        });
                        // buffer output
                        for await (const rawPart of result.textStream as any) {
                            const part: any = rawPart;
                            if (typeof part === 'string') {
                                full += part;
                            } else if (part?.type === 'text-delta') {
                                full += part.text;
                            } else if (part?.type === 'error') {
                                send({ type: 'agentError', id: spec.id, error: part.error });
                            }
                        }
                    } catch (err) {
                        console.error('[analyze/stream] agent error', spec.id, err);
                        send({ type: 'agentError', id: spec.id, error: (err as Error).message });
                    } finally {
                        let parsedMarkdown = full;
                        try {
                            // parse xml wrapper
                            const match = full.match(/<agentOutput[\s\S]*?<\/agentOutput>/i);
                            if (match) {
                                const xmlSnippet = match[0];
                                const parser = new XMLParser({
                                    cdataPropName: '__cdata',
                                    ignoreAttributes: false,
                                });
                                const parsed: any = parser.parse(xmlSnippet);
                                const cdata = parsed?.agentOutput?.markdown?.__cdata || '';
                                if (cdata.trim()) parsedMarkdown = cdata.trim();
                            }
                        } catch (parseErr) {
                            console.warn('[analyze/stream] xml parse failure', parseErr);
                        }
                        console.log('[analyze/stream] agent done', {
                            agent: spec.id,
                            chars: parsedMarkdown.length,
                        });
                        agentOutputs.push({
                            id: spec.id,
                            name: spec.name,
                            markdown: parsedMarkdown,
                        });
                        // emit cleaned markdown
                        send({ type: 'agentChunk', id: spec.id, delta: parsedMarkdown });
                        send({ type: 'agentDone', id: spec.id });
                    }
                })(),
            );

            await Promise.allSettled(agentPromises);
            send({ type: 'agentsComplete' });

            try {
                const summarySystem = buildSummarySystem(readingLevel);
                const summaryPrompt = `Integrate specialist analyses below. Provide unbiased, concise output respecting schema.\n${agentOutputs.map((a) => `\n<agent id="${a.id}">\n<![CDATA[\n${a.markdown}\n]]>\n</agent>`).join('')}`;
                const genObj: any = generateObject as any; // loose typing fallback due to build-time inference issue
                const summaryResult: any = await genObj({
                    model: anthropic('claude-opus-4-1-20250805'),
                    system: summarySystem,
                    schema: TRUST_SCHEMA,
                    messages: [{ role: 'user', content: summaryPrompt }],
                    maxRetries: 1,
                });
                const object = summaryResult?.object as TrustObject | undefined;
                if (object) {
                    send({ type: 'summaryObject', object });
                } else {
                    send({ type: 'summaryError', error: 'no_summary_object' });
                }
            } catch (e) {
                send({ type: 'summaryError', error: (e as Error).message });
            }

            send({ type: 'done' });
            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        },
    });
}
