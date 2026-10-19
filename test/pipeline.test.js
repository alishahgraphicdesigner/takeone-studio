/* TakeOne Studio 2.2.0 — Phase C unit tests: pipeline state machine,
 * script analyzer, taste rules, context-assist. All pure — no disk needed
 * except through main/library.js helpers. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
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
  addTasteRule,
  removeTasteRule,
  updateTasteRule,
  suggestNextMoves,
  engineGateText,
} = require('../main/pipeline.js');
const { defaultProjectDoc } = require('../main/library.js');

function doc() { return defaultProjectDoc('p1', 'Test Film'); }

describe('STEPS', () => {
  it('has 6 steps in demo order', () => {
    assert.deepEqual(STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.equal(STEPS[0].name, 'Prompt Brief');
    assert.equal(STEPS[5].name, 'Final');
  });
  it('has no LTX anywhere', () => {
    assert.ok(!JSON.stringify(STEPS).toLowerCase().includes('ltx'));
  });
});

describe('step state machine', () => {
  it('settings persist on the step', () => {
    const d = doc();
    setStepSettings(d, 2, { seed: 42, style: 'Cinematic' });
    assert.equal(d.steps[2].settings.seed, 42);
    setStepSettings(d, 2, { ratio: '16:9' });
    assert.equal(d.steps[2].settings.seed, 42, 'merge, not replace');
  });
  it('addStepOutput marks ready and snapshots settings', () => {
    const d = doc();
    setStepSettings(d, 2, { seed: 7 });
    addStepOutput(d, 2, { label: 'Source image', rel: 'images/a.png' });
    assert.equal(d.steps[2].status, 'ready');
    assert.equal(d.steps[2].outputs[0].settings.seed, 7);
    assert.equal(d.currentStep, 3);
  });
  it('fail/retry cycle is honest', () => {
    const d = doc();
    failStep(d, 3, 'GPU ran out of memory');
    assert.equal(d.steps[3].status, 'failed');
    assert.match(d.steps[3].error, /GPU/);
    retryStep(d, 3);
    assert.equal(d.steps[3].status, 'empty');
    assert.equal(d.steps[3].error, null);
  });
  it('variations toggle is real select/deselect', () => {
    const d = doc();
    assert.deepEqual(toggleVariation(d, 2, 'v1'), ['v1']);
    assert.deepEqual(toggleVariation(d, 2, 'v2'), ['v1', 'v2']);
    assert.deepEqual(toggleVariation(d, 2, 'v1'), ['v2'], 'deselect works');
  });
});

describe('projectThread', () => {
  it('tracks idea, locks, current and whats-left', () => {
    const d = doc();
    d.originalIdea = 'A Roman street before the ash';
    d.lockedDecisions = ['Grounded realism', 'Dawn palette'];
    addStepOutput(d, 1, { label: 'Brief' });
    addStepOutput(d, 2, { label: 'Image' });
    const t = projectThread(d);
    assert.equal(t.originalIdea, 'A Roman street before the ash');
    assert.deepEqual(t.lockedDecisions, ['Grounded realism', 'Dawn palette']);
    assert.equal(t.current.n, 3);
    assert.equal(t.current.name, 'Animate');
    assert.ok(t.whatsLeft[0].startsWith('Animate'));
    assert.equal(t.readyCount, 2);
  });
  it('empty project: current is step 1, everything left', () => {
    const t = projectThread(doc());
    assert.equal(t.current.n, 1);
    assert.equal(t.whatsLeft.length, 6);
    assert.equal(t.hasIdea, false);
  });
});

describe('resumeState', () => {
  it('returns null when there is nothing to resume', () => {
    assert.equal(resumeState([]), null);
    assert.equal(resumeState(null), null);
  });
  it('picks the most recent project with real progress', () => {
    const r = resumeState([
      { id: 'a', name: 'Film A', updatedAt: '2026-10-15T10:00:00Z', currentStep: 4, readySteps: 3, hasIdea: true },
    ]);
    assert.equal(r.projectId, 'a');
    assert.equal(r.stepN, 4);
    assert.equal(r.stepName, 'Director');
  });
});

describe('analyzeScript', () => {
  const SCRIPT = `EXT. ROMAN STREET — DAWN

A baker opens his shutters. Fine ash lands on the bread.

BAKER
(quietly)
It is only weather.

The street darkens. A distant rumble stops every conversation.

MARA
We should go inside now, all of us, before the sky decides for us.`;

  it('rejects empty input honestly', () => {
    const r = analyzeScript('   ');
    assert.equal(r.ok, false);
    assert.match(r.reason, /nothing to analyze/);
  });
  it('finds scenes and dialogue', () => {
    const r = analyzeScript(SCRIPT);
    assert.equal(r.ok, true);
    assert.equal(r.counts.scenes, 1);
    assert.equal(r.dialogueCount, undefined); // counts.dialogue is the field
    assert.equal(r.counts.dialogue, 2);
    assert.equal(r.scenes[0].dialogue[0].character, 'BAKER');
    assert.equal(r.scenes[0].dialogue[0].hasNote, true);
    assert.equal(r.scenes[0].dialogue[1].character, 'MARA');
    assert.equal(r.scenes[0].dialogue[1].hasNote, false);
  });
  it('flags real ambiguities', () => {
    const r = analyzeScript(SCRIPT);
    const types = r.ambiguities.map((a) => a.type);
    assert.ok(types.includes('no-delivery-note'), 'MARA has no delivery note: ' + types.join(','));
    assert.ok(types.includes('unintroduced-character'), 'BAKER unintroduced: ' + types.join(','));
    assert.ok(!types.includes('no-setting'), 'EXT. heading present — no false flag');
    for (const a of r.ambiguities) {
      assert.ok(a.suggestion && a.suggestion.length > 10, 'every flag carries a suggestion');
    }
  });
  it('splits INT./EXT. scenes', () => {
    const r = analyzeScript('INT. HOUSE — NIGHT\nA man sleeps.\n\nEXT. STREET — DAY\nHe runs.');
    assert.equal(r.counts.scenes, 2);
  });
  it('handles NAME: line format', () => {
    const r = analyzeScript('BAKER: It is only weather, I tell you.');
    assert.equal(r.counts.dialogue, 1);
    assert.equal(r.scenes[0].dialogue[0].character, 'BAKER');
  });
});

describe('taste rules', () => {
  it('adds Always/Never rules, rejects dupes and empties', () => {
    let t = {};
    let r = addTasteRule(t, 'always', 'Warm narrator voice');
    assert.equal(r.ok, true);
    t = { rules: r.rules };
    r = addTasteRule(t, 'always', 'warm narrator voice');
    assert.equal(r.ok, false, 'case-insensitive dupe rejected');
    assert.match(r.reason, /already/);
    assert.equal(addTasteRule(t, 'sometimes', 'x').ok, false);
    assert.equal(addTasteRule(t, 'always', '  ').ok, false);
    assert.equal(addTasteRule(t, 'never', 'y'.repeat(201)).ok, false);
  });
  it('removes and updates', () => {
    const added = addTasteRule({}, 'never', 'Shaky handheld');
    const id = added.rule.id;
    const removed = removeTasteRule({ rules: added.rules }, id);
    assert.equal(removed.rules.length, 0);
    const updated = updateTasteRule({ rules: added.rules }, id, 'Shaky handheld ever');
    assert.equal(updated.rules[0].text, 'Shaky handheld ever');
  });
});

describe('suggestNextMoves', () => {
  it('asks for the idea first when there is none', () => {
    const s = suggestNextMoves(doc(), null);
    assert.equal(s[0].kind, 'idea');
  });
  it('points at the current step with a tool gate when the tool is missing', () => {
    const d = doc();
    d.originalIdea = 'Test idea';
    addStepOutput(d, 1, { label: 'Brief' }); // step 1 done -> current is step 2 (Image)
    const s = suggestNextMoves(d, { 'image-studio': { state: 'not-installed' } });
    assert.equal(s[0].kind, 'tool');
    assert.equal(s[0].toolId, 'image-studio');
  });
  it('surfaces failed steps first', () => {
    const d = doc();
    d.originalIdea = 'Test idea';
    failStep(d, 2, 'boom');
    const s = suggestNextMoves(d, null);
    assert.equal(s[0].kind, 'retry');
    assert.equal(s[0].step, 2);
  });
});

describe('engineGateText', () => {
  it('is honest when the tool is missing', () => {
    const g = engineGateText(2, false);
    assert.match(g.title, /not downloaded/);
    assert.equal(g.action, 'model-manager');
    assert.ok(!/terminal/i.test(g.body), 'no terminal words');
  });
  it('is honest when the tool exists but the engine is Phase D', () => {
    const g = engineGateText(2, true);
    assert.match(g.title, /next update/);
    assert.equal(g.action, null);
  });
  it('returns null for steps with no engine need', () => {
    assert.equal(engineGateText(1, false), null);
  });
});

describe('maskPersonalPath (no personal identifiers in UI)', () => {
  const { maskPersonalPath } = require('../main.js');
  it('masks a Windows username', () => {
    assert.equal(
      maskPersonalPath('C:\\Users\\AliAhmed\\Documents\\TakeOne'),
      'C:\\Users\\•••\\Documents\\TakeOne'
    );
  });
  it('masks a Linux home', () => {
    assert.equal(maskPersonalPath('/home/ali/workspace'), '/home/•••/workspace');
  });
  it('leaves custom paths untouched', () => {
    assert.equal(maskPersonalPath('D:\\Media\\TakeOne'), 'D:\\Media\\TakeOne');
  });
  it('handles null safely', () => {
    assert.equal(maskPersonalPath(null), null);
  });
});
