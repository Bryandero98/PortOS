import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useOpenWorldViewport, { classifyOpenWorldViewport } from './useOpenWorldViewport.js';

const setViewport = (width, height = 1080) => {
  window.innerWidth = width;
  window.innerHeight = height;
};

afterEach(() => setViewport(1024));

describe('classifyOpenWorldViewport', () => {
  it('classifies phone / compact / desktop at the sm+lg breakpoints', () => {
    expect(classifyOpenWorldViewport(390)).toBe('phone');
    expect(classifyOpenWorldViewport(639)).toBe('phone');
    expect(classifyOpenWorldViewport(640)).toBe('compact');
    expect(classifyOpenWorldViewport(1023)).toBe('compact');
    expect(classifyOpenWorldViewport(1024)).toBe('desktop');
    expect(classifyOpenWorldViewport(1440)).toBe('desktop');
  });

  it('uses the compact HUD when a desktop-width viewport is too short for both HUD rails', () => {
    expect(classifyOpenWorldViewport(1440, 899)).toBe('compact');
    expect(classifyOpenWorldViewport(1440, 900)).toBe('desktop');
  });
});

describe('useOpenWorldViewport', () => {
  it('reports the initial bracket from the current width', () => {
    setViewport(390);
    const { result } = renderHook(() => useOpenWorldViewport());
    expect(result.current.mode).toBe('phone');
    expect(result.current.isPhone).toBe(true);
    expect(result.current.isCondensed).toBe(true);
    expect(result.current.isDesktop).toBe(false);
  });

  it('updates on resize across width and height brackets', () => {
    setViewport(1440);
    const { result } = renderHook(() => useOpenWorldViewport());
    expect(result.current.isDesktop).toBe(true);

    act(() => { setViewport(1440, 899); window.dispatchEvent(new Event('resize')); });
    expect(result.current.isCompact).toBe(true);
    expect(result.current.isCondensed).toBe(true);

    act(() => { setViewport(800); window.dispatchEvent(new Event('resize')); });
    expect(result.current.isCompact).toBe(true);
    expect(result.current.isCondensed).toBe(true);

    act(() => { setViewport(375); window.dispatchEvent(new Event('resize')); });
    expect(result.current.isPhone).toBe(true);
  });
});
