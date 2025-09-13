// Lightweight client for external Markdowner service.
// Public instance documented at https://github.com/supermemoryai/markdowner
// Usage: fetchMarkdown(url) returns markdown string or throws.

const MARKDOWNER_ENDPOINT = 'https://md.dhr.wtf';

export async function fetchMarkdown(targetUrl: string): Promise<string> {
  const q = new URL(MARKDOWNER_ENDPOINT);
  q.searchParams.set('url', targetUrl);
  // plain text response (default) is fine
  const resp = await fetch(q.toString(), {
    method: 'GET',
    headers: { 'User-Agent': 'htn2025-app/1.0' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`markdowner_fetch_failed status=${resp.status} body=${text.slice(0,200)}`);
  }
  return resp.text();
}
