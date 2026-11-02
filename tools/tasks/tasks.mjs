#!/usr/bin/env node
// Task tooling for tasks/*.md (ADR 0012). Zero dependencies.
//
// Usage:
//   node tools/tasks/tasks.mjs validate          — check schema, deps, cycles, statuses, milestones
//   node tools/tasks/tasks.mjs ready [--area X]  — list todo tasks whose dependencies are all done
//   node tools/tasks/tasks.mjs index             — regenerate tasks/INDEX.md
//   node tools/tasks/tasks.mjs show <ID>         — print task summary with dependency status
//   node tools/tasks/tasks.mjs claim <ID> --as <agent>   — set in_progress + assignee + claimed_at
//   node tools/tasks/tasks.mjs status <ID> <status>      — change status (todo|in_progress|review|done|blocked|cancelled)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKS_DIR = join(ROOT, 'tasks');
const ROADMAP = join(ROOT, 'docs', 'planning', 'roadmap.md');

const STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked', 'cancelled'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const COMPLEXITIES = ['S', 'M', 'L'];
const REQUIRED_KEYS = [
  'id',
  'title',
  'status',
  'priority',
  'complexity',
  'phase',
  'milestone',
  'area',
  'depends_on',
  'modules',
  'assignee',
  'claimed_at',
];
const REQUIRED_SECTIONS = [
  'Описание',
  'Цель',
  'Scope',
  'Out of Scope',
  'Зависимости',
  'Затрагиваемые модули',
  'Ожидаемый результат',
  'Критерии приёмки',
  'Требования к тестированию',
  'Требования к документации',
];
const ID_RE = /^[A-Z]+-\d{3}$/;
const ID_IN_TEXT_RE = /\b[A-Z]+-\d{3}\b/g;
const STALE_CLAIM_HOURS = 72;

// ───────────── parsing ─────────────

function parseScalar(raw) {
  const v = raw.trim();
  if (v === 'null' || v === '') return null;
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith('[')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function parseTask(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { file, text, error: 'missing frontmatter block' };
  const meta = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx < 0) return { file, text, error: `bad frontmatter line: ${line}` };
    meta[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
  }
  const sections = {};
  let current = null;
  for (const line of m[2].split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      current = h[1].trim();
      sections[current] = '';
      continue;
    }
    if (current) sections[current] += line + '\n';
  }
  return { file, text, meta, sections };
}

function loadTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => ID_RE.test(basename(f, '.md')))
    .sort()
    .map((f) => parseTask(join(TASKS_DIR, f)));
}

function loadMilestones() {
  if (!existsSync(ROADMAP)) return new Map();
  const map = new Map();
  for (const line of readFileSync(ROADMAP, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^### (M\d+)\b\s*[—-]\s*(.+?)\s*\(фаза (\d+)\)/);
    if (m) map.set(m[1], { title: m[2], phase: Number(m[3]) });
  }
  return map;
}

// ───────────── validation ─────────────

function validate(tasks) {
  const errors = [];
  const warnings = [];
  const byId = new Map();
  const milestones = loadMilestones();
  if (milestones.size === 0)
    errors.push('roadmap: no milestones found in docs/planning/roadmap.md');

  for (const t of tasks) {
    const where = basename(t.file);
    if (t.error) {
      errors.push(`${where}: ${t.error}`);
      continue;
    }
    const { meta } = t;
    for (const k of REQUIRED_KEYS) if (!(k in meta)) errors.push(`${where}: missing key "${k}"`);
    if (meta.id !== basename(t.file, '.md'))
      errors.push(`${where}: id "${meta.id}" does not match file name`);
    if (byId.has(meta.id)) errors.push(`${where}: duplicate id ${meta.id}`);
    byId.set(meta.id, t);
    if (!STATUSES.includes(meta.status)) errors.push(`${where}: bad status "${meta.status}"`);
    if (!PRIORITIES.includes(meta.priority))
      errors.push(`${where}: bad priority "${meta.priority}"`);
    if (!COMPLEXITIES.includes(meta.complexity))
      errors.push(`${where}: bad complexity "${meta.complexity}" (split XL tasks)`);
    if (!Number.isInteger(meta.phase) || meta.phase < 1 || meta.phase > 11)
      errors.push(`${where}: phase must be 1..11`);
    const ms = milestones.get(meta.milestone);
    if (!ms) errors.push(`${where}: unknown milestone "${meta.milestone}"`);
    else if (ms.phase !== meta.phase)
      errors.push(
        `${where}: milestone ${meta.milestone} belongs to phase ${ms.phase}, task phase is ${meta.phase}`,
      );
    if (!Array.isArray(meta.depends_on)) errors.push(`${where}: depends_on must be a list`);
    if (!Array.isArray(meta.modules) || meta.modules.length === 0)
      errors.push(`${where}: modules must be a non-empty list`);
    if (meta.status === 'in_progress' || meta.status === 'review') {
      if (!meta.assignee) errors.push(`${where}: status ${meta.status} requires assignee`);
      if (!meta.claimed_at) errors.push(`${where}: status ${meta.status} requires claimed_at`);
    }
    if (meta.status === 'in_progress' && meta.claimed_at) {
      const ageH = (Date.now() - Date.parse(meta.claimed_at)) / 36e5;
      if (ageH > STALE_CLAIM_HOURS)
        warnings.push(
          `${where}: claim is older than ${STALE_CLAIM_HOURS}h (stale, may be reclaimed)`,
        );
    }
    for (const s of REQUIRED_SECTIONS) {
      if (!(s in t.sections)) errors.push(`${where}: missing section "## ${s}"`);
      else if (!t.sections[s].trim()) errors.push(`${where}: empty section "## ${s}"`);
    }
    const depSection = t.sections['Зависимости'] ?? '';
    const mentioned = new Set(depSection.match(ID_IN_TEXT_RE) ?? []);
    const declared = new Set(meta.depends_on ?? []);
    for (const d of declared)
      if (!mentioned.has(d))
        errors.push(`${where}: depends_on ${d} not listed in "## Зависимости"`);
    for (const d of mentioned)
      if (!declared.has(d))
        errors.push(`${where}: "## Зависимости" mentions ${d} which is not in depends_on`);
  }

  const titles = new Map();
  for (const t of tasks) {
    if (t.error) continue;
    const key = String(t.meta.title).toLowerCase();
    if (titles.has(key))
      errors.push(`${basename(t.file)}: duplicate title with ${titles.get(key)}`);
    titles.set(key, t.meta.id);
    for (const d of t.meta.depends_on ?? []) {
      const dep = byId.get(d);
      if (!dep) {
        errors.push(`${t.meta.id}: unknown dependency ${d}`);
        continue;
      }
      if (d === t.meta.id) errors.push(`${t.meta.id}: depends on itself`);
      if (dep.meta.phase > t.meta.phase)
        warnings.push(
          `${t.meta.id} (phase ${t.meta.phase}) depends on ${d} from later phase ${dep.meta.phase}`,
        );
      if (t.meta.status === 'done' && dep.meta.status !== 'done')
        errors.push(`${t.meta.id}: done but dependency ${d} is ${dep.meta.status}`);
      if (t.meta.status === 'in_progress' && dep.meta.status !== 'done')
        warnings.push(`${t.meta.id}: in_progress while dependency ${d} is ${dep.meta.status}`);
    }
  }

  // Cycle detection (DFS with colors).
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.meta.depends_on ?? []) {
      if (!byId.has(d)) continue;
      if (color.get(d) === 1)
        errors.push(`dependency cycle: ${[...stack.slice(stack.indexOf(d)), d].join(' → ')}`);
      else if (!color.get(d)) visit(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of byId.keys()) if (!color.get(id)) visit(id);

  return { errors, warnings, byId };
}

// ───────────── queries ─────────────

const PRIORITY_ORDER = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

function readyTasks(byId) {
  return [...byId.values()]
    .filter((t) => t.meta.status === 'todo')
    .filter((t) => t.meta.depends_on.every((d) => byId.get(d)?.meta.status === 'done'))
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority] ||
        a.meta.phase - b.meta.phase ||
        a.meta.id.localeCompare(b.meta.id),
    );
}

// Longest dependency chain (by task count) among unfinished tasks — the critical path.
function criticalPath(byId) {
  const memo = new Map();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = byId.get(id);
    let best = [];
    for (const d of t.meta.depends_on) {
      if (!byId.has(d) || byId.get(d).meta.status === 'done') continue;
      const p = longest(d);
      if (p.length > best.length) best = p;
    }
    const path = [...best, id];
    memo.set(id, path);
    return path;
  };
  let result = [];
  for (const [id, t] of byId) {
    if (t.meta.status === 'done' || t.meta.status === 'cancelled') continue;
    const p = longest(id);
    if (p.length > result.length) result = p;
  }
  return result;
}

function dependents(byId) {
  const map = new Map([...byId.keys()].map((id) => [id, []]));
  for (const t of byId.values()) for (const d of t.meta.depends_on) map.get(d)?.push(t.meta.id);
  return map;
}

// ───────────── index generation ─────────────

function buildIndex(byId) {
  const milestones = loadMilestones();
  const tasks = [...byId.values()];
  const count = (pred) => tasks.filter(pred).length;
  const lines = [];
  lines.push('# Индекс задач', '');
  lines.push(
    '> Файл сгенерирован `npm run tasks:index`. Не редактируйте вручную — источник истины в `tasks/<ID>.md`.',
    '',
  );
  lines.push(
    `Всего задач: **${tasks.length}** · todo: ${count((t) => t.meta.status === 'todo')} · in_progress: ${count((t) => t.meta.status === 'in_progress')} · review: ${count((t) => t.meta.status === 'review')} · done: ${count((t) => t.meta.status === 'done')} · blocked: ${count((t) => t.meta.status === 'blocked')}`,
    '',
  );

  lines.push('## Готовы к взятию сейчас', '');
  const ready = readyTasks(byId);
  if (ready.length === 0) lines.push('_Нет задач, у которых выполнены все зависимости._');
  for (const t of ready)
    lines.push(
      `- [${t.meta.id}](${t.meta.id}.md) — ${t.meta.title} (${t.meta.priority}, ${t.meta.complexity})`,
    );
  lines.push('');

  lines.push('## Критический путь', '');
  lines.push(
    'Самая длинная цепочка незавершённых зависимостей — задержка любой из этих задач сдвигает MVP и последующие фазы:',
    '',
  );
  lines.push(
    criticalPath(byId)
      .map((id) => `[${id}](${id}.md)`)
      .join(' → '),
    '',
  );

  const deps = dependents(byId);
  const blockers = [...deps.entries()]
    .filter(([id]) => byId.get(id).meta.status !== 'done')
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12);
  lines.push('## Самые блокирующие задачи', '', '| Задача | Блокирует напрямую |', '|---|---|');
  for (const [id, ds] of blockers)
    lines.push(`| [${id}](${id}.md) ${byId.get(id).meta.title} | ${ds.length} |`);
  lines.push('');

  for (const [ms, info] of [...milestones.entries()].sort((a, b) => a[1].phase - b[1].phase)) {
    const list = tasks
      .filter((t) => t.meta.milestone === ms)
      .sort((a, b) => a.meta.id.localeCompare(b.meta.id));
    lines.push(`## Фаза ${info.phase} · ${ms} — ${info.title} (${list.length})`, '');
    if (list.length === 0) {
      lines.push('_Задач пока нет._', '');
      continue;
    }
    lines.push(
      '| ID | Задача | P | C | Статус | Исполнитель | Зависит от |',
      '|---|---|---|---|---|---|---|',
    );
    for (const t of list) {
      const d = t.meta.depends_on.map((x) => `[${x}](${x}.md)`).join(', ') || '—';
      lines.push(
        `| [${t.meta.id}](${t.meta.id}.md) | ${t.meta.title} | ${t.meta.priority} | ${t.meta.complexity} | ${t.meta.status} | ${t.meta.assignee ?? '—'} | ${d} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ───────────── mutations ─────────────

function setFrontmatter(task, updates) {
  let text = task.text.replace(/\r\n/g, '\n');
  for (const [k, v] of Object.entries(updates)) {
    const value =
      v === null
        ? 'null'
        : typeof v === 'string' && /[:#"]/.test(v)
          ? JSON.stringify(v)
          : String(v);
    text = text.replace(new RegExp(`^${k}:.*$`, 'm'), `${k}: ${value}`);
  }
  writeFileSync(task.file, text);
}

// ───────────── CLI ─────────────

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const tasks = loadTasks();
  const { errors, warnings, byId } = validate(tasks);

  switch (cmd) {
    case 'validate': {
      for (const w of warnings) console.warn(`warning: ${w}`);
      for (const e of errors) console.error(`error: ${e}`);
      if (existsSync(join(TASKS_DIR, 'INDEX.md')) && errors.length === 0) {
        const current = readFileSync(join(TASKS_DIR, 'INDEX.md'), 'utf8').replace(/\r\n/g, '\n');
        if (current !== buildIndex(byId)) {
          console.error('error: tasks/INDEX.md is outdated — run npm run tasks:index');
          process.exitCode = 1;
        }
      }
      console.log(`${tasks.length} tasks, ${errors.length} errors, ${warnings.length} warnings`);
      if (errors.length) process.exitCode = 1;
      return;
    }
    case 'ready': {
      const areaIdx = args.indexOf('--area');
      const area = areaIdx >= 0 ? args[areaIdx + 1] : null;
      const list = readyTasks(byId).filter((t) => !area || t.meta.area === area);
      if (list.length === 0) console.log('No ready tasks.');
      for (const t of list)
        console.log(
          `${t.meta.id}\t${t.meta.priority}\t${t.meta.complexity}\tphase ${t.meta.phase}\t${t.meta.title}`,
        );
      return;
    }
    case 'index': {
      if (errors.length) {
        for (const e of errors) console.error(`error: ${e}`);
        process.exitCode = 1;
        return;
      }
      writeFileSync(join(TASKS_DIR, 'INDEX.md'), buildIndex(byId));
      console.log('tasks/INDEX.md updated');
      return;
    }
    case 'show': {
      const t = byId.get(args[0]);
      if (!t) {
        console.error(`unknown task ${args[0]}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `${t.meta.id}: ${t.meta.title}\nstatus: ${t.meta.status}  priority: ${t.meta.priority}  complexity: ${t.meta.complexity}  phase: ${t.meta.phase}`,
      );
      for (const d of t.meta.depends_on)
        console.log(
          `  depends on ${d} [${byId.get(d)?.meta.status ?? 'missing'}] ${byId.get(d)?.meta.title ?? ''}`,
        );
      console.log(`  blocks: ${dependents(byId).get(t.meta.id).join(', ') || '—'}`);
      return;
    }
    case 'claim': {
      const t = byId.get(args[0]);
      const asIdx = args.indexOf('--as');
      const agent = asIdx >= 0 ? args[asIdx + 1] : null;
      if (!t || !agent) {
        console.error('usage: claim <ID> --as <agent>');
        process.exitCode = 1;
        return;
      }
      if (t.meta.status !== 'todo') {
        console.error(
          `${t.meta.id} is ${t.meta.status} (assignee: ${t.meta.assignee}) — pick another task`,
        );
        process.exitCode = 1;
        return;
      }
      const notDone = t.meta.depends_on.filter((d) => byId.get(d)?.meta.status !== 'done');
      if (notDone.length) {
        console.error(`${t.meta.id} is blocked by: ${notDone.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      setFrontmatter(t, {
        status: 'in_progress',
        assignee: agent,
        claimed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      console.log(
        `${t.meta.id} claimed by ${agent}. Now: npm run tasks:index, commit "claim(${t.meta.id}): ${agent}" and push to main.`,
      );
      return;
    }
    case 'status': {
      const [id, status] = args;
      const t = byId.get(id);
      if (!t || !STATUSES.includes(status)) {
        console.error(`usage: status <ID> <${STATUSES.join('|')}>`);
        process.exitCode = 1;
        return;
      }
      const updates = { status };
      if (status === 'todo') Object.assign(updates, { assignee: null, claimed_at: null });
      setFrontmatter(t, updates);
      console.log(`${id}: ${t.meta.status} → ${status}. Run npm run tasks:index.`);
      return;
    }
    default:
      console.log(
        'commands: validate | ready [--area X] | index | show <ID> | claim <ID> --as <agent> | status <ID> <status>',
      );
      if (cmd) process.exitCode = 1;
  }
}

main();
