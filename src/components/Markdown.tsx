'use client';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// @ts-ignore no types packaged
import remarkBreaks from 'remark-breaks';

interface MarkdownProps {
    children: string;
    className?: string;
}

// Centralized markdown renderer with consistent styling + GFM + soft-breaks.
export function Markdown({ children, className = '' }: MarkdownProps) {
    return (
        <div className={'markdown prose prose-invert max-w-none ' + className}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                    ul: ({ node, ...props }) => (
                        <ul className="my-3 ml-5 list-disc space-y-1" {...props} />
                    ),
                    ol: ({ node, ...props }) => (
                        <ol className="my-3 ml-5 list-decimal space-y-1" {...props} />
                    ),
                    li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
                    p: ({ node, ...props }) => <p className="my-3 leading-relaxed" {...props} />,
                    table: ({ node, ...props }) => (
                        <div className="my-4 overflow-x-auto">
                            <table className="w-full border-collapse text-sm" {...props} />
                        </div>
                    ),
                    thead: ({ node, ...props }) => <thead className="bg-neutral-800" {...props} />,
                    th: ({ node, ...props }) => (
                        <th
                            className="border border-neutral-700 px-2 py-1 text-left font-medium"
                            {...props}
                        />
                    ),
                    td: ({ node, ...props }) => (
                        <td className="border border-neutral-800 px-2 py-1 align-top" {...props} />
                    ),
                    code: ({ node, className, children, ...props }) => (
                        <code
                            className={
                                'rounded bg-neutral-800/70 px-1.5 py-0.5 text-[0.8rem] ' +
                                (className || '')
                            }
                            {...props}
                        >
                            {children}
                        </code>
                    ),
                    pre: ({ node, ...props }) => (
                        <pre
                            className="my-4 overflow-x-auto rounded-md bg-neutral-900/70 p-3 text-sm"
                            {...props}
                        />
                    ),
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}
