import { createContext, useContext } from 'react';
import { deriveOpenWorldPalette } from './openWorldConstants';

// OpenWorld's "brand" surfaces (ground grid, particles, online buildings, the lead
// neon accent, the dark structural bases) track the active PortOS theme accent. The
// palette is derived once per theme (see deriveOpenWorldPalette) and handed down through
// this context instead of mutating a shared module-level singleton during render —
// the old approach fired a side-effect mid-render that was fragile under React
// StrictMode's double-invoke and concurrent rendering.
//
// IMPORTANT: react-three-fiber's <Canvas> runs its own reconciler, so React context
// does NOT cross that boundary automatically (the same reason `settings` is prop-
// threaded into every scene component). The palette is therefore provided TWICE: once
// by OpenWorldInner for the DOM-side HUD/minimap, and again inside <Canvas> by
// OpenWorldScene for the 3D scene. Both providers share the same derived palette object.

// Default to the cyan-era baseline so a consumer rendered outside a provider (or in a
// test) still gets a valid, fully-formed palette rather than crashing on undefined.
const DEFAULT_OPEN_WORLD_PALETTE = deriveOpenWorldPalette(undefined);

const OpenWorldPaletteContext = createContext(DEFAULT_OPEN_WORLD_PALETTE);

export function OpenWorldPaletteProvider({ palette, children }) {
  return (
    <OpenWorldPaletteContext.Provider value={palette || DEFAULT_OPEN_WORLD_PALETTE}>
      {children}
    </OpenWorldPaletteContext.Provider>
  );
}

export function useOpenWorldPalette() {
  return useContext(OpenWorldPaletteContext);
}
