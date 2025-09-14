'use client';
import { useState, useEffect, useRef } from 'react';
import { Play, Square } from 'lucide-react';
import { AGENT_SPECS } from '@/lib/agents';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Markdown } from '@/components/Markdown';

interface AgentResult {
    id: string;
    name: string;
    markdown: string;
}
interface TrustSummary {
    trustLevel: 'high' | 'medium' | 'low' | 'uncertain';
    plainVerdict: string;
    mainConcerns: string[];
    toVerify: string[];
    notes?: string;
}

type ReadingLevel = 'standard' | 'simple';

export default function Home() {
    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [agents, setAgents] = useState<AgentResult[]>([]);
    const [summaryMarkdown, setSummaryMarkdown] = useState('');
    const [summaryObject, setSummaryObject] = useState<TrustSummary | null>(null);
    const [searchEvents, setSearchEvents] = useState<
        {
            agent: string;
            query: string;
            ts: number;
            done?: boolean;
            sources?: {
                url: string;
                title: string;
                page_age?: string;
                encrypted_content?: string;
            }[];
        }[]
    >([]);
    const [aborted, setAborted] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const [active, setActive] = useState(0);
    const visibleAgents = agents.length
        ? agents
        : AGENT_SPECS.map((a) => ({ id: a.id, name: a.name, markdown: '' }));
    const count = visibleAgents.length;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const CARD_WIDTH = 460;
    const GAP = 40;
    const CARD_HEIGHT = 460;
    const [started, setStarted] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);
    const [dragOffset, setDragOffset] = useState(0);
    const dragState = useRef<{ active: boolean; startX: number; lastX: number; moved: boolean }>({
        active: false,
        startX: 0,
        lastX: 0,
        moved: false,
    });
    const wheelLockRef = useRef(0);
    const sectionRef = useRef<HTMLElement | null>(null);
    const inputWrapperRef = useRef<HTMLDivElement | null>(null);
    const raysRef = useRef<SVGLineElement[]>([]);
    const originCircleRef = useRef<SVGCircleElement | null>(null);
    const RAINBOW = ['#ff4747', '#ff8c1a', '#ffd400', '#25d366', '#1fa8ff', '#7b5bff', '#ff4db8'];
    const summaryRef = useRef<HTMLDivElement | null>(null);
    const [summaryStarted, setSummaryStarted] = useState(false);
    const [summaryDone, setSummaryDone] = useState(false);
    const [autoScrollAgents, setAutoScrollAgents] = useState<Record<string, boolean>>({});
    const [readingLevel, setReadingLevel] = useState<ReadingLevel>('standard');
    // track completion per agent
    const [doneAgents, setDoneAgents] = useState<Record<string, true>>({});
    const allAgentsDone = AGENT_SPECS.every((a) => doneAgents[a.id]);
    // summary visibility logic
    const showSummarySkeleton =
        !aborted && !summaryObject && !summaryMarkdown && !summaryStarted && allAgentsDone;
    const showSummarySection =
        !aborted && (summaryObject || summaryMarkdown || summaryStarted || allAgentsDone);

    function resetState() {
        setAgents([]);
        setSummaryMarkdown('');
        setSummaryObject(null);
        setSearchEvents([]);
        setAborted(false);
        setSummaryStarted(false);
        setSummaryDone(false);
        setDoneAgents({});
    }

    async function analyze(e?: React.FormEvent) {
        e?.preventDefault();
        resetState();
        setError(null);
        setLoading(true);
        const controller = new AbortController();
        setStarted(true);
        abortRef.current = controller;
        // local map for incremental ui updates
        const agentMap: Record<string, AgentResult> = {};
        const commitAgents = () => setAgents(Object.values(agentMap));
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
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop() || '';
                for (const chunk of parts) {
                    if (!chunk.startsWith('data:')) continue;
                    const json = chunk.replace(/^data:\s*/, '');
                    let evt: any;
                    try {
                        evt = JSON.parse(json);
                    } catch {
                        continue;
                    }
                    switch (evt.type) {
                        case 'agentStart': {
                            agentMap[evt.id] = {
                                id: evt.id,
                                name: AGENT_SPECS.find((a) => a.id === evt.id)?.name || evt.id,
                                markdown: '',
                            };
                            commitAgents();
                            break;
                        }
                        case 'agentChunk': {
                            if (!agentMap[evt.id])
                                agentMap[evt.id] = { id: evt.id, name: evt.id, markdown: '' };
                            agentMap[evt.id].markdown += evt.delta;
                            setAutoScrollAgents((m) =>
                                m[evt.id] === undefined ? { ...m, [evt.id]: true } : m,
                            );
                            commitAgents();
                            break;
                        }
                        case 'agentError': {
                            if (!agentMap[evt.id])
                                agentMap[evt.id] = { id: evt.id, name: evt.id, markdown: '' };
                            agentMap[evt.id].markdown += `\n\n**error:** ${evt.error}`;
                            commitAgents();
                            break;
                        }
                        case 'searchStart': {
                            setSearchEvents((s) => [
                                ...s,
                                { agent: evt.agent, query: evt.query, ts: Date.now() },
                            ]);
                            break;
                        }
                        case 'searchResult': {
                            // Attach sources to matching (agent,query) entry (most recent without sources yet)
                            setSearchEvents((s) => {
                                const copy = [...s];
                                for (let i = copy.length - 1; i >= 0; i--) {
                                    const ev = copy[i];
                                    if (
                                        ev.agent === evt.agent &&
                                        ev.query === evt.query &&
                                        !ev.sources
                                    ) {
                                        copy[i] = { ...ev, sources: evt.sources, done: true };
                                        break;
                                    }
                                }
                                // Fallback: if no existing start event (edge case), push one complete.
                                if (
                                    !copy.some(
                                        (ev) => ev.agent === evt.agent && ev.query === evt.query,
                                    )
                                ) {
                                    copy.push({
                                        agent: evt.agent,
                                        query: evt.query,
                                        ts: Date.now(),
                                        done: true,
                                        sources: evt.sources,
                                    });
                                }
                                return copy;
                            });
                            break;
                        }
                        case 'agentDone': {
                            if (agentMap[evt.id] && !agentMap[evt.id].markdown.trim()) {
                                // ensure placeholder
                                agentMap[evt.id].markdown =
                                    '**No response** – agent finished with no output.';
                                commitAgents();
                            }
                            setSearchEvents((s) =>
                                s.map((ev) => (ev.agent === evt.id ? { ...ev, done: true } : ev)),
                            );
                            setDoneAgents((m) => ({ ...m, [evt.id]: true }));
                            break;
                        }
                        case 'summaryChunk': {
                            // legacy support
                            setSummaryMarkdown((prev) => {
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
                            setSummaryMarkdown((s) => s + `\n\n**summary error:** ${evt.error}`);
                            break;
                        }
                        case 'done': {
                            if (evt.aborted) {
                                // server signalled early abort
                                setAborted(true);
                            }
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
            // ensure placeholders for all agents
            for (const spec of AGENT_SPECS) {
                if (!agentMap[spec.id]) {
                    agentMap[spec.id] = {
                        id: spec.id,
                        name: spec.name,
                        markdown: aborted
                            ? '**No response** – analysis aborted before agent started.'
                            : '**No response** – agent did not start.',
                    };
                } else if (!agentMap[spec.id].markdown.trim()) {
                    agentMap[spec.id].markdown = aborted
                        ? '**No response** – analysis aborted before agent replied.'
                        : '**No response** – agent failed or was rate limited.';
                }
                setDoneAgents((m) => ({ ...m, [spec.id]: true }));
            }
            setAgents(Object.values(agentMap));
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
        setActive((a) => Math.min(a, Math.max(0, count - 1)));
    }, [count]);

    useEffect(() => {
        function handler(e: KeyboardEvent) {
            if (e.key === 'ArrowRight') setActive((a) => (a + 1) % count);
            else if (e.key === 'ArrowLeft') setActive((a) => (a - 1 + count) % count);
        }
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [count]);

    useEffect(() => {
        function measure() {
            setContainerWidth(containerRef.current?.offsetWidth || 0);
        }
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    useEffect(() => {
        if (!started) return;
        const frame = requestAnimationFrame(() => {
            setContainerWidth(containerRef.current?.offsetWidth || 0);
        });
        return () => cancelAnimationFrame(frame);
    }, [started]);

    useEffect(() => {
        /* width recalcs */
    }, [containerWidth]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        function onPointerDown(e: PointerEvent) {
            if (e.button !== 0) return;
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
            const step = CARD_WIDTH + GAP;
            const threshold = step * 0.25;
            let delta = 0;
            if (Math.abs(dx) > threshold) {
                delta = Math.round((dx / step) * -1);
            }
            if (delta !== 0) {
                setActive((a) => Math.min(count - 1, Math.max(0, a + delta)));
            }
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

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        function onWheel(e: WheelEvent) {
            if (!count) return;
            // Only treat as carousel navigation if horizontal intent is clear.
            const absX = Math.abs(e.deltaX);
            const absY = Math.abs(e.deltaY);
            // Require horizontal to dominate by a factor; ignore mostly vertical scroll (trackpad swipes).
            if (absX < 4 || absX < absY * 1.2) return; // horizontal must be at least ~20% greater than vertical
            e.preventDefault();
            const now = performance.now();
            if (now < wheelLockRef.current) return;
            wheelLockRef.current = now + 140; // slight increase for smoother feel
            if (e.deltaX > 0) setActive((a) => Math.min(count - 1, a + 1));
            else if (e.deltaX < 0) setActive((a) => Math.max(0, a - 1));
        }
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [count]);

    const baseTranslate = containerWidth
        ? containerWidth / 2 - (active * (CARD_WIDTH + GAP) + CARD_WIDTH / 2)
        : 0;
    const translate = baseTranslate + dragOffset;

    useEffect(() => {
        if (summaryDone && summaryRef.current)
            summaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [summaryDone]);

    useEffect(() => {
        if (!started) return;
        let running = true;
        const frame = () => {
            if (!running) return;
            const sectionEl = sectionRef.current;
            const inputEl = inputWrapperRef.current;
            if (sectionEl && inputEl) {
                const sectionRect = sectionEl.getBoundingClientRect();
                const inputRect = inputEl.getBoundingClientRect();
                const originX = inputRect.left + inputRect.width / 2 - sectionRect.left;
                const originY = inputRect.bottom - sectionRect.top;
                if (originCircleRef.current) {
                    originCircleRef.current.setAttribute('cx', originX.toString());
                    originCircleRef.current.setAttribute('cy', originY.toString());
                }
                const cards: NodeListOf<HTMLElement> = sectionEl.querySelectorAll('[data-card]');
                cards.forEach((card, idx) => {
                    const line = raysRef.current[idx];
                    if (!line) return;
                    const rect = card.getBoundingClientRect();
                    const x2 = rect.left + rect.width / 2 - sectionRect.left;
                    const targetTop = rect.top - 3;
                    const y2 = targetTop - sectionRect.top;
                    line.setAttribute('x1', originX.toString());
                    line.setAttribute('y1', originY.toString());
                    line.setAttribute('x2', x2.toString());
                    line.setAttribute('y2', y2.toString());
                });
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        return () => {
            running = false;
        };
    }, [started, visibleAgents.length]);

    const Form = (
        <form onSubmit={analyze} className="flex w-full items-stretch gap-4">
            <div ref={inputWrapperRef} className="group relative w-full">
                <div className="absolute -inset-[2px] rounded-xl bg-[linear-gradient(110deg,#ff4747,#ff8c1a,#ffd400,#25d366,#1fa8ff,#7b5bff,#ff4db8)] opacity-80 shadow-[0_0_12px_-2px_rgba(255,255,255,0.4)] transition group-hover:opacity-100" />
                <div className="absolute -inset-[2px] rounded-xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),rgba(255,255,255,0)_70%)] mix-blend-screen" />
                <div className="absolute -inset-[10px] rounded-2xl bg-[linear-gradient(110deg,#ff4747,#ff8c1a,#ffd400,#25d366,#1fa8ff,#7b5bff,#ff4db8)] opacity-30 blur-xl transition group-hover:opacity-50" />
                <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="Paste a news article link to get a clear breakdown."
                    className="relative h-14 rounded-xl border-white/95 bg-neutral-950/60 px-6 py-4 text-base text-neutral-100 shadow-[0_0_0_1px_rgba(255,255,255,0.35),0_0_12px_-2px_rgba(255,255,255,0.5)] backdrop-blur placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-white md:text-lg"
                />
            </div>
            {!loading && (
                <Button
                    type="submit"
                    aria-label="Analyze"
                    title="Analyze"
                    className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-neutral-800 p-0 text-neutral-100 hover:bg-neutral-700"
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
                    className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-red-600 p-0 hover:bg-red-500"
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
                    className="h-14 shrink-0 cursor-pointer px-6 text-base"
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
        uncertain: 'bg-neutral-700/40 text-neutral-300 border-neutral-500/40',
    };

    return (
        <div className="relative flex min-h-screen w-full flex-col bg-neutral-950 text-neutral-200">
            <div
                className="pointer-events-none fixed inset-y-0 left-0 z-30"
                style={{ width: '20%' }}
            >
                <div className="h-full w-full bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent" />
            </div>
            <div
                className="pointer-events-none fixed inset-y-0 right-0 z-30"
                style={{ width: '20%' }}
            >
                <div className="h-full w-full bg-gradient-to-l from-neutral-950 via-neutral-950/80 to-transparent" />
            </div>
            {/* Unified heading + controls cluster */}
            <div
                className={`pointer-events-auto relative mx-auto flex w-full max-w-5xl flex-col items-stretch px-6 transition-[padding,margin,transform,width] duration-700 ease-out gap-3 pb-2 ${started ? 'mt-4' : 'mt-20'}`}
            >
                <div
                    className={`flex flex-col transition-all duration-700 ${started ? 'items-start gap-2' : 'items-center gap-4'}`}
                >
                    <h1
                        className={`font-semibold tracking-tight transition-all duration-700 ${started ? 'text-2xl bg-none text-neutral-50 text-left' : 'text-5xl md:text-6xl text-center bg-gradient-to-r from-neutral-50 via-neutral-200 to-neutral-400 bg-clip-text text-transparent'}`}
                    >
                        Prism
                    </h1>
                    <div
                        className={`flex flex-wrap items-center transition-all duration-700 self-start text-sm`}
                    >
                        <span className="mr-2 text-neutral-400">Reading level:</span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setReadingLevel('standard')}
                                className={`rounded-md border px-3 py-1 text-xs transition-colors ${readingLevel === 'standard' ? 'border-neutral-600 bg-neutral-800 text-neutral-100' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
                            >
                                Standard
                            </button>
                            <button
                                type="button"
                                onClick={() => setReadingLevel('simple')}
                                className={`rounded-md border px-3 py-1 text-xs transition-colors ${readingLevel === 'simple' ? 'border-neutral-600 bg-neutral-800 text-neutral-100' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
                            >
                                Simple
                            </button>
                        </div>
                    </div>
                </div>
                <div className={`transition-all duration-700 ${started ? '' : ''}`}>{Form}</div>
                {error && <p className={`text-sm text-red-400 ${started ? '' : 'text-center'}`}>{error}</p>}
            </div>
            <main
                className={`flex flex-1 flex-col gap-10 pb-16 transition-all duration-700 ${started ? 'pt-4' : 'items-center justify-center pt-0'}`}
            >
                {!started && !loading && (
                    <div className="flex w-full flex-col items-center gap-4 px-6 text-center">
                        <p className="max-w-xl text-balance text-sm text-neutral-400 md:text-base">
                            Paste a news article link and we will run multiple agents to cross‑check
                            claims and produce a trust & concern summary.
                        </p>
                    </div>
                )}
                {started && (
                    <section
                        ref={sectionRef}
                        className="relative select-none"
                        style={{ height: CARD_HEIGHT + 70 }}
                    >
                        <div className="absolute inset-0 flex flex-col items-center">
                            {started && (
                                <svg
                                    className="pointer-events-none absolute inset-0 z-0 overflow-visible"
                                    width="100%"
                                    height="100%"
                                    preserveAspectRatio="none"
                                >
                                    <defs>
                                        <filter
                                            id="glow"
                                            x="-150%"
                                            y="-200%"
                                            width="400%"
                                            height="500%"
                                        >
                                            <feGaussianBlur stdDeviation="10" result="blur1" />
                                            <feGaussianBlur
                                                stdDeviation="22"
                                                in="blur1"
                                                result="blur2"
                                            />
                                            <feMerge>
                                                <feMergeNode in="blur2" />
                                                <feMergeNode in="SourceGraphic" />
                                            </feMerge>
                                        </filter>
                                        <radialGradient id="originPulse" cx="50%" cy="50%" r="50%">
                                            <stop
                                                offset="0%"
                                                stopColor="#ffffff"
                                                stopOpacity="0.95"
                                            />
                                            <stop
                                                offset="50%"
                                                stopColor="#ffffff"
                                                stopOpacity="0.55"
                                            />
                                            <stop
                                                offset="100%"
                                                stopColor="#ffffff"
                                                stopOpacity="0"
                                            />
                                        </radialGradient>
                                    </defs>
                                    <circle
                                        ref={originCircleRef}
                                        cx={0}
                                        cy={0}
                                        r={14}
                                        fill="url(#originPulse)"
                                        filter="url(#glow)"
                                    />
                                    {visibleAgents.map((_, i) => (
                                        <line
                                            key={i}
                                            ref={(el) => {
                                                if (el) raysRef.current[i] = el;
                                            }}
                                            x1={0}
                                            y1={0}
                                            x2={0}
                                            y2={0}
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
                            <div
                                ref={containerRef}
                                className="relative z-10 h-full w-full touch-pan-y overflow-hidden px-4 select-none"
                            >
                                <div
                                    className="absolute top-1/2 left-0 flex -translate-y-1/2 gap-[40px] transition-transform duration-500 ease-out will-change-transform"
                                    style={{
                                        transform: `translateX(${translate}px)`,
                                        transition: dragState.current.active ? 'none' : undefined,
                                    }}
                                >
                                    {visibleAgents.map((card, idx) => {
                                        const agentSearches = searchEvents.filter(
                                            (se) => se.agent === card.id,
                                        );
                                        const done = !!doneAgents[card.id];
                                        const startedAgent = agents.some(a => a.id === card.id); // may also be placeholder from visibleAgents
                                        return (
                                            <div
                                                key={card.id}
                                                data-card
                                                className={`relative shrink-0 transition-all duration-500 ${idx === active ? 'scale-100' : 'scale-90'} cursor-pointer`}
                                                style={{ width: CARD_WIDTH }}
                                                onClick={() => setActive(idx)}
                                            >
                                                <AnalysisCard
                                                    agent={card}
                                                    color={RAINBOW[idx % RAINBOW.length]}
                                                    active={idx === active}
                                                    autoScroll={autoScrollAgents[card.id] !== false}
                                                    onAutoScrollToggle={(enabled) =>
                                                        setAutoScrollAgents((m) => ({
                                                            ...m,
                                                            [card.id]: enabled,
                                                        }))
                                                    }
                                                    searches={agentSearches}
                                                    done={done}
                                                    started={startedAgent}
                                                    aborted={aborted}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                            {count > 1 && (
                                <>
                                    <button
                                        aria-label="previous"
                                        onClick={() => setActive((a) => (a - 1 + count) % count)}
                                        className="absolute top-1/2 left-4 z-30 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-800/70 text-neutral-200 backdrop-blur hover:bg-neutral-700"
                                    >
                                        ‹
                                    </button>
                                    <button
                                        aria-label="next"
                                        onClick={() => setActive((a) => (a + 1) % count)}
                                        className="absolute top-1/2 right-4 z-30 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-800/70 text-neutral-200 backdrop-blur hover:bg-neutral-700"
                                    >
                                        ›
                                    </button>
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
                {showSummarySection && (
                    <section ref={summaryRef} className="w-full px-6">
                        <div className="mx-auto max-w-5xl">
                            <Card className="relative w-full overflow-hidden border-neutral-700 bg-neutral-900">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-3 text-lg text-neutral-50">
                                        Verdict & Trust
                                        {summaryObject && (
                                            <span
                                                className={`rounded-full border px-2 py-1 text-xs font-medium ${trustBadgeColors[summaryObject.trustLevel]}`}
                                            >
                                                {summaryObject.trustLevel.toUpperCase()}
                                            </span>
                                        )}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="prose prose-invert max-w-none space-y-6 text-sm leading-relaxed text-neutral-200">
                                    {summaryObject ? (
                                        <div className="space-y-5">
                                            <div>
                                                <p className="font-medium text-neutral-100">
                                                    Plain Verdict:
                                                </p>
                                                <p className="mt-1 text-neutral-200">
                                                    {summaryObject.plainVerdict}
                                                </p>
                                            </div>
                                            {!!summaryObject.mainConcerns?.length && (
                                                <div>
                                                    <p className="font-medium text-neutral-100">
                                                        Main Concerns
                                                    </p>
                                                    <ul className="mt-2 ml-5 list-disc space-y-1">
                                                        {summaryObject.mainConcerns.map((c, i) => (
                                                            <li key={i}>{c}</li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                            {!!summaryObject.toVerify?.length && (
                                                <div>
                                                    <p className="font-medium text-neutral-100">
                                                        What to Double‑Check
                                                    </p>
                                                    <ul className="mt-2 ml-5 list-disc space-y-1">
                                                        {summaryObject.toVerify.map((c, i) => (
                                                            <li key={i}>{c}</li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                            {summaryObject.notes && (
                                                <div>
                                                    <p className="font-medium text-neutral-100">
                                                        Notes
                                                    </p>
                                                    <Markdown>{summaryObject.notes}</Markdown>
                                                </div>
                                            )}
                                            <div className="border-t border-neutral-700 pt-2 text-xs text-neutral-500">
                                                This assistive summary may be imperfect. Always
                                                compare with at least one other reputable source.
                                            </div>
                                        </div>
                                    ) : summaryMarkdown ? (
                                        <Markdown>{summaryMarkdown}</Markdown>
                                    ) : showSummarySkeleton ? (
                                        // summary skeleton
                                        <div className="relative flex h-[600px] w-full flex-col gap-10 overflow-hidden">
                                            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_25%_15%,rgba(255,255,255,0.07),transparent_70%)]" />
                                            <div className="space-y-6 pt-4">
                                                <div className="space-y-4">
                                                    <div className="shimmer-block h-8 w-3/5" />
                                                    <div className="shimmer-line h-5 w-2/5" />
                                                </div>
                                                <div className="space-y-3">
                                                    {Array.from({ length: 14 }).map((_, i) => (
                                                        <div
                                                            key={i}
                                                            className="shimmer-line h-4"
                                                            style={{
                                                                width: `${92 - (i % 5) * 8}%`,
                                                            }}
                                                        />
                                                    ))}
                                                </div>
                                                <div className="mt-4 space-y-5">
                                                    <div className="shimmer-block h-5 w-48" />
                                                    <ul className="space-y-3">
                                                        {Array.from({ length: 8 }).map((_, i) => (
                                                            <li
                                                                key={i}
                                                                className="flex items-start gap-3"
                                                            >
                                                                <span className="shimmer-dot mt-1 h-3 w-3 rounded-full" />
                                                                <span
                                                                    className="shimmer-line h-4 flex-1 rounded"
                                                                    style={{
                                                                        width: `${88 - ((i * 6) % 40)}%`,
                                                                    }}
                                                                />
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                                <div className="mt-6 space-y-5">
                                                    <div className="shimmer-block h-5 w-56" />
                                                    <div className="space-y-3">
                                                        {Array.from({ length: 10 }).map((_, i) => (
                                                            <div
                                                                key={i}
                                                                className="shimmer-line h-4"
                                                                style={{
                                                                    width: `${96 - ((i * 5) % 50)}%`,
                                                                }}
                                                            />
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="mt-8 space-y-4">
                                                    <div className="shimmer-block h-5 w-40" />
                                                    <ul className="space-y-3">
                                                        {Array.from({ length: 6 }).map((_, i) => (
                                                            <li
                                                                key={i}
                                                                className="flex items-start gap-3"
                                                            >
                                                                <span className="shimmer-dot mt-1 h-3 w-3 rounded-full" />
                                                                <span
                                                                    className="shimmer-line h-4 flex-1 rounded"
                                                                    style={{
                                                                        width: `${90 - ((i * 7) % 35)}%`,
                                                                    }}
                                                                />
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="animate-pulse space-y-3">
                                            <div className="h-4 w-2/3 rounded bg-neutral-800" />
                                            <div className="h-4 w-5/6 rounded bg-neutral-800" />
                                            <div className="h-4 w-1/2 rounded bg-neutral-800" />
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

function AnalysisCard({
    agent,
    color,
    active,
    autoScroll,
    onAutoScrollToggle,
    searches,
    done,
    started,
    aborted,
}: {
    agent: AgentResult;
    color?: string;
    active: boolean;
    autoScroll: boolean;
    onAutoScrollToggle: (enabled: boolean) => void;
    searches: {
        agent: string;
        query: string;
        ts: number;
        done?: boolean;
        sources?: { url: string; title: string; page_age?: string; encrypted_content?: string }[];
    }[];
    done: boolean;
    started: boolean;
    aborted: boolean;
}) {
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

    useEffect(() => {
        if (!autoScroll) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [agent.markdown, searches.length, autoScroll]);

    function handleScroll() {
        const el = scrollRef.current;
        if (!el) return;
        const threshold = 24;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
        if (atBottom && !autoScroll) {
            onAutoScrollToggle(true);
        } else if (!atBottom && autoScroll) {
            onAutoScrollToggle(false);
        }
    }
    return (
        <Card
            className="relative h-[460px] w-[460px] shrink-0 snap-center border"
            style={{ background, borderColor, transformStyle: 'preserve-3d' }}
            data-active={active ? 'true' : 'false'}
        >
            <CardHeader>
                <CardTitle
                    className={`flex items-center gap-2 text-base font-medium tracking-tight ${headingClass}`}
                >
                    <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ background: base, boxShadow: dotShadow }}
                    />
                    {agent.name}
                </CardTitle>
            </CardHeader>
            <CardContent
                ref={scrollRef}
                onScroll={handleScroll}
                className={`custom-scroll prose prose-invert max-w-none space-y-3 overflow-y-auto pr-2 text-sm leading-relaxed ${bodyText}`}
            >
                {!!searches.length && (
                    <div className="space-y-3">
                        <div className="text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
                            Searches
                        </div>
                        <ul className="space-y-3">
                            {searches.map((s, i) => (
                                <li
                                    key={s.ts + '-' + i}
                                    className="space-y-1 text-xs text-neutral-300"
                                >
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`inline-block h-2 w-2 rounded-full ${s.done ? 'bg-emerald-500' : 'animate-pulse bg-amber-500'}`}
                                        />
                                        <span className="truncate font-medium" title={s.query}>
                                            {s.query}
                                        </span>
                                    </div>
                                    {!!s.sources?.length && (
                                        <ul className="mt-1 list-none space-y-1 pl-4">
                                            {s.sources.map((src, j) => (
                                                <li key={j} className="flex flex-col gap-0.5">
                                                    <a
                                                        href={src.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="truncate text-[11px] text-neutral-200 hover:underline"
                                                        title={src.title || src.url}
                                                    >
                                                        {src.title || src.url}
                                                    </a>
                                                    <div className="flex flex-wrap gap-2 text-[10px] text-neutral-500">
                                                        {src.page_age && (
                                                            <span>{src.page_age}</span>
                                                        )}
                                                        {src.encrypted_content && (
                                                            <span className="italic opacity-70">
                                                                enc
                                                            </span>
                                                        )}
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            ))}
                        </ul>
                        <div className="border-t border-neutral-700/50 pt-2" />
                    </div>
                )}
                {(!agent.markdown || !agent.markdown.trim()) && !done && !aborted ? (
                    <div className="relative space-y-3 pb-2">
                        <div className="shimmer-line h-4 w-5/6" />
                        <div className="shimmer-line h-4 w-4/6" />
                        <div className="shimmer-line h-4 w-3/5" />
                        <div className="pt-1 space-y-2">
                            <div className="shimmer-block h-5 w-2/5" />
                            <div className="shimmer-line h-4 w-11/12" />
                            <div className="shimmer-line h-4 w-10/12" />
                        </div>
                        <div className="pt-2 space-y-2">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="flex items-start gap-3">
                                    <span className="shimmer-dot mt-0.5 h-3 w-3 rounded-full" />
                                    <span
                                        className="shimmer-line h-4 rounded flex-1"
                                        style={{ width: `${92 - (i % 5) * 10}%` }}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <Markdown>{agent.markdown}</Markdown>
                )}
            </CardContent>
        </Card>
    );
}

/* SkeletonCard no longer used (cards always visible) */
function SkeletonCard({ title, color }: { title: string; color?: string }) {
    const base = color || '#7b5bff';
    const gradient = `radial-gradient(circle at 50% 0%, ${base}30 0%, ${base}1f 22%, #0a0a0a 70%)`;
    return (
        <Card
            className="flex h-[460px] w-[460px] shrink-0 animate-pulse snap-center flex-col border"
            style={{ background: gradient, borderColor: base + '55' }}
        >
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-neutral-200/80">
                    <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ background: base, boxShadow: `0 0 6px ${base}` }}
                    />
                    {title}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 px-6 pb-6 text-sm">
                <div className="h-4 w-5/6 rounded bg-neutral-800" />
                <div className="h-4 w-4/6 rounded bg-neutral-800" />
                <div className="h-4 w-3/5 rounded bg-neutral-800" />
                <div className="h-4 w-2/5 rounded bg-neutral-800" />
                <div className="h-4 w-3/4 rounded bg-neutral-800" />
            </CardContent>
        </Card>
    );
}

function SearchCard({ agent, query, done }: { agent: string; query: string; done?: boolean }) {
    return (
        <div
            title={query}
            className={`flex w-fit max-w-xs flex-col gap-1 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm shadow-sm`}
        >
            <div className="flex items-center gap-2">
                <span className="text-xs tracking-wide text-neutral-400 uppercase">Search</span>
                <span className="text-[10px] text-neutral-500">{done ? 'done' : '…'}</span>
            </div>
            <div className="truncate font-medium text-neutral-200">{query}</div>
            <div className="text-xs text-neutral-500">agent: {agent}</div>
            {!done && <div className="text-xs text-neutral-500 italic">Searching…</div>}
            {done && <div className="text-xs text-neutral-600 italic">Completed</div>}
        </div>
    );
}
