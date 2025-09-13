## anti-disinformation article analysis

parallel multi-agent article decomposition using next.js (app router) + bun + shadcn/ui + vercel ai sdk cerebras provider + exa web search tool.

### features

- five specialized analysis agents executed in parallel (credibility, facts vs interpretation, cui bono, omissions, rhetoric)
- synthesis summary using a higher depth model
- dark minimal ui with horizontal snap carousel
- markdown rendering of each agent output
- external article retrieval via Firecrawl API (https://firecrawl.dev) converting the target URL to markdown prior to multi-agent analysis
- manual start (no auto-run) + explicit red Stop (abort) button using AbortController
- live search activity cards (one per outgoing web search) with status pulse → done indicator
- adaptive carousel sizing + keyboard navigation (←/→)
- graceful abort (no error flash on intentional cancel)
- (pending small UX niceties being added): persisted last URL, Retry button on abort/error, collapsible summary card, full query tooltips

### environment

1. Copy `.env.example` to `.env.local` (this file is gitignored).
2. Put your real Cerebras, Exa & Firecrawl key values:

```
"# example env file"
CEREBRAS_API_KEY=sk_cerebras_real_key_here
EXA_API_KEY=exa_real_key_here
FIRECRAWL_API_KEY=fc_live_your_firecrawl_key
```

3. Restart the dev server after adding or changing env vars.

Security / hygiene:

- Never commit real keys. `.env.example` should only contain placeholders.
- If a real key was ever committed, rotate it immediately in the Cerebras or Exa dashboards.
- In production (e.g. Vercel) add `CEREBRAS_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` via the dashboard Environment Variables UI; no code change needed.

### development

```
bun install
bun run dev
```

visit http://localhost:3000

Workflow:

1. Paste article URL → Analyze.
2. During processing you may Stop to instantly abort downstream model calls.
3. Each agent card streams markdown; summary appears after agents complete.
4. Search cards show evidence gathering queries in real time.

Planned minor enhancements (tracked in codebase TODOs):

- Persist last used URL (localStorage) so refresh keeps context.
- Retry button when analysis aborted or failed.
- Collapsible summary (hide/show body to reduce vertical scroll).
- Hover tooltip on truncated search queries.

These are incremental and do not affect the streaming protocol.

### api

Streaming endpoint: `POST /api/analyze/stream` body: `{ "url": "https://example.com/article" }`
Returns Server-Sent Events (text/event-stream). Event `type` values:

```
start            { url, hasKey }
article          { bytes }
articleError     { message }
agentStart       { id }
agentChunk       { id, delta }
agentError       { id, error }
agentDone        { id }
agentsComplete   {}
searchStart      { agent, query }
summaryStart     {}
summaryChunk     { delta }
summaryError     { error }
summaryDone      {}
done             {}
```

Client accumulates deltas to build agent content & summary.

Non-stream JSON route deprecated in favor of unified streaming. Agents now execute in PARALLEL; only the summary waits for all agent outputs.

Prompt structure improvements:

- Article markdown wrapped as XML: `<article_markdown><![CDATA[ ... ]]></article_markdown>` for unambiguous delimitation.
- Agents receive additional `<context_instructions>` block guiding evidence use and discouraging false "missing context" claims.

### mock fallback

If `CEREBRAS_API_KEY` is absent the streaming route emits deterministic mock markdown chunks for each agent plus a mock summary. This lets the UI be demonstrated without incurring API usage. (Legacy non‑stream route removed.)

Client logic already handles this transparently; no special flag is required beyond the existing event sequence.

### notes

- web search powered by Exa (via custom tool) when `EXA_API_KEY` present; agents lacking search permission skip tool usage.
- production hardening: pre-fetch article server-side, chunk & pass extracted readable text to reduce external fetch variability.
- article content retrieved via Firecrawl extract endpoint (markdown format). Consider adding caching (KV / Redis) for rate & latency optimization.

### license

mit

---

below is the default create-next-app reference material:

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
