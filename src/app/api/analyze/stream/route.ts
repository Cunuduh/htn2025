import { NextRequest } from 'next/server';
import { anthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { AGENT_SPECS, DEFAULT_URL, SUMMARY_SYSTEM } from '@/lib/agents';
import { hasAnthropicKey } from '@/lib/env';
import { fetchFirecrawlMarkdown } from '@/lib/firecrawl';

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

export async function POST(req: NextRequest) {
	const body = await req.json().catch(() => ({}));
	const url = (body?.url as string) || DEFAULT_URL;
	const apiKeyPresent = hasAnthropicKey();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enc = sseEncoder();
			function send(obj: Record<string, unknown>) { controller.enqueue(enc.encode(obj)); }

			send({ type: 'start', url, hasKey: apiKeyPresent });

			if (!apiKeyPresent) {
				// mock outputs
				for (const spec of AGENT_SPECS) {
					send({ type: 'agentChunk', id: spec.id, name: spec.name, delta: `**mock output** (no key) for ${spec.name}` });
					send({ type: 'agentDone', id: spec.id });
				}
				send({ type: 'summaryChunk', delta: '**mock summary** add ANTHROPIC_API_KEY to enable live analysis.' });
				send({ type: 'summaryDone' });
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
                        'Be concise, avoid being personable and do not try to follow up or use pleasantries, just do the task as instructed.',
						'</context_instructions>',
						xmlWrappedArticle,
					].join('\n');
					const promptLength = prompt.length;
					console.log('[analyze/stream] agent begin', { agent: spec.id, name: spec.name, promptLength, systemRoleChars: spec.system.length });
					const result = await streamText({
						model: anthropic('claude-3-5-haiku-20241022'),
						system: spec.system,
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

			// Summary (waits for all agents)
			send({ type: 'summaryStart' });
			try {
				const summaryPrompt = `<context_instructions>Integrate specialist analyses below. Be concise, avoid redundancy, preserve factual nuance.</context_instructions>\n${agentOutputs.map(a => `\n<agent id="${a.id}">\n<![CDATA[\n${a.markdown}\n]]>\n</agent>`).join('')}`;
				const summaryResult = await streamText({
					model: anthropic('claude-3-7-sonnet-latest'),
					system: SUMMARY_SYSTEM,
					messages: [ { role: 'user', content: summaryPrompt } ],
				});
				for await (const rawPart of summaryResult.textStream as any) {
					const part: any = rawPart;
					if (typeof part === 'string') send({ type: 'summaryChunk', delta: part });
					else if (part?.type === 'text-delta') send({ type: 'summaryChunk', delta: part.text });
					else if (part?.type === 'error') send({ type: 'summaryError', error: part.error });
				}
				send({ type: 'summaryDone' });
			} catch (e) {
				send({ type: 'summaryError', error: (e as Error).message });
				send({ type: 'summaryDone' });
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
