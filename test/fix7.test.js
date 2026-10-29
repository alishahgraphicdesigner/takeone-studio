'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const lib = require('../main/library.js');

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function mkRoot() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'fix7-'));
}

async function mkProjectWithImage(root, name) {
  const c = await lib.createProject(root, name);
  assert.ok(c.ok, 'createProject must succeed');
  const id = c.project.id;
  await fsp.writeFile(path.join(root, 'Projects', id, 'images', 'shot.png'), Buffer.from(TINY_PNG_B64, 'base64'));
  return id;
}

test('FIX-7: create -> trash -> restore returns the project to Library with thumbnail', async () => {
  const root = await mkRoot();
  const id = await mkProjectWithImage(root, 'Fix Seven');
  const tr = await lib.trashProject(root, id);
  assert.ok(tr.ok, 'trashProject must succeed');
  assert.deepEqual((await lib.listProjects(root)).map((p) => p.id), [], 'Library empty after trash');
  const trash = await lib.listTrash(root);
  assert.strictEqual(trash.length, 1, 'one trash entry');
  assert.strictEqual(trash[0].kind, 'project');
  const rs = await lib.restoreFromTrash(root, trash[0].trashName, 'project');
  assert.ok(rs.ok, 'restoreFromTrash must succeed: ' + JSON.stringify(rs));
  const back = await lib.listProjects(root);
  assert.strictEqual(back.length, 1, 'project back in Library');
  assert.strictEqual(back[0].id, id, 'same project id restored');
  assert.ok(back[0].thumb && back[0].thumb.startsWith('images/'), 'thumbnail present, got ' + back[0].thumb);
  assert.deepEqual(await lib.listTrash(root), [], 'Trash empty after restore');
});

test('FIX-7: restore with a name conflict restores under a distinct folder, both listed', async () => {
  const root = await mkRoot();
  const id = await mkProjectWithImage(root, 'Conflict Case');
  await lib.trashProject(root, id);
  // Simulate a recreated project occupying the original id folder.
  await fsp.mkdir(path.join(root, 'Projects', id, 'images'), { recursive: true });
  const doc = JSON.parse(await fsp.readFile(path.join(root, 'Trash', 'projects', (await lib.listTrash(root))[0].trashName, 'project.json'), 'utf8'));
  await fsp.writeFile(path.join(root, 'Projects', id, 'project.json'), JSON.stringify({ ...doc, name: 'Conflict Case (new)' }));
  const trash = await lib.listTrash(root);
  const rs = await lib.restoreFromTrash(root, trash[0].trashName, 'project');
  assert.ok(rs.ok, 'conflict restore must succeed: ' + JSON.stringify(rs));
  assert.notStrictEqual(rs.projectId, id, 'restored folder must differ from the occupied id');
  const listed = (await lib.listProjects(root)).map((p) => p.id).sort();
  assert.strictEqual(listed.length, 2, 'both projects listed, got ' + listed);
  assert.ok(listed.includes(rs.projectId), 'restored project listed');
});

test('FIX-7: delete forever removes only that entry; empty trash clears the rest', async () => {
  const root = await mkRoot();
  const a = await mkProjectWithImage(root, 'Keep Gone');
  const b = await mkProjectWithImage(root, 'Also Gone');
  await lib.trashProject(root, a);
  await lib.trashProject(root, b);
  let trash = await lib.listTrash(root);
  assert.strictEqual(trash.length, 2);
  const df = await lib.deleteForever(root, trash[0].trashName, 'project');
  assert.ok(df.ok, 'deleteForever must succeed');
  trash = await lib.listTrash(root);
  assert.strictEqual(trash.length, 1, 'one entry left after delete forever');
  const em = await lib.emptyTrash(root);
  assert.ok(em.ok, 'emptyTrash must succeed');
  assert.deepEqual(await lib.listTrash(root), [], 'Trash empty after emptyTrash');
});

test('FIX-7: restoring a missing trash entry fails honestly (no throw, no silent move)', async () => {
  const root = await mkRoot();
  const rs = await lib.restoreFromTrash(root, 'no-such-project__1234567890123', 'project');
  assert.strictEqual(rs.ok, false, 'missing entry must fail, not silently succeed');
  assert.ok(rs.reason, 'a reason must be returned');
});
