import { NextRequest } from 'next/server';
import { anthropic } from '@ai-sdk/anthropic';
import { cerebras } from '@ai-sdk/cerebras';
import { streamText, generateText, generateObject, stepCountIs } from 'ai';
import { AGENT_SPECS, DEFAULT_URL, buildAgentSystem, buildSummarySystem, ReadingLevel } from '@/lib/agents';
import { hasCerebrasKey, hasExaKey } from '@/lib/env';
import { fetchFirecrawlMarkdown } from '@/lib/firecrawl';
import { z } from 'zod';

// Using Firecrawl SDK which may require Node.js runtime rather than edge.
export const runtime = 'nodejs';

// Simple Server-Sent Events helper
function sseEncoder() {
	const encoder = new TextEncoder();
	return {
		encode(data: Record<string, unknown>) {
			return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
		}
	};
}

const TRUST_SCHEMA = z.object({
  trustLevel: z.enum(['high','medium','low','uncertain']).describe('Overall trust assessment bucket.'),
  plainVerdict: z.string().describe('One short sentence everyday-language verdict (<= 20 words).'),
  mainConcerns: z.array(z.string()).max(5).describe('Key concerns or red flags, short phrases.'),
  toVerify: z.array(z.string()).max(6).describe('Concrete things a reader should check elsewhere.'),
  notes: z.string().optional().describe('Optional extra nuance if needed.')
});

type TrustObject = z.infer<typeof TRUST_SCHEMA>;

export async function POST(req: NextRequest) {
	const body = await req.json().catch(() => ({}));
	const url = (body?.url as string) || DEFAULT_URL;
  const readingLevel: ReadingLevel = (body?.readingLevel === 'simple' ? 'simple' : 'standard');
	const apiKeyPresent = hasCerebrasKey();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enc = sseEncoder();
			function send(obj: Record<string, unknown>) { controller.enqueue(enc.encode(obj)); }

			send({ type: 'start', url, hasKey: apiKeyPresent, readingLevel });

			if (!apiKeyPresent) {
				// mock outputs
				for (const spec of AGENT_SPECS) {
					send({ type: 'agentChunk', id: spec.id, name: spec.name, delta: `**mock output** (no key) for ${spec.name}` });
					send({ type: 'agentDone', id: spec.id });
				}
				// mock structured summary object
				send({ type: 'summaryObject', object: { trustLevel: 'uncertain', plainVerdict: 'Mock verdict (no key).', mainConcerns: ['Add API key'], toVerify: ['Add CEREBRAS_API_KEY env var'], notes: 'Structured summary disabled in mock.' } });
				send({ type: 'done' });
				controller.close();
				return;
			}

			// fetch markdown once via Firecrawl; abort entire analysis if it fails
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

			// Collect full agent outputs concurrently for later summary
			const agentOutputs: { id: string; name: string; markdown: string }[] = [];

			// Build XML wrapped article for stronger context delimitation
			const xmlWrappedArticle = `<article_markdown><![CDATA[\n${articleMarkdown}\n]]></article_markdown>`;

					const agentPromises = AGENT_SPECS.map((spec) => (async () => {
				send({ type: 'agentStart', id: spec.id });
				let full = '';
				try {
					const webSearch = anthropic.tools.webSearch_20250305({ maxUses: 3 }) as any; // enforce max 3 searches per agent
					const prompt = [
						`<date>${new Date().toISOString().split('T')[0]}</date>`,
						`<time>${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time>`,
						'<context_instructions>',
						'You are given the complete article markdown inside <article_markdown>.',
						'Use ONLY that content (plus optional factual web_search queries if tool is available) as evidence.',
						`If you believe content is missing, first restate what you have; do NOT claim absence unless clearly absent.`,
						'Specialize according to your system role; output well-structured GitHub-flavored markdown.',
              'Keep to your requested headings. No fluffy language.',
						'</context_instructions>',
						xmlWrappedArticle,
					].join('\n');
					const system = buildAgentSystem(spec.system, readingLevel);
					// Model selection: use Anthropic Sonnet for high-precision analytical agents needing
					// more nuanced separation (facts_vs_interpretation & omissions). Others use Cerebras
					// for cost/performance balance.
					const agentModel = (spec.id === 'facts_vs_interpretation' || spec.id === 'omissions')
						? anthropic('claude-sonnet-4-20250514')
						: cerebras('qwen-3-235b-a22b-instruct-2507');
					const promptLength = prompt.length;
					console.log('[analyze/stream] agent begin', { agent: spec.id, name: spec.name, promptLength, systemRoleChars: system.length, readingLevel });
						const tools = (spec.id === 'facts_vs_interpretation' || spec.id === 'omissions') ? { web_search: webSearch } : undefined;
						// Maintain persistent mapping across streaming & step finishes for this agent invocation
						const searchIdToQuery: Record<string,string> = {};
						let emittedSearchCount = 0;
						const MAX_SEARCHES = 3;

						// Helper normalizers so we can catch both snake_case & camelCase variants coming from SDKs
						function maybeEmitSearchStart(id: string | undefined | null, query: string | undefined | null) {
							if (!id || !query) return;
							const q = query.trim();
							if (!q) return;
							if (searchIdToQuery[id]) return; // already recorded
							if (emittedSearchCount >= MAX_SEARCHES) return;
							searchIdToQuery[id] = q;
							emittedSearchCount += 1;
							send({ type: 'searchStart', agent: spec.id, query: q });
						}

						function maybeEmitSearchResult(id: string | undefined | null, payload: any) {
							if (!id) return;
							const query = searchIdToQuery[id];
							if (!query) return; // only emit for known search ids
							let sources: any[] = [];
							const content = payload?.content || payload?.results || payload?.result?.results;
							if (Array.isArray(content)) {
								sources = content
									.filter((c: any) => c && (c.type === 'web_search_result' || c.type === 'webSearchResult' || c.url))
									.map((c: any) => ({
										url: c.url,
										title: c.title,
										page_age: c.page_age || c.pageAge,
										encrypted_content: c.encrypted_content || c.encryptedContent,
									}));
							}
							if (!sources.length) return;
							const norm = sources.slice(0, 8).map(s => ({
								url: s.url,
								title: s.title,
								page_age: s.page_age,
								encrypted_content: s.encrypted_content,
							}));
							send({ type: 'searchResult', agent: spec.id, query, sources: norm });
						}

						const result = await streamText({
							model: agentModel,
							system,
							tools,
							maxRetries: 2,
							messages: [ { role: 'user', content: prompt } ],
							stopWhen: stepCountIs(3),
							onStepFinish: ({ toolCalls, toolResults }) => {
								try {
									if (Array.isArray(toolCalls)) {
										for (const callAny of toolCalls as any[]) {
											const call = callAny as any;
											const name = call.toolName || call.name;
											if (name === 'web_search') {
												const id = call.id || call.toolUseId || call.tool_use_id || call.tool_call_id;
												const query = call.input?.query || call.args?.query;
												maybeEmitSearchStart(id, query);
											}
										}
									}
									if (Array.isArray(toolResults)) {
										for (const resultAny of toolResults as any[]) {
											const r = resultAny as any;
											const name = r.toolName || r.name;
											if (name === 'web_search') {
												const toolUseId = r.toolUseId || r.tool_use_id || r.callId || r.call_id;
												maybeEmitSearchResult(toolUseId, r);
											}
										}
									}
								} catch (err) {
									console.warn('[analyze/stream] search event emit error', err);
								}
							}
						});
						for await (const rawPart of result.textStream as any) {
							const part: any = rawPart;
							try {
								// Real-time interception of tool usage BEFORE text to ensure search cards appear at top
								if (part && typeof part === 'object') {
									const pType = part.type;
									// Detect tool call (server_tool_use / serverToolUse / tool-call etc.)
									if (pType === 'server_tool_use' || pType === 'serverToolUse' || pType === 'tool-call' || pType === 'toolCall') {
										const name = part.name || part.toolName;
										if (name === 'web_search') {
											const id = part.id || part.toolUseId || part.tool_use_id || part.tool_call_id;
											const query = part.input?.query || part.args?.query;
											maybeEmitSearchStart(id, query);
										}
									}
									// Detect results (web_search_tool_result / webSearchToolResult)
									if (pType === 'web_search_tool_result' || pType === 'webSearchToolResult' || pType === 'tool-result' || pType === 'toolResult') {
										const id = part.toolUseId || part.tool_use_id || part.callId || part.call_id;
										// Only treat as web_search if associated id already known (avoids misclassification)
										if (id && searchIdToQuery[id]) {
											maybeEmitSearchResult(id, part);
										}
									}
								}
							} catch (streamToolErr) {
								console.warn('[analyze/stream] real-time search parse error', streamToolErr);
							}
							// Standard text / error handling
							if (typeof part === 'string') { send({ type: 'agentChunk', id: spec.id, delta: part }); full += part; }
							else if (part?.type === 'text-delta') { send({ type: 'agentChunk', id: spec.id, delta: part.text }); full += part.text; }
							else if (part?.type === 'error') { send({ type: 'agentError', id: spec.id, error: part.error }); }
						}
				} catch (err) {
					console.error('[analyze/stream] agent error', spec.id, err);
					send({ type: 'agentError', id: spec.id, error: (err as Error).message });
				} finally {
					console.log('[analyze/stream] agent done', { agent: spec.id, chars: full.length });
					agentOutputs.push({ id: spec.id, name: spec.name, markdown: full });
					send({ type: 'agentDone', id: spec.id });
				}
			})());

			await Promise.allSettled(agentPromises);
			send({ type: 'agentsComplete' });

			try {
        const summarySystem = buildSummarySystem(readingLevel);
        const summaryPrompt = `Integrate specialist analyses below. Provide unbiased, concise output respecting schema.\n${agentOutputs.map(a => `\n<agent id="${a.id}">\n<![CDATA[\n${a.markdown}\n]]>\n</agent>`).join('')}`;
				const genObj: any = generateObject as any; // loose typing fallback due to build-time inference issue
				const summaryResult: any = await genObj({
							model: anthropic('claude-sonnet-4-20250514'),
							system: summarySystem,
							schema: TRUST_SCHEMA,
							messages: [ { role: 'user', content: summaryPrompt } ],
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
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		},
	});
}
