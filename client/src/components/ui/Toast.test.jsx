import { useEffect } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

import { toast, Toaster, COLLAPSE_AFTER_MS } from './Toast.jsx';

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Toast on an insecure origin', () => {
  // Regression: `add()` minted ids with a bare `crypto.randomUUID()`, which is
  // undefined outside a secure context. PortOS is routinely reached over plain
  // HTTP via Tailscale, so EVERY toast threw `crypto.randomUUID is not a
  // function` there — including the error toasts the API client raises to
  // report a failure, which surfaced it as an unhandled rejection.
  it('renders without crypto.randomUUID (plain HTTP via Tailscale)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    render(<Toaster />);
    expect(() => act(() => { toast.error('Request failed'); })).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
  });
});

describe('Toaster accessibility', () => {
  it('exposes the toast stack as a labelled notification region', () => {
    render(<Toaster />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toBeInTheDocument();
  });

  it('announces a default toast politely (role="status") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast('Saved'); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
    // role="status" already implies aria-live="polite"; pairing both
    // double-announces in iOS VoiceOver, so aria-live must be absent.
    expect(status).not.toHaveAttribute('aria-live');
  });

  it('announces an error toast assertively (role="alert") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast.error('Boom'); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Boom');
    // role="alert" already implies aria-live="assertive".
    expect(alert).not.toHaveAttribute('aria-live');
  });

  it('hides the decorative status glyph from assistive tech', () => {
    render(<Toaster />);
    act(() => { toast.success('Done'); });
    const status = screen.getByRole('status');
    const glyph = status.querySelector('[aria-hidden="true"]');
    expect(glyph).toHaveTextContent('✓');
  });
});

/** Why a never-dismissing toast has to fold away: see COLLAPSE_AFTER_MS. */
describe('long-lived toasts stop blocking the page', () => {
  const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  // Every test here measures a timeout, so fake timers are mandatory — a test
  // that forgot them would silently no-op every `advance()`.
  beforeEach(() => {
    vi.useFakeTimers();
    render(<Toaster />);
  });

  it('collapses a persistent toast to a pill that no longer covers the page', () => {
    act(() => { toast('Install out of sync', { duration: Infinity, icon: '⚠️' }); });

    // Still a full-size toast for the first COLLAPSE_AFTER_MS.
    expect(screen.getByRole('status')).toBeVisible();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();

    advance(COLLAPSE_AFTER_MS);

    // The body is hidden (out of hit-testing and out of the a11y tree) and only
    // a corner pill remains.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('leaves transient toasts alone — they never live long enough to block anything', () => {
    act(() => { toast('Saved'); });

    // The default 4s toast is dismissed well before the collapse threshold, so
    // it must never sprout a pill on its way out.
    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();
  });

  it('re-expands when the pill is clicked, and re-collapses on its own', () => {
    // Distinct text per test: identical content within DEDUP_WINDOW_MS is
    // dropped, and the fingerprint map outlives an individual test.
    act(() => { toast('New build available', { duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);

    fireEvent.click(screen.getByRole('button', { name: /show notification/i }));
    expect(screen.getByRole('status')).toBeVisible();

    // No pinning on expand — a tap on a touch device (no mouseleave ever
    // arrives) must still fold the toast back away.
    advance(COLLAPSE_AFTER_MS);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the toast open while focus is inside it', () => {
    act(() => {
      toast(() => <button type="button">Reconcile</button>, { duration: Infinity, label: 'Install out of sync' });
    });

    fireEvent.focus(screen.getByRole('button', { name: 'Reconcile' }));
    advance(COLLAPSE_AFTER_MS * 2);
    // Collapsing here would `display: none` the focused button and dump focus
    // on <body> mid-interaction.
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeVisible();

    fireEvent.blur(screen.getByRole('button', { name: 'Reconcile' }));
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('unfolds a collapsed toast when it is updated in place', () => {
    act(() => { toast.loading('Restarting PortOS...', { id: 'restart', duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: /show notification/i })).toBeVisible();

    // Same id, new content: the swap has something to say, so it must not land
    // inside a pill nobody thinks to open.
    act(() => { toast.success('PortOS restarted', { id: 'restart' }); });
    expect(screen.getByRole('status')).toHaveTextContent('PortOS restarted');
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();
  });

  it('moves focus into the toast when the pill is expanded from the keyboard', () => {
    act(() => {
      toast(() => <button type="button">Reconcile</button>, {
        duration: Infinity,
        label: 'Install out of sync',
      });
    });
    advance(COLLAPSE_AFTER_MS);

    // Activating the pill unmounts it. Without a handover focus lands on
    // <body> and the toast's own buttons leave the tab sequence entirely.
    const pill = screen.getByRole('button', { name: /show notification/i });
    pill.focus();
    fireEvent.click(pill);

    const body = screen.getByRole('status');
    expect(document.activeElement).toBe(body);
    expect(document.activeElement).not.toBe(document.body);
    // ...and the toast stays put while it holds focus.
    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  });

  it('does not steal focus when the pill is expanded by pointer', () => {
    // Nothing to rescue, and taking focus here would pin the toast open until
    // the user clicked elsewhere — back to a parked overlay.
    act(() => { toast('Build is stale', { duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);

    fireEvent.click(screen.getByRole('button', { name: /show notification/i }));

    expect(document.activeElement).toBe(document.body);
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Build is stale' })).toBeVisible();
  });

  it('keeps focus held even after the pointer sweeps over the toast and leaves', () => {
    // Hover and focus are independent holds. A single shared flag lets the
    // pointer leaving release a hold that focus still owns, and the collapse
    // then `display: none`s the very button the keyboard user is sitting on.
    act(() => {
      toast(() => <button type="button">Reconcile now</button>, {
        duration: Infinity,
        label: 'Install out of sync',
      });
    });

    const button = screen.getByRole('button', { name: 'Reconcile now' });
    const body = screen.getByRole('status');

    fireEvent.focus(button);       // keyboard user tabs in
    fireEvent.mouseEnter(body);    // pointer drifts across the toast
    fireEvent.mouseLeave(body);    // and off again — focus is still inside

    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('button', { name: 'Reconcile now' })).toBeVisible();

    // Once focus actually leaves, nothing is holding it open any more.
    fireEvent.blur(button);
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('keeps hover held even after focus leaves the toast', () => {
    // The mirror image: focus departing must not release the pointer's hold.
    act(() => { toast('Update available', { duration: Infinity }); });

    const body = screen.getByRole('status');
    fireEvent.mouseEnter(body);
    fireEvent.focus(body);
    fireEvent.blur(body);

    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('status')).toBeVisible();

    fireEvent.mouseLeave(body);
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Update available' })).toBeVisible();
  });

  it('folds on the content\'s own schedule when it passes collapseAfter', () => {
    // The agent-feedback card sets duration: Infinity only because it runs a
    // 15s dismiss of its own. Folding at the 8s default would hide its rating
    // buttons for the last 7s of a life the caller did bound.
    const OWN_BOUND = COLLAPSE_AFTER_MS * 2;
    act(() => {
      toast(() => <button type="button">Rate</button>, {
        duration: Infinity,
        label: 'Agent finished',
        collapseAfter: OWN_BOUND,
      });
    });

    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Rate' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();

    // Still folds — a longer delay is not an opt-out. The card clears its own
    // dismiss timer once expanded, and an unbounded card is the click sink.
    advance(OWN_BOUND - COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Agent finished' })).toBeVisible();
  });

  it('ignores a collapseAfter that would switch the fold off entirely', () => {
    // `Infinity` here would read as "never fold" and hand back the very
    // click-eating overlay this exists to remove, so it must not be honoured.
    act(() => { toast('Stuck forever', { duration: Infinity, collapseAfter: Infinity }); });

    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Stuck forever' })).toBeVisible();
  });

  it('hides rather than unmounts, so a self-dismissing toast keeps its timers', () => {
    const unmounted = vi.fn();
    function SelfManaging() {
      useEffect(() => unmounted, []);
      return <span>Agent finished</span>;
    }
    act(() => { toast(() => <SelfManaging />, { duration: Infinity, label: 'Agent finished' }); });

    advance(COLLAPSE_AFTER_MS);

    // Unmounting the body would destroy the render-prop's own auto-dismiss
    // timer and strand the pill on screen forever.
    expect(unmounted).not.toHaveBeenCalled();
    expect(screen.getByText('Agent finished')).toBeInTheDocument();
  });
});
