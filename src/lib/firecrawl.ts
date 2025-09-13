import Firecrawl from '@mendable/firecrawl-js';

// lazy singleton client
let singleton: Firecrawl | null = null;
function getClient(): Firecrawl {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) throw new Error('missing_FIRECRAWL_API_KEY');
    if (!singleton) singleton = new Firecrawl({ apiKey: key });
    return singleton;
}

export async function fetchFirecrawlMarkdown(url: string): Promise<string> {
    const client = getClient();
    const res: any = await client.scrapeUrl(url, { formats: ['markdown'] });
    if (!res || !res.data || !res.data.markdown) throw new Error('firecrawl_no_markdown');
    return res.data.markdown as string;
}
