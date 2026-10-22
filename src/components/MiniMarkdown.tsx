'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * Tiny markdown renderer for agent replies.
 * Supports: **bold**, `code`, "- " bullet lists and hard line breaks.
 * Deliberately dependency-free — the reply format is fixed by the agent.
 */

/** Render inline markup inside a single line of text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded-md border border-slate-700/70 bg-slate-800/70 px-1.5 py-0.5 font-mono text-[12px] text-sky-300"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export default function MiniMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="my-1.5 space-y-1 pl-1">
        {bullets.map((bullet, i) => (
          <li key={`${key}-${i}`} className="flex gap-2 text-[13.5px] leading-relaxed text-slate-300">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-sky-400/80" />
            <span>{renderInline(bullet, `${key}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, index) => {
    const key = `l${index}`;
    if (line.trim().startsWith('- ')) {
      bullets.push(line.trim().slice(2));
      return;
    }
    flushBullets(key);
    if (line.trim() === '') return;
    blocks.push(
      <p key={key} className="my-1.5 text-[13.5px] leading-relaxed text-slate-300 first:mt-0 last:mb-0">
        {renderInline(line, key)}
      </p>,
    );
  });
  flushBullets('l-tail');

  return <div className="[&_p+p]:mt-0">{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
