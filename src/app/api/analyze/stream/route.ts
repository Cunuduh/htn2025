import { NextRequest } from 'next/server';
import { anthropic } from '@ai-sdk/anthropic';
import { streamText, generateObject } from 'ai';
import { AGENT_SPECS, DEFAULT_URL, buildAgentSystem, buildSummarySystem, ReadingLevel } from '@/lib/agents';
import { hasAnthropicKey } from '@/lib/env';
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
	const apiKeyPresent = hasAnthropicKey();

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
        send({ type: 'summaryObject', object: { trustLevel: 'uncertain', plainVerdict: 'Mock verdict (no key).', mainConcerns: ['Add API key'], toVerify: ['Add ANTHROPIC_API_KEY env var'], notes: 'Structured summary disabled in mock.' } });
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

			const agentPromises = AGENT_SPECS.map(spec => (async () => {
				send({ type: 'agentStart', id: spec.id });
				let full = '';
				try {
					const webSearch: any = anthropic.tools.webSearch_20250305({
						maxUses: 5,
						onInputStart: (options: any) => {
							try {
								const q = options?.input?.query;
								if (q) send({ type: 'searchStart', agent: spec.id, query: q });
							} catch {/* ignore */}
						}
					});
					const prompt = [
						'<context_instructions>',
						'You are given the complete article markdown inside <article_markdown>.',
						'Use ONLY that content (plus optional factual web_search queries) as evidence.',
						`If you believe content is missing, first restate what you have; do NOT claim absence unless clearly absent.`,
						'Specialize according to your system role; output well-structured GitHub-flavored markdown.',
              'Keep to your requested headings. No fluffy language.',
						'</context_instructions>',
						xmlWrappedArticle,
					].join('\n');
					const system = buildAgentSystem(spec.system, readingLevel);
					const promptLength = prompt.length;
					console.log('[analyze/stream] agent begin', { agent: spec.id, name: spec.name, promptLength, systemRoleChars: system.length, readingLevel });
					const result = await streamText({
						model: anthropic('claude-3-5-haiku-20241022'),
						system,
						tools: { web_search: webSearch } as any,
						maxRetries: 1,
						messages: [
							{ role: 'user', content: prompt },
						],
					});
					for await (const rawPart of result.textStream as any) {
						const part: any = rawPart;
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

			// Structured Summary (generateObject, no streaming currently for simplicity)
			try {
        const summarySystem = buildSummarySystem(readingLevel);
        const summaryPrompt = `Integrate specialist analyses below. Provide unbiased, concise output respecting schema.\n${agentOutputs.map(a => `\n<agent id="${a.id}">\n<![CDATA[\n${a.markdown}\n]]>\n</agent>`).join('')}`;
				const genObj: any = generateObject as any; // loose typing fallback due to build-time inference issue
				const summaryResult: any = await genObj({
							model: anthropic('claude-3-7-sonnet-latest'),
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
