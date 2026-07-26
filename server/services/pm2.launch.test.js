import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPm2 = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn()
}));

vi.mock('pm2', () => ({ default: mockPm2 }));

import { startApp, startWithCommand } from './pm2.js';

describe('PM2 command launch interpreters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPm2.connect.mockImplementation(callback => callback(null));
    mockPm2.start.mockImplementation((options, callback) => callback(null, options));
  });

  it('executes shell-script commands directly instead of parsing them with Node', async () => {
    await startWithCommand(
      'elsewhere-acres-godot',
      '/repo/elsewhere-acres',
      './scripts/game run',
      { autorestart: false }
    );

    expect(mockPm2.start).toHaveBeenCalledWith(expect.objectContaining({
      name: 'elsewhere-acres-godot',
      script: './scripts/game',
      args: ['run'],
      interpreter: 'none',
      autorestart: false
    }), expect.any(Function));
  });

  it('keeps JavaScript entrypoints on PM2\'s Node interpreter', async () => {
    await startWithCommand('web-app', '/repo/web-app', './server.mjs');

    const [options] = mockPm2.start.mock.calls[0];
    expect(options).not.toHaveProperty('interpreter');
  });

  it('applies the same direct-execution rule to configured app scripts', async () => {
    await startApp('tooling-app', { script: 'npm', args: 'run dev' });

    expect(mockPm2.start).toHaveBeenCalledWith(expect.objectContaining({
      script: 'npm',
      args: 'run dev',
      interpreter: 'none'
    }), expect.any(Function));
  });
});
