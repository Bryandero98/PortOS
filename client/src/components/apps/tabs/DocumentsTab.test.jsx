import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DocumentsTab from './DocumentsTab';

vi.mock('../../../services/api', () => ({
  getAppDocuments: vi.fn(),
  getAppDocument: vi.fn(),
  saveAppDocument: vi.fn()
}));

import * as api from '../../../services/api';

const listing = {
  documents: [
    { filename: 'ARCHITECTURE.md', exists: true },
    { filename: 'README.md', exists: true },
    { filename: 'AGENTS.md', exists: false }
  ],
  docs: ['docs/API.md', 'docs/decisions/2026-01-01-choice.md'],
  hasPlanning: false
};

describe('DocumentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAppDocuments.mockResolvedValue(listing);
    api.getAppDocument.mockImplementation((_id, filename) =>
      Promise.resolve({ filename, content: `# ${filename}` }));
  });

  it('lists every root markdown file, not just the conventional four', async () => {
    render(<DocumentsTab appId="app-1" repoPath="/repo/example" />);

    expect(await screen.findByRole('button', { name: /ARCHITECTURE\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /README\.md/ })).toBeInTheDocument();
    // Auto-selects the first existing root document
    await waitFor(() => expect(api.getAppDocument).toHaveBeenCalledWith('app-1', 'ARCHITECTURE.md'));
  });

  it('groups the docs/ tree by directory and opens a nested file by its full path', async () => {
    render(<DocumentsTab appId="app-1" repoPath="/repo/example" />);

    expect(await screen.findByText('docs/')).toBeInTheDocument();
    expect(screen.getByText('docs/decisions/')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /2026-01-01-choice\.md/ }));

    await waitFor(() =>
      expect(api.getAppDocument).toHaveBeenCalledWith('app-1', 'docs/decisions/2026-01-01-choice.md'));
  });

  it('still offers to create a conventional document the repo is missing', async () => {
    render(<DocumentsTab appId="app-1" repoPath="/repo/example" />);

    expect(await screen.findByRole('button', { name: /AGENTS\.md/ })).toBeInTheDocument();
  });

  it('shows the empty state only when the root and docs/ are both empty', async () => {
    api.getAppDocuments.mockResolvedValue({ documents: [], docs: [], hasPlanning: false });

    render(<DocumentsTab appId="app-1" repoPath="/repo/example" />);

    expect(await screen.findByText('No documents found')).toBeInTheDocument();
    expect(api.getAppDocument).not.toHaveBeenCalled();
  });
});
