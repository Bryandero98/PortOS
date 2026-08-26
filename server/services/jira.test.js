import fs from 'fs/promises';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildColumnsFromBoardConfig,
  buildColumnsFromStatuses,
  clearCloudAssigneeCache,
  createJiraClient,
  createTicket,
  deleteInstance,
  isCloudInstance,
  jiraAuthHeader,
  upsertInstance
} from './jira.js';

describe('isCloudInstance', () => {
  it('treats *.atlassian.net hosts as Cloud', () => {
    expect(isCloudInstance('https://example.atlassian.net')).toBe(true);
    expect(isCloudInstance('https://example.atlassian.net/jira/software/c/projects/PROJ')).toBe(true);
    expect(isCloudInstance('https://ATLASSIAN.NET')).toBe(true);
  });

  it('treats Server / Data Center hosts as not Cloud', () => {
    expect(isCloudInstance('https://jira.example.com')).toBe(false);
    expect(isCloudInstance('https://jira.example.com:8443')).toBe(false);
    // Guard against a lookalike host that merely contains the string.
    expect(isCloudInstance('https://atlassian.net.evil.com')).toBe(false);
  });

  it('does not throw on a malformed baseUrl', () => {
    expect(isCloudInstance('not a url')).toBe(false);
    expect(isCloudInstance(undefined)).toBe(false);
  });
});

describe('jiraAuthHeader', () => {
  it('uses Basic base64(email:token) for Cloud instances', () => {
    const header = jiraAuthHeader({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    expect(header).toBe(`Basic ${Buffer.from('me@x.com:tok').toString('base64')}`);
  });

  it('uses Bearer PAT for Server / Data Center instances', () => {
    const header = jiraAuthHeader({ baseUrl: 'https://jira.example.com', email: 'me@x.com', apiToken: 'pat' });
    expect(header).toBe('Bearer pat');
  });
});

describe('createJiraClient expired-token detection', () => {
  afterEach(() => {
    // vi.stubGlobal is only reverted by unstubAllGlobals (restoreAllMocks won't
    // touch it unless unstubGlobals is set in vitest config), so the stubbed
    // fetch would otherwise leak into later suites in this file.
    vi.unstubAllGlobals();
  });

  // Helper: stub global fetch with a single response so createHttpClient's request()
  // observes exactly what the given JIRA instance type would return on an expired token.
  const stubFetch = ({ ok, status, contentType, body }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok,
      status,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body,
      text: async () => body
    }));
  };

  it('maps a Server HTML login page (200 + <!DOCTYPE) to the friendly expiry error', async () => {
    stubFetch({ ok: true, status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html><body>login</body></html>' });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('token expired or invalid')
    });
  });

  it('maps a Cloud JSON 401 to the same friendly expiry error', async () => {
    stubFetch({
      ok: false,
      status: 401,
      contentType: 'application/json',
      body: { errorMessages: ['Client must be authenticated to access this resource.'], errors: {} }
    });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('token expired or invalid')
    });
  });

  it('does not trip the HTML heuristic on a Cloud JSON payload that contains "<!DOCTYPE"', async () => {
    // A Cloud instance returns JSON; even if a field value contained the marker string,
    // the heuristic is gated off for Cloud so a valid response passes through untouched.
    stubFetch({ ok: true, status: 200, contentType: 'application/json', body: { note: '<!DOCTYPE lives in this field' } });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    const res = await client.get('/rest/api/2/myself');
    expect(res.data).toEqual({ note: '<!DOCTYPE lives in this field' });
  });

  it('lets non-401 errors bubble unchanged', async () => {
    stubFetch({ ok: false, status: 500, contentType: 'application/json', body: { errorMessages: ['boom'] } });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({ status: 500 });
  });
});

describe('createJiraClient search endpoint routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetchOk = (body) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('routes a Cloud instance to /rest/api/2/search/jql', async () => {
    const fetchMock = stubFetchOk({ issues: [] });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    await client.search({ jql: 'assignee = currentUser()', maxResults: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/2/search/jql');
  });

  it('keeps a Server/DC instance on the classic /rest/api/2/search — Atlassian only sunset it on Cloud, and an older DC version may not serve /search/jql at all', async () => {
    const fetchMock = stubFetchOk({ issues: [] });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await client.search({ jql: 'assignee = currentUser()', maxResults: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/2/search?');
    expect(url).not.toContain('/search/jql');
  });
});

describe('createTicket assignee resolution', () => {
  const INSTANCE_ID = 'jira-example';

  const stubInstance = (instance = {}) => {
    stubInstances({
      [INSTANCE_ID]: {
        id: INSTANCE_ID,
        name: 'Example JIRA',
        baseUrl: 'https://jira.example.com',
        apiToken: 'pat',
        ...instance
      }
    });
  };

  const stubInstances = (instances) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      instances
    }));
  };

  const stubFetchSequence = (responses) => {
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: response.ok !== false,
        status: response.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => response.body,
        text: async () => JSON.stringify(response.body)
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCloudAssigneeCache();
  });

  it('resolves a Cloud email to accountId and caches it for later tickets', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-123', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'PROJ-1' } },
      { body: { key: 'PROJ-2' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'First', assignee: 'assignee@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Second', assignee: 'assignee@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const searchUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(searchUrl.pathname).toBe('/rest/api/2/user/search');
    expect(searchUrl.searchParams.get('query')).toBe('assignee@example.com');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-123' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-123' });
  });

  it('resolves a Cloud display name to accountId', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-456', displayName: 'Example Assignee' }] },
      { body: { key: 'PROJ-3' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Display name', assignee: 'Example Assignee' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-456' });
  });

  it('resolves a privacy-redacted Cloud email result when it is unique', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-567' }] },
      { body: { key: 'PROJ-8' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Redacted email', assignee: 'private@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-567' });
  });

  it('keeps Server/DC assignees as name without a user-search request', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-4' } }]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Server ticket', assignee: 'jdoe' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.assignee).toEqual({ name: 'jdoe' });
  });

  it('creates unassigned Cloud tickets and retries an unresolvable assignee', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [] },
      { body: { key: 'PROJ-5' } },
      { body: [] },
      { body: { key: 'PROJ-6' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Unassigned', assignee: 'missing@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Still unassigned', assignee: 'missing@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields).not.toHaveProperty('assignee');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be resolved'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not assign a Cloud ticket when the search result is ambiguous', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-789', displayName: 'Example User' },
        { accountId: 'acct-987', displayName: 'Example User' }
      ] },
      { body: { key: 'PROJ-7' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Ambiguous', assignee: 'Example User' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('does not use the privacy fallback across multiple returned candidates', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-789' },
        { accountId: 'acct-987', displayName: 'Other User' }
      ] },
      { body: { key: 'PROJ-9' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Mixed candidates', assignee: 'private@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('creates unassigned tickets for malformed Cloud search responses and retries', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: { users: [] } },
      { body: { key: 'PROJ-10' } },
      { body: [{ accountId: 'acct-999', emailAddress: 'retry@example.com' }] },
      { body: { key: 'PROJ-11' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Malformed response', assignee: 'retry@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Retry response', assignee: 'retry@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-999' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  it('creates unassigned tickets when Cloud user search fails and retries', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { ok: false, status: 503, body: { errorMessages: ['temporary failure'] } },
      { body: { key: 'PROJ-12' } },
      { body: [{ accountId: 'acct-1000', emailAddress: 'retry@example.com' }] },
      { body: { key: 'PROJ-13' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Failed lookup', assignee: 'retry@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Retry failed lookup', assignee: 'retry@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-1000' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  it('normalizes the Cloud cache key for case-only assignee changes', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-case', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'PROJ-14' } },
      { body: { key: 'PROJ-15' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Lowercase', assignee: 'assignee@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Uppercase', assignee: 'ASSIGNEE@EXAMPLE.COM' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-case' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-case' });
  });

  it('ignores inactive and app accounts when resolving a Cloud assignee', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-inactive', emailAddress: 'assignee@example.com', active: false },
        { accountId: 'acct-app', emailAddress: 'assignee@example.com', accountType: 'app' }
      ] },
      { body: { key: 'PROJ-16' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Inactive', assignee: 'assignee@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('does not use a filtered candidate as the privacy fallback', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-inactive', displayName: 'Jane', active: false },
        { accountId: 'acct-janet', displayName: 'Janet Roe' }
      ] },
      { body: { key: 'PROJ-18' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Filtered candidate', assignee: 'Jane' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('omits whitespace-only assignees without a Cloud lookup', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-17' } }]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Blank assignee', assignee: '   ' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields).not.toHaveProperty('assignee');
  });

  it('isolates assignee caches per Jira instance', async () => {
    stubInstances({
      'jira-one': { id: 'jira-one', baseUrl: 'https://one.atlassian.net', email: 'one@example.com', apiToken: 'token' },
      'jira-two': { id: 'jira-two', baseUrl: 'https://two.atlassian.net', email: 'two@example.com', apiToken: 'token' }
    });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-one', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'ONE-1' } },
      { body: [{ accountId: 'acct-two', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'TWO-1' } }
    ]);

    await createTicket('jira-one', { projectKey: 'ONE', summary: 'One', assignee: 'assignee@example.com' });
    await createTicket('jira-two', { projectKey: 'TWO', summary: 'Two', assignee: 'assignee@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-one' });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-two' });
  });

  it('coalesces concurrent lookups and invalidates them on instance changes', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-first', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-11' } },
      { body: { key: 'PROJ-12' } },
      { body: [{ accountId: 'acct-updated', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-13' } },
      { body: [{ accountId: 'acct-deleted', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-14' } }
    ]);
    vi.spyOn(fs, 'writeFile').mockResolvedValue();

    await Promise.all([
      createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Concurrent one', assignee: 'concurrent@example.com' }),
      createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Concurrent two', assignee: 'concurrent@example.com' })
    ]);
    await upsertInstance(INSTANCE_ID, {
      name: 'Example JIRA',
      baseUrl: 'https://example.atlassian.net',
      email: 'me@example.com',
      apiToken: 'new-token'
    });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Updated', assignee: 'concurrent@example.com' });
    await deleteInstance(INSTANCE_ID);
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Deleted', assignee: 'concurrent@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-first' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-first' });
    expect(JSON.parse(fetchMock.mock.calls[4][1].body).fields.assignee).toEqual({ accountId: 'acct-updated' });
    expect(JSON.parse(fetchMock.mock.calls[6][1].body).fields.assignee).toEqual({ accountId: 'acct-deleted' });
  });
});

describe('buildColumnsFromBoardConfig', () => {
  const statusById = new Map([
    ['1', { name: 'To Do', category: 'To Do' }],
    ['2', { name: 'In Progress', category: 'In Progress' }],
    ['3', { name: 'Blocked', category: 'In Progress' }],
    ['4', { name: 'In Review', category: 'In Progress' }],
    ['5', { name: 'Done', category: 'Done' }]
  ]);

  it('maps board status ids to names and preserves board column order', () => {
    const boardColumns = [
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: 2 }] },
      { name: 'Blocked', statuses: [{ id: '3' }] },
      { name: 'In Review', statuses: [{ id: '4' }] },
      { name: 'Done', statuses: [{ id: '5' }] }
    ];
    const result = buildColumnsFromBoardConfig(boardColumns, statusById);
    expect(result.map(c => c.name)).toEqual(['To Do', 'In Progress', 'Blocked', 'In Review', 'Done']);
    expect(result.find(c => c.name === 'Blocked')).toEqual({
      name: 'Blocked',
      category: 'In Progress',
      statuses: ['Blocked']
    });
  });

  it('tolerates numeric and string status ids', () => {
    const result = buildColumnsFromBoardConfig([{ name: 'Go', statuses: [{ id: 2 }, { id: '4' }] }], statusById);
    expect(result[0].statuses).toEqual(['In Progress', 'In Review']);
  });

  it('drops columns that map to no known status (e.g. empty backlog column)', () => {
    const boardColumns = [
      { name: 'Backlog', statuses: [] },
      { name: 'Unknown', statuses: [{ id: '999' }] },
      { name: 'Done', statuses: [{ id: '5' }] }
    ];
    const result = buildColumnsFromBoardConfig(boardColumns, statusById);
    expect(result.map(c => c.name)).toEqual(['Done']);
  });

  it('derives the column category from its first mapped status', () => {
    const result = buildColumnsFromBoardConfig([{ name: 'WIP', statuses: [{ id: '3' }, { id: '5' }] }], statusById);
    expect(result[0].category).toBe('In Progress');
  });

  it('returns [] for empty/missing input', () => {
    expect(buildColumnsFromBoardConfig([], statusById)).toEqual([]);
    expect(buildColumnsFromBoardConfig(undefined, statusById)).toEqual([]);
  });
});

describe('buildColumnsFromStatuses', () => {
  it('produces one single-status column per status, ordered by category', () => {
    const statusOrder = [
      { name: 'In Review', category: 'In Progress' },
      { name: 'Done', category: 'Done' },
      { name: 'To Do', category: 'To Do' },
      { name: 'Blocked', category: 'In Progress' }
    ];
    const result = buildColumnsFromStatuses(statusOrder);
    expect(result.map(c => c.name)).toEqual(['To Do', 'In Review', 'Blocked', 'Done']);
    expect(result[1]).toEqual({ name: 'In Review', category: 'In Progress', statuses: ['In Review'] });
  });

  it('keeps discovery order stable within a category', () => {
    const statusOrder = [
      { name: 'Blocked', category: 'In Progress' },
      { name: 'In Progress', category: 'In Progress' },
      { name: 'In Review', category: 'In Progress' }
    ];
    expect(buildColumnsFromStatuses(statusOrder).map(c => c.name)).toEqual(['Blocked', 'In Progress', 'In Review']);
  });

  it('treats unknown categories as In Progress for ordering', () => {
    const statusOrder = [
      { name: 'Mystery', category: 'Weird' },
      { name: 'To Do', category: 'To Do' },
      { name: 'Done', category: 'Done' }
    ];
    expect(buildColumnsFromStatuses(statusOrder).map(c => c.name)).toEqual(['To Do', 'Mystery', 'Done']);
  });

  it('returns [] for empty/missing input', () => {
    expect(buildColumnsFromStatuses([])).toEqual([]);
    expect(buildColumnsFromStatuses(undefined)).toEqual([]);
  });
});
