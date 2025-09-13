import { POST } from '../src/app/api/analyze/stream/route';
import { NextRequest } from 'next/server';

async function main() {
  const req = new NextRequest('http://localhost/api/analyze/stream', { method: 'POST', body: JSON.stringify({ url: 'https://example.com', readingLevel: 'simple' }) } as any);
  const res = await POST(req);
  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let summaryObject: any = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (!part.startsWith('data:')) continue;
      const json = part.replace(/^data:\s*/, '');
      try {
        const evt = JSON.parse(json);
        if (evt.type === 'summaryObject') summaryObject = evt.object;
      } catch {}
    }
  }
  console.log('Summary Object (mock or real):', summaryObject);
}

main().catch(e => { console.error(e); process.exit(1); });
