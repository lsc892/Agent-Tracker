// Independently reconciles raw JSONL usage records for the real-data collection benchmark.
const { join, basename, sep, isAbsolute, relative } = require('node:path');

const zero = () => ({ input: 0, output: 0 });
const key = (...fields) => JSON.stringify(fields);
const score = value => value.input + value.output;
const equal = (a, b) => a.input === b.input && a.output === b.output;
const atLeast = (a, b) => a.input >= b.input && a.output >= b.output;
const diff = (a, b) => ({ input: a.input - b.input, output: a.output - b.output });
const add = (a, b) => {
  a.input += b.input;
  a.output += b.output;
};

function tokenCount(value) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid token count in the frozen JSONL');
  return value;
}

function io(value) {
  return { input: tokenCount(value.input_tokens), output: tokenCount(value.output_tokens) };
}

function keepResponse(responses, id, row) {
  const previous = responses.get(id);
  if (!previous || score(row.usage) >= score(previous.usage)) responses.set(id, row);
}

async function readClaude(readJsonl, file, relativePath) {
  const parts = relativePath.split(sep), child = parts.lastIndexOf('subagents');
  let session = child > 0 ? parts[child - 1] : basename(file.path).replace(/\.jsonl$/i, '');
  const usages = [];
  await readJsonl(file.path, file.bytes, row => {
    if (child < 0 && row.sessionId) session = row.sessionId;
    const message = row.message;
    if (row.type !== 'assistant' || !message?.id || !message.usage) return;
    const usage = io(message.usage);
    usage.input += tokenCount(message.usage.cache_read_input_tokens) + tokenCount(message.usage.cache_creation_input_tokens);
    if (score(usage) === 0 && (row.isApiErrorMessage || message.model === '<synthetic>')) return;
    usages.push({ response: message.id, request: row.requestId ?? null, usage });
  });
  return usages.map(row => ({ ...row, session }));
}

async function readCodex(readJsonl, file) {
  const log = { owner: null, parent: null, responses: [], legacy: [] };
  let turn;
  await readJsonl(file.path, file.bytes, (row, position) => {
    const p = row.payload;
    if (!p) return;
    if (row.type === 'session_meta' && !log.owner) {
      log.owner = p.id;
      log.parent = p.forked_from_id ?? p.parent_thread_id
        ?? (p.source ?? p.thread_source)?.subagent?.thread_spawn?.parent_thread_id ?? null;
    }
    turn = p.turn_id ?? turn;
    if (row.type === 'token_usage_record' && p.usage) {
      const thread = p.thread_id ?? log.owner;
      if (!thread || !turn || !p.response_id) throw new Error('Modern Codex usage has no response identity');
      log.responses.push({ id: key(thread, turn, p.response_id), thread, turn, position, usage: io(p.usage),
        cumulative: p.thread_token_usage && io(p.thread_token_usage), turnTotal: p.turn_token_usage && io(p.turn_token_usage) });
    }
    if (row.type !== 'event_msg' || p.type !== 'token_count') return;
    const total = p.info?.total_token_usage, last = p.info?.last_token_usage;
    if (total || last) log.legacy.push({ position, total: total && io(total), last: last && io(last), turn,
      content: key(turn, total, last), payload: JSON.stringify(p) });
  });
  return log;
}

function foldClaude(rows) {
  const requests = new Map(), responses = new Map();
  for (const row of rows) {
    if (!row.request) continue;
    const id = key(row.session, row.response), choices = requests.get(id) ?? new Set();
    choices.add(row.request);
    requests.set(id, choices);
  }
  for (const row of rows) {
    const id = key(row.session, row.response), choices = requests.get(id);
    const request = row.request ?? (choices?.size === 1 ? choices.values().next().value : null);
    keepResponse(responses, key(id, request), row);
  }
  const usage = zero();
  for (const row of responses.values()) add(usage, row.usage);
  return { usage, responses: responses.size };
}

function legacyPrefix(log, parents) {
  let confirmed = 0;
  for (const parent of parents ?? []) {
    let count = 0;
    while (count < log.legacy.length && count < parent.legacy.length) {
      const childRow = log.legacy[count], parentRow = parent.legacy[count];
      if (childRow.turn !== parentRow.turn || childRow.payload !== parentRow.payload) break;
      count++;
    }
    confirmed = Math.max(confirmed, count);
  }
  return confirmed;
}

function legacyIncreases(history, copied) {
  let prior;
  const seen = new Set();
  const increments = [];
  for (const [index, row] of history.entries()) {
    if (seen.has(row.content)) continue;
    seen.add(row.content);
    const previous = prior;
    prior = row.total ?? prior;
    if (index < copied) continue;
    const usage = row.total && previous && atLeast(row.total, previous) ? diff(row.total, previous) : row.last;
    if (usage && score(usage) > 0) increments.push({ ...row, usage });
  }
  return increments;
}

function verifiedGap(first, last, usage, singleTurn, legacyCheckpoints) {
  const gap = diff(diff(last.cumulative, first.cumulative), usage);
  if (!atLeast(gap, zero()) || score(gap) === 0) return;
  const begin = legacyCheckpoints.get(key(first.cumulative.input, first.cumulative.output));
  const end = legacyCheckpoints.get(key(last.cumulative.input, last.cumulative.output));
  const corroboratedByLegacy = begin !== undefined && end !== undefined && begin < end;
  const corroboratedByTurn = singleTurn && first.turn === last.turn && first.turnTotal && last.turnTotal
    && equal(gap, diff(diff(last.turnTotal, first.turnTotal), usage));
  return corroboratedByLegacy || corroboratedByTurn ? gap : undefined;
}

function foldCodex(logs) {
  const responses = new Map(), originals = new Map(), gapKeys = new Set();
  const evidence = { copiedRows: 0, legacyFiles: 0, mixedLeading: 0, corroboratedGaps: 0, unresolvedGaps: 0 };
  for (const log of logs) {
    const copies = originals.get(log.owner) ?? [];
    copies.push(log);
    originals.set(log.owner, copies);
    for (const row of log.responses) keepResponse(responses, row.id, row);
  }

  const usage = zero();
  for (const row of responses.values()) add(usage, row.usage);
  for (const log of logs) {
    const copied = log.parent ? legacyPrefix(log, originals.get(log.parent)) : 0;
    evidence.copiedRows += copied;
    const increases = legacyIncreases(log.legacy, copied);
    const ownResponses = new Map();
    for (const row of log.responses) if (row.thread === log.owner) keepResponse(ownResponses, row.id, row);
    const modern = [...ownResponses.values()].sort((a, b) => a.position - b.position);
    if (!modern.length) {
      if (increases.length) evidence.legacyFiles++;
      for (const increment of increases) add(usage, increment.usage);
      continue;
    }

    const first = modern[0];
    for (const increment of increases) {
      if (increment.position >= first.position) break;
      if (increment.total && first.cumulative && equal(increment.total, first.cumulative)) continue;
      add(usage, increment.usage);
      evidence.mixedLeading += score(increment.usage);
    }
    const checkpoints = new Map();
    for (const row of log.legacy.slice(copied)) {
      if (row.total) checkpoints.set(key(row.total.input, row.total.output), row.position);
    }
    let start, interval = zero(), sameTurn = true;
    for (const row of modern) {
      if (start) {
        add(interval, row.usage);
        sameTurn &&= row.turn === start.turn;
      }
      if (!row.cumulative) continue;
      if (start) {
        const gap = verifiedGap(start, row, interval, sameTurn, checkpoints);
        const gapKey = key(row.thread, start.cumulative, row.cumulative);
        if (gap && !gapKeys.has(gapKey)) {
          gapKeys.add(gapKey);
          add(usage, gap);
          evidence.corroboratedGaps += score(gap);
        } else if (!gap && atLeast(row.cumulative, start.cumulative)
          && score(diff(diff(row.cumulative, start.cumulative), interval)) > 0) evidence.unresolvedGaps++;
      }
      start = row;
      interval = zero();
      sameTurn = true;
    }
  }
  return { usage, responses: responses.size, ...evidence };
}

async function auditThreadUsage(snapshot, previousBuildRoot) {
  // Share the byte and compression reader with the benchmark baseline, with no projection or application parser.
  const { readJsonl } = require(join(previousBuildRoot, 'dist/src/summary/jsonl'));
  const claudeRows = [], codexLogs = [];
  for (const file of snapshot.files) {
    const root = snapshot.roots.find(candidate => {
      const path = relative(candidate.path, file.path);
      return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
    });
    if (!root) throw new Error('Frozen JSONL does not belong to a provider');
    if (root.provider === 'claude') claudeRows.push(...await readClaude(readJsonl, file, relative(root.path, file.path)));
    else codexLogs.push(await readCodex(readJsonl, file));
  }
  const claude = foldClaude(claudeRows), { usage: codex, ...evidence } = foldCodex(codexLogs);
  return { files: snapshot.files.length, totals: {
    claude: { ...claude.usage, tokens: score(claude.usage) }, codex: { ...codex, tokens: score(codex) },
  }, evidence: { claudeRawRows: claudeRows.length, claudeResponses: claude.responses, ...evidence } };
}

module.exports = { auditThreadUsage };
