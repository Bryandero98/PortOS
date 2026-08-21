import { describe, it, expect } from 'vitest';
import { buildReadinessProbe } from './shellReadinessProbe.js';

describe('buildReadinessProbe', () => {
  it('renders the POSIX printf probe byte-identical to the pre-dialect-aware form', () => {
    expect(buildReadinessProbe('abc123', '/bin/zsh')).toBe("printf '%s\\n' 'PORTOSRDY''abc123'");
    expect(buildReadinessProbe('abc123', '/bin/bash')).toBe("printf '%s\\n' 'PORTOSRDY''abc123'");
  });

  it('renders a split-literal Write-Output probe on PowerShell', () => {
    expect(buildReadinessProbe('abc123', 'pwsh.exe')).toBe("Write-Output ('PORTOSRDY' + 'abc123')");
    expect(buildReadinessProbe('abc123', 'powershell.exe')).toBe("Write-Output ('PORTOSRDY' + 'abc123')");
  });

  it('returns null for cmd.exe — no safe split-literal probe exists', () => {
    expect(buildReadinessProbe('abc123', 'cmd.exe')).toBeNull();
    expect(buildReadinessProbe('abc123', 'C:\\WINDOWS\\system32\\cmd.exe')).toBeNull();
  });

  it('keeps POSIX quoting for git-bash on Windows', () => {
    expect(buildReadinessProbe('abc123', 'C:\\Program Files\\Git\\bin\\bash.exe'))
      .toBe("printf '%s\\n' 'PORTOSRDY''abc123'");
  });

  it('never contains the assembled marker in its own source, in any dialect', () => {
    const marker = 'PORTOSRDYabc123';
    for (const shell of ['/bin/zsh', 'pwsh.exe', 'powershell.exe']) {
      const probe = buildReadinessProbe('abc123', shell);
      expect(probe).not.toBeNull();
      expect(probe).not.toContain(marker);
    }
  });
});
