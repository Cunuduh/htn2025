"use client";
import { useState, useEffect, useRef } from 'react';
import { Play, Square } from 'lucide-react';
import { AGENT_SPECS } from '@/lib/agents';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Markdown } from '@/components/Markdown';

interface AgentResult { id: string; name: string; markdown: string }
interface TrustSummary { trustLevel: 'high' | 'medium' | 'low' | 'uncertain'; plainVerdict: string; mainConcerns: string[]; toVerify: string[]; notes?: string }

type ReadingLevel = 'standard' | 'simple';

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentResult[]>([]);
  const [summaryMarkdown, setSummaryMarkdown] = useState(''); // legacy fallback if text summary ever used
  const [summaryObject, setSummaryObject] = useState<TrustSummary | null>(null);
  const [searchEvents, setSearchEvents] = useState<{ agent: string; query: string; ts: number; done?: boolean }[]>([]);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [active, setActive] = useState(0);
  const visibleAgents = agents.length ? agents : AGENT_SPECS.map(a => ({ id: a.id, name: a.name, markdown: '' }));
  const count = visibleAgents.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const CARD_WIDTH = 460;
  const GAP = 40;
  const CARD_HEIGHT = 460;
  const [started, setStarted] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const dragState = useRef<{active:boolean; startX:number; lastX:number; moved:boolean}>({active:false,startX:0,lastX:0,moved:false});
  const wheelLockRef = useRef(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement | null>(null);
  const raysRef = useRef<SVGLineElement[]>([]);
  const originCircleRef = useRef<SVGCircleElement | null>(null);
  const RAINBOW = ['#ff4747','#ff8c1a','#ffd400','#25d366','#1fa8ff','#7b5bff','#ff4db8'];
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [summaryStarted, setSummaryStarted] = useState(false);
  const [summaryDone, setSummaryDone] = useState(false);
  const [autoScrollAgents, setAutoScrollAgents] = useState<Record<string, boolean>>({});
  const [readingLevel, setReadingLevel] = useState<ReadingLevel>('standard');

  function resetState() {
    setAgents([]);
    setSummaryMarkdown('');
    setSummaryObject(null);
    setSearchEvents([]);
    setAborted(false);
    setSummaryStarted(false);
    setSummaryDone(false);
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
        body: JSON.stringify({ url, readingLevel }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('Could not start analysis');
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
              setAutoScrollAgents(m => (m[evt.id] === undefined ? { ...m, [evt.id]: true } : m));
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
            case 'summaryChunk': { // legacy support
              setSummaryMarkdown(prev => {
                if (!summaryStarted) setSummaryStarted(true);
                return prev + evt.delta;
              });
              break;
            }
            case 'summaryObject': {
              setSummaryObject(evt.object as TrustSummary);
              setSummaryDone(true);
              break;
            }
            case 'summaryError': {
              setSummaryMarkdown(s => s + `\n\n**summary error:** ${evt.error}`);
              break;
            }
            case 'done': {
              setSummaryDone(true);
              break;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (!aborted) {
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

  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, count - 1)));
  }, [count]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') setActive(a => (a + 1) % count);
      else if (e.key === 'ArrowLeft') setActive(a => (a - 1 + count) % count);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count]);

  useEffect(() => {
    function measure() { setContainerWidth(containerRef.current?.offsetWidth || 0); }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!started) return;
    const frame = requestAnimationFrame(() => { setContainerWidth(containerRef.current?.offsetWidth || 0); });
    return () => cancelAnimationFrame(frame);
  }, [started]);

  useEffect(() => {
    // reserved for width recalcs
  }, [containerWidth]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    function onPointerDown(e: PointerEvent) { if (e.button !== 0) return; dragState.current.active = true; dragState.current.startX = e.clientX; dragState.current.lastX = e.clientX; dragState.current.moved = false; setDragOffset(0); (e.target as HTMLElement).setPointerCapture(e.pointerId); }
    function onPointerMove(e: PointerEvent) { if (!dragState.current.active) return; const dx = e.clientX - dragState.current.startX; if (Math.abs(dx) > 4) dragState.current.moved = true; dragState.current.lastX = e.clientX; setDragOffset(dx); }
    function onPointerUp(e: PointerEvent) { if (!dragState.current.active) return; dragState.current.active = false; const dx = e.clientX - dragState.current.startX; const step = CARD_WIDTH + GAP; const threshold = step * 0.25; let delta = 0; if (Math.abs(dx) > threshold) { delta = Math.round(dx / step * -1); } if (delta !== 0) { setActive(a => Math.min(count - 1, Math.max(0, a + delta))); } setDragOffset(0); }
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => { el.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); window.removeEventListener('pointercancel', onPointerUp); };
  }, [count]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    function onWheel(e: WheelEvent) { if (!count) return; const dominant = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (Math.abs(dominant) < 4) return; e.preventDefault(); const now = performance.now(); if (now < wheelLockRef.current) return; wheelLockRef.current = now + 120; if (dominant > 0) setActive(a => Math.min(count - 1, a + 1)); else if (dominant < 0) setActive(a => Math.max(0, a - 1)); }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [count]);

  const baseTranslate = containerWidth ? (containerWidth / 2) - (active * (CARD_WIDTH + GAP) + CARD_WIDTH / 2) : 0;
  const translate = baseTranslate + dragOffset;

  useEffect(() => { if (summaryDone && summaryRef.current) { summaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, [summaryDone]);

  useEffect(() => {
    if (!started) return; let running = true; const frame = () => { if (!running) return; const sectionEl = sectionRef.current; const inputEl = inputWrapperRef.current; if (sectionEl && inputEl) { const sectionRect = sectionEl.getBoundingClientRect(); const inputRect = inputEl.getBoundingClientRect(); const originX = inputRect.left + inputRect.width / 2 - sectionRect.left; const originY = inputRect.bottom - sectionRect.top; if (originCircleRef.current) { originCircleRef.current.setAttribute('cx', originX.toString()); originCircleRef.current.setAttribute('cy', originY.toString()); } const cards: NodeListOf<HTMLElement> = sectionEl.querySelectorAll('[data-card]'); cards.forEach((card, idx) => { const line = raysRef.current[idx]; if (!line) return; const rect = card.getBoundingClientRect(); const x2 = rect.left + rect.width / 2 - sectionRect.left; const targetTop = rect.top - 3; const y2 = targetTop - sectionRect.top; line.setAttribute('x1', originX.toString()); line.setAttribute('y1', originY.toString()); line.setAttribute('x2', x2.toString()); line.setAttribute('y2', y2.toString()); }); } requestAnimationFrame(frame); }; requestAnimationFrame(frame); return () => { running = false; }; }, [started, visibleAgents.length]);

  const Form = (
    <form onSubmit={analyze} className="flex gap-4 w-full items-stretch">
      <div ref={inputWrapperRef} className="relative w-full group">
        <div className="absolute -inset-[2px] rounded-xl bg-[linear-gradient(110deg,#ff4747,#ff8c1a,#ffd400,#25d366,#1fa8ff,#7b5bff,#ff4db8)] opacity-80 group-hover:opacity-100 transition shadow-[0_0_12px_-2px_rgba(255,255,255,0.4)]" />
        <div className="absolute -inset-[2px] rounded-xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),rgba(255,255,255,0)_70%)] mix-blend-screen" />
        <div className="absolute -inset-[10px] rounded-2xl bg-[linear-gradient(110deg,#ff4747,#ff8c1a,#ffd400,#25d366,#1fa8ff,#7b5bff,#ff4db8)] blur-xl opacity-30 group-hover:opacity-50 transition" />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a news article link to get a clear breakdown."
          className="relative bg-neutral-950/60 backdrop-blur border-white/95 focus-visible:ring-2 focus-visible:ring-white text-base md:text-lg h-14 px-6 py-4 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.35),0_0_12px_-2px_rgba(255,255,255,0.5)] rounded-xl text-neutral-100"
        />
      </div>
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

  const trustBadgeColors: Record<TrustSummary['trustLevel'], string> = {
    high: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40',
    medium: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
    low: 'bg-red-600/25 text-red-300 border-red-500/40',
    uncertain: 'bg-neutral-700/40 text-neutral-300 border-neutral-500/40'
  };

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-200 flex flex-col relative">
      <div className="pointer-events-none fixed inset-y-0 left-0 z-30" style={{ width: '20%' }}>
        <div className="w-full h-full bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent" />
      </div>
      <div className="pointer-events-none fixed inset-y-0 right-0 z-30" style={{ width: '20%' }}>
        <div className="w-full h-full bg-gradient-to-l from-neutral-950 via-neutral-950/80 to-transparent" />
      </div>
      <header className="p-6 flex flex-col gap-4 max-w-5xl w-full mx-auto">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Prism</h1>
          <div className="flex flex-wrap gap-3 items-center text-sm">
            <span className="text-neutral-400">Reading level:</span>
            <button type="button" onClick={() => setReadingLevel('standard')} className={`px-3 py-1 rounded-md border text-xs ${readingLevel==='standard' ? 'bg-neutral-800 border-neutral-600 text-neutral-100' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}>Standard</button>
            <button type="button" onClick={() => setReadingLevel('simple')} className={`px-3 py-1 rounded-md border text-xs ${readingLevel==='simple' ? 'bg-neutral-800 border-neutral-600 text-neutral-100' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}>Simple</button>
            <span className="text-xs text-neutral-500">Simple = everyday words & short sentences.</span>
          </div>
        </div>
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
          <div className="flex flex-col items-center gap-8 w-full max-w-2xl px-6 text-center">
            {Form}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}
        {started && (
        <section ref={sectionRef} className="relative select-none" style={{height: CARD_HEIGHT + 70}}>
          <div className="absolute inset-0 flex flex-col items-center">
            {started && (
              <svg className="pointer-events-none absolute inset-0 z-0 overflow-visible" width="100%" height="100%" preserveAspectRatio="none">
                <defs>
                  <filter id="glow" x="-150%" y="-200%" width="400%" height="500%">
                    <feGaussianBlur stdDeviation="10" result="blur1" />
                    <feGaussianBlur stdDeviation="22" in="blur1" result="blur2" />
                    <feMerge>
                      <feMergeNode in="blur2" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <radialGradient id="originPulse" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                    <stop offset="50%" stopColor="#ffffff" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <circle ref={originCircleRef} cx={0} cy={0} r={14} fill="url(#originPulse)" filter="url(#glow)" />
                {visibleAgents.map((_, i) => (
                  <line
                    key={i}
                    ref={el => { if (el) raysRef.current[i] = el; }}
                    x1={0} y1={0} x2={0} y2={0}
                    stroke={RAINBOW[i % RAINBOW.length]}
                    strokeWidth={9}
                    strokeOpacity={0.65}
                    strokeLinecap="round"
                    style={{ mixBlendMode: 'screen' }}
                    filter="url(#glow)"
                  />
                ))}
              </svg>
            )}
            <div ref={containerRef} className="relative w-full h-full overflow-hidden px-4 touch-pan-y select-none z-10">
              <div
                className="absolute top-1/2 left-0 -translate-y-1/2 flex gap-[40px] transition-transform duration-500 ease-out will-change-transform"
                style={{ transform: `translateX(${translate}px)`, transition: dragState.current.active ? 'none' : undefined }}
              >
                {visibleAgents.map((card, idx) => (
                  <div
                    key={card.id}
                    data-card
                    className={`shrink-0 transition-all duration-500 relative ${idx === active ? 'scale-100' : 'scale-90'} cursor-pointer`}
                    style={{ width: CARD_WIDTH }}
                    onClick={() => setActive(idx)}
                  >
                    {card.markdown ? (
                      <AnalysisCard
                        agent={card}
                        color={RAINBOW[idx % RAINBOW.length]}
                        active={idx === active}
                        autoScroll={autoScrollAgents[card.id] !== false}
                        onAutoScrollToggle={(enabled) => setAutoScrollAgents(m => ({ ...m, [card.id]: enabled }))}
                      />
                    ) : (started && loading ? <SkeletonCard title={card.name} color={RAINBOW[idx % RAINBOW.length]} /> : null)}
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
        {(summaryObject || summaryMarkdown || summaryStarted) && (
          <section ref={summaryRef} className="w-full px-6">
            <div className="max-w-5xl mx-auto">
              <Card className="bg-neutral-900 border-neutral-700 w-full">
                <CardHeader>
                  <CardTitle className="text-lg text-neutral-50 flex items-center gap-3">Verdict & Trust
                    {summaryObject && (
                      <span className={`text-xs font-medium px-2 py-1 rounded-full border ${trustBadgeColors[summaryObject.trustLevel]}`}>{summaryObject.trustLevel.toUpperCase()}</span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="prose prose-invert max-w-none text-sm leading-relaxed text-neutral-200 space-y-6">
                  {summaryObject ? (
                    <div className="space-y-5">
                      <div>
                        <p className="font-medium text-neutral-100">Plain Verdict:</p>
                        <p className="mt-1 text-neutral-200">{summaryObject.plainVerdict}</p>
                      </div>
                      {!!summaryObject.mainConcerns?.length && (
                        <div>
                          <p className="font-medium text-neutral-100">Main Concerns</p>
                          <ul className="list-disc ml-5 mt-2 space-y-1">{summaryObject.mainConcerns.map((c,i)=><li key={i}>{c}</li>)}</ul>
                        </div>
                      )}
                      {!!summaryObject.toVerify?.length && (
                        <div>
                          <p className="font-medium text-neutral-100">What to Double‑Check</p>
                          <ul className="list-disc ml-5 mt-2 space-y-1">{summaryObject.toVerify.map((c,i)=><li key={i}>{c}</li>)}</ul>
                        </div>
                      )}
                      {summaryObject.notes && (
                        <div>
                          <p className="font-medium text-neutral-100">Notes</p>
                          <Markdown>{summaryObject.notes}</Markdown>
                        </div>
                      )}
                      <div className="pt-2 border-t border-neutral-700 text-xs text-neutral-500">This assistive summary may be imperfect. Always compare with at least one other reputable source.</div>
                    </div>
                  ) : (
                    summaryMarkdown ? <Markdown>{summaryMarkdown}</Markdown> : (
                      <div className="space-y-3 animate-pulse">
                        <div className="h-4 bg-neutral-800 rounded w-2/3" />
                        <div className="h-4 bg-neutral-800 rounded w-5/6" />
                        <div className="h-4 bg-neutral-800 rounded w-1/2" />
                      </div>
                    )
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

function AnalysisCard({ agent, color, active, autoScroll, onAutoScrollToggle }: { agent: AgentResult; color?: string; active: boolean; autoScroll: boolean; onAutoScrollToggle: (enabled: boolean) => void }) {
  const base = color || '#7b5bff';
  const siteBg = '#0a0a0a';
  const background = active
    ? `radial-gradient(circle at 50% 0%, ${base}3f 0%, ${base}24 22%, ${base}10 40%, ${siteBg} 72%)`
    : siteBg;
  const borderColor = active ? base + '66' : '#262626';
  const headingClass = active ? 'text-neutral-50' : 'text-neutral-400';
  const dotShadow = active ? `0 0 6px ${base}` : `0 0 3px ${base}aa`;
  const bodyText = active ? 'text-neutral-200' : 'text-neutral-500';
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (!autoScroll) return; const el = scrollRef.current; if (!el) return; el.scrollTop = el.scrollHeight; }, [agent.markdown, autoScroll]);

  function handleScroll() { const el = scrollRef.current; if (!el) return; const threshold = 24; const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold; if (atBottom && !autoScroll) { onAutoScrollToggle(true); } else if (!atBottom && autoScroll) { onAutoScrollToggle(false); } }
  return (
    <Card
      className="w-[460px] h-[460px] shrink-0 snap-center border relative"
      style={{ background, borderColor, transformStyle: 'preserve-3d' }}
      data-active={active ? 'true' : 'false'}
    >
      <CardHeader>
        <CardTitle className={`text-base font-medium tracking-tight flex items-center gap-2 ${headingClass}`}>
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: base, boxShadow: dotShadow }} />
          {agent.name}
        </CardTitle>
      </CardHeader>
      <CardContent ref={scrollRef} onScroll={handleScroll} className={`overflow-y-auto pr-2 text-sm leading-relaxed space-y-3 custom-scroll prose prose-invert max-w-none ${bodyText}`}>
        <Markdown>{agent.markdown}</Markdown>
      </CardContent>
    </Card>
  );
}

function SkeletonCard({ title, color }: { title: string; color?: string }) {
  const base = color || '#7b5bff';
  const gradient = `radial-gradient(circle at 50% 0%, ${base}30 0%, ${base}1f 22%, #0a0a0a 70%)`;
  return (
    <Card className="w-[460px] h-[460px] shrink-0 snap-center border animate-pulse flex flex-col" style={{ background: gradient, borderColor: base + '55' }}>
      <CardHeader>
        <CardTitle className="text-base text-neutral-200/80 flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: base, boxShadow: `0 0 6px ${base}` }} />
          {title}
        </CardTitle>
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
