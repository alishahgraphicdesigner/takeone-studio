/* TakeOne Studio 2.2.0 — Phase C: pipeline state machine + script analyzer + taste.
 *
 * The 6-step pipeline (demo is the source of truth, decision #61):
 *   01 Prompt Brief → 02 Image → 03 Animate → 04 Director → 05 Voice → 06 Final
 *
 * State lives in <root>/Projects/<id>/project.json (see main/library.js).
 * Generation itself is NOT wired in Phase C (engine = Phase D). Every step is
 * either really functional (forms persist, script analysis runs) or honestly
 * labelled "not yet wired" — never theater.
 *
 * Pure functions are exported for unit tests (node --test).
 */
'use strict';

const STEPS = [
  { n: 1, key: 'brief',   name: 'Prompt Brief', short: 'Brief',   from: null,        to: 'Production prompt', needsTool: null,            needsLabel: null },
  { n: 2, key: 'image',   name: 'Image',        short: 'Image',   from: 'Brief',     to: 'Source image',      needsTool: 'image-studio',  needsLabel: 'Image Studio' },
  { n: 3, key: 'animate', name: 'Animate',      short: 'Animate', from: 'Image',     to: 'Shot set',          needsTool: 'video-studio',  needsLabel: 'Video Studio' },
  { n: 4, key: 'director',name: 'Director',     short: 'Director',from: 'Shot set',  to: 'Sequence',          needsTool: 'video-studio',  needsLabel: 'Video Studio' },
  { n: 5, key: 'voice',   name: 'Voice',        short: 'Voice',   from: 'Sequence',  to: 'Voiced film',       needsTool: 'voice-studio',  needsLabel: 'Voice Studio' },
  { n: 6, key: 'final',   name: 'Final',        short: 'Final',   from: 'Voiced film',to: 'Export',            needsTool: null,            needsLabel: null },
];

function stepDef(n) { return STEPS.find((s) => s.n === n) || null; }

/** Fresh per-step state. Pure. */
function freshStepState() {
  return {
    status: 'empty', // empty | ready | failed
    outputs: [],     // [{ id, kind, label, rel, createdAt, settings }]
    settings: {},
    selectedVariation: null,
    variations: [],  // selected/deselected variant refs (real toggle state)
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
  };
}

/** Set a step's settings (forms persist even before the engine exists). */
function setStepSettings(doc, n, settings) {
  const s = doc.steps[n] || (doc.steps[n] = freshStepState());
  s.settings = { ...(s.settings || {}), ...(settings || {}) };
  return s;
}

/** Record a real output on a step (file must exist — caller verifies). */
function addStepOutput(doc, n, output) {
  const s = doc.steps[n] || (doc.steps[n] = freshStepState());
  s.outputs.push({
    id: output.id || `out-${Date.now()}`,
    kind: output.kind || 'file',
    label: output.label || 'Output',
    rel: output.rel || null,
    createdAt: new Date().toISOString(),
    settings: JSON.parse(JSON.stringify(s.settings || {})),
  });
  s.status = 'ready';
  s.error = null;
  s.finishedAt = new Date().toISOString();
  if (n >= (doc.currentStep || 1)) doc.currentStep = Math.min(6, n + 1);
  return s;
}

function failStep(doc, n, error) {
  const s = doc.steps[n] || (doc.steps[n] = freshStepState());
  s.status = 'failed';
  s.error = String(error || 'Something went wrong.');
  s.finishedAt = new Date().toISOString();
  return s;
}

/** Retry = clear the failure honestly. Real generation retry lands in Phase D. */
function retryStep(doc, n) {
  const s = doc.steps[n] || (doc.steps[n] = freshStepState());
  s.status = 'empty';
  s.error = null;
  s.startedAt = null;
  s.finishedAt = null;
  s.durationMs = null;
  return s;
}

/** Variations ×4 select/deselect — the toggle state is real and persisted. */
function toggleVariation(doc, n, variationId) {
  const s = doc.steps[n] || (doc.steps[n] = freshStepState());
  s.variations = s.variations || [];
  const i = s.variations.indexOf(variationId);
  if (i >= 0) s.variations.splice(i, 1);
  else s.variations.push(variationId);
  return s.variations;
}

/** Project Thread: one storyline carried through every step. Pure. */
function projectThread(doc) {
  const steps = doc.steps || {};
  let current = 1;
  for (let n = 1; n <= 6; n++) {
    if (steps[n] && steps[n].status !== 'empty') current = Math.min(6, n + 1);
  }
  const whatsLeft = [];
  for (let n = current; n <= 6; n++) {
    const d = stepDef(n);
    const st = steps[n] && steps[n].status;
    if (st !== 'ready') whatsLeft.push(`${d.name} → ${d.to}`);
  }
  const readyCount = STEPS.filter((s) => steps[s.n] && steps[s.n].status === 'ready').length;
  return {
    originalIdea: doc.originalIdea || '',
    lockedDecisions: Array.isArray(doc.lockedDecisions) ? doc.lockedDecisions : [],
    current: { n: current, name: stepDef(current).name },
    whatsLeft,
    readyCount,
    hasIdea: !!(doc.originalIdea && doc.originalIdea.trim()),
  };
}

/** Resume strip: the most recently updated project + where it stands. Pure. */
function resumeState(projects) {
  // projects: [{ id, name, updatedAt, currentStep, readySteps, ... }]
  if (!projects || !projects.length) return null;
  const p = projects[0]; // listProjects sorts by updatedAt desc
  if (!p.hasIdea && (p.readySteps || 0) === 0) return null; // nothing to resume
  const d = stepDef(p.currentStep || 1);
  return {
    projectId: p.id,
    projectName: p.name,
    stepN: d.n,
    stepName: d.name,
    readySteps: p.readySteps || 0,
    updatedAt: p.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Script-to-Film analyzer — deterministic, real. No AI needed.
// Paste a script -> scenes, dialogue, ambiguity flags. Analyze-before-generate.
// ---------------------------------------------------------------------------

/** Split raw text into scene blocks. Pure. */
function splitScenes(text) {
  const lines = String(text || '').split('\n');
  const scenes = [];
  let cur = { heading: '', lines: [] };
  const headingRe = /^\s*(SCENE\s+\d+|INT\.|EXT\.|INT\/EXT\.|INT\.\/EXT\.).*$/i;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*---+\s*$/.test(line) && cur.lines.length) {
      scenes.push(cur); cur = { heading: '', lines: [] };
      continue;
    }
    if (headingRe.test(line) && (cur.lines.length || cur.heading)) {
      scenes.push(cur); cur = { heading: line.trim(), lines: [] };
      continue;
    }
    if (!cur.heading && headingRe.test(line)) { cur.heading = line.trim(); continue; }
    cur.lines.push(line);
  }
  if (cur.lines.length || cur.heading) scenes.push(cur);
  // No headings at all -> blank-line blocks become scenes.
  if (scenes.length <= 1 && !scenes[0].heading) {
    const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length > 1) {
      return blocks.map((b, i) => ({ heading: `Scene ${i + 1}`, lines: b.split('\n') }));
    }
  }
  return scenes.map((s, i) => ({ heading: s.heading || `Scene ${i + 1}`, lines: s.lines }));
}

/** Pull dialogue out of a scene's lines. Pure.
 *  Supports "NAME: line" and screenplay style (CAPS name, then dialogue). */
function extractDialogue(lines) {
  const out = [];
  const inlineRe = /^\s*([A-Z][A-Z .'\-]{1,28})\s*[:\u2014-]\s*(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(inlineRe);
    if (m) {
      out.push({ character: m[1].trim(), line: m[2].trim(), hasNote: /\(.*\)/.test(m[2]) });
      continue;
    }
    // Screenplay style: a lone CAPS name line followed by dialogue.
    if (/^\s*[A-Z][A-Z .'\-]{1,28}\s*$/.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next && !/^[A-Z][A-Z .'\-]{1,28}$/.test(next)) {
        const noteMatch = next.match(/^\(([^)]+)\)\s*(.*)$/);
        out.push({
          character: line.trim(),
          line: noteMatch ? noteMatch[2].trim() : next,
          hasNote: !!noteMatch,
        });
        i++;
      }
    }
  }
  return out;
}

/** Flag ambiguities a director would need resolved. Pure. */
function findAmbiguities(scenes) {
  const flags = [];
  const introduced = new Set();
  scenes.forEach((sc, si) => {
    const label = sc.heading || `Scene ${si + 1}`;
    if (!/^(INT\.|EXT\.|INT\/EXT\.)/i.test(sc.heading || '')) {
      flags.push({
        type: 'no-setting',
        scene: label,
        text: 'No INT./EXT. setting on this scene.',
        suggestion: 'Add where and when this happens (e.g. "EXT. ROMAN STREET — DAWN").',
      });
    }
    const dlg = extractDialogue(sc.lines);
    dlg.forEach((d) => {
      if (!introduced.has(d.character)) {
        introduced.add(d.character);
        flags.push({
          type: 'unintroduced-character',
          scene: label,
          text: `${d.character} speaks before being introduced.`,
          suggestion: `Give ${d.character} a first appearance in the action lines.`,
        });
      }
      if (!d.hasNote) {
        flags.push({
          type: 'no-delivery-note',
          scene: label,
          text: `“${d.line.slice(0, 60)}${d.line.length > 60 ? '…' : ''}” has no delivery note.`,
          suggestion: 'Add how it is said (e.g. "(quietly)", "(measured)").',
        });
      }
      if (d.line.split(/\s+/).length > 40) {
        flags.push({
          type: 'long-line',
          scene: label,
          text: `${d.character}'s line is ${d.line.split(/\s+/).length} words — long for one breath.`,
          suggestion: 'Consider splitting it across a pause or a reaction shot.',
        });
      }
    });
  });
  return flags;
}

/** Full analysis: scenes + dialogue + ambiguities + counts. Pure. */
function analyzeScript(text) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, reason: 'Paste a script first — there is nothing to analyze yet.' };
  if (clean.length > 200000) return { ok: false, reason: 'That script is over 200,000 characters — split it into parts.' };
  const scenes = splitScenes(clean);
  const withDialogue = scenes.map((sc) => ({ ...sc, dialogue: extractDialogue(sc.lines) }));
  const ambiguities = findAmbiguities(withDialogue);
  const dialogueCount = withDialogue.reduce((a, s) => a + s.dialogue.length, 0);
  return {
    ok: true,
    scenes: withDialogue.map((s) => ({
      heading: s.heading,
      lineCount: s.lines.filter((l) => l.trim()).length,
      dialogue: s.dialogue,
    })),
    ambiguities,
    counts: { scenes: withDialogue.length, dialogue: dialogueCount, ambiguities: ambiguities.length },
  };
}

// ---------------------------------------------------------------------------
// Taste Lock — real rules, stored on the config. Pure helpers.
// Rule: { id, type: 'always'|'never', text, createdAt }
// ---------------------------------------------------------------------------

function validateTasteRule(type, text) {
  const t = String(text || '').trim();
  if (type !== 'always' && type !== 'never') return { ok: false, reason: 'Rule must be Always or Never.' };
  if (!t) return { ok: false, reason: 'Write the rule first.' };
  if (t.length > 200) return { ok: false, reason: 'Keep the rule under 200 characters.' };
  return { ok: true, type, text: t };
}

function addTasteRule(taste, type, text) {
  const v = validateTasteRule(type, text);
  if (!v.ok) return v;
  const rules = Array.isArray(taste && taste.rules) ? [...taste.rules] : [];
  const dup = rules.some((r) => r.type === v.type && r.text.toLowerCase() === v.text.toLowerCase());
  if (dup) return { ok: false, reason: 'That rule is already in your Taste Lock.' };
  const rule = { id: `taste-${Date.now()}`, type: v.type, text: v.text, createdAt: new Date().toISOString() };
  rules.push(rule);
  return { ok: true, rules, rule };
}

function removeTasteRule(taste, id) {
  const rules = Array.isArray(taste && taste.rules) ? taste.rules.filter((r) => r.id !== id) : [];
  return { ok: true, rules };
}

function updateTasteRule(taste, id, text) {
  const v = validateTasteRule('always', text); // type validated separately; reuse text rules
  if (!v.ok && v.reason !== 'Rule must be Always or Never.') return v;
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'Write the rule first.' };
  if (t.length > 200) return { ok: false, reason: 'Keep the rule under 200 characters.' };
  const rules = Array.isArray(taste && taste.rules) ? taste.rules.map((r) => (r.id === id ? { ...r, text: t } : r)) : [];
  return { ok: true, rules };
}

// ---------------------------------------------------------------------------
// Context-assist — deterministic, project-aware suggestions. Real rules,
// plainly labelled. No fake AI.
// ---------------------------------------------------------------------------

/** Suggest next moves from real project state. Pure. */
function suggestNextMoves(doc, toolStates) {
  // toolStates: { toolId: { state } } from mergedToolStates — may be null.
  const out = [];
  const steps = doc.steps || {};
  const thread = projectThread(doc);
  if (!thread.hasIdea) {
    out.push({ kind: 'idea', title: 'Give this film its one-line idea', why: 'Every locked decision hangs off the original idea.' });
    return out;
  }
  const needFor = (n) => {
    const d = stepDef(n);
    return d.needsTool ? { toolId: d.needsTool, label: d.needsLabel } : null;
  };
  for (let n = 1; n <= 6; n++) {
    const st = steps[n];
    if (st && st.status === 'failed') {
      out.push({ kind: 'retry', step: n, title: `Step ${n} ${stepDef(n).name} failed — review and retry`, why: st.error || 'See the error on the step.' });
    }
  }
  const cur = thread.current.n;
  if (cur <= 6 && (!steps[cur] || steps[cur].status !== 'ready')) {
    const need = needFor(cur);
    if (need && toolStates && toolStates[need.toolId] && toolStates[need.toolId].state !== 'installed') {
      out.push({ kind: 'tool', step: cur, toolId: need.toolId, title: `Step ${cur} needs ${need.label} (not downloaded)`, why: 'Download it in Model Manager, or import a file from your Library instead.' });
    } else if (need) {
      out.push({ kind: 'generate', step: cur, title: `Continue at Step ${cur} — ${stepDef(cur).name}`, why: `Produces: ${stepDef(cur).to}.` });
    } else {
      out.push({ kind: 'generate', step: cur, title: `Continue at Step ${cur} — ${stepDef(cur).name}`, why: `Produces: ${stepDef(cur).to}.` });
    }
  }
  if (thread.lockedDecisions.length === 0) {
    out.push({ kind: 'locks', title: 'Lock 2–3 decisions (style, palette, pacing)', why: 'Locked decisions keep every later step from drifting.' });
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Honest engine gate text per step. Pure — the renderer shows this verbatim.
// ---------------------------------------------------------------------------

function engineGateText(stepN, toolInstalled) {
  const d = stepDef(stepN);
  if (!d || !d.needsTool) return null; // step needs no engine (brief/final handled separately)
  if (!toolInstalled) {
    return {
      title: `${d.needsLabel} is not downloaded yet`,
      body: `Step ${d.n} (${d.name}) needs ${d.needsLabel}. Download it in Model Manager — or import a finished file from your Library to keep moving.`,
      action: 'model-manager',
      actionLabel: 'Open Model Manager',
    };
  }
  return {
    title: 'Engine connects in the next update',
    body: `Your settings for Step ${d.n} (${d.name}) are saved. Generation itself switches on with the engine update — nothing you set now will be lost.`,
    action: null,
    actionLabel: null,
  };
}

module.exports = {
  STEPS,
  stepDef,
  freshStepState,
  setStepSettings,
  addStepOutput,
  failStep,
  retryStep,
  toggleVariation,
  projectThread,
  resumeState,
  splitScenes,
  extractDialogue,
  findAmbiguities,
  analyzeScript,
  validateTasteRule,
  addTasteRule,
  removeTasteRule,
  updateTasteRule,
  suggestNextMoves,
  engineGateText,
};
