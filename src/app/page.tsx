"use client";
import { useState, useEffect, useRef } from 'react';
import { Play, Square } from 'lucide-react';
import { AGENT_SPECS } from '@/lib/agents';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Markdown } from '@/components/Markdown';

interface AgentResult { id: string; name: string; markdown: string }

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentResult[]>([]);
  const [summary, setSummary] = useState('');
  // summary always visible now (removed collapse)
  const [searchEvents, setSearchEvents] = useState<{ agent: string; query: string; ts: number; done?: boolean }[]>([]);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [active, setActive] = useState(0);
  const visibleAgents = agents.length ? agents : AGENT_SPECS.map(a => ({ id: a.id, name: a.name, markdown: '' }));
  const count = visibleAgents.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const CARD_WIDTH = 460;
  const GAP = 40; // gap between cards (must match flex gap below)
  const CARD_HEIGHT = 460;
  const [started, setStarted] = useState(false); // whether at least one analysis has begun
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const dragState = useRef<{active:boolean; startX:number; lastX:number; moved:boolean}>({active:false,startX:0,lastX:0,moved:false});
  const wheelLockRef = useRef(0);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [summaryStarted, setSummaryStarted] = useState(false);

  function resetState() {
    setAgents([]);
    setSummary('');
    setSearchEvents([]);
    setAborted(false);
  }

  async function analyze(e?: React.FormEvent) {
    e?.preventDefault();
    resetState();
    setError(null);
    setLoading(true);
  const controller = new AbortController();
  setStarted(true);
    abortRef.current = controller;
    try {
      const res = await fetch('/api/analyze/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('stream start failed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const agentMap: Record<string, AgentResult> = {};
      const commitAgents = () => setAgents(Object.values(agentMap));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const chunk of parts) {
          if (!chunk.startsWith('data:')) continue;
          const json = chunk.replace(/^data:\s*/, '');
          let evt: any; try { evt = JSON.parse(json); } catch { continue; }
          switch (evt.type) {
            case 'agentStart': {
              agentMap[evt.id] = { id: evt.id, name: (AGENT_SPECS.find(a => a.id === evt.id)?.name) || evt.id, markdown: '' };
              commitAgents();
              break;
            }
            case 'agentChunk': {
              if (!agentMap[evt.id]) agentMap[evt.id] = { id: evt.id, name: evt.id, markdown: '' };
              agentMap[evt.id].markdown += evt.delta;
              commitAgents();
              break;
            }
            case 'agentError': {
              if (!agentMap[evt.id]) agentMap[evt.id] = { id: evt.id, name: evt.id, markdown: '' };
              agentMap[evt.id].markdown += `\n\n**error:** ${evt.error}`;
              commitAgents();
              break;
            }
            case 'searchStart': {
              setSearchEvents(s => [...s, { agent: evt.agent, query: evt.query, ts: Date.now() }]);
              break;
            }
            case 'agentDone': {
              setSearchEvents(s => s.map(ev => ev.agent === evt.id ? { ...ev, done: true } : ev));
              break;
            }
            case 'summaryChunk': {
              setSummary(prev => {
                if (!summaryStarted) setSummaryStarted(true);
                return prev + evt.delta;
              });
              break;
            }
            case 'summaryError': {
              setSummary(s => s + `\n\n**summary error:** ${evt.error}`);
              break;
            }
            case 'done': {
              break;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (aborted) {
        // abort -> ignore
      } else {
        setError(err instanceof Error ? err.message : 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  function stopAnalysis() {
    if (abortRef.current) {
      setAborted(true);
      abortRef.current.abort();
    }
  }

  // removed persistence of last URL to keep input empty by default

  // clamp active when count changes
  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, count - 1)));
  }, [count]);

  // keyboard navigation
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') setActive(a => (a + 1) % count);
      else if (e.key === 'ArrowLeft') setActive(a => (a - 1 + count) % count);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count]);

  // measure width
  useEffect(() => {
    function measure() {
      setContainerWidth(containerRef.current?.offsetWidth || 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // re-measure once started (layout shift) + raf fallback for accurate centering
  useEffect(() => {
    if (!started) return;
    let frame = requestAnimationFrame(() => {
      setContainerWidth(containerRef.current?.offsetWidth || 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [started]);

  // ensure active slides remains centered after width recalculation
  useEffect(() => {
    // trigger translate recompute by setting state (active unchanged) if width changed
    // no-op assignment to cause rerender is not needed because containerWidth already updated.
  }, [containerWidth]);

  // pointer drag for carousel
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return; // left only
      dragState.current.active = true;
      dragState.current.startX = e.clientX;
      dragState.current.lastX = e.clientX;
      dragState.current.moved = false;
      setDragOffset(0);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragState.current.active) return;
      const dx = e.clientX - dragState.current.startX;
      if (Math.abs(dx) > 4) dragState.current.moved = true;
      dragState.current.lastX = e.clientX;
      setDragOffset(dx);
    }
    function onPointerUp(e: PointerEvent) {
      if (!dragState.current.active) return;
      dragState.current.active = false;
      const dx = e.clientX - dragState.current.startX;
      // determine how many card widths moved (with threshold)
      const step = CARD_WIDTH + GAP;
      const threshold = step * 0.25;
      let delta = 0;
      if (Math.abs(dx) > threshold) {
        delta = Math.round(dx / step * -1); // invert because dragging left shows next (dx negative)
      }
      if (delta !== 0) {
        setActive(a => {
          const next = Math.min(count - 1, Math.max(0, a + delta));
          return next;
        });
      }
      // smooth snap back handled by transition re-enabled
      setDragOffset(0);
    }
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [count]);

  // wheel / trackpad support (treat dominant axis as navigation, vertical allowed)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!count) return;
      const dominant = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(dominant) < 4) return; // small jitter ignore
      // only intercept if pointer within carousel bounds (element itself)
      e.preventDefault(); // lock scroll to carousel navigation
      const now = performance.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + 120; // debounce
      if (dominant > 0) {
        setActive(a => Math.min(count - 1, a + 1));
      } else if (dominant < 0) {
        setActive(a => Math.max(0, a - 1));
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [count]);

  const baseTranslate = containerWidth ? (containerWidth / 2) - (active * (CARD_WIDTH + GAP) + CARD_WIDTH / 2) : 0;
  const translate = baseTranslate + dragOffset;

  // auto-scroll to summary when it first starts streaming
  useEffect(() => {
    if (summaryStarted && summaryRef.current) {
      summaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [summaryStarted]);

  // reusable form component so we can position it differently pre/post start
  const Form = (
    <form onSubmit={analyze} className="flex gap-4 w-full items-stretch">
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Enter an article URL to begin multi-agent disinformation analysis."
        className="bg-neutral-900 border-neutral-700 focus-visible:ring-neutral-400 text-base md:text-lg h-14 px-6 py-4 placeholder:text-neutral-600"
      />
      {!loading && (
        <Button
          type="submit"
          aria-label="Analyze"
          title="Analyze"
          className="cursor-pointer shrink-0 h-14 w-14 p-0 flex items-center justify-center rounded-lg text-neutral-100 bg-neutral-800 hover:bg-neutral-700"
        >
          <Play size={24} />
        </Button>
      )}
      {loading && (
        <Button
          type="button"
          onClick={stopAnalysis}
          aria-label="Stop"
            title="Stop"
          variant="destructive"
          className="cursor-pointer shrink-0 h-14 w-14 p-0 flex items-center justify-center rounded-lg bg-red-600 hover:bg-red-500"
        >
          <Square size={26} />
        </Button>
      )}
      {!loading && (aborted || error) && (
        <Button
          type="button"
          onClick={() => analyze()}
          variant="secondary"
          aria-label="Retry"
          title="Retry"
          className="cursor-pointer shrink-0 h-14 px-6 text-base"
        >
          Retry
        </Button>
      )}
    </form>
  );

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-200 flex flex-col">
      <header className="p-6 flex flex-col gap-4 max-w-5xl w-full mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight">Prism</h1>
        {started && Form}
        {started && error && <p className="text-sm text-red-400">{error}</p>}
        {started && !!searchEvents.length && (
          <div className="flex flex-wrap gap-3">
            {searchEvents.slice(-12).map((s,i) => (
              <SearchCard key={i} agent={s.agent} query={s.query} done={s.done} />
            ))}
          </div>
        )}
      </header>
      <main className={`flex-1 flex flex-col gap-10 pb-16 ${!started ? 'items-center justify-center' : ''}`}>
        {!started && !loading && (
          <div className="flex flex-col items-center gap-6 w-full max-w-2xl px-6 text-center">
            {Form}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}
        {started && (
        <section className="relative select-none" style={{height: CARD_HEIGHT + 70}}>
          <div className="pointer-events-none absolute inset-0 z-20">
            <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent" style={{ width: '20%' }} />
            <div className="absolute inset-y-0 right-0 bg-gradient-to-l from-neutral-950 via-neutral-950/80 to-transparent" style={{ width: '20%' }} />
          </div>
          <div className="absolute inset-0 flex flex-col items-center">
            <div ref={containerRef} className="relative w-full h-full overflow-hidden px-4 touch-pan-y select-none">
              <div
                className="absolute top-1/2 left-0 -translate-y-1/2 flex gap-[40px] transition-transform duration-500 ease-out will-change-transform"
                style={{ transform: `translateX(${translate}px)`, transition: dragState.current.active ? 'none' : undefined }}
              >
                {visibleAgents.map((card, idx) => (
                  <div
                    key={card.id}
                    className={`shrink-0 transition-all duration-500 ${idx === active ? 'scale-100 opacity-100' : 'scale-90 opacity-50'} cursor-pointer`}
                    style={{ width: CARD_WIDTH }}
                    onClick={() => setActive(idx)}
                  >
                    {card.markdown ? <AnalysisCard agent={card} /> : (started && loading ? <SkeletonCard title={card.name} /> : null)}
                  </div>
                ))}
              </div>
            </div>
            {count > 1 && (
              <>
                <button
                  aria-label="previous"
                  onClick={() => setActive(a => (a - 1 + count) % count)}
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-30 h-10 w-10 rounded-full bg-neutral-800/70 hover:bg-neutral-700 text-neutral-200 backdrop-blur flex items-center justify-center"
                >‹</button>
                <button
                  aria-label="next"
                  onClick={() => setActive(a => (a + 1) % count)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-30 h-10 w-10 rounded-full bg-neutral-800/70 hover:bg-neutral-700 text-neutral-200 backdrop-blur flex items-center justify-center"
                >›</button>
              </>
            )}
            <div className="mt-4 flex gap-2">
              {visibleAgents.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={`h-2 w-6 rounded-full transition-colors ${i === active ? 'bg-neutral-300' : 'bg-neutral-600/40 hover:bg-neutral-500'}`}
                  aria-label={`go to slide ${i + 1}`}
                />
              ))}
            </div>
          </div>
        </section>
        )}
        {(summary || summaryStarted) && (
          <section ref={summaryRef} className="w-full px-6">
            <div className="max-w-5xl mx-auto">
              <Card className="bg-neutral-900 border-neutral-700 w-full">
                <CardHeader>
                  <CardTitle className="text-lg text-neutral-50">Synthesis Summary</CardTitle>
                </CardHeader>
                <CardContent className="prose prose-invert max-w-none text-sm leading-relaxed text-neutral-200 min-h-[140px]">
                  {summary ? <Markdown>{summary}</Markdown> : (
                    <div className="space-y-3 animate-pulse">
                      <div className="h-4 bg-neutral-800 rounded w-2/3" />
                      <div className="h-4 bg-neutral-800 rounded w-5/6" />
                      <div className="h-4 bg-neutral-800 rounded w-1/2" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// Skeleton removed (carousel hidden until start)

function AnalysisCard({ agent }: { agent: AgentResult }) {
  return (
    <Card
      className="w-[460px] h-[460px] shrink-0 snap-center bg-neutral-900 border-neutral-700 relative"
      style={{
        transformStyle: 'preserve-3d',
      }}
    >
      <CardHeader>
        <CardTitle className="text-base font-medium tracking-tight text-neutral-50">{agent.name}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-y-auto pr-2 text-sm leading-relaxed space-y-3 custom-scroll prose prose-invert max-w-none text-neutral-200">
  <Markdown>{agent.markdown}</Markdown>
      </CardContent>
    </Card>
  );
}

function SkeletonCard({ title }: { title: string }) {
  return (
    <Card className="w-[460px] h-[460px] shrink-0 snap-center bg-neutral-900/60 border border-neutral-800 animate-pulse flex flex-col">
      <CardHeader>
        <CardTitle className="text-base text-neutral-400">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-6 pb-6 text-sm">
        <div className="h-4 bg-neutral-800 rounded w-5/6" />
        <div className="h-4 bg-neutral-800 rounded w-4/6" />
        <div className="h-4 bg-neutral-800 rounded w-3/5" />
        <div className="h-4 bg-neutral-800 rounded w-2/5" />
        <div className="h-4 bg-neutral-800 rounded w-3/4" />
      </CardContent>
    </Card>
  );
}

function SearchCard({ agent, query, done }: { agent: string; query: string; done?: boolean }) {
  return (
    <div title={query} className={`rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm shadow-sm flex flex-col gap-1 w-fit max-w-xs`}> 
      <div className="flex items-center gap-2">
        <span className="text-neutral-400 text-xs uppercase tracking-wide">Search</span>
        <span className={`h-2 w-2 rounded-full ${done ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
      </div>
      <div className="font-medium text-neutral-200 truncate">{query}</div>
      <div className="text-xs text-neutral-500">agent: {agent}</div>
      {!done && <div className="text-xs text-neutral-500 italic">Searching…</div>}
      {done && <div className="text-xs text-neutral-500 italic">Done</div>}
    </div>
  );
}
