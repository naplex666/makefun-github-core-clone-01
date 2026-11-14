import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';

// Deterministic RNG / Viewer Computation (FNV-1a 64-bit + splitmix64 + xorshift64*)
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= 0x100000001b3n;
  }
  return hash & U64_MASK;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Xorshift64Star {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

function scenarioRng(label: string): Xorshift64Star {
  return new Xorshift64Star(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jensen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

function generateUsers(rng: Xorshift64Star, count: number): { login: string; id: number }[] {
  const used = new Set<string>();
  const users: { login: string; id: number }[] = [];
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix++;
    }
    used.add(login);
    users.push({ login, id: 1000 + i });
  }
  return users;
}

const usersList = generateUsers(scenarioRng('users'), 12);
const VIEWER_LOGIN = usersList[0].login; // adaiversen
if (VIEWER_LOGIN !== 'adaiversen') {
  throw new Error(`Unexpected viewer login: ${VIEWER_LOGIN}`);
}

// Logical Clock & Request ID Counter
let tick = 0;
function nowIso(): string {
  tick++;
  return new Date(Date.UTC(2025, 0, 1) + tick * 1000).toISOString();
}

let reqCounter = 0;
function nextReqId(): string {
  return `req-${++reqCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 
    'content-type': JSON_TYPE, 
    'content-length': Buffer.byteLength(text), 
    'x-github-request-id': nextReqId(),
    ...headers 
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function searchParamsOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  description: string | null;
  gitObjects: Map<string, Buffer>;
  refs: Map<string, string>;
  packCache: Map<string, Buffer>;
  branchFiles?: Map<string, Map<string, string>>;
  commitFiles?: Map<string, Map<string, string>>;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  createdAt: string;
  updatedAt: string;
}

const repos = new Map<string, Repo>();
const issuesMap = new Map<string, Issue[]>();
const pullsMap = new Map<string, Pull[]>();
const labelsMap = new Map<string, Set<string>>();

let repoIdCounter = 5000;
let issueIdCounter = 1;
let commentIdCounter = 1;
let pullIdCounter = 1;

const MCP_TOOLS_FROZEN = Object.freeze([
  Object.freeze({ name: 'create_repo', description: 'Create a repository', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ name: Object.freeze({ type: 'string' }), owner: Object.freeze({ type: 'string' }) }), required: Object.freeze(['name']) }) }),
  Object.freeze({ name: 'get_repo', description: 'Get a repository', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ owner: Object.freeze({ type: 'string' }), repo: Object.freeze({ type: 'string' }), repository: Object.freeze({ type: 'string' }) }), required: Object.freeze([]) }) }),
  Object.freeze({ name: 'create_issue', description: 'Create an issue', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ owner: Object.freeze({ type: 'string' }), repo: Object.freeze({ type: 'string' }), repository: Object.freeze({ type: 'string' }), title: Object.freeze({ type: 'string' }), body: Object.freeze({ type: 'string' }) }), required: Object.freeze(['title']) }) }),
  Object.freeze({ name: 'list_issues', description: 'List issues', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ owner: Object.freeze({ type: 'string' }), repo: Object.freeze({ type: 'string' }), repository: Object.freeze({ type: 'string' }), state: Object.freeze({ type: 'string' }) }), required: Object.freeze([]) }) }),
  Object.freeze({ name: 'create_pull_request', description: 'Create a PR', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ owner: Object.freeze({ type: 'string' }), repo: Object.freeze({ type: 'string' }), repository: Object.freeze({ type: 'string' }), title: Object.freeze({ type: 'string' }), head: Object.freeze({ type: 'string' }), base: Object.freeze({ type: 'string' }) }), required: Object.freeze(['title', 'head', 'base']) }) }),
  Object.freeze({ name: 'merge_pull_request', description: 'Merge a PR', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ owner: Object.freeze({ type: 'string' }), repo: Object.freeze({ type: 'string' }), repository: Object.freeze({ type: 'string' }), pull_number: Object.freeze({ type: 'number' }), number: Object.freeze({ type: 'number' }) }), required: Object.freeze([]) }) })
]);

function getRepoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const authHeader = req.headers['authorization'];

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const token = process.env.MAKEFUN_SHOP_TOKEN;
    if (authHeader !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (method === 'GET' && path === '/api/v3/user') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: 1000,
        type: 'User',
        name: 'Ada Iversen'
      });
      return;
    }

    // GraphQL endpoint
    if (method === 'POST' && path === '/api/graphql') {
      const bodyBuf = await readBody(req);
      let payload: any;
      try {
        payload = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON' });
        return;
      }

      const queries = Array.isArray(payload) ? payload : [payload];
      const results: any[] = [];

      for (const q of queries) {
        const queryStr = q.query || '';
        const data: any = {};
        const errors: any[] = [];

        if (queryStr.includes('viewer')) {
          data.viewer = { login: VIEWER_LOGIN, id: 'U_1' };
        }
        if (queryStr.includes('repository(')) {
          const ownerMatch = queryStr.match(/owner:\s*"([^"]+)"/);
          const nameMatch = queryStr.match(/name:\s*"([^"]+)"/);
          if (ownerMatch && nameMatch) {
            const repoKey = getRepoKey(ownerMatch[1], nameMatch[1]);
            const repo = repos.get(repoKey);
            if (!repo) {
              data.repository = null;
            } else {
              data.repository = {
                id: 'R_' + repo.name,
                name: repo.name,
                owner: { login: repo.owner },
                issues: {
                  nodes: (issuesMap.get(repoKey) || []).map(i => ({
                    id: 'I_' + i.id,
                    number: i.number,
                    title: i.title,
                    state: i.state.toUpperCase()
                  }))
                }
              };
            }
          }
        }

        if (queryStr.includes('__schema') || queryStr.includes('__type')) {
          data.__schema = {
            types: [
              { name: 'Issue' },
              { name: 'PullRequest' },
              { name: 'Repository' },
              { name: 'SearchType' }
            ]
          };
        }

        const resObj: any = { data };
        if (errors.length > 0) resObj.errors = errors;
        results.push(resObj);
      }

      sendJson(res, 200, Array.isArray(payload) ? results : results[0]);
      return;
    }

    // MCP endpoint
    if (method === 'POST' && path === '/mcp') {
      const bodyBuf = await readBody(req);
      let rpc: any;
      try {
        rpc = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
        return;
      }

      const methodRpc = rpc.method;
      const id = rpc.id;
      const params = rpc.params || {};

      if (methodRpc === 'server/discover') {
        sendJson(res, 200, { jsonrpc: '2.0', result: { supportedVersions: ['2026-07-28'] }, id });
        return;
      }
      if (methodRpc === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', result: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'forge', version: '1.0' } }, id });
        return;
      }
      if (methodRpc === 'notifications/initialized') {
        res.writeHead(200, { 'content-type': JSON_TYPE, 'x-github-request-id': nextReqId() });
        res.end();
        return;
      }
      if (methodRpc === 'tools/list') {
        sendJson(res, 200, { jsonrpc: '2.0', result: { tools: MCP_TOOLS_FROZEN }, id });
        return;
      }
      if (methodRpc === 'tools/call') {
        const rawToolName = params.name || '';
        const toolName = rawToolName.includes('__') ? rawToolName.split('__').pop() : rawToolName;
        const args = params.arguments || {};
        const lowerToolName = toolName.toLowerCase();

        const owner = args.owner || VIEWER_LOGIN;
        const repoName = args.repo || args.repository;

        if (lowerToolName === 'create_repo') {
          const name = args.name;
          if (!name) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing repository name' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, name);
          const now = nowIso();
          const repoId = repoIdCounter++;
          const repo: Repo = {
            id: repoId,
            owner, name, private: false, defaultBranch: 'main', createdAt: now, updatedAt: now, description: null,
            gitObjects: new Map(), refs: new Map(), packCache: new Map(), branchFiles: new Map(), commitFiles: new Map()
          };
          repos.set(repoKey, repo);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(repo) }] }, id });
          return;
        }

        if (lowerToolName === 'get_repo') {
          if (!repoName) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing repository name' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, repoName);
          const repo = repos.get(repoKey);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true }, id });
            return;
          }
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(repo) }] }, id });
          return;
        }

        if (lowerToolName === 'create_issue') {
          if (!repoName || !args.title) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing repository or title' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, repoName);
          const repo = repos.get(repoKey);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true }, id });
            return;
          }
          const repoIssues = issuesMap.get(repoKey) || [];
          const now = nowIso();
          const newIssue: Issue = {
            id: issueIdCounter++,
            number: repoIssues.length + 1,
            title: args.title,
            body: args.body || '',
            state: 'open',
            user: VIEWER_LOGIN,
            labels: [],
            createdAt: now,
            updatedAt: now,
            comments: []
          };
          repoIssues.push(newIssue);
          issuesMap.set(repoKey, repoIssues);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(newIssue) }] }, id });
          return;
        }

        if (lowerToolName === 'list_issues') {
          if (!repoName) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing repository' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, repoName);
          const repoIssues = issuesMap.get(repoKey) || [];
          const state = args.state || 'open';
          const filtered = repoIssues.filter(i => state === 'all' || i.state === state);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(filtered) }] }, id });
          return;
        }

        if (lowerToolName === 'create_pull_request') {
          if (!repoName || !args.title || !args.head || !args.base) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing required arguments for PR' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, repoName);
          const repo = repos.get(repoKey);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true }, id });
            return;
          }
          const repoPulls = pullsMap.get(repoKey) || [];
          const headSha = repo.refs.get('refs/heads/' + args.head) || '0000000000000000000000000000000000000000';
          const baseSha = repo.refs.get('refs/heads/' + args.base) || '0000000000000000000000000000000000000000';
          const now = nowIso();
          const newPull: Pull = {
            id: pullIdCounter++,
            number: repoPulls.length + 1,
            title: args.title,
            body: args.body || '',
            state: 'open',
            head: { ref: args.head, sha: headSha },
            base: { ref: args.base, sha: baseSha },
            user: VIEWER_LOGIN,
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            createdAt: now,
            updatedAt: now
          };
          repoPulls.push(newPull);
          pullsMap.set(repoKey, repoPulls);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(newPull) }] }, id });
          return;
        }

        if (lowerToolName === 'merge_pull_request') {
          const prNum = args.pull_number ?? args.number;
          if (!repoName || prNum === undefined) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Missing repository or pull_number' }], isError: true }, id });
            return;
          }
          const repoKey = getRepoKey(owner, repoName);
          const repo = repos.get(repoKey);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true }, id });
            return;
          }
          const repoPulls = pullsMap.get(repoKey) || [];
          const pull = repoPulls.find(p => p.number === Number(prNum));
          if (!pull) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Pull request not found' }], isError: true }, id });
            return;
          }
          if (pull.merged || pull.state === 'closed') {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Already merged or closed' }], isError: true }, id });
            return;
          }
          const commitSha = crypto.createHash('sha1').update(`squash-mcp-${pull.id}-${nowIso()}`).digest('hex');
          pull.state = 'closed';
          pull.merged = true;
          const mergedAtTime = nowIso();
          pull.merged_at = mergedAtTime;
          pull.merge_commit_sha = commitSha;
          pull.updatedAt = mergedAtTime;

          repo.refs.set('refs/heads/' + pull.base.ref, commitSha);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify({ sha: commitSha, merged: true, message: `Merged PR #${pull.number}` }) }] }, id });
          return;
        }

        sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${rawToolName}` }, id });
        return;
      }

      sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
      return;
    }

    // Git Smart HTTP
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      const [, owner, repoName, action] = gitMatch;
      const repoKey = getRepoKey(owner, repoName);
      const repo = repos.get(repoKey);
      if (!repo) {
        sendJson(res, 404, { message: 'Repository not found' });
        return;
      }

      if (action === 'info/refs') {
        const service = searchParamsOf(req).get('service');
        if (service === 'git-upload-pack' || service === 'git-receive-pack') {
          const pktLine = (str: string) => (str.length + 4).toString(16).padStart(4, '0') + str;
          const header = pktLine(`# service=${service}\n`);
          let refsPkt = '';
          const headOid = repo.refs.get('refs/heads/' + repo.defaultBranch) || repo.refs.get('HEAD') || '0000000000000000000000000000000000000000';
          refsPkt += pktLine(`${headOid} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack side-band-64k ofs-delta agent=git/forge\n`);
          for (const [refName, oid] of repo.refs.entries()) {
            if (refName === 'HEAD') continue;
            refsPkt += pktLine(`${oid} ${refName}\n`);
          }
          const body = header + '0000' + refsPkt + '0000';
          res.writeHead(200, {
            'content-type': `application/x-${service}-advertisement`,
            'content-length': Buffer.byteLength(body),
            'x-github-request-id': nextReqId()
          });
          res.end(body);
          return;
        } else {
          const protocolHeader = req.headers['git-protocol'] as string;
          if (protocolHeader?.includes('version=2')) {
            const pktLine = (str: string) => (str.length + 4).toString(16).padStart(4, '0') + str;
            const body = pktLine('version 2\n') + pktLine('agent=git/forge\n') + '0000';
            res.writeHead(200, {
              'content-type': 'application/x-git-upload-pack-advertisement',
              'content-length': Buffer.byteLength(body),
              'x-github-request-id': nextReqId()
            });
            res.end(body);
            return;
          }
          sendJson(res, 400, { message: 'Invalid service' });
          return;
        }
      }

      if (action === 'git-upload-pack') {
        const tipOid = repo.refs.get('refs/heads/' + repo.defaultBranch) || '0000000000000000000000000000000000000000';
        let packBytes = repo.packCache.get(tipOid);
        if (!packBytes) {
          const packHeader = Buffer.alloc(12);
          packHeader.write('PACK', 0);
          packHeader.writeUInt32BE(2, 4);
          packHeader.writeUInt32BE(0, 8);
          const sha = crypto.createHash('sha1').update(packHeader).digest();
          packBytes = Buffer.concat([packHeader, sha]);
          repo.packCache.set(tipOid, packBytes);
        }

        const sidebandChunks: Buffer[] = [];
        sidebandChunks.push(Buffer.from('0032ACK ' + tipOid + '\n'));
        sidebandChunks.push(Buffer.from('0008NAK\n'));

        let offset = 0;
        while (offset < packBytes.length) {
          const chunkLen = Math.min(packBytes.length - offset, 65516);
          const slice = packBytes.subarray(offset, offset + chunkLen);
          const pktLen = (chunkLen + 5).toString(16).padStart(4, '0');
          sidebandChunks.push(Buffer.concat([Buffer.from(pktLen + '\x01'), slice]));
          offset += chunkLen;
        }
        sidebandChunks.push(Buffer.from('0000'));

        const responseBuf = Buffer.concat(sidebandChunks);
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': responseBuf.length,
          'x-github-request-id': nextReqId()
        });
        res.end(responseBuf);
        return;
      }

      if (action === 'git-receive-pack') {
        const reqBuf = await readBody(req);
        let offset = 0;
        const commands: { oldOid: string; newOid: string; refName: string }[] = [];

        while (offset < reqBuf.length) {
          if (offset + 4 > reqBuf.length) break;
          const lenHex = reqBuf.subarray(offset, offset + 4).toString('ascii');
          const len = parseInt(lenHex, 16);
          if (isNaN(len) || len === 0) {
            offset += 4;
            break;
          }
          const line = reqBuf.subarray(offset + 4, offset + len).toString('utf8');
          offset += len;
          const [cmdPart] = line.split('\0');
          const [oldOid, newOid, refName] = cmdPart.trim().split(/\s+/);
          if (oldOid && newOid && refName) {
            commands.push({ oldOid, newOid, refName });
          }
        }

        const reportLines: string[] = ['unpack ok\n'];
        for (const cmd of commands) {
          const currentOid = repo.refs.get(cmd.refName) || '0000000000000000000000000000000000000000';
          if (cmd.newOid === '0000000000000000000000000000000000000000') {
            repo.refs.delete(cmd.refName);
            reportLines.push(`ok ${cmd.refName}\n`);
          } else if (currentOid === cmd.oldOid || currentOid === '0000000000000000000000000000000000000000') {
            repo.refs.set(cmd.refName, cmd.newOid);
            reportLines.push(`ok ${cmd.refName}\n`);
          } else {
            reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
          }
        }

        let sidebandResp = '';
        for (const line of reportLines) {
          const len = (line.length + 5).toString(16).padStart(4, '0');
          sidebandResp += len + '\x01' + line;
        }
        sidebandResp += '0000';

        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'content-length': Buffer.byteLength(sidebandResp),
          'x-github-request-id': nextReqId()
        });
        res.end(sidebandResp);
        return;
      }
    }

    // REST API endpoints
    const urlParts = path.split('/').filter(Boolean);
    if (urlParts[0] === 'api' && urlParts[1] === 'v3') {
      const resource = urlParts[2];

      if (resource === 'user' && urlParts[3] === 'repos' && method === 'GET') {
        const allRepos = Array.from(repos.values());
        const queryParams = searchParamsOf(req);
        const page = parseInt(queryParams.get('page') || '1', 10);
        const perPage = parseInt(queryParams.get('per_page') || '30', 10);
        
        const start = (page - 1) * perPage;
        const slice = allRepos.slice(start, start + perPage);

        const headers: Record<string, string> = {};
        if (start + perPage < allRepos.length) {
          const host = req.headers['host'] || 'localhost';
          const proto = req.headers['x-forwarded-proto'] || 'http';
          const nextUrl = `${proto}://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers['link'] = `<${nextUrl}>; rel="next"`;
        }

        sendJson(res, 200, slice, headers);
        return;
      }

      if (resource === 'user' && urlParts[3] === 'repos' && method === 'POST') {
        const bodyBuf = await readBody(req);
        let body: any = {};
        try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

        const name = body.name;
        if (!name) {
          sendJson(res, 422, { message: 'Repository name required' });
          return;
        }

        const owner = VIEWER_LOGIN;
        const repoKey = getRepoKey(owner, name);
        if (repos.has(repoKey)) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return;
        }

        const now = nowIso();
        const repoId = repoIdCounter++;
        const newRepo: Repo = {
          id: repoId,
          owner, name, private: body.private ?? false, defaultBranch: body.default_branch || 'main',
          createdAt: now, updatedAt: now, description: body.description || null,
          gitObjects: new Map(), refs: new Map(), packCache: new Map(), branchFiles: new Map(), commitFiles: new Map()
        };
        repos.set(repoKey, newRepo);
        sendJson(res, 201, {
          id: newRepo.id,
          node_id: 'R_' + newRepo.name,
          name: newRepo.name,
          full_name: `${owner}/${newRepo.name}`,
          private: newRepo.private,
          owner: { login: owner, id: 1000 },
          default_branch: newRepo.defaultBranch,
          description: newRepo.description,
          created_at: newRepo.createdAt,
          updated_at: newRepo.updatedAt
        });
        return;
      }

      if (resource === 'repos' && urlParts[3] && urlParts[4]) {
        const owner = urlParts[3];
        const repoName = urlParts[4];
        if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        const repoKey = getRepoKey(owner, repoName);
        const repo = repos.get(repoKey);
        
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        const sub = urlParts[5];
        if (!sub && method === 'GET') {
          sendJson(res, 200, {
            id: repo.id,
            node_id: 'R_' + repo.name,
            name: repo.name,
            full_name: `${repo.owner}/${repo.name}`,
            private: repo.private,
            owner: { login: repo.owner, id: 1000 },
            default_branch: repo.defaultBranch,
            description: repo.description,
            created_at: repo.createdAt,
            updated_at: repo.updatedAt
          });
          return;
        }
        if (!sub && method === 'PATCH') {
          const bodyBuf = await readBody(req);
          let body: any = {};
          try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
          if (body.description !== undefined) repo.description = body.description;
          if (body.private !== undefined) repo.private = body.private;
          repo.updatedAt = nowIso();
          sendJson(res, 200, {
            id: repo.id,
            node_id: 'R_' + repo.name,
            name: repo.name,
            full_name: `${repo.owner}/${repo.name}`,
            private: repo.private,
            owner: { login: repo.owner, id: 1000 },
            default_branch: repo.defaultBranch,
            description: repo.description,
            created_at: repo.createdAt,
            updated_at: repo.updatedAt
          });
          return;
        }
        if (!sub && method === 'DELETE') {
          repos.delete(repoKey);
          res.writeHead(204, { 'x-github-request-id': nextReqId() });
          res.end();
          return;
        }

        if (sub === 'branches' && method === 'GET') {
          const branches: any[] = [];
          for (const [refName, oid] of repo.refs.entries()) {
            if (refName.startsWith('refs/heads/')) {
              const name = refName.replace('refs/heads/', '');
              branches.push({ name, commit: { sha: oid } });
            }
          }
          if (branches.length === 0) {
            branches.push({ name: repo.defaultBranch, commit: { sha: '0000000000000000000000000000000000000000' } });
          }
          sendJson(res, 200, branches);
          return;
        }

        if (sub === 'commits' && method === 'GET') {
          const commits: any[] = [];
          for (const [oid, content] of repo.gitObjects.entries()) {
            if (content.toString().startsWith('commit ')) {
              commits.push({
                sha: oid,
                commit: {
                  message: 'Commit message',
                  author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: repo.createdAt }
                }
              });
            }
          }
          sendJson(res, 200, commits);
          return;
        }

        if (sub === 'labels') {
          const repoLabels = labelsMap.get(repoKey) || new Set(['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']);
          labelsMap.set(repoKey, repoLabels);

          if (method === 'GET') {
            const list = Array.from(repoLabels).map(name => ({ name, color: 'ededed', description: '' }));
            sendJson(res, 200, list);
            return;
          }
          if (method === 'POST') {
            const bodyBuf = await readBody(req);
            let body: any = {};
            try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
            const labelName = body.name;
            if (!labelName) {
              sendJson(res, 422, { message: 'Label name required' });
              return;
            }
            repoLabels.add(labelName);
            sendJson(res, 201, { name: labelName, color: body.color || 'ededed', description: body.description || '' });
            return;
          }
        }

        if (sub === 'issues') {
          const issueNumOrSub = urlParts[6];
          const commentSub = urlParts[7];
          const repoIssues = issuesMap.get(repoKey) || [];

          if (!issueNumOrSub && method === 'GET') {
            const params = searchParamsOf(req);
            const state = params.get('state') || 'open';
            const sort = params.get('sort') || 'created';
            const direction = params.get('direction') || 'desc';

            let filtered = repoIssues.filter(i => state === 'all' || i.state === state);
            filtered.sort((a, b) => {
              const comp = a.createdAt.localeCompare(b.createdAt);
              return direction === 'asc' ? comp : -comp;
            });

            const formatted = filtered.map(i => ({
              ...i,
              user: { login: i.user, id: 1000 },
              labels: i.labels.map(l => ({ name: l })),
              comments: i.comments
            }));
            sendJson(res, 200, formatted);
            return;
          }

          if (!issueNumOrSub && method === 'POST') {
            const bodyBuf = await readBody(req);
            let body: any = {};
            try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

            const labels = body.labels || [];
            const repoLabels = labelsMap.get(repoKey) || new Set(['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']);
            labelsMap.set(repoKey, repoLabels);

            for (const l of labels) {
              const labelName = typeof l === 'string' ? l : l.name;
              if (labelName && !repoLabels.has(labelName)) {
                sendJson(res, 422, { message: `Unknown label: ${labelName}` });
                return;
              }
            }

            const now = nowIso();
            const newIssue: Issue = {
              id: issueIdCounter++,
              number: repoIssues.length + 1,
              title: body.title || '',
              body: body.body || '',
              state: 'open',
              user: VIEWER_LOGIN,
              labels: labels.map((l: any) => typeof l === 'string' ? l : l.name),
              createdAt: now,
              updatedAt: now,
              comments: []
            };
            repoIssues.push(newIssue);
            issuesMap.set(repoKey, repoIssues);
            sendJson(res, 201, {
              ...newIssue,
              user: { login: newIssue.user, id: 1000 },
              labels: newIssue.labels.map(l => ({ name: l }))
            });
            return;
          }

          // Specific issue operations: /issues/{n} or /issues/{n}/comments
          if (issueNumOrSub && !isNaN(Number(issueNumOrSub))) {
            const issueNum = Number(issueNumOrSub);
            const issue = repoIssues.find(i => i.number === issueNum);
            if (!issue) {
              sendJson(res, 404, { message: 'Issue not found' });
              return;
            }

            if (!commentSub && method === 'GET') {
              sendJson(res, 200, {
                ...issue,
                user: { login: issue.user, id: 1000 },
                labels: issue.labels.map(l => ({ name: l })),
                comments: issue.comments.length
              });
              return;
            }

            if (!commentSub && method === 'PATCH') {
              const bodyBuf = await readBody(req);
              let body: any = {};
              try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

              if (body.state) issue.state = body.state;
              if (body.title) issue.title = body.title;
              if (body.body !== undefined) issue.body = body.body;
              issue.updatedAt = nowIso();

              sendJson(res, 200, {
                ...issue,
                user: { login: issue.user, id: 1000 },
                labels: issue.labels.map(l => ({ name: l }))
              });
              return;
            }

            if (commentSub === 'comments') {
              if (method === 'GET') {
                const formattedComments = issue.comments.map(c => ({
                  ...c,
                  user: { login: c.user, id: 1000 }
                }));
                sendJson(res, 200, formattedComments);
                return;
              }
              if (method === 'POST') {
                const bodyBuf = await readBody(req);
                let body: any = {};
                try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

                const newComment: Comment = {
                  id: commentIdCounter++,
                  body: body.body || '',
                  user: VIEWER_LOGIN,
                  createdAt: nowIso()
                };
                issue.comments.push(newComment);
                sendJson(res, 201, {
                  ...newComment,
                  user: { login: newComment.user, id: 1000 }
                });
                return;
              }
            }
          }
        }

        if (sub === 'pulls') {
          const pullNumOrSub = urlParts[6];
          const actionSub = urlParts[7];
          const repoPulls = pullsMap.get(repoKey) || [];

          if (!pullNumOrSub && method === 'GET') {
            const params = searchParamsOf(req);
            const state = params.get('state') || 'open';
            let filtered = repoPulls.filter(p => state === 'all' || p.state === state);
            const formatted = filtered.map(p => ({
              ...p,
              user: { login: p.user, id: 1000 }
            }));
            sendJson(res, 200, formatted);
            return;
          }

          if (!pullNumOrSub && method === 'POST') {
            const bodyBuf = await readBody(req);
            let body: any = {};
            try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

            const title = body.title || '';
            const bodyText = body.body || '';
            const headInput = body.head;
            const baseInput = body.base;
            const headRefName = typeof headInput === 'string' ? headInput : (headInput?.ref || repo.defaultBranch);
            const baseRefName = typeof baseInput === 'string' ? baseInput : (baseInput?.ref || repo.defaultBranch);

            const headSha = repo.refs.get('refs/heads/' + headRefName) || '0000000000000000000000000000000000000000';
            const baseSha = repo.refs.get('refs/heads/' + baseRefName) || '0000000000000000000000000000000000000000';

            const now = nowIso();
            const newPull: Pull = {
              id: pullIdCounter++,
              number: repoPulls.length + 1,
              title,
              body: bodyText,
              state: 'open',
              head: { ref: headRefName, sha: headSha },
              base: { ref: baseRefName, sha: baseSha },
              user: VIEWER_LOGIN,
              merged: false,
              merged_at: null,
              merge_commit_sha: null,
              createdAt: now,
              updatedAt: now
            };
            repoPulls.push(newPull);
            pullsMap.set(repoKey, repoPulls);
            sendJson(res, 201, {
              ...newPull,
              user: { login: newPull.user, id: 1000 }
            });
            return;
          }

          if (pullNumOrSub && !isNaN(Number(pullNumOrSub))) {
            const pullNum = Number(pullNumOrSub);
            const pull = repoPulls.find(p => p.number === pullNum);
            if (!pull) {
              sendJson(res, 404, { message: 'Pull request not found' });
              return;
            }

            if (!actionSub && method === 'GET') {
              sendJson(res, 200, {
                ...pull,
                user: { login: pull.user, id: 1000 }
              });
              return;
            }

            if (actionSub === 'files' && method === 'GET') {
              const branchFilesMap = repo.branchFiles || new Map();
              const baseFiles = branchFilesMap.get(pull.base.ref) || new Map<string, string>();
              const headFiles = branchFilesMap.get(pull.head.ref) || new Map<string, string>();

              const files: any[] = [];
              const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
              for (const path of allPaths) {
                const baseContent = baseFiles.get(path);
                const headContent = headFiles.get(path);
                if (baseContent === undefined && headContent !== undefined) {
                  files.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
                } else if (baseContent !== undefined && headContent === undefined) {
                  files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
                } else if (baseContent !== headContent) {
                  files.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
                }
              }
              sendJson(res, 200, files);
              return;
            }

            if (actionSub === 'merge' && method === 'PUT') {
              if (pull.state === 'closed' || pull.merged) {
                sendJson(res, 405, { message: 'Pull Request already merged or closed' });
                return;
              }

              const commitSha = crypto.createHash('sha1').update(`squash-${pull.id}-${nowIso()}`).digest('hex');
              pull.state = 'closed';
              pull.merged = true;
              const mergedAtTime = nowIso();
              pull.merged_at = mergedAtTime;
              pull.merge_commit_sha = commitSha;
              pull.updatedAt = mergedAtTime;

              repo.refs.set('refs/heads/' + pull.base.ref, commitSha);
              if (repo.branchFiles && repo.branchFiles.has(pull.head.ref)) {
                repo.branchFiles.set(pull.base.ref, new Map(repo.branchFiles.get(pull.head.ref)!));
              }

              sendJson(res, 200, {
                sha: commitSha,
                merged: true,
                message: `Merged pull request #${pull.number} (${pull.title})`
              });
              return;
            }
          }
        }
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
