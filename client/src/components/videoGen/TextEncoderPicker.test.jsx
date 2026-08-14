import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TextEncoderPicker from './TextEncoderPicker';

const STOCK = { id: 'stock', label: 'Stock — H3 Qwen3-VL-32B', description: 'Ships with the model.', builtIn: true };
const HERETIC = {
  id: 'heretic-bf16',
  label: 'Ultra-Heretic uncensored',
  description: 'Abliterated Qwen3-VL-32B conditioner.',
  builtIn: false,
  sizeBytes: 51506295440,
  advisory: 'This conditioner has had its refusal behavior removed.',
};
const OPTIONS = [STOCK, HERETIC];

describe('TextEncoderPicker', () => {
  // The empty/one-entry list is how a runtime with no substitutions hides the
  // control — rendering a select with a single unchangeable option would be
  // pure noise on every non-H3 model.
  it.each([[[]], [[STOCK]]])('renders nothing for %j options', (options) => {
    const { container } = render(<TextEncoderPicker options={options} value="stock" onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pairs its label to the select and reports the chosen id', async () => {
    const onChange = vi.fn();
    render(<TextEncoderPicker options={OPTIONS} value="stock" onChange={onChange} />);
    const select = screen.getByLabelText('Text encoder');
    expect(select).toHaveValue('stock');
    await userEvent.selectOptions(select, 'heretic-bf16');
    expect(onChange).toHaveBeenCalledWith('heretic-bf16');
  });

  it('surfaces the download size in the option text', () => {
    render(<TextEncoderPicker options={OPTIONS} value="stock" onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: /Ultra-Heretic uncensored \(~48 GB download\)/ })).toBeInTheDocument();
    // The built-in option has no separate download, so no size is invented for it.
    expect(screen.getByRole('option', { name: 'Stock — H3 Qwen3-VL-32B' })).toBeInTheDocument();
  });

  // An uncensored conditioner is a deliberate choice, so the picker states what
  // changed instead of leaving it to an external model card.
  it('shows the advisory only for the option that carries one', () => {
    const { rerender } = render(<TextEncoderPicker options={OPTIONS} value="stock" onChange={vi.fn()} />);
    expect(screen.queryByText(HERETIC.advisory)).not.toBeInTheDocument();
    expect(screen.getByText(STOCK.description)).toBeInTheDocument();

    rerender(<TextEncoderPicker options={OPTIONS} value="heretic-bf16" onChange={vi.fn()} />);
    expect(screen.getByText(HERETIC.advisory)).toBeInTheDocument();
    expect(screen.getByText(HERETIC.description)).toBeInTheDocument();
  });

  // The built-in option ships inside the model's own weights — badging it would
  // offer a download for something that isn't separately downloadable.
  it('badges a download only for a substitute that needs one', () => {
    const { rerender } = render(
      <TextEncoderPicker options={OPTIONS} value="stock" onChange={vi.fn()} status={null} />,
    );
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();

    rerender(
      <TextEncoderPicker
        options={OPTIONS}
        value="heretic-bf16"
        onChange={vi.fn()}
        status={{ id: 'heretic-bf16', repo: 'org/heretic', cached: false, sizeBytes: 0 }}
      />,
    );
    expect(screen.getByRole('button', { name: /Download \(~48 GB\)/ })).toBeInTheDocument();
  });

  it('passes the selected id to the download handler', async () => {
    const onDownload = vi.fn();
    render(
      <TextEncoderPicker
        options={OPTIONS}
        value="heretic-bf16"
        onChange={vi.fn()}
        status={{ id: 'heretic-bf16', repo: 'org/heretic', cached: false, sizeBytes: 0 }}
        onDownload={onDownload}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(onDownload).toHaveBeenCalledWith('heretic-bf16');
  });

  it('drops the badge once the substitute is cached', () => {
    render(
      <TextEncoderPicker
        options={OPTIONS}
        value="heretic-bf16"
        onChange={vi.fn()}
        status={{ id: 'heretic-bf16', repo: 'org/heretic', cached: true, sizeBytes: 51506295440 }}
      />,
    );
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  // A value with no matching option would leave the browser rendering the first
  // entry while the parent believes something else is selected; fall back
  // visibly to the first (stock) option instead.
  it('falls back to the first option for an unknown value', () => {
    render(<TextEncoderPicker options={OPTIONS} value="gone" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Text encoder')).toHaveValue('stock');
  });

  it('disables the select while a render is in flight', () => {
    render(<TextEncoderPicker options={OPTIONS} value="stock" onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('Text encoder')).toBeDisabled();
  });
});
