import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import CollapsibleText from './CollapsibleText';

// jsdom reports 0 for both scrollHeight and clientHeight, so nothing measures as
// overflowing unless we force it.
const forceOverflow = () =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

afterEach(() => vi.restoreAllMocks());

describe('CollapsibleText', () => {
  it('clamps overflowing text and toggles the clamp on expand', () => {
    forceOverflow();
    render(<CollapsibleText id="t1" text={'long '.repeat(500)} />);

    const p = document.getElementById('t1');
    expect(p).toHaveClass('line-clamp-2');

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(p).not.toHaveClass('line-clamp-2');
    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('renders no toggle when the text fits', () => {
    render(<CollapsibleText id="t2" text="short" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.getElementById('t2')).toHaveClass('line-clamp-2');
  });

  it('keeps the toggle visible while expanded even though the clamp is gone', () => {
    // Removing the clamp collapses scrollHeight to fit, so a re-measure on the
    // expanded path would hide the toggle mid-expand and strand the user with no
    // way back. The effect early-returns while expanded to prevent that.
    const spy = forceOverflow();
    render(<CollapsibleText id="t3" text={'long '.repeat(500)} />);

    spy.mockReturnValue(0);
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));

    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('keeps the toggle when a resize fires against the unclamped element', () => {
    // Expanding IS a resize of the observed <p>, and the observer is still
    // connected at that moment (disconnect runs in passive-effect cleanup, which
    // the scheduler may flush after the browser delivers the notification). A
    // callback that lands then measures an unclamped element, sees no overflow,
    // and — without the `|| expanded` render guard — would drop the toggle,
    // stranding the user in the expanded wall of text with no way back.
    let fire;
    const observers = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { fire = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    });
    const spy = forceOverflow();
    render(<CollapsibleText id="t7" text={'long '.repeat(500)} />);

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    // The clamp is gone, so a late measurement reports no overflow.
    spy.mockReturnValue(0);
    act(() => fire());

    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('drops a stale toggle when the text shrinks below the clamp', () => {
    const spy = forceOverflow();
    const { rerender } = render(<CollapsibleText id="t6" text={'long '.repeat(500)} />);
    expect(screen.getByRole('button', { name: /Show more/ })).toBeInTheDocument();

    spy.mockReturnValue(0);
    rerender(<CollapsibleText id="t6" text="now short" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wires the toggle to the text it controls', () => {
    forceOverflow();
    render(<CollapsibleText id="t4" text={'long '.repeat(500)} />);

    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-controls', 't4');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('forwards a caller className alongside the clamp', () => {
    render(<CollapsibleText id="t5" text="hi" className="text-sm text-gray-500 mt-1" />);
    const p = document.getElementById('t5');
    expect(p).toHaveClass('text-sm', 'text-gray-500', 'mt-1', 'line-clamp-2');
  });

  it('clamps at the requested depth', () => {
    render(<CollapsibleText id="t8" text="hi" lines={3} />);
    expect(document.getElementById('t8')).toHaveClass('line-clamp-3');
  });

  it('falls back to the 2-line clamp for an unsupported depth', () => {
    // Tailwind only emits the literal class names in CLAMP_CLASS, so an
    // out-of-range value must degrade to a real clamp rather than to none —
    // an unclamped "preview" is the exact bug this component exists to prevent.
    render(<CollapsibleText id="t9" text="hi" lines={99} />);
    expect(document.getElementById('t9')).toHaveClass('line-clamp-2');
  });

  it('shows the toggle on forceToggle so a fitting-but-lossy preview still reaches its rich content', () => {
    // No forceOverflow here: the preview fits. With expandedContent the toggle
    // is the ONLY route to the rich markup, so a short-but-lossy body (a
    // one-line description holding a link) would otherwise be stranded as
    // inert flattened text.
    render(
      <CollapsibleText id="t11" text="see the report" expandedContent={<a href="/r">the report</a>} forceToggle />
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(screen.getByRole('link', { name: 'the report' })).toBeInTheDocument();
  });

  it('keeps the toggle hidden without forceToggle when the text fits', () => {
    render(<CollapsibleText id="t12" text="short" expandedContent={<a href="/r">the report</a>} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('swaps in expandedContent on expand and restores the plain-text clamp on collapse', () => {
    forceOverflow();
    render(
      <CollapsibleText
        id="t10"
        text="flattened preview"
        lines={3}
        expandedContent={<h4>Foreign Heading</h4>}
        expandedClassName="max-h-80 overflow-y-auto"
      />
    );

    // Collapsed: plain text only — the rich content (and its heading) is absent
    // from the document, so it cannot pollute the page outline.
    expect(document.getElementById('t10')).toHaveClass('line-clamp-3');
    expect(screen.getByText('flattened preview')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Foreign Heading' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(screen.getByRole('heading', { name: 'Foreign Heading' })).toBeInTheDocument();
    expect(screen.queryByText('flattened preview')).not.toBeInTheDocument();
    // The expanded body keeps the id (so aria-controls still resolves) and is
    // height-capped so one expanded card can't swallow the list.
    const expandedBody = document.getElementById('t10');
    expect(expandedBody).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(expandedBody).not.toHaveClass('line-clamp-3');

    fireEvent.click(screen.getByRole('button', { name: /Show less/ }));
    expect(screen.getByText('flattened preview')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Foreign Heading' })).not.toBeInTheDocument();
  });
});

describe('CollapsibleText children (max-height) variant', () => {
  it('caps overflowing children and lifts the cap on expand', () => {
    // `line-clamp` applies to a container's own inline content, so it silently
    // does nothing to block children like rendered markdown. The max-height cap
    // is the alternative clamp strategy for exactly that content.
    forceOverflow();
    render(
      <CollapsibleText id="c1" maxHeight="3.5rem">
        <h4>Rendered heading</h4>
        <p>body</p>
      </CollapsibleText>
    );

    const box = document.getElementById('c1');
    expect(box).toHaveClass('overflow-hidden');
    expect(box.style.maxHeight).toBe('3.5rem');
    expect(box).not.toHaveClass('line-clamp-2');

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(box).not.toHaveClass('overflow-hidden');
    expect(box.style.maxHeight).toBe('');
    // Unlike the `expandedContent` swap, the children stay mounted throughout —
    // expanding only removes the cap.
    expect(screen.getByRole('heading', { name: 'Rendered heading' })).toBeInTheDocument();
  });

  it('renders no toggle when the children fit', () => {
    render(<CollapsibleText id="c2"><p>short</p></CollapsibleText>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.getElementById('c2')).toHaveClass('overflow-hidden');
  });

  it('wires the toggle to the capped container', () => {
    forceOverflow();
    render(<CollapsibleText id="c3"><p>long</p></CollapsibleText>);

    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-controls', 'c3');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('forwards a caller className onto the capped container', () => {
    render(<CollapsibleText id="c4" className="text-sm"><p>hi</p></CollapsibleText>);
    expect(document.getElementById('c4')).toHaveClass('text-sm', 'break-words');
  });

  it('prefers children over text so a caller cannot get a silently unclamped preview', () => {
    render(
      <CollapsibleText id="c5" text="plain fallback">
        <p>rich body</p>
      </CollapsibleText>
    );
    expect(screen.getByText('rich body')).toBeInTheDocument();
    expect(screen.queryByText('plain fallback')).not.toBeInTheDocument();
  });

  it('observes the uncapped inner wrapper, not just the capped container', () => {
    // The outer element is height-capped, so growing children never change its
    // box — a resize callback bound to it alone would never fire and the toggle
    // would never appear for content that arrives after mount.
    const observed = [];
    vi.stubGlobal('ResizeObserver', class {
      observe(el) { observed.push(el); }
      disconnect() {}
    });

    render(<CollapsibleText id="c6"><p>body</p></CollapsibleText>);

    const box = document.getElementById('c6');
    expect(observed).toContain(box);
    expect(observed).toContain(box.firstElementChild);
  });

  it('keeps the toggle when a resize fires against the uncapped container', () => {
    // Same in-flight-callback race as the line-clamp path: expanding removes the
    // cap, and a resize notification already in flight would otherwise measure
    // the now-uncapped element and drop the only way back.
    let fire;
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { fire = cb; }
      observe() {}
      disconnect() {}
    });
    const spy = forceOverflow();
    render(<CollapsibleText id="c7"><p>long</p></CollapsibleText>);

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    spy.mockReturnValue(0);
    act(() => fire());

    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });
});
