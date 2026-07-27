import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The place/object IDENTITY-REFERENCE surface: describe it, render a candidate,
// freeze it. #3134 gave the reference render its own correction note in the shared
// page-owned map; the load-bearing behavior here is that the note is ADDITIVE to
// the design prompt rather than a replacement for it.
//
// Since #3136 the ambient LOOP is no longer this component's concern — it is one
// animation track among any number the user may define, and it renders through
// the generic `TrackWorkflow` (see `TrackWorkflow.test.jsx` for the loop note).

vi.mock('../../services/apiSprites.js', () => ({
  lockSpriteReference: vi.fn(() => Promise.resolve({})),
}));

import AmbientWorkflow from './AmbientWorkflow.jsx';

const record = { id: 'example-grove', kind: 'place', name: 'Example Grove' };
const CANDIDATE = { target: 'main', path: 'reference/candidates/main-candidate-01.png' };

const renderAmbient = (props = {}) => render(
  <AmbientWorkflow
    record={record}
    reference={{ manifest: { mainReference: { locked: false } }, candidates: [CANDIDATE] }}
    renders={{ pendingJobs: {} }}
    hasBackend
    mode="codex"
    onGenerateReference={vi.fn()}
    onChanged={vi.fn()}
    {...props}
  />,
);

// A locked main means this surface is DONE — the animation tracks take over.
const lockedReference = { manifest: { mainReference: { locked: true, path: 'reference/example-grove-main-v1.png' } }, candidates: [] };

describe('AmbientWorkflow correction notes (#3134)', () => {
  it('offers a reference correction once there is a candidate to correct', () => {
    const onCorrectionChange = vi.fn();
    renderAmbient({ corrections: {}, onCorrectionChange });
    fireEvent.click(screen.getByRole('button', { name: /Show correction note for ambient reference/i }));
    fireEvent.change(screen.getByLabelText(/Correction guidance for the ambient reference/i), {
      target: { value: 'the trunk leans too far right' },
    });
    const merged = onCorrectionChange.mock.calls[0][0]({});
    expect(merged).toHaveProperty('ambient-reference');
    // The design prompt is a SEPARATE control — the correction is additive, so it
    // must not be written into the design field's state.
    expect(merged).not.toHaveProperty('designPrompt');
  });

  it('does not offer a reference correction before the first render exists', () => {
    renderAmbient({
      reference: { manifest: { mainReference: { locked: false } }, candidates: [] },
      corrections: {},
      onCorrectionChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('omits every affordance when the page supplies no writer', () => {
    renderAmbient();
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('retires itself once the identity reference is frozen (#3136)', () => {
    // The reference step is one-and-done; leaving it on screen would offer a
    // Freeze for an already-frozen still. Everything after this point is an
    // animation track, rendered by TrackWorkflow.
    const { container } = renderAmbient({
      reference: lockedReference, corrections: {}, onCorrectionChange: vi.fn(),
    });
    expect(container).toBeEmptyDOMElement();
  });
});

// The server requires a design input on the ambient main, so the field must
// carry the manifest's stored design forward — otherwise a correction typed
// against a blank field 400s with DESIGN_INPUT_REQUIRED (#3134).
describe('AmbientWorkflow design prompt', () => {
  it('seeds the design field from the manifest so a regenerate is not blank', () => {
    renderAmbient({
      reference: {
        manifest: { mainReference: { locked: false }, designPrompt: 'a willow by a pond' },
        candidates: [CANDIDATE],
      },
    });
    expect(screen.getByLabelText(/Describe this place/i)).toHaveValue('a willow by a pond');
    // With a design present the regenerate is reachable — which is what makes the
    // correction note usable at all on this surface.
    expect(screen.getByRole('button', { name: /Regenerate reference/i })).toBeEnabled();
  });

  it('stays empty for a record that has never been rendered', () => {
    renderAmbient({ reference: { manifest: { mainReference: { locked: false } }, candidates: [] } });
    expect(screen.getByLabelText(/Describe this place/i)).toHaveValue('');
  });
});
