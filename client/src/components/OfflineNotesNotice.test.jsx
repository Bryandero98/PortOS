import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OfflineNotesNotice from './OfflineNotesNotice.jsx';

describe('OfflineNotesNotice', () => {
  it('renders nothing when no notes were skipped', () => {
    const { container } = render(<OfflineNotesNotice count={0} />);
    // Callers drop it in unconditionally, so 0 must be invisible — not an empty box.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an absent or non-numeric count', () => {
    expect(render(<OfflineNotesNotice />).container).toBeEmptyDOMElement();
    expect(render(<OfflineNotesNotice count={undefined} />).container).toBeEmptyDOMElement();
    expect(render(<OfflineNotesNotice count={'oops'} />).container).toBeEmptyDOMElement();
  });

  it('warns, in the singular, for one skipped note', () => {
    render(<OfflineNotesNotice count={1} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/1 note is stored in iCloud/);
    expect(status).not.toHaveTextContent(/notes are/);
  });

  it('warns, in the plural, for several', () => {
    render(<OfflineNotesNotice count={12} />);
    expect(screen.getByRole('status')).toHaveTextContent(/12 notes are stored in iCloud/);
  });
});
