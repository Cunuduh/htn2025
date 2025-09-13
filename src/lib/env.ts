// Centralized environment variable access & validation.
// In edge/runtime contexts (Next.js), process.env is still available for static keys at build time.
// For dynamic checks keep minimal logic.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export const Env = {
  anthropicKey: () => process.env.ANTHROPIC_API_KEY || '',
  requireAnthropicKey: () => required('ANTHROPIC_API_KEY'),
  firecrawlKey: () => process.env.FIRECRAWL_API_KEY || '',
  requireFirecrawlKey: () => required('FIRECRAWL_API_KEY'),
};

export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function hasFirecrawlKey(): boolean {
  return !!process.env.FIRECRAWL_API_KEY;
}
