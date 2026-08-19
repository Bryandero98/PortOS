import { createContext, useContext, useMemo } from 'react';
import useOpenWorldSettings from '../../hooks/useOpenWorldSettings';

const OpenWorldSettingsContext = createContext(null);

export function OpenWorldSettingsProvider({ children }) {
  const [settings, updateSetting, resetSettings, resetNonce] = useOpenWorldSettings();

  const value = useMemo(
    () => ({ settings, updateSetting, resetSettings, resetNonce }),
    [settings, updateSetting, resetSettings, resetNonce]
  );

  return (
    <OpenWorldSettingsContext.Provider value={value}>
      {children}
    </OpenWorldSettingsContext.Provider>
  );
}

export function useOpenWorldSettingsContext() {
  const ctx = useContext(OpenWorldSettingsContext);
  if (!ctx) return { settings: null, updateSetting: () => {}, resetSettings: () => {}, resetNonce: 0 };
  return ctx;
}
