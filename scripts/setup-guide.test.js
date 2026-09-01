import { describe, expect, it } from 'vitest';
import { formatSetupGuide, formatSetupSummary } from './setup-guide.js';

const incompleteGuide = {
  complete: false,
  nextStep: {
    id: 'https-cert',
    title: 'Provision a trusted HTTPS certificate',
    detail: 'Enable HTTPS Certificates, then let PortOS fetch the certificate.',
  },
  steps: [
    {
      id: 'tailscale-install',
      title: 'Install Tailscale',
      status: 'complete',
      detail: 'The Tailscale CLI is installed.',
      action: null,
    },
    {
      id: 'magic-dns',
      title: 'Enable MagicDNS',
      status: 'complete',
      detail: 'MagicDNS assigned host-alpha.example-tailnet.ts.net.',
      action: null,
    },
    {
      id: 'https-cert',
      title: 'Provision a trusted HTTPS certificate',
      status: 'action',
      detail: 'Enable HTTPS Certificates, then let PortOS fetch the certificate.',
      action: {
        type: 'provision-cert',
        label: 'Enable HTTPS',
        adminUrl: 'https://login.tailscale.com/admin/dns',
      },
    },
  ],
};

describe('setup walkthrough formatting', () => {
  it('prints the ordered network actions and all three AI provider paths', () => {
    const output = formatSetupGuide(incompleteGuide, {
      localUrl: 'http://localhost:5555',
      setupUrl: 'http://localhost:5555/capabilities',
    });

    expect(output).toContain('[✓] Install Tailscale');
    expect(output).toContain('[→] Provision a trusted HTTPS certificate');
    expect(output).toContain('https://login.tailscale.com/admin/dns');
    expect(output).toContain('npm run setup:cert');
    expect(output).toContain('Subscription CLI');
    expect(output).toContain('API provider');
    expect(output).toContain('Local/private');
    expect(output).toContain('Open setup: http://localhost:5555/capabilities');
    expect(output).toContain('Local PortOS URL: http://localhost:5555');
  });

  it('summarizes the next action without claiming setup is complete', () => {
    expect(formatSetupSummary(incompleteGuide)).toBe(
      'Provision a trusted HTTPS certificate — Enable HTTPS Certificates, then let PortOS fetch the certificate.',
    );
  });

  it('prints the exact trusted URL for a completed install', () => {
    const guide = {
      complete: true,
      trustedUrl: 'https://host-alpha.example-tailnet.ts.net:5555',
      nextStep: null,
      steps: [],
    };
    expect(formatSetupSummary(guide)).toBe(
      'Trusted Tailscale HTTPS ready at https://host-alpha.example-tailnet.ts.net:5555',
    );
    expect(formatSetupGuide(guide)).toContain(
      'Trusted PortOS URL: https://host-alpha.example-tailnet.ts.net:5555',
    );
  });
});
