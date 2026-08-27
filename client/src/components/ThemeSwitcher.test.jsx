import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ThemeSwitcher from './ThemeSwitcher';

vi.mock('./ThemeContext', () => ({
  useThemeContext: () => ({
    themeId: 'classic-midnight',
    theme: { label: 'Classic Midnight' },
    themeList: [
      {
        id: 'classic-midnight',
        label: 'Classic Midnight',
        shortLabel: 'Classic',
        density: 'comfortable',
        family: 'classic',
        accent: '#2563eb',
      },
      {
        id: 'blueprint-day',
        label: 'Blueprint Day',
        shortLabel: 'Blueprint',
        density: 'compact',
        family: 'blueprint',
        accent: '#0ea5e9',
      },
    ],
    setTheme: vi.fn(),
  }),
}));

describe('ThemeSwitcher', () => {
  it('exposes the current theme through accessible menu radio state', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Switch theme/ }));

    const menu = screen.getByRole('menu', { name: 'Interface theme' });
    expect(within(menu).getByRole('menuitemradio', { name: /Classic Midnight/ }))
      .toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: /Blueprint Day/ }))
      .toHaveAttribute('aria-checked', 'false');
  });
});
