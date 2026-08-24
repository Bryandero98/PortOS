import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DailyActionsWidget from './DailyActionsWidget';

const renderWidget = (actions) => render(
  <MemoryRouter>
    <DailyActionsWidget dashboardState={{ dailyActions: { actions } }} />
  </MemoryRouter>,
);

describe('DailyActionsWidget', () => {
  it('renders deep-linked daily actions from dashboard state', () => {
    renderWidget([{
      id: 'daily-post',
      type: 'post_engagement',
      severity: 'high',
      title: 'Daily POST is waiting',
      detail: 'No POST activity today.',
      link: '/post/launcher',
    }]);

    expect(screen.getByRole('heading', { name: "Today's actions" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /daily post is waiting.*no post activity today/i })).toHaveAttribute('href', '/post/launcher');
  });

  it('reserves no card when there are no actions', () => {
    const { container } = renderWidget([]);
    expect(container).toBeEmptyDOMElement();
  });
});
