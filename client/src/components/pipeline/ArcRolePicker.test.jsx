import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ArcRolePicker from './ArcRolePicker';

describe('ArcRolePicker', () => {
  const arcRoles = ['pilot', 'climax', 'finale'];

  it('renders server-provided roles and saves climax independently', () => {
    const onChange = vi.fn();
    render(<ArcRolePicker issue={{ arcRole: 'pilot' }} arcRoles={arcRoles} onChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Arc role' });
    expect(screen.getByRole('option', { name: 'Climax' })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'climax' } });
    expect(onChange).toHaveBeenCalledWith('climax');
  });

  it('maps the empty selection to an intentional clear', () => {
    const onChange = vi.fn();
    render(<ArcRolePicker issue={{ arcRole: 'climax' }} arcRoles={arcRoles} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Arc role' }), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
