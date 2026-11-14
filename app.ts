import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';

// Deterministic RNG / Viewer Computation (FNV-1a 64-bit + splitmix64 + xorshift64*)
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= 0x100000001b3n;
  }
  return hash;
}

function splitmix64(state: { x: bigint }): bigint {
  state.x += 0x9e3779b97f4a7c15n;
  let z = state.x;
  z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n;
  z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn;
  return z ^ (z >> 31n);
}

class Xorshift64Star {
  state: bigint;
  constructor(seed: bigint) {
    this.state = seed === 0n ? 0x123456789abcdef0n : seed;
  }
  nextBigInt(): bigint {
    let x = this.state;
    x ^= x >> 12n;
    x ^= x << 25n;
    x ^= x >> 27n;
    this.state = x;
    return x * 0x2545f4914f6cdd1dn;
  }
  nextFloat(): number {
    return Number(this.nextBigInt() & 0xfffffffffffffn) / 4503599627370496;
  }
  nextInt(max: number): number {
    return Math.floor(this.nextFloat() * max);
  }
}

function scenarioRng(name: string): Xorshift64Star {
  const seed = fnv1a64(name) ^ SCENARIO_SEED;
  const smState = { x: seed };
  const s1 = splitmix64(smState);
  const s2 = splitmix64(smState);
  return new Xorshift64Star((s1 << 32n) | s2);
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jensen', 'keller', 'larsen', 'moen', 'nielsen', 'olsen', 'pedersen', 'quist', 'rasmussen', 'svendsen', 'thomsen', 'underwood', 'voss', 'witt', 'young', 'zeiger'];

function generateUsers(rng: Xorshift64Star, count: number): { login: string; id: number }[] {
  const used = new Set<string>();
  const users: { login: string; id: number }[] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST_NAMES[rng.nextInt(FIRST_NAMES.length)];
    const last = LAST_NAMES[rng.nextInt(LAST_NAMES.length)];
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
  head: string;
  base: string;
  user: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  files?: { filename: string; status: string }[];
}

const repos = new Map<string, Repo>();
const issuesMap = new Map<string, Issue[]>();
const pullsMap = new Map<string, Pull[]>();
const labelsMap = new Map<string, Set<string>>();

let issueIdCounter = 1;
let commentIdCounter = 1;
let pullIdCounter = 1;

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
          data.viewer = { login: 'octocat', id: 'U_1' };
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
        res.writeHead(200, { 'content-type': JSON_TYPE, 'x-github-request-id': crypto.randomUUID() });
        res.end();
        return;
      }
      if (methodRpc === 'tools/list') {
        const tools = [
          { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
          { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' } }, required: ['owner', 'name'] } },
          { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
          { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
          { name: 'create_pull_request', description: 'Create a PR', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
          { name: 'merge_pull_request', description: 'Merge a PR', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } }
        ];
        sendJson(res, 200, { jsonrpc: '2.0', result: { tools }, id });
        return;
      }
      if (methodRpc === 'tools/call') {
        const toolName = params.name;
        const args = params.arguments || {};
        
        if (toolName?.endsWith('create_repo') || toolName === 'create_repo') {
          const name = args.name;
          const owner = args.owner || 'octocat';
          const repoKey = getRepoKey(owner, name);
          const now = new Date().toISOString();
          const repo: Repo = {
            owner, name, private: false, defaultBranch: 'main', createdAt: now, updatedAt: now, description: null,
            gitObjects: new Map(), refs: new Map(), packCache: new Map()
          };
          repos.set(repoKey, repo);
          sendJson(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(repo) }] }, id });
          return;
        }

        sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${toolName}` }, id });
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
            'x-github-request-id': crypto.randomUUID()
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
              'x-github-request-id': crypto.randomUUID()
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
          'x-github-request-id': crypto.randomUUID()
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
          'x-github-request-id': crypto.randomUUID()
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
        const newRepo: Repo = {
          owner, name, private: body.private ?? false, defaultBranch: body.default_branch || 'main',
          createdAt: now, updatedAt: now, description: body.description || null,
          gitObjects: new Map(), refs: new Map(), packCache: new Map()
        };
        repos.set(repoKey, newRepo);
        sendJson(res, 201, {
          id: 5000 + repos.size,
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
            id: 5000,
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
          const repoIssues = issuesMap.get(repoKey) || [];

          if (!issueNumOrSub && method === 'GET') {
            const state = searchParamsOf(req).get('state') || 'open';
            const filtered = repoIssues.filter(i => state === 'all' || i.state === state);
            const formatted = filtered.map(i => ({
              ...i,
              user: { login: i.user, id: 1000 },
              labels: i.labels.map(l => ({ name: l }))
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
        }
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
