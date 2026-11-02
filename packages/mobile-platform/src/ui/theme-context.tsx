/**
 * Pravshi OS  Mobile Platform Theme Context & Provider.
 *
 * Exposes a reactive theming context for mobile screens and components.
 */

import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  DefaultLightTheme,
  resolveTenantTheme,
  type ThemeTokens,
  type WhiteLabelBranding,
} from './tokens';

export interface ThemeContextValue {
  theme: ThemeTokens;
  mode: 'light' | 'dark';
  branding: WhiteLabelBranding | null;
  setMode: (mode: 'light' | 'dark') => void;
  toggleMode: () => void;
  setBranding: (branding: WhiteLabelBranding | null) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DefaultLightTheme,
  mode: 'light',
  branding: null,
  setMode: () => undefined,
  toggleMode: () => undefined,
  setBranding: () => undefined,
});

export interface ThemeProviderProps {
  children: ReactNode;
  initialMode?: 'light' | 'dark';
  initialBranding?: WhiteLabelBranding | null;
}

export function ThemeProvider({
  children,
  initialMode = 'light',
  initialBranding = null,
}: ThemeProviderProps): React.JSX.Element {
  const [mode, setMode] = useState<'light' | 'dark'>(initialMode);
  const [branding, setBranding] = useState<WhiteLabelBranding | null>(initialBranding);

  const toggleMode = () => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const theme = useMemo(() => {
    return resolveTenantTheme(branding, mode);
  }, [branding, mode]);

  const value = useMemo(
    () => ({
      theme,
      mode,
      branding,
      setMode,
      toggleMode,
      setBranding,
    }),
    [theme, mode, branding],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
