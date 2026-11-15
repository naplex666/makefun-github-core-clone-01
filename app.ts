import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { GitRepoStore, parseCommit, sha1Object, parseTree, packEncode, packDecode } from './gitstore.ts';
import { executeGraphQL } from './graphql.ts';

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
  store: GitRepoStore;
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
    try {
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

    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
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
      const gqlCtx = {
        repos, issuesMap, pullsMap, labelsMap, nowIso,
        viewerLogin: VIEWER_LOGIN, getRepoKey,
        nextIssueId: () => issueIdCounter++,
        nextPullId: () => pullIdCounter++,
        nextCommentId: () => commentIdCounter++
      };
      const queries = Array.isArray(payload) ? payload : [payload];
      const results: any[] = [];
      for (const q of queries) {
        results.push(executeGraphQL(q.query || '', q.variables || {}, gqlCtx));
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
        sendJson(res, 200, { jsonrpc: '2.0', result: { supportedVersions: ['2026-07-28'], serverInfo: { name: 'forge', version: '1.0' }, capabilities: { tools: {} } }, id });
        return;
      }
      if (methodRpc === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', result: { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0' } }, id });
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
            store: new GitRepoStore()
          };
          repos.set(repoKey, repo);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify({ id: repo.id, name: repo.name, full_name: repo.owner + '/' + repo.name, private: repo.private, default_branch: repo.defaultBranch, owner: { login: repo.owner } }) }] }, id });
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
          const headSha = repo.store.refs.get('refs/heads/' + args.head) || '0000000000000000000000000000000000000000';
          const baseSha = repo.store.refs.get('refs/heads/' + args.base) || '0000000000000000000000000000000000000000';
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
          const baseTipNow = repo.store.refs.get('refs/heads/' + pull.base.ref) || '0000000000000000000000000000000000000000';
          const mergeBaseOid = repo.store.mergeBase(pull.head.sha, baseTipNow);
          const ancestorFiles = mergeBaseOid ? repo.store.commitFileMap(mergeBaseOid) : new Map<string, Buffer>();
          const baseCurrentFiles = repo.store.commitFileMap(baseTipNow);
          const headFiles0 = repo.store.commitFileMap(pull.head.sha);
          let conflicted = false;
          for (const p of new Set([...ancestorFiles.keys(), ...baseCurrentFiles.keys(), ...headFiles0.keys()])) {
            const a = ancestorFiles.get(p);
            const b = baseCurrentFiles.get(p);
            const h = headFiles0.get(p);
            const same = (x?: Buffer, y?: Buffer) => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.equals(y));
            if (!same(h, a) && !same(b, a) && !same(h, b)) { conflicted = true; break; }
          }
          if (conflicted) {
            sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Merge conflict' }], isError: true }, id });
            return;
          }
          const baseTip = baseTipNow;
          const headFiles = headFiles0;
          const mergeTree = repo.store.writeTreeFromMap(headFiles);
          const commitSha = repo.store.writeCommit(mergeTree, baseTip === '0000000000000000000000000000000000000000' ? [] : [baseTip], `Squash merge PR #${pull.number}: ${pull.title}`);
          repo.store.commitFiles.set(commitSha, new Map(headFiles));
          repo.store.branchFiles.set(pull.base.ref, new Map<string, Buffer>(headFiles));
          pull.state = 'closed';
          pull.merged = true;
          const mergedAtTime = nowIso();
          pull.merged_at = mergedAtTime;
          pull.merge_commit_sha = commitSha;
          pull.updatedAt = mergedAtTime;

          repo.store.refs.set('refs/heads/' + pull.base.ref, commitSha);
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
        const protocolHeader = req.headers['git-protocol'] as string;
        if (service === 'git-receive-pack' || ((service === 'git-upload-pack') && !protocolHeader?.includes('version=2'))) {
          const pktLine = (str: string) => (str.length + 4).toString(16).padStart(4, '0') + str;
          const header = pktLine(`# service=${service}\n`);
          let refsPkt = '';
          const zeroOid = '0000000000000000000000000000000000000000';
          const headOid = repo.store.refs.get('refs/heads/' + repo.defaultBranch) || repo.store.refs.get('HEAD') || zeroOid;
          const caps = 'multi_ack multi_ack_detailed side-band-64k ofs-delta report-status delete-refs agent=git/forge';
          const refsEntries = Array.from(repo.store.refs.entries());

          if (refsEntries.length === 0) {
            refsPkt += pktLine(`${zeroOid} capabilities^{}\0${caps}\n`);
          } else {
            let first = true;
            for (const [refName, oid] of refsEntries) {
              if (refName === 'HEAD') continue;
              if (first) {
                refsPkt += pktLine(`${oid} ${refName}\0symref=HEAD:refs/heads/${repo.defaultBranch} ${caps}\n`);
                first = false;
              } else {
                refsPkt += pktLine(`${oid} ${refName}\n`);
              }
              // Check for annotated tag in store
              const obj = repo.store.objects.get(oid);
              if (obj && obj.type === 'tag') {
                try {
                  const tagText = obj.data.toString('utf8');
                  const m = tagText.match(/^object\s+([0-9a-f]{40})/m);
                  if (m) {
                    refsPkt += pktLine(`${m[1]} ${refName}^{}\n`);
                  }
                } catch {}
              }
            }
            if (first) {
              // Only HEAD was present
              refsPkt += pktLine(`${headOid} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} ${caps}\n`);
            }
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
            const body = pktLine('version 2\n') +
                         pktLine('ls-refs=unborn peel symrefs ref-prefix\n') +
                         pktLine('fetch=shallow filter\n') +
                         pktLine('agent=git/forge\n') +
                         pktLine('object-format=sha1\n') +
                         '0000';
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
        const reqBuf = await readBody(req);
        const packets: { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }[] = [];
        let offset = 0;
        while (offset < reqBuf.length) {
          if (offset + 4 > reqBuf.length) break;
          const lenHex = reqBuf.subarray(offset, offset + 4).toString('ascii');
          const len = parseInt(lenHex, 16);
          if (isNaN(len)) break;
          offset += 4;
          if (len === 0) {
            packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
          } else if (len === 1) {
            packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
          } else if (len === 2) {
            packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
          } else {
            const dataLen = len - 4;
            const payload = reqBuf.subarray(offset, offset + dataLen);
            offset += dataLen;
            packets.push({ kind: 'data', payload });
          }
        }

        const pktLine = (str: string) => (str.length + 4).toString(16).padStart(4, '0') + str;
        const zeroOid = '0000000000000000000000000000000000000000';

        // Check if v2 ls-refs command
        const firstData = packets.find(p => p.kind === 'data');
        const firstText = firstData ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';

        if (firstText.startsWith('command=ls-refs')) {
          let peel = false;
          let symrefs = false;
          let unborn = false;
          const refPrefixes: string[] = [];
          for (const p of packets) {
            if (p.kind !== 'data') continue;
            const t = p.payload.toString('utf8').replace(/\n$/, '');
            if (t === 'peel') peel = true;
            else if (t === 'symrefs') symrefs = true;
            else if (t === 'unborn') unborn = true;
            else if (t.startsWith('ref-prefix ')) refPrefixes.push(t.slice(11).trim());
          }

          const outChunks: string[] = [];
          const matchesPrefix = (refName: string) => {
            if (refPrefixes.length === 0) return true;
            return refPrefixes.some(pref => refName.startsWith(pref));
          };

          const defaultBranchRef = 'refs/heads/' + repo.defaultBranch;
          const headOid = repo.store.refs.get(defaultBranchRef) || repo.store.refs.get('HEAD') || zeroOid;

          // HEAD handling
          if (matchesPrefix('HEAD')) {
            let line = `${headOid} HEAD`;
            if (symrefs) line += ` symref-target:${defaultBranchRef}`;
            outChunks.push(pktLine(line + '\n'));
          }

          for (const [refName, oid] of repo.store.refs.entries()) {
            if (refName === 'HEAD') continue;
            if (!matchesPrefix(refName)) continue;
            let line = `${oid} ${refName}`;
            if (symrefs && refName === defaultBranchRef) line += ` symref-target:${defaultBranchRef}`;
            if (peel) {
              const obj = repo.store.objects.get(oid);
              if (obj && obj.type === 'tag') {
                try {
                  const m = obj.data.toString('utf8').match(/^object\s+([0-9a-f]{40})/m);
                  if (m) line += ` peeled:${m[1]}`;
                } catch {}
              }
            }
            outChunks.push(pktLine(line + '\n'));
          }

          outChunks.push('0000');
          const respBuf = Buffer.from(outChunks.join(''));
          res.writeHead(200, {
            'content-type': 'application/x-git-upload-pack-result',
            'content-length': respBuf.length,
            'x-github-request-id': nextReqId()
          });
          res.end(respBuf);
          return;
        }

        // v2 fetch or v0 fetch
        let wants: string[] = [];
        let haves: string[] = [];
        let requestedShallow: string[] = [];
        let deepenDepth = 0;
        let isFetchCommand = firstText.startsWith('command=fetch');

        for (const p of packets) {
          if (p.kind !== 'data') continue;
          const t = p.payload.toString('utf8').replace(/\n$/, '');
          if (t.startsWith('want ')) {
            const parts = t.slice(5).trim().split(' ');
            wants.push(parts[0]);
          } else if (t.startsWith('have ')) {
            const parts = t.slice(5).trim().split(' ');
            haves.push(parts[0]);
          } else if (t.startsWith('deepen ')) {
            deepenDepth = parseInt(t.slice(7).trim(), 10) || 0;
          } else if (t.startsWith('shallow ')) {
            requestedShallow.push(t.slice(8).trim());
          }
        }

        // Early cache check (fix #4): the key is computable from the parsed
        // request alone, so a hit skips both walks + encodeMap.
        const cacheKey = [...wants].sort().join(',') + '|' + [...haves].sort().join(',') + '|d' + deepenDepth + '|s' + [...requestedShallow].sort().join(',');
        const allWantsPresent = wants.length > 0 && wants.every((w: string) => repo.store.objects.has(w));
        const cachedPack = allWantsPresent ? repo.store.packCache.get(cacheKey) : undefined;
        let packBytes: Buffer | undefined = cachedPack?.pack;
        let shallowOids: string[] = cachedPack?.shallowOids ?? [];
        let unshallowOids: string[] = cachedPack?.unshallowOids ?? [];
        if (!cachedPack) {

        // Compute object closure
        const visitedObjects = new Set<string>();
        const walkQueue = [...wants];
        let walkHead = 0;

        // If deepenDepth is set, limit commit parent traversal
        const commitDepths = new Map<string, number>();
        for (const w of wants) commitDepths.set(w, 1);

        while (walkHead < walkQueue.length) {
          const oid = walkQueue[walkHead++];
          if (visitedObjects.has(oid)) continue;
          const obj = repo.store.objects.get(oid);
          if (!obj) continue;
          visitedObjects.add(oid);

          const curDepth = commitDepths.get(oid) || 1;

          if (obj.type === 'commit') {
            try {
              const parsed = parseCommit(obj.data);
              if (parsed.tree) walkQueue.push(parsed.tree);
              if (deepenDepth === 0 || curDepth < deepenDepth) {
                for (const pOid of parsed.parents) {
                  commitDepths.set(pOid, curDepth + 1);
                  walkQueue.push(pOid);
                }
              }
            } catch {}
          } else if (obj.type === 'tree') {
            try {
              for (const entry of parseTree(obj.data)) {
                walkQueue.push(entry.oid);
              }
            } catch {}
          } else if (obj.type === 'tag') {
            try {
              const m = obj.data.toString('utf8').match(/^object\s+([0-9a-f]{40})/m);
              if (m) walkQueue.push(m[1]);
            } catch {}
          }
        }

        // Subtract haves if any: the FULL closure (commits + trees + blobs),
        // exactly like the want-walk, so already-held objects are never re-sent.
        if (haves.length > 0) {
          const haveReachable = new Set<string>();
          const hQueue = [...haves];
          let hHead = 0;
          while (hHead < hQueue.length) {
            const hOid = hQueue[hHead++];
            if (haveReachable.has(hOid)) continue;
            haveReachable.add(hOid);
            const obj = repo.store.objects.get(hOid);
            if (!obj) continue;
            if (obj.type === 'commit') {
              try {
                const parsed = parseCommit(obj.data);
                if (parsed.tree) hQueue.push(parsed.tree);
                // A shallow boundary's history is NOT held by the client:
                // include the commit itself (and its tree) but not its parents.
                if (!requestedShallow.includes(hOid)) {
                  for (const pOid of parsed.parents) hQueue.push(pOid);
                }
              } catch {}
            } else if (obj.type === 'tree') {
              try {
                for (const entry of parseTree(obj.data)) hQueue.push(entry.oid);
              } catch {}
            } else if (obj.type === 'tag') {
              try {
                const m = obj.data.toString('utf8').match(/^object\s+([0-9a-f]{40})/m);
                if (m) hQueue.push(m[1]);
              } catch {}
            }
          }
          for (const hOid of haveReachable) {
            visitedObjects.delete(hOid);
          }
        }

        // Build objects map for packEncode
        const encodeMap = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
        for (const oid of visitedObjects) {
          const obj = repo.store.objects.get(oid);
          if (obj) encodeMap.set(oid, obj);
        }

        // The pack for (wants, haves, deepen) is deterministic and immutable,
        // so cache it: 50 shallow clones of one tip share one pack build.
          packBytes = packEncode(encodeMap);
          // Derive shallow/unshallow from this walk (same logic as the
          // response block below) so a later hit can skip the walks.
          for (const [oid, depth] of commitDepths) {
            if (depth === deepenDepth && visitedObjects.has(oid)) {
              const obj = repo.store.objects.get(oid);
              if (obj && obj.type === 'commit') shallowOids.push(oid);
            }
          }
          for (const s of requestedShallow) {
            const obj = repo.store.objects.get(s);
            if (!obj || obj.type !== 'commit') continue;
            try {
              const parsed = parseCommit(obj.data);
              if (parsed.parents.some((p: string) => visitedObjects.has(p))) unshallowOids.push(s);
            } catch {}
          }
          if (allWantsPresent) repo.store.packCache.set(cacheKey, { pack: packBytes, shallowOids, unshallowOids });
        } // end if (!cachedPack)

        const responseChunks: Buffer[] = [];
        if (isFetchCommand) {
          responseChunks.push(Buffer.from(pktLine('acknowledgments\n')));
        }
        if (haves.length > 0) {
          let acked = false;
          for (const h of haves) {
            if (repo.store.objects.has(h)) {
              responseChunks.push(Buffer.from(pktLine(`ACK ${h}\n`)));
              acked = true;
            }
          }
          if (!acked) {
            responseChunks.push(Buffer.from(pktLine('NAK\n')));
          }
        } else {
          responseChunks.push(Buffer.from(pktLine('NAK\n')));
        }

        if (isFetchCommand) {
          responseChunks.push(Buffer.from('0001')); // delim: end of acknowledgments
          if (deepenDepth > 0) {
            responseChunks.push(Buffer.from(pktLine('shallow-info\n')));
            // Boundary commits + unshallow come from the walk, or from the
            // cache on a hit (fix #4) — same bytes either way.
            for (const oid of shallowOids) {
              responseChunks.push(Buffer.from(pktLine(`shallow ${oid}\n`)));
            }
            for (const s of unshallowOids) {
              responseChunks.push(Buffer.from(pktLine(`unshallow ${s}\n`)));
            }
            responseChunks.push(Buffer.from('0001')); // delim: end of shallow-info
          }
          responseChunks.push(Buffer.from(pktLine('wanted-refs\n')));
          for (const w of wants) {
            for (const [refName, oid] of repo.store.refs.entries()) {
              if (oid === w) responseChunks.push(Buffer.from(pktLine(`${w} ${refName}\n`)));
            }
          }
          responseChunks.push(Buffer.from('0001')); // delim: end of wanted-refs
          responseChunks.push(Buffer.from(pktLine('packfile\n')));
        }

        // Sideband band 1 packing
        let offsetPack = 0;
        while (offsetPack < packBytes.length) {
          const chunkLen = Math.min(packBytes.length - offsetPack, 65515);
          const slice = packBytes.subarray(offsetPack, offsetPack + chunkLen);
          const pktLen = (chunkLen + 5).toString(16).padStart(4, '0');
          responseChunks.push(Buffer.concat([Buffer.from(pktLen + '\x01'), slice]));
          offsetPack += chunkLen;
        }
        responseChunks.push(Buffer.from('0000')); // flush

        const responseBuf = Buffer.concat(responseChunks);
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

        // Store the pack that follows the command-list flush packet (if any).
        let unpackErr: string | null = null;
        const packBytes = reqBuf.subarray(offset);
        const hasPack = packBytes.length >= 12 && packBytes.subarray(0, 4).toString('ascii') === 'PACK';
        if (hasPack) {
          try {
            const decoded = packDecode(packBytes, repo.store.objects);
            for (const [oid, obj] of decoded) repo.store.objects.set(oid, obj);
          } catch (e: any) {
            unpackErr = e?.message || String(e);
          }
        }

        const reportLines: string[] = [];
        if (unpackErr) {
          reportLines.push(`unpack ${unpackErr}\n`);
          for (const cmd of commands) {
            reportLines.push(`ng ${cmd.refName} unpack failed\n`);
          }
        } else {
          if (hasPack) {
            reportLines.push('unpack ok\n');
          } else {
            reportLines.push('unpack ok\n');
          }
          for (const cmd of commands) {
            const zeroOid = '0000000000000000000000000000000000000000';
            const currentOid = repo.store.refs.get(cmd.refName) || zeroOid;
            const isDelete = cmd.newOid === zeroOid;
            const isCreate = cmd.oldOid === zeroOid;
            if (isDelete) {
              if (currentOid === zeroOid || currentOid !== cmd.oldOid) {
                reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
              } else {
                repo.store.refs.delete(cmd.refName);
                if (cmd.refName.startsWith('refs/heads/')) repo.store.branchFiles.delete(cmd.refName.replace('refs/heads/', ''));
                reportLines.push(`ok ${cmd.refName}\n`);
              }
            } else if (isCreate) {
              if (currentOid !== zeroOid) {
                reportLines.push(`ng ${cmd.refName} already exists\n`);
              } else if (!repo.store.objects.has(cmd.newOid)) {
                reportLines.push(`ng ${cmd.refName} missing object\n`);
              } else {
                repo.store.refs.set(cmd.refName, cmd.newOid);
                if (cmd.refName.startsWith('refs/heads/')) repo.store.branchFiles.set(cmd.refName.replace('refs/heads/', ''), repo.store.commitFileMap(cmd.newOid));
                reportLines.push(`ok ${cmd.refName}\n`);
              }
            } else if (currentOid !== cmd.oldOid) {
              reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
            } else if (!repo.store.isAncestor(cmd.newOid, cmd.oldOid)) {
              reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
            } else if (!repo.store.objects.has(cmd.newOid)) {
              reportLines.push(`ng ${cmd.refName} missing object\n`);
            } else {
              repo.store.refs.set(cmd.refName, cmd.newOid);
              if (cmd.refName.startsWith('refs/heads/')) repo.store.branchFiles.set(cmd.refName.replace('refs/heads/', ''), repo.store.commitFileMap(cmd.newOid));
              reportLines.push(`ok ${cmd.refName}\n`);
            }
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
        try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Malformed JSON body' }); return; }

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
          store: new GitRepoStore()
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
          for (const [refName, oid] of repo.store.refs.entries()) {
            if (refName.startsWith('refs/heads/') && oid !== '0000000000000000000000000000000000000000') {
              const name = refName.replace('refs/heads/', '');
              branches.push({ name, commit: { sha: oid } });
            }
          }
          sendJson(res, 200, branches);
          return;
        }

        if (sub === 'commits' && method === 'GET') {
          const branchParam = searchParamsOf(req).get('sha') || repo.defaultBranch;
          const tip = repo.store.refs.get('refs/heads/' + branchParam) || '';
          const commits: any[] = [];
          const seen = new Set<string>();
          const queue: string[] = tip && tip !== '0000000000000000000000000000000000000000' ? [tip] : [];
          while (queue.length > 0) {
            const oid = queue.shift()!;
            if (seen.has(oid)) continue;
            seen.add(oid);
            const obj = repo.store.objects.get(oid);
            if (!obj || obj.type !== 'commit') continue;
            const parsed = parseCommit(obj.data);
            const epochMatch = parsed.author.match(/ (\d+) \+0000$/);
            const epoch = epochMatch ? parseInt(epochMatch[1], 10) : 1735689600;
            const date = new Date(epoch * 1000).toISOString();
            commits.push({ sha: oid, commit: { message: parsed.message.trim(), author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date } }, parents: parsed.parents.map((p: string) => ({ sha: p })) });
            for (const p of parsed.parents) queue.push(p);
          }
          sendJson(res, 200, commits);
          return;
        }

        if (sub === 'git' && urlParts[6] === 'refs' && method === 'POST') {
          const bodyBuf = await readBody(req);
          let body: any = {};
          try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
          const ref = body.ref;
          const sha = body.sha;
          if (!ref || !sha) {
            sendJson(res, 422, { message: 'Ref and sha required' });
            return;
          }
          const commitObj = repo.store.objects.get(sha);
          if (!commitObj || commitObj.type !== 'commit') {
            sendJson(res, 422, { message: 'Commit sha not found' });
            return;
          }
          repo.store.refs.set(ref, sha);
          if (ref.startsWith('refs/heads/')) {
            const branchName = ref.replace('refs/heads/', '');
            const files = repo.store.commitFileMap(sha);
            repo.store.branchFiles.set(branchName, new Map(files));
          }
          sendJson(res, 201, {
            ref,
            object: { sha, type: 'commit', url: `http://localhost/repos/${owner}/${repo.name}/git/commits/${sha}` }
          });
          return;
        }

        if (sub === 'contents') {
          const filePath = urlParts.slice(6).join('/');
          const params = searchParamsOf(req);
          const branchParam = params.get('ref') || repo.defaultBranch;
          const branchRef = 'refs/heads/' + branchParam;
          const tip = repo.store.refs.get(branchRef) || '0000000000000000000000000000000000000000';
          const fileMap = tip === '0000000000000000000000000000000000000000' ? new Map<string, Buffer>() : repo.store.commitFileMap(tip);

          if (method === 'GET') {
            if (!filePath || filePath === '') {
              // Root directory listing
              const entries: any[] = [];
              const seenDirs = new Set<string>();
              for (const [path, buf] of fileMap.entries()) {
                const parts = path.split('/');
                if (parts.length === 1) {
                  const sha = sha1Object('blob', buf);
                  entries.push({ name: parts[0], path: parts[0], sha, size: buf.length, type: 'file' });
                } else {
                  const dirName = parts[0];
                  if (!seenDirs.has(dirName)) {
                    seenDirs.add(dirName);
                    entries.push({ name: dirName, path: dirName, sha: '0000000000000000000000000000000000000000', size: 0, type: 'dir' });
                  }
                }
              }
              sendJson(res, 200, entries);
              return;
            }

            const existing = fileMap.get(filePath);
            if (existing !== undefined) {
              const sha = sha1Object('blob', existing);
              const name = filePath.split('/').pop() || filePath;
              sendJson(res, 200, {
                name,
                path: filePath,
                sha,
                size: existing.length,
                type: 'file',
                encoding: 'base64',
                content: existing.toString('base64')
              });
              return;
            }

            // Check if directory
            const prefix = filePath + '/';
            const dirEntries: any[] = [];
            const seenSub = new Set<string>();
            for (const [path, buf] of fileMap.entries()) {
              if (path.startsWith(prefix)) {
                const rel = path.slice(prefix.length);
                const subParts = rel.split('/');
                const subName = subParts[0];
                if (!seenSub.has(subName)) {
                  seenSub.add(subName);
                  if (subParts.length === 1) {
                    const fullPath = filePath + '/' + subName;
                    const subBuf = fileMap.get(fullPath)!;
                    dirEntries.push({ name: subName, path: fullPath, sha: sha1Object('blob', subBuf), size: subBuf.length, type: 'file' });
                  } else {
                    dirEntries.push({ name: subName, path: prefix + subName, sha: '0000000000000000000000000000000000000000', size: 0, type: 'dir' });
                  }
                }
              }
            }
            if (dirEntries.length > 0) {
              sendJson(res, 200, dirEntries);
              return;
            }

            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (method === 'PUT') {
            const bodyBuf = await readBody(req);
            let body: any = {};
            try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

            const message = body.message || 'Update ' + filePath;
            const contentBase64 = body.content;
            if (typeof contentBase64 !== 'string') {
              sendJson(res, 400, { message: 'Invalid base64 content' });
              return;
            }
            let contentBuf: Buffer;
            try {
              contentBuf = Buffer.from(contentBase64.replace(/\s/g, ''), 'base64');
            } catch {
              sendJson(res, 400, { message: 'Invalid base64' });
              return;
            }

            const targetBranch = body.branch || branchParam;
            const targetBranchRef = 'refs/heads/' + targetBranch;
            const targetTip = repo.store.refs.get(targetBranchRef) || '0000000000000000000000000000000000000000';
            const targetFileMap = targetTip === '0000000000000000000000000000000000000000' ? new Map<string, Buffer>() : repo.store.commitFileMap(targetTip);

            const existing = targetFileMap.get(filePath);
            const existingSha = existing ? sha1Object('blob', existing) : undefined;

            if (existingSha) {
              if (!body.sha || body.sha !== existingSha) {
                sendJson(res, 409, { message: 'SHA mismatch or missing for existing file' });
                return;
              }
            } else {
              if (body.sha && body.sha !== '') {
                sendJson(res, 409, { message: 'SHA provided for non-existent file' });
                return;
              }
            }

            targetFileMap.set(filePath, contentBuf);
            const blobOid = repo.store.writeBlob(contentBuf);
            const treeOid = repo.store.writeTreeFromMap(targetFileMap);
            const parents = targetTip !== '0000000000000000000000000000000000000000' ? [targetTip] : [];
            const commitOid = repo.store.writeCommit(treeOid, parents, message);

            repo.store.refs.set(targetBranchRef, commitOid);
            repo.store.commitFiles.set(commitOid, new Map(targetFileMap));
            repo.store.branchFiles.set(targetBranch, new Map(targetFileMap));
            repo.store.packCache.delete(targetTip);

            // If default branch ref wasn't set or main, ensure refs/heads/main exists
            if (!repo.store.refs.has('refs/heads/' + repo.defaultBranch)) {
              repo.store.refs.set('refs/heads/' + repo.defaultBranch, commitOid);
            }

            const status = existingSha ? 200 : 201;
            const name = filePath.split('/').pop() || filePath;
            sendJson(res, status, {
              content: {
                name,
                path: filePath,
                sha: blobOid,
                size: contentBuf.length,
                type: 'file',
                encoding: 'base64',
                content: contentBuf.toString('base64')
              },
              commit: {
                sha: commitOid,
                message
              }
            });
            return;
          }

          if (method === 'DELETE') {
            const bodyBuf = await readBody(req);
            let body: any = {};
            try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

            const message = body.message || 'Delete ' + filePath;
            const targetBranch = body.branch || branchParam;
            const targetBranchRef = 'refs/heads/' + targetBranch;
            const targetTip = repo.store.refs.get(targetBranchRef) || '0000000000000000000000000000000000000000';
            if (targetTip === '0000000000000000000000000000000000000000') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }

            const targetFileMap = repo.store.commitFileMap(targetTip);
            const existing = targetFileMap.get(filePath);
            if (!existing) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const existingSha = sha1Object('blob', existing);
            if (!body.sha || body.sha !== existingSha) {
              sendJson(res, 409, { message: 'SHA mismatch' });
              return;
            }

            targetFileMap.delete(filePath);
            const treeOid = repo.store.writeTreeFromMap(targetFileMap);
            const commitOid = repo.store.writeCommit(treeOid, [targetTip], message);

            repo.store.refs.set(targetBranchRef, commitOid);
            repo.store.commitFiles.set(commitOid, new Map(targetFileMap));
            repo.store.branchFiles.set(targetBranch, new Map(targetFileMap));
            repo.store.packCache.delete(targetTip);

            sendJson(res, 200, {
              commit: {
                sha: commitOid,
                message
              }
            });
            return;
          }
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

            const headSha = repo.store.refs.get('refs/heads/' + headRefName) || '0000000000000000000000000000000000000000';
            const baseSha = repo.store.refs.get('refs/heads/' + baseRefName) || '0000000000000000000000000000000000000000';

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
              const baseFiles = repo.store.commitFileMap(pull.base.sha);
              const headFiles = repo.store.commitFileMap(pull.head.sha);

              const files: any[] = [];
              const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
              for (const path of allPaths) {
                const baseContent = baseFiles.get(path);
                const headContent = headFiles.get(path);
                if (baseContent === undefined && headContent !== undefined) {
                  files.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
                } else if (baseContent !== undefined && headContent === undefined) {
                  files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
                } else if (baseContent !== undefined && headContent !== undefined && !baseContent.equals(headContent)) {
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

              const baseTipNow = repo.store.refs.get('refs/heads/' + pull.base.ref) || '0000000000000000000000000000000000000000';
              const mergeBaseOid = repo.store.mergeBase(pull.head.sha, baseTipNow);
              const ancestorFiles = mergeBaseOid ? repo.store.commitFileMap(mergeBaseOid) : new Map<string, Buffer>();
              const baseCurrentFiles = repo.store.commitFileMap(baseTipNow);
              const headFiles0 = repo.store.commitFileMap(pull.head.sha);
              let conflicted = false;
              for (const p of new Set([...ancestorFiles.keys(), ...baseCurrentFiles.keys(), ...headFiles0.keys()])) {
                const a = ancestorFiles.get(p);
                const b = baseCurrentFiles.get(p);
                const h = headFiles0.get(p);
                const same = (x?: Buffer, y?: Buffer) => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.equals(y));
                if (!same(h, a) && !same(b, a) && !same(h, b)) { conflicted = true; break; }
              }
              if (conflicted) {
                sendJson(res, 405, { message: 'Merge conflict' });
                return;
              }
              const baseTip = baseTipNow;
              const headFiles = headFiles0;
              const mergeTree = repo.store.writeTreeFromMap(headFiles);
              const commitSha = repo.store.writeCommit(mergeTree, baseTip === '0000000000000000000000000000000000000000' ? [] : [baseTip], `Squash merge PR #${pull.number}: ${pull.title}`);
              repo.store.commitFiles.set(commitSha, new Map(headFiles));
              repo.store.branchFiles.set(pull.base.ref, new Map<string, Buffer>(headFiles));
              pull.state = 'closed';
              pull.merged = true;
              const mergedAtTime = nowIso();
              pull.merged_at = mergedAtTime;
              pull.merge_commit_sha = commitSha;
              pull.updatedAt = mergedAtTime;

              repo.store.refs.set('refs/heads/' + pull.base.ref, commitSha);

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
    } catch (err) {
      console.error('handler error:', err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else { try { res.end(); } catch {} }
    }
  });
}
