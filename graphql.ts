export interface GqlCtx {
  repos: Map<string, any>;
  issuesMap: Map<string, any[]>;
  pullsMap: Map<string, any[]>;
  labelsMap: Map<string, Set<string>>;
  nowIso: () => string;
  viewerLogin: string;
  getRepoKey: (owner: string, name: string) => string;
  nextIssueId: () => number;
  nextPullId: () => number;
  nextCommentId: () => number;
}

export const FIELD_SETS: Record<string, string[]> = {};
export const ENUM_TYPES: Record<string, string[]> = {};
export const FIELD_RESOLVERS: Record<string, Record<string, Function>> = {};

export function tokenize(src: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ',' || c === '@') {
      if (c === '@') {
        // Skip directive name and args if needed, or tokenize as punct/name
        // Actually, let's treat @ as punct or skip directive entirely if desired.
        // Wait, parser handles directives. Let's make @ a punct token.
      }
      if (c === ',') {
        i++;
        continue;
      }
    }
    if ('{}()[]:=!$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (c === '"') {
      let val = '';
      i++;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\' && i + 1 < src.length) {
          const next = src[i + 1];
          if (next === 'n') val += '\n';
          else if (next === 't') val += '\t';
          else if (next === '"') val += '"';
          else if (next === '\\') val += '\\';
          else val += next;
          i += 2;
        } else {
          val += ch;
          i++;
        }
      }
      tokens.push({ kind: 'string', value: val });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let val = '';
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) {
        val += src[i];
        i++;
      }
      tokens.push({ kind: 'name', value: val });
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let val = '';
      let isFloat = false;
      if (c === '-') {
        val += c;
        i++;
      }
      while (i < src.length && /[\.0-9eE+-]/.test(src[i])) {
        if (src[i] === '.' || src[i] === 'e' || src[i] === 'E') isFloat = true;
        val += src[i];
        i++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: val });
      continue;
    }
    // Unknown char, skip or treat as punct
    tokens.push({ kind: 'punct', value: c });
    i++;
  }
  return tokens;
}

export function parseDocument(src: string) {
  const tokens = tokenize(src);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function consume(val?: string) {
    const t = tokens[pos++];
    if (!t) throw new Error(`Expected token '${val}', got end of input`);
    if (val === 'name') {
      if (t.kind !== 'name') throw new Error(`Expected name, got '${t.value}'`);
    } else if (val !== undefined && t.value !== val) {
      throw new Error(`Expected token '${val}', got '${t.value}'`);
    }
    return t;
  }

  function parseValue(): any {
    const t = peek();
    if (!t) return { kind: 'null', value: null };
    if (t.kind === 'string') {
      pos++;
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      pos++;
      return { kind: 'int', value: t.value };
    }
    if (t.kind === 'float') {
      pos++;
      return { kind: 'float', value: t.value };
    }
    if (t.kind === 'name') {
      pos++;
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      if (tokens[pos]?.value === ':') {
        // Could be enum or part of object
      }
      return { kind: 'enum', value: t.value };
    }
    if (t.value === '$') {
      pos++;
      const name = consume('name').value;
      return { kind: 'variable', name };
    }
    if (t.value === '[') {
      pos++;
      const values: any[] = [];
      while (peek() && peek().value !== ']') {
        values.push(parseValue());
      }
      consume(']');
      return { kind: 'list', values };
    }
    if (t.value === '{') {
      pos++;
      const fields: Record<string, any> = {};
      while (peek() && peek().value !== '}') {
        const key = consume('name').value;
        consume(':');
        fields[key] = parseValue();
      }
      consume('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected token in value: ${t.value}`);
  }

  function parseArguments(): Record<string, any> {
    const args: Record<string, any> = {};
    if (peek() && peek().value === '(') {
      pos++;
      while (peek() && peek().value !== ')') {
        const name = consume('name').value;
        consume(':');
        args[name] = parseValue();
        parseDirectives();
      }
      consume(')');
    }
    return args;
  }

  function parseDirectives() {
    while (peek() && peek().value === '@') {
      pos++; // @
      consume('name'); // directive name
      if (peek() && peek().value === '(') {
        pos++;
        let depth = 1;
        while (pos < tokens.length && depth > 0) {
          if (tokens[pos].value === '(') depth++;
          else if (tokens[pos].value === ')') depth--;
          pos++;
        }
      }
    }
  }

  function parseSelectionsForFields(): any[] {
    const sels: any[] = [];
    while (peek() && peek().value !== '}' && peek().kind === 'name') {
      parseDirectives();
      const nameToken = consume('name');
      let alias: string | null = null;
      let fieldName = nameToken.value;
      if (peek() && peek().value === ':') {
        pos++;
        alias = fieldName;
        fieldName = consume('name').value;
      }
      const args = parseArguments();
      parseDirectives();
      let selections: any[] = [];
      if (peek() && peek().value === '{') {
        selections = parseSelections();
      }
      sels.push({
        kind: 'field',
        name: fieldName,
        alias,
        args,
        selections
      });
      parseDirectives();
    }
    return sels;
  }

  function parseSelections(): any[] {
    if (!peek() || peek().value !== '{') {
      // If shorthand operation without top-level '{' (e.g. query { ... } vs viewer { login } if allowed, or top-level selection set)
      // Wait, standard GraphQL requires operations to start with `{` or `query {`.
      // But if someone passes `viewer { login }` directly, parseSelections expects `{`.
    }
    if (!peek() || peek().value !== '{') return [];
    pos++;
    const sels: any[] = [];
    while (peek() && peek().value !== '}') {
      parseDirectives();
      const t = peek();
      if (t.value === '...') {
        pos++;
        if (peek() && peek().value === 'on') {
          pos++;
          const typeCondition = consume('name').value;
          parseDirectives();
          const selections = parseSelections();
          sels.push({ kind: 'inline', typeCondition, selections });
        } else if (peek() && peek().kind === 'name') {
          const name = consume('name').value;
          parseDirectives();
          sels.push({ kind: 'spread', name });
        } else {
          parseDirectives();
          const selections = parseSelections();
          sels.push({ kind: 'inline', typeCondition: null, selections });
        }
      } else {
        const nameToken = consume('name');
        let alias: string | null = null;
        let fieldName = nameToken.value;
        if (peek() && peek().value === ':') {
          pos++;
          alias = fieldName;
          fieldName = consume('name').value;
        }
        const args = parseArguments();
        parseDirectives();
        const selections = parseSelections();
        sels.push({
          kind: 'field',
          name: fieldName,
          alias,
          args,
          selections
        });
      }
      parseDirectives();
    }
    consume('}');
    return sels;
  }

  const operations: any[] = [];
  const fragments = new Map<string, any[]>();

  while (pos < tokens.length) {
    parseDirectives();
    const t = peek();
    if (!t) break;

    if (t.value === 'fragment') {
      pos++;
      const fragName = consume('name').value;
      consume('on');
      consume('name'); // type condition
      parseDirectives();
      const sels = parseSelections();
      fragments.set(fragName, sels);
      continue;
    }

    let kind = 'query';
    let name: string | null = null;
    const varDefs: string[] = [];

    if (t.value === 'query' || t.value === 'mutation') {
      kind = t.value;
      pos++;
      if (peek() && peek().kind === 'name') {
        name = consume('name').value;
      }
      if (peek() && peek().value === '(') {
        pos++;
        while (peek() && peek().value !== ')') {
          consume('$');
          const varName = consume('name').value;
          varDefs.push(varName);
          consume(':');
          let bracketDepth = 0;
          while (peek() && peek().value !== ')' && peek().value !== '=') {
            if (peek().value === '[') bracketDepth++;
            if (peek().value === ']') bracketDepth--;
            pos++;
          }
          if (peek() && peek().value === '=') {
            pos++;
            parseValue();
          }
          parseDirectives();
        }
        consume(')');
      }
      parseDirectives();
      const selections = parseSelections();
      operations.push({ kind, name, varDefs, selections });
    } else if (t.value === '{') {
      const selections = parseSelections();
      operations.push({ kind: 'query', name: null, varDefs: [], selections });
    } else if (t.kind === 'name' || t.value === '{') {
      const selections = parseSelections(true);
      operations.push({ kind: 'query', name: null, varDefs: [], selections });
    } else {
      break;
    }
  }

  return { operations, fragments };
}

export function resolveValue(node: any, variables: Record<string, any>): any {
  if (!node) return null;
  if (node.kind === 'variable') {
    return variables ? variables[node.name] : undefined;
  }
  if (node.kind === 'string' || node.kind === 'boolean') {
    return node.value;
  }
  if (node.kind === 'int') {
    return Number(node.value);
  }
  if (node.kind === 'float') {
    return Number(node.value);
  }
  if (node.kind === 'enum') {
    return node.value;
  }
  if (node.kind === 'null') {
    return null;
  }
  if (node.kind === 'list') {
    return node.values.map((v: any) => resolveValue(v, variables));
  }
  if (node.kind === 'object') {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(node.fields)) {
      res[k] = resolveValue(v, variables);
    }
    return res;
  }
  return node.value;
}

export function resolveSelections(
  obj: any,
  typeName: string,
  selections: any[],
  ctx: GqlCtx,
  errors: any[],
  fragments: Map<string, any[]>,
  variables: Record<string, any>
): any {
  if (obj === null || obj === undefined) return null;
  const result: Record<string, any> = {};

  for (const sel of selections) {
    if (sel.kind === 'field') {
      const outKey = sel.alias || sel.name;
      const val = resolveField(obj, typeName, sel, ctx, errors, fragments, variables);
      result[outKey] = val;
    } else if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === obj.__typename) {
        const sub = resolveSelections(obj, obj.__typename || typeName, sel.selections, ctx, errors, fragments, variables);
        Object.assign(result, sub);
      }
    } else if (sel.kind === 'spread') {
      const fragSels = fragments.get(sel.name);
      if (fragSels) {
        const sub = resolveSelections(obj, typeName, fragSels, ctx, errors, fragments, variables);
        Object.assign(result, sub);
      }
    }
  }
  return result;
}

export function resolveField(
  obj: any,
  typeName: string,
  sel: any,
  ctx: GqlCtx,
  errors: any[],
  fragments: Map<string, any[]>,
  variables: Record<string, any>
): any {
  if (sel.name === '__typename') {
    return obj.__typename;
  }

  const typeResolvers = FIELD_RESOLVERS[typeName];
  const resolver = typeResolvers ? typeResolvers[sel.name] : undefined;

  if (!resolver) {
    errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
    return null;
  }

  const resolvedArgs: Record<string, any> = {};
  if (sel.args) {
    for (const [k, v] of Object.entries(sel.args)) {
      resolvedArgs[k] = resolveValue(v, variables);
    }
  }

  let raw: any;
  try {
    raw = resolver(obj, resolvedArgs, ctx, errors, fragments);
  } catch (err: any) {
    errors.push({ message: err.message || String(err) });
    return null;
  }

  if (raw === null || raw === undefined) {
    return null;
  }

  if (sel.selections && sel.selections.length > 0) {
    if (Array.isArray(raw)) {
      return raw.map((item) => {
        if (item === null || item === undefined) return null;
        const itemType = item.__typename || typeName;
        return resolveSelections(item, itemType, sel.selections, ctx, errors, fragments, variables);
      });
    } else {
      const itemType = raw.__typename || typeName;
      return resolveSelections(raw, itemType, sel.selections, ctx, errors, fragments, variables);
    }
  }

  return raw;
}

export function executeGraphQL(query: string, variables: Record<string, any>, ctx: GqlCtx) {
  let doc: any;
  try {
    doc = parseDocument(query);
  } catch (err: any) {
    return {
      data: null,
      errors: [{ message: err.message || 'Parse error' }]
    };
  }

  if (!doc.operations || doc.operations.length === 0) {
    return { data: {} };
  }

  const op = doc.operations[0];
  const errors: any[] = [];
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';

  // Root execution object
  const rootObj = { __typename: rootType };
  const data = resolveSelections(rootObj, rootType, op.selections, ctx, errors, doc.fragments, variables || {});

  if (errors.length > 0) {
    return { data, errors };
  }
  return { data };
}

// Appending CHUNK 2 resolvers and helpers to graphql.ts


Object.assign(FIELD_SETS, {
  Issue: ['id','number','title','body','state','author','user','labels','comments','createdAt','updatedAt','url'],
  PullRequest: ['id','number','title','body','state','merged','mergeable','headRefName','baseRefName','head','base','files','author','user','createdAt','updatedAt','url'],
  Repository: ['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','description','url','createdAt','updatedAt','issue','issues','pullRequests','pullRequest','labels'],
  User: ['login','id','name'],
  Ref: ['name'],
  IssueConnection: ['nodes','pageInfo','totalCount'],
  PullRequestConnection: ['nodes','pageInfo','totalCount'],
  PullRequestFileConnection: ['nodes','pageInfo'],
  PageInfo: ['hasNextPage','hasPreviousPage','startCursor','endCursor'],
  IssueComment: ['id','body','author','user','createdAt'],
  CommentEdge: ['node','cursor'],
  Query: ['viewer','repository','node','__type','__schema'],
  Mutation: ['createIssue','closeIssue','createPullRequest','mergePullRequest','addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name','kind','fields','enumValues','description'],
  __Field: ['name','description'],
  __EnumValue: ['name','description'],
  __Schema: ['queryType','mutationType','types'],
  Label: ['name'],
  PullRequestFile: ['path','status'],
  IssueCommentConnection: ['nodes','pageInfo','totalCount']
});

Object.assign(ENUM_TYPES, {
  SearchType: ['ISSUE','PULL_REQUEST','REPOSITORY','USER','COMMIT','DISCUSSION']
});

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64');
}

function base64Decode(str: string): string {
  try {
    return Buffer.from(str, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function repoKeyOf(ctx: GqlCtx, repoObj: any): string {
  return ctx.getRepoKey(repoObj.owner, repoObj.name);
}

function findIssueByGlobalId(ctx: GqlCtx, idStr: string): any {
  let numStr = idStr.startsWith('I_') ? idStr.slice(2) : idStr;
  let num = Number(numStr);
  for (let issues of ctx.issuesMap.values()) {
    for (let issue of issues) {
      if (issue.id === num) return issue;
    }
  }
  return null;
}

function findPullByGlobalId(ctx: GqlCtx, idStr: string): any {
  let numStr = idStr.startsWith('PR_') ? idStr.slice(3) : idStr;
  let num = Number(numStr);
  for (let pulls of ctx.pullsMap.values()) {
    for (let pull of pulls) {
      if (pull.id === num) return pull;
    }
  }
  return null;
}

function findRepoByGlobalId(ctx: GqlCtx, idStr: string): any {
  let name = idStr.startsWith('R_') ? idStr.slice(2) : idStr;
  let repoKey = ctx.getRepoKey(ctx.viewerLogin, name);
  let repo = ctx.repos.get(repoKey);
  if (repo) return repo;
  // search any repo matching name
  for (let r of ctx.repos.values()) {
    if (r.name === name) return r;
  }
  return null;
}

function findCommentByGlobalId(ctx: GqlCtx, idStr: string): any {
  let numStr = idStr.startsWith('C_') ? idStr.slice(2) : idStr;
  let num = Number(numStr);
  for (let issues of ctx.issuesMap.values()) {
    for (let issue of issues) {
      for (let c of (issue.comments || [])) {
        if (c.id === num) return c;
      }
    }
  }
  return null;
}

function findIssue(ctx: GqlCtx, repoKey: string, number: number): any {
  let issues = ctx.issuesMap.get(repoKey) || [];
  return issues.find((i: any) => i.number === number) || null;
}

function findPull(ctx: GqlCtx, repoKey: string, number: number): any {
  let pulls = ctx.pullsMap.get(repoKey) || [];
  return pulls.find((p: any) => p.number === number) || null;
}

function findRepoForPull(ctx: GqlCtx, pull: any): any {
  for (let [repoKey, pulls] of ctx.pullsMap.entries()) {
    if (pulls.some((p: any) => p.id === pull.id)) {
      return ctx.repos.get(repoKey);
    }
  }
  return null;
}

function buildIssueConnection(repoObj: any, args: any, ctx: GqlCtx): any {
  let rKey = repoKeyOf(ctx, repoObj);
  let issues = [...(ctx.issuesMap.get(rKey) || [])];

  // filter states
  if (args.states && Array.isArray(args.states)) {
    let mappedStates = args.states.map((s: string) => s === 'OPEN' ? 'open' : 'closed');
    issues = issues.filter(i => mappedStates.includes(i.state));
  }

  // orderBy
  let direction = 'DESC';
  if (args.orderBy && args.orderBy.direction) {
    direction = args.orderBy.direction;
  }
  issues.sort((a, b) => {
    if (direction === 'ASC') {
      return a.number - b.number;
    } else {
      return b.number - a.number;
    }
  });

  let first = args.first ?? 10;
  let after = args.after;
  if (after) {
    let decoded = base64Decode(after);
    // format cursor:number or just number
    let numPart = decoded.includes(':') ? Number(decoded.split(':')[1]) : Number(decoded);
    if (!isNaN(numPart)) {
      if (direction === 'ASC') {
        issues = issues.filter(i => i.number > numPart);
      } else {
        issues = issues.filter(i => i.number < numPart);
      }
    }
  }

  let slice = issues.slice(0, first);
  let hasNextPage = issues.length > first;
  let startCursor = slice.length > 0 ? base64Encode('cursor:' + slice[0].number) : null;
  let endCursor = slice.length > 0 ? base64Encode('cursor:' + slice[slice.length - 1].number) : null;

  let nodes = slice.map(i => ({ __typename: 'Issue', ...i }));
  return {
    __typename: 'IssueConnection',
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor,
      endCursor
    },
    totalCount: (ctx.issuesMap.get(rKey) || []).length
  };
}

function buildPullRequestConnection(repoObj: any, args: any, ctx: GqlCtx): any {
  let rKey = repoKeyOf(ctx, repoObj);
  let pulls = [...(ctx.pullsMap.get(rKey) || [])];
  pulls.sort((a, b) => a.number - b.number);

  let first = args.first ?? 10;
  let after = args.after;
  if (after) {
    let decoded = base64Decode(after);
    let numPart = decoded.includes(':') ? Number(decoded.split(':')[1]) : Number(decoded);
    if (!isNaN(numPart)) {
      pulls = pulls.filter(p => p.number > numPart);
    }
  }

  let slice = pulls.slice(0, first);
  let hasNextPage = pulls.length > first;
  let startCursor = slice.length > 0 ? base64Encode('cursor:' + slice[0].number) : null;
  let endCursor = slice.length > 0 ? base64Encode('cursor:' + slice[slice.length - 1].number) : null;

  let nodes = slice.map(p => ({ __typename: 'PullRequest', ...p }));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor,
      endCursor
    },
    totalCount: (ctx.pullsMap.get(rKey) || []).length
  };
}

function buildPullFiles(repoObj: any, pull: any, args: any, ctx: GqlCtx): any {
  let store = repoObj.store;
  let baseSha = pull.base.sha;
  let headSha = pull.head.sha;
  let baseFiles = store.commitFileMap(baseSha);
  let headFiles = store.commitFileMap(headSha);

  let allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  let nodes: any[] = [];
  for (let p of allPaths) {
    let bBuf = baseFiles.get(p);
    let hBuf = headFiles.get(p);
    let status = 'modified';
    if (!bBuf && hBuf) status = 'added';
    else if (bBuf && !hBuf) status = 'removed';
    else if (bBuf && hBuf && Buffer.compare(bBuf, hBuf) === 0) continue;
    nodes.push({ __typename: 'PullRequestFile', path: p, status });
  }

  let first = args.first ?? 10;
  return {
    __typename: 'PullRequestFileConnection',
    nodes: nodes.slice(0, first),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: nodes.length > first,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null
    }
  };
}

function computeMergeable(pull: any, ctx: GqlCtx): string {
  try {
    let repo = findRepoForPull(ctx, pull);
    if (!repo) return 'UNKNOWN';
    let baseTip = repo.store.refs.get('refs/heads/' + pull.base.ref);
    if (!baseTip) return 'MERGEABLE';
    let mergeBase = repo.store.mergeBase(pull.head.sha, baseTip);
    let baseFiles = repo.store.commitFileMap(baseTip);
    let headFiles = repo.store.commitFileMap(pull.head.sha);
    let ancestorFiles = mergeBase ? repo.store.commitFileMap(mergeBase) : new Map();

    let allPaths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
    for (let path of allPaths) {
      let anc = ancestorFiles.get(path);
      let base = baseFiles.get(path);
      let head = headFiles.get(path);

      let baseChanged = (anc && !base) || (!anc && base) || (anc && base && Buffer.compare(anc, base) !== 0);
      let headChanged = (anc && !head) || (!anc && head) || (anc && head && Buffer.compare(anc, head) !== 0);

      if (baseChanged && headChanged) {
        if (!base || !head || Buffer.compare(base, head) !== 0) {
          return 'CONFLICTING';
        }
      }
    }
    return 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

Object.assign(FIELD_RESOLVERS, {
  User: {
    login: (obj: any) => obj.login,
    id: (obj: any) => obj.id || 'U_1',
    name: (obj: any) => obj.name || obj.login
  },
  Ref: {
    name: (obj: any) => obj.name
  },
  Repository: {
    id: (obj: any) => 'R_' + obj.name,
    databaseId: (obj: any) => obj.id || 5000,
    name: (obj: any) => obj.name,
    nameWithOwner: (obj: any) => obj.owner + '/' + obj.name,
    owner: (obj: any) => ({ __typename: 'User', login: obj.owner, id: 1000, name: obj.owner }),
    defaultBranchRef: (obj: any) => ({ __typename: 'Ref', name: obj.defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (obj: any) => obj.description || null,
    url: () => '',
    createdAt: (obj: any) => obj.createdAt,
    updatedAt: (obj: any) => obj.updatedAt,
    issue: (obj: any, args: any, ctx: GqlCtx) => {
      let rKey = repoKeyOf(ctx, obj);
      let issue = findIssue(ctx, rKey, args.number);
      return issue ? { __typename: 'Issue', ...issue } : null;
    },
    issues: (obj: any, args: any, ctx: GqlCtx) => buildIssueConnection(obj, args, ctx),
    pullRequests: (obj: any, args: any, ctx: GqlCtx) => buildPullRequestConnection(obj, args, ctx),
    pullRequest: (obj: any, args: any, ctx: GqlCtx) => {
      let rKey = repoKeyOf(ctx, obj);
      let pull = findPull(ctx, rKey, args.number);
      return pull ? { __typename: 'PullRequest', ...pull } : null;
    },
    labels: () => []
  },
  Issue: {
    id: (obj: any) => 'I_' + obj.id,
    number: (obj: any) => obj.number,
    title: (obj: any) => obj.title,
    body: (obj: any) => obj.body,
    state: (obj: any) => obj.state === 'open' ? 'OPEN' : 'CLOSED',
    user: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    author: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    labels: (obj: any) => (obj.labels || []).map((l: string) => ({ __typename: 'Label', name: l })),
    comments: (obj: any) => ({
      __typename: 'IssueCommentConnection',
      nodes: (obj.comments || []).map((c: any) => ({ __typename: 'IssueComment', ...c })),
      pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: (obj.comments || []).length
    }),
    createdAt: (obj: any) => obj.createdAt,
    updatedAt: (obj: any) => obj.updatedAt,
    url: () => ''
  },
  PullRequest: {
    id: (obj: any) => 'PR_' + obj.id,
    number: (obj: any) => obj.number,
    title: (obj: any) => obj.title,
    body: (obj: any) => obj.body,
    state: (obj: any) => obj.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: (obj: any) => !!obj.merged,
    mergeable: (obj: any, args: any, ctx: GqlCtx) => computeMergeable(obj, ctx),
    headRefName: (obj: any) => obj.head.ref,
    baseRefName: (obj: any) => obj.base.ref,
    head: (obj: any) => ({ __typename: 'Ref', name: obj.head.ref, sha: obj.head.sha }),
    base: (obj: any) => ({ __typename: 'Ref', name: obj.base.ref, sha: obj.base.sha }),
    files: (obj: any, args: any, ctx: GqlCtx) => buildPullFiles(findRepoForPull(ctx, obj), obj, args, ctx),
    user: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    author: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    createdAt: (obj: any) => obj.createdAt,
    updatedAt: (obj: any) => obj.updatedAt,
    url: () => ''
  },
  IssueConnection: {
    nodes: (obj: any) => obj.nodes,
    pageInfo: (obj: any) => obj.pageInfo,
    totalCount: (obj: any) => obj.totalCount ?? obj.nodes.length
  },
  PullRequestConnection: {
    nodes: (obj: any) => obj.nodes,
    pageInfo: (obj: any) => obj.pageInfo,
    totalCount: (obj: any) => obj.totalCount ?? obj.nodes.length
  },
  PullRequestFileConnection: {
    nodes: (obj: any) => obj.nodes,
    pageInfo: (obj: any) => obj.pageInfo
  },
  PageInfo: {
    hasNextPage: (obj: any) => !!obj.hasNextPage,
    hasPreviousPage: (obj: any) => !!obj.hasPreviousPage,
    startCursor: (obj: any) => obj.startCursor || null,
    endCursor: (obj: any) => obj.endCursor || null
  },
  Label: {
    name: (obj: any) => obj.name
  },
  PullRequestFile: {
    path: (obj: any) => obj.path,
    status: (obj: any) => obj.status
  },
  IssueCommentConnection: {
    nodes: (obj: any) => obj.nodes,
    pageInfo: (obj: any) => obj.pageInfo,
    totalCount: (obj: any) => obj.totalCount ?? obj.nodes.length
  },
  IssueComment: {
    id: (obj: any) => 'C_' + obj.id,
    body: (obj: any) => obj.body,
    user: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    author: (obj: any) => ({ __typename: 'User', login: obj.user, id: 1000 }),
    createdAt: (obj: any) => obj.createdAt
  },
  CommentEdge: {
    node: (obj: any) => obj.node,
    cursor: (obj: any) => obj.cursor || null
  },
  __Type: {
    name: (obj: any) => obj.name,
    kind: (obj: any) => obj.kind,
    fields: (obj: any, args: any) => {
      let fields = FIELD_SETS[obj.name];
      if (!fields) return null;
      return fields.map(f => ({ __typename: '__Field', name: f, description: null }));
    },
    enumValues: (obj: any) => {
      let vals = ENUM_TYPES[obj.name];
      if (!vals) return null;
      return vals.map(v => ({ __typename: '__EnumValue', name: v, description: null }));
    },
    description: () => null
  },
  __Field: {
    name: (obj: any) => obj.name,
    description: () => null
  },
  __EnumValue: {
    name: (obj: any) => obj.name,
    description: () => null
  },
  __Schema: {
    queryType: () => ({ __typename: '__Type', name: 'Query' }),
    mutationType: () => ({ __typename: '__Type', name: 'Mutation' }),
    types: () => {
      let allNames = new Set([...Object.keys(FIELD_SETS), ...Object.keys(ENUM_TYPES)]);
      let types: any[] = [];
      for (let name of allNames) {
        let kind = ENUM_TYPES[name] ? 'ENUM' : 'OBJECT';
        types.push({ __typename: '__Type', name, kind });
      }
      return types;
    }
  },
  CreateIssuePayload: {
    issue: (obj: any) => obj.issue
  },
  CloseIssuePayload: {
    issue: (obj: any) => obj.issue
  },
  CreatePullRequestPayload: {
    pullRequest: (obj: any) => obj.pullRequest
  },
  MergePullRequestPayload: {
    pullRequest: (obj: any) => obj.pullRequest
  },
  AddCommentPayload: {
    commentEdge: (obj: any) => obj.commentEdge
  },
  Query: {
    viewer: (_obj: any, _args: any, ctx: GqlCtx) => ({ __typename: 'User', login: ctx.viewerLogin, id: 'U_1', name: 'Ada Iversen' }),
    repository: (obj: any, args: any, ctx: GqlCtx) => {
      let rKey = ctx.getRepoKey(args.owner, args.name);
      let repo = ctx.repos.get(rKey);
      return repo ? { __typename: 'Repository', ...repo } : null;
    },
    node: (obj: any, args: any, ctx: GqlCtx) => {
      let id = args.id;
      if (id.startsWith('R_')) {
        let repo = findRepoByGlobalId(ctx, id);
        return repo ? { __typename: 'Repository', ...repo } : null;
      }
      if (id.startsWith('I_')) {
        let issue = findIssueByGlobalId(ctx, id);
        return issue ? { __typename: 'Issue', ...issue } : null;
      }
      if (id.startsWith('PR_')) {
        let pull = findPullByGlobalId(ctx, id);
        return pull ? { __typename: 'PullRequest', ...pull } : null;
      }
      if (id.startsWith('C_')) {
        let comment = findCommentByGlobalId(ctx, id);
        return comment ? { __typename: 'IssueComment', ...comment } : null;
      }
      return null;
    },
    __type: (obj: any, args: any) => {
      let name = args.name;
      let kind = ENUM_TYPES[name] ? 'ENUM' : (FIELD_SETS[name] ? 'OBJECT' : null);
      if (!kind) return null;
      return { __typename: '__Type', name, kind };
    },
    __schema: () => ({ __typename: '__Schema' })
  },
  Mutation: {
    createIssue: (obj: any, args: any, ctx: GqlCtx, errors: any[]) => {
      const input = args.input || {};
      const repo = findRepoByGlobalId(ctx, input.repositoryId);
      if (!repo) { errors.push({ message: 'repository not found' }); return null; }
      const repoKey = repoKeyOf(ctx, repo);
      const repoIssues = ctx.issuesMap.get(repoKey) || [];
      const now = ctx.nowIso();
      const newIssue: any = { id: ctx.nextIssueId(), number: repoIssues.length + 1, title: input.title || '', body: input.body || '', state: 'open', user: ctx.viewerLogin, labels: [], createdAt: now, updatedAt: now, comments: [] };
      repoIssues.push(newIssue);
      ctx.issuesMap.set(repoKey, repoIssues);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', ...newIssue } };
    },
    closeIssue: (obj: any, args: any, ctx: GqlCtx, errors: any[]) => {
      const input = args.input || {};
      const issue = findIssueByGlobalId(ctx, input.issueId);
      if (!issue) { errors.push({ message: 'issue not found' }); return null; }
      issue.state = 'closed';
      issue.updatedAt = ctx.nowIso();
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', ...issue } };
    },
    createPullRequest: (obj: any, args: any, ctx: GqlCtx, errors: any[]) => {
      const input = args.input || {};
      const repo = findRepoByGlobalId(ctx, input.repositoryId);
      if (!repo) { errors.push({ message: 'repository not found' }); return null; }
      const repoKey = repoKeyOf(ctx, repo);
      const repoPulls = ctx.pullsMap.get(repoKey) || [];
      const headRefName = input.headRefName || repo.defaultBranch;
      const baseRefName = input.baseRefName || repo.defaultBranch;
      const zeroOid = '0000000000000000000000000000000000000000';
      const headSha = repo.store.refs.get('refs/heads/' + headRefName) || zeroOid;
      const baseSha = repo.store.refs.get('refs/heads/' + baseRefName) || zeroOid;
      const now = ctx.nowIso();
      const newPull: any = { id: ctx.nextPullId(), number: repoPulls.length + 1, title: input.title || '', body: input.body || '', state: 'open', head: { ref: headRefName, sha: headSha }, base: { ref: baseRefName, sha: baseSha }, user: ctx.viewerLogin, merged: false, merged_at: null, merge_commit_sha: null, createdAt: now, updatedAt: now };
      repoPulls.push(newPull);
      ctx.pullsMap.set(repoKey, repoPulls);
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', ...newPull } };
    },
    mergePullRequest: (obj: any, args: any, ctx: GqlCtx, errors: any[]) => {
      const input = args.input || {};
      const pull = findPullByGlobalId(ctx, input.pullRequestId);
      if (!pull) { errors.push({ message: 'pull request not found' }); return null; }
      if (pull.merged || pull.state === 'closed') { errors.push({ message: 'pull request already merged or closed' }); return null; }
      const repo = findRepoForPull(ctx, pull);
      if (!repo) { errors.push({ message: 'repository not found' }); return null; }
      if (computeMergeable(pull, ctx) === 'CONFLICTING') { errors.push({ message: 'Merge conflict' }); return null; }
      const zeroOid = '0000000000000000000000000000000000000000';
      const baseTip = repo.store.refs.get('refs/heads/' + pull.base.ref) || zeroOid;
      const headFiles = repo.store.commitFileMap(pull.head.sha);
      const mergeTree = repo.store.writeTreeFromMap(headFiles);
      const commitSha = repo.store.writeCommit(mergeTree, baseTip === zeroOid ? [] : [baseTip], `Squash merge PR #${pull.number}: ${pull.title}`);
      repo.store.commitFiles.set(commitSha, new Map(headFiles));
      repo.store.branchFiles.set(pull.base.ref, new Map<string, Buffer>(headFiles));
      pull.state = 'closed';
      pull.merged = true;
      const mergedAtTime = ctx.nowIso();
      pull.merged_at = mergedAtTime;
      pull.merge_commit_sha = commitSha;
      pull.updatedAt = mergedAtTime;
      repo.store.refs.set('refs/heads/' + pull.base.ref, commitSha);
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', ...pull } };
    },
    addComment: (obj: any, args: any, ctx: GqlCtx, errors: any[]) => {
      const input = args.input || {};
      const issue = findIssueByGlobalId(ctx, input.subjectId);
      if (!issue) { errors.push({ message: 'subject not found' }); return null; }
      const comment: any = { id: ctx.nextCommentId(), body: input.body || '', user: ctx.viewerLogin, createdAt: ctx.nowIso() };
      issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', ...comment }, cursor: null } };
    }
  }
});
