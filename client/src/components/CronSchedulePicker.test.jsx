import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CronSchedulePicker from './CronSchedulePicker.jsx';

describe('CronSchedulePicker', () => {
  it('edits an arbitrary weekly interval without losing the weekday', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' }}
        valueShape="recurrence"
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Every 2 weeks on Mon at 02:00')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Tue'));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      frequency: 'weekly', interval: 2, weekdays: [1, 2], anchorDate: '2026-08-31',
    }));
  });

  it('keeps weekly recurrence valid when the last weekday is clicked', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ frequency: 'weekly', interval: 1, weekdays: [1], time: '02:00' }}
        valueShape="recurrence"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTitle('Mon'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: [1] }));
  });

  it('adapts legacy commission schedules and promotes them to rich recurrence', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ kind: 'WEEKLY', weekday: 1, atLocalTime: '02:00' }}
        valueShape="commission"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Repeat every number of weeks'), { target: { value: '2' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'RECURRENCE',
      recurrence: expect.objectContaining({ frequency: 'weekly', interval: 2, weekdays: [1] }),
    }));
  });
});
