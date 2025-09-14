## anti-disinformation article analysis

parallel multi-agent article decomposition using next.js (app router) + bun + shadcn/ui + vercel ai sdk cerebras provider + exa web search tool.

### features

- five fast, specialized analysis agents powered by Cerebras executed in parallel (credibility, facts vs interpretation, cui bono, omissions, rhetoric)
- summary and trustworthiness verdict made using Claude Opus 4.1
- external article retrieval via Firecrawl API (https://firecrawl.dev) converting the target URL to markdown prior to multi-agent analysis
- web search tool powered by Exa (https://exa.ai) for agents with search permission

### environment

1. Copy `.env.example` to `.env.local` (this file is gitignored).
2. Put your real Anthropic, Cerebras, Exa & Firecrawl key values:

```
"# example env file"
ANTHROPIC_API_KEY=sk_anthropic_real_key_here
CEREBRAS_API_KEY=sk_cerebras_real_key_here
EXA_API_KEY=exa_real_key_here
FIRECRAWL_API_KEY=fc_live_your_firecrawl_key
```

3. Restart the dev server after adding or changing env vars.

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