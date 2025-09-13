// env var access helpers

function required(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Missing required env var ${name}`);
    }
    return v;
}

export const Env = {
    cerebrasKey: () => process.env.CEREBRAS_API_KEY || '',
    requireCerebrasKey: () => required('CEREBRAS_API_KEY'),
    exaKey: () => process.env.EXA_API_KEY || '',
    requireExaKey: () => required('EXA_API_KEY'),
    firecrawlKey: () => process.env.FIRECRAWL_API_KEY || '',
    requireFirecrawlKey: () => required('FIRECRAWL_API_KEY'),
};

export function hasCerebrasKey(): boolean {
    return !!process.env.CEREBRAS_API_KEY;
}

export function hasExaKey(): boolean {
    return !!process.env.EXA_API_KEY;
}

export function hasFirecrawlKey(): boolean {
    return !!process.env.FIRECRAWL_API_KEY;
}
