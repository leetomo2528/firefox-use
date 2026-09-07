'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  fileUpload, uploadImage, tools, resolvePaths, imageName, requirePoint,
  FILES_FN, DROP_FN,
} = require('../src/uploads');
const { FakeSession } = require('./helpers/fake-session');
const { NO_TAB, NO_REF } = require('../src/session');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-uploads-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function tmpFile(name, contents = 'hello') {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents);
  return p;
}

// Sparse, so a 10 MB+ fixture costs nothing.
function tmpSparse(name, size) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '');
  fs.truncateSync(p, size);
  return p;
}

function ctxFor(session, downloadDir = TMP) {
  return { session: async () => session, callTool: async () => { throw new Error('no'); }, config: { downloadDir } };
}

const setFilesCall = (session) => session.callsOf('send').find((c) => c.args.method === 'input.setFiles');

// --- path validation ------------------------------------------------------

test('paths must be a non-empty array of strings', async () => {
  const session = new FakeSession();
  await assert.rejects(fileUpload(session, { paths: [], ref: 'ref_1', tabId: 1 }), /non-empty array/);
  await assert.rejects(fileUpload(session, { ref: 'ref_1', tabId: 1 }), /non-empty array/);
  await assert.rejects(fileUpload(session, { paths: ['  '], ref: 'ref_1', tabId: 1 }), /non-empty string/);
  assert.equal(session.calls.length, 0, 'the page is never touched for an invalid request');
});

test('a missing file is reported by absolute path, before any page work', async () => {
  const session = new FakeSession();
  const missing = path.join(TMP, 'nope.txt');
  await assert.rejects(
    fileUpload(session, { paths: [missing], ref: 'ref_1', tabId: 1 }),
    (err) => err.message === `File not found: ${missing}`
  );
  assert.equal(session.calls.length, 0);
});

test('a directory is refused instead of being handed to setFiles', async () => {
  const session = new FakeSession();
  await assert.rejects(
    fileUpload(session, { paths: [TMP], ref: 'ref_1', tabId: 1 }),
    /is a directory\. file_upload takes files, not folders\./
  );
  assert.equal(setFilesCall(session), undefined);
});

test('relative and ~ paths become absolute in the setFiles payload', () => {
  const rel = path.relative(process.cwd(), tmpFile('rel.txt'));
  const { files } = resolvePaths([rel]);
  assert.equal(files[0].path, path.join(TMP, 'rel.txt'));
  assert.throws(() => resolvePaths(['~/definitely-not-here-ffuse.txt']), (err) => {
    assert.match(err.message, /^File not found: /);
    assert.ok(err.message.includes(os.homedir()), 'the ~ is expanded before reporting');
    return true;
  });
});

// --- the 10 MB budget -----------------------------------------------------

test('the combined size limit is 10 MB across all files, with the spec wording', async () => {
  const session = new FakeSession();
  const a = tmpSparse('big-a.bin', 6 * 1024 * 1024);
  const b = tmpSparse('big-b.bin', 6 * 1024 * 1024);
  await assert.rejects(
    fileUpload(session, { paths: [a, b], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.match(err.message, /These 2 files add up to 12\.0 MB\./);
      assert.match(err.message, /The combined size of all files in a single call must stay under 10 MB\./);
      return true;
    }
  );
  assert.equal(session.calls.length, 0);
});

test('the budget is exclusive: 10 MB exactly is refused, a byte under is not', async () => {
  const at = tmpSparse('edge-at.bin', 10 * 1024 * 1024);
  await assert.rejects(
    fileUpload(new FakeSession(), { paths: [at], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.equal(
        err.message,
        `${at} is 10.0 MB. The combined size of all files in a single call must stay under 10 MB.`,
        'a single oversized file is named, not counted as "These 1 file"'
      );
      return true;
    }
  );
  const under = tmpSparse('edge-under.bin', 10 * 1024 * 1024 - 1);
  const session = new FakeSession({ responses: { callJson: [{ found: true, tag: 'input', count: 1, names: ['edge-under.bin'] }] } });
  const out = await fileUpload(session, { paths: [under], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Attached 1 file \(10\.0 MB\)/);
});

// --- input.setFiles -------------------------------------------------------

test('file_upload sends input.setFiles with the context, sharedId and absolute paths', async () => {
  const session = new FakeSession({
    responses: {
      refNode: [{ type: 'node', sharedId: 'shared-9', handle: 'h-9' }],
      callJson: [{ found: true, tag: 'input', fileInput: true, count: 2, names: ['a.txt', 'b.txt'] }],
    },
  });
  const a = tmpFile('a.txt', 'aaa');
  const b = tmpFile('b.txt', 'bbbb');
  const out = await fileUpload(session, { paths: [a, b], ref: 'ref_3', tabId: 1 });

  const call = setFilesCall(session);
  assert.deepEqual(call.args.params, {
    context: 'ctx-1',
    element: { sharedId: 'shared-9', handle: 'h-9' },
    files: [a, b],
  });
  assert.equal(session.callsOf('ensureRefStore').length, 1, 'the ref store is installed before refs are read');
  assert.deepEqual(session.callsOf('refNode')[0].args, { tabId: 1, ref: 'ref_3' });
  assert.match(out, /Attached 2 files \(7 B\) to ref_3 on tab 1:/);
  assert.match(out, new RegExp(`  ${a.replace(/[.\\/]/g, '\\$&')} \\(3 B\\)`));
  assert.match(out, /The input now reports 2 files: a\.txt, b\.txt\./);
});

test('the readback reports a mismatch rather than claiming success', async () => {
  const session = new FakeSession({ responses: { callJson: [{ found: true, tag: 'input', count: 0, names: [] }] } });
  const out = await fileUpload(session, { paths: [tmpFile('c.txt')], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Warning: the input reports 0 files, not 1\./);
});

test('a page that cannot be read back does not fail the upload', async () => {
  const session = new FakeSession();
  session.callJson = async () => { throw new Error('page script failed'); };
  const out = await fileUpload(session, { paths: [tmpFile('d.txt')], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Attached 1 file/);
  assert.match(out, /could not be read back to confirm/);
  assert.ok(setFilesCall(session), 'setFiles still ran');
});

test('a non-file element surfaces the BiDi error with the type hint', async () => {
  const session = new FakeSession();
  session.send = async () => { throw new Error('no such element: not a file input'); };
  await assert.rejects(
    fileUpload(session, { paths: [tmpFile('e.txt')], ref: 'ref_2', tabId: 1 }),
    /Could not attach files to ref_2: no such element: not a file input\. The element must be an <input type="file">\./
  );
});

test('a stale ref and a dead tab keep the shared Chrome wording', async () => {
  const stale = new FakeSession({ responses: { refNode: [null] } });
  await assert.rejects(
    fileUpload(stale, { paths: [tmpFile('f.txt')], ref: 'ref_7', tabId: 1 }),
    (err) => err.message === NO_REF('ref_7')
  );
  const gone = new FakeSession();
  await assert.rejects(
    fileUpload(gone, { paths: [tmpFile('g.txt')], ref: 'ref_1', tabId: 42 }),
    (err) => err.message === NO_TAB(42)
  );
});

test('file_upload without a ref says which tool produces one', async () => {
  const session = new FakeSession();
  await assert.rejects(
    fileUpload(session, { paths: [tmpFile('h.txt')], tabId: 1 }),
    /ref is required: use read_page or find to locate the file input/
  );
});

test('an omitted tabId falls back to the default tab', async () => {
  const session = new FakeSession({ tabs: [{ tabId: 5, context: 'ctx-5', url: 'https://x/' }] });
  const out = await fileUpload(session, { paths: [tmpFile('i.txt')], ref: 'ref_1' });
  assert.equal(setFilesCall(session).args.params.context, 'ctx-5');
  assert.match(out, /on tab 5:/);
});

test('a tabId that is not a number keeps the tab wording readable', async () => {
  const session = new FakeSession();
  await assert.rejects(
    fileUpload(session, { paths: [tmpFile('j.txt')], ref: 'ref_1', tabId: 'abc' }),
    (err) => err.message === NO_TAB('abc')
  );
  assert.equal(setFilesCall(session), undefined);
});

test('a single-file input that swallowed the extras says why', async () => {
  const session = new FakeSession({
    responses: { callJson: [{ found: true, tag: 'input', fileInput: true, multiple: false, count: 1, names: ['b.txt'] }] },
  });
  const out = await fileUpload(session, { paths: [tmpFile('k.txt'), tmpFile('l.txt')], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Warning: the input reports 1 file \(b\.txt\), not 2\./);
  assert.match(out, /no multiple attribute, so it holds one file at a time/);
});

// --- upload_image ---------------------------------------------------------

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function sessionWithImage(responses = {}) {
  const session = new FakeSession({ responses });
  const imageId = session.images.put({ data: PNG_B64, mimeType: 'image/png' });
  return { session, imageId };
}

test('an unknown imageId lists the ids that do exist', async () => {
  const { session } = sessionWithImage();
  await assert.rejects(
    uploadImage(session, { imageId: 'img_99', ref: 'ref_1', tabId: 1 }, ctxFor(session)),
    /Unknown imageId "img_99"\. Available image ids: img_1\./
  );
  const empty = new FakeSession();
  await assert.rejects(
    uploadImage(empty, { imageId: 'img_1', ref: 'ref_1', tabId: 1 }, ctxFor(empty)),
    /No images have been captured in this session yet/
  );
  assert.equal(empty.calls.length, 0);
});

test('ref and coordinate are mutually exclusive, and one is required', async () => {
  const { session, imageId } = sessionWithImage();
  await assert.rejects(
    uploadImage(session, { imageId, ref: 'ref_1', coordinate: [10, 20], tabId: 1 }, ctxFor(session)),
    /^Error: Provide either ref or coordinate, not both\.$/
  );
  await assert.rejects(
    uploadImage(session, { imageId, tabId: 1 }, ctxFor(session)),
    /Provide either ref .* or coordinate/
  );
  assert.equal(session.calls.length, 0);
});

test('upload_image by ref writes the bytes under downloadDir and reuses setFiles', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl-'));
  const { session, imageId } = sessionWithImage({ callJson: [{ found: true, tag: 'input', count: 1, names: ['image.png'] }] });
  const out = await uploadImage(session, { imageId, ref: 'ref_4', tabId: 1 }, ctxFor(session, dir));

  const written = path.join(dir, 'image.png');
  assert.equal(fs.readFileSync(written, 'utf8'), 'fake-png-bytes');
  assert.deepEqual(setFilesCall(session).args.params, {
    context: 'ctx-1',
    element: { sharedId: 'shared-1' },
    files: [written],
  });
  assert.match(out, /Uploaded img_1 to ref_4 on tab 1 as image\.png \(14 B\) through the file input\./);
  assert.match(out, /The input now reports 1 file: image\.png\./);
});

test('the filename is a basename with an extension, never a path', () => {
  assert.equal(imageName(undefined, 'image/png'), 'image.png');
  assert.equal(imageName('   ', 'image/png'), 'image.png');
  assert.equal(imageName('shot.jpg', 'image/png'), 'shot.jpg');
  assert.equal(imageName('../../etc/passwd', 'image/png'), 'passwd.png');
  assert.equal(imageName('snap', 'image/jpeg'), 'snap.jpg');
  assert.equal(imageName('..', 'image/png'), 'image.png');
  assert.equal(imageName('...', 'image/png'), 'image.png');
  assert.equal(imageName('..\\..\\win.png', 'image/png'), '.._.._win.png', 'a backslash never survives into the path');
  assert.equal(path.dirname(path.join('/dl', imageName('a/b/c.png', 'image/png'))), '/dl');
});

test('a custom filename lands in downloadDir and is what the page receives', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl2-'));
  const { session, imageId } = sessionWithImage();
  await uploadImage(session, { imageId, ref: 'ref_1', tabId: 1, filename: '../evil/shot.png' }, ctxFor(session, dir));
  assert.deepEqual(setFilesCall(session).args.params.files, [path.join(dir, 'shot.png')]);
});

test('a ref that is not a file input falls back to a drop on that element', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl3-'));
  const { session, imageId } = sessionWithImage({
    callJson: [{ ok: true, target: 'div#editor', dispatched: ['dragenter', 'dragover', 'drop'], dropHandled: true }],
    resolveRef: [{ found: true, visible: true, x: 300, y: 400, width: 600, height: 400, tag: 'div' }],
  });
  session.send = async () => { throw new Error('unable to set file input'); };
  const out = await uploadImage(session, { imageId, ref: 'ref_8', tabId: 1 }, ctxFor(session, dir));

  assert.match(out, /ref_8 is not a file input, so img_1 was dropped onto it instead\./);
  assert.match(out, /Dropped img_1 as image\.png onto <div#editor> at \(300, 400\) on tab 1\./);
  assert.deepEqual(session.callsOf('callJson')[0].args.args.slice(2), ['image.png', 300, 400]);
  assert.deepEqual(fs.readdirSync(dir), [], 'the file written for setFiles is cleaned up again');
});

test('an invisible non-input ref keeps the setFiles error instead of dropping at (0,0)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl4-'));
  const { session, imageId } = sessionWithImage({
    resolveRef: [{ found: true, visible: false, x: 0, y: 0, width: 0, height: 0, tag: 'div' }],
  });
  session.send = async () => { throw new Error('unable to set file input'); };
  await assert.rejects(
    uploadImage(session, { imageId, ref: 'ref_9', tabId: 1 }, ctxFor(session, dir)),
    /Could not attach files to ref_9: unable to set file input\. The element must be an <input type="file">\./
  );
  assert.equal(session.callsOf('callJson').length, 0, 'no drop is attempted at a zero-sized box');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a stale ref in upload_image is not turned into a drop', async () => {
  const { session, imageId } = sessionWithImage({ refNode: [null] });
  await assert.rejects(
    uploadImage(session, { imageId, ref: 'ref_7', tabId: 1 }, ctxFor(session)),
    (err) => err.message === NO_REF('ref_7')
  );
  assert.equal(session.callsOf('callJson').length, 0);
});

test('upload_image by coordinate runs the drop script with the image, name and point', async () => {
  const { session, imageId } = sessionWithImage({
    callJson: [{ ok: true, target: 'div#editor', dispatched: ['dragenter', 'dragover', 'drop'], dropHandled: true, pasteHandled: false }],
  });
  const out = await uploadImage(session, { imageId, coordinate: [640.4, 300.6], tabId: 1 }, ctxFor(session));

  const call = session.callsOf('callJson')[0];
  assert.equal(call.args.fn, DROP_FN);
  assert.deepEqual(call.args.args, [PNG_B64, 'image/png', 'image.png', 640, 301]);
  assert.equal(setFilesCall(session), undefined, 'drag & drop never touches input.setFiles');
  assert.match(out, /Dropped img_1 as image\.png onto <div#editor> at \(640, 301\) on tab 1\./);
  assert.match(out, /Dispatched dragenter, dragover, drop; the page handled the drop\./);
});

test('an unhandled drop is reported honestly, including the paste fallback', async () => {
  const handled = sessionWithImage({ callJson: [{ ok: true, target: 'body', dispatched: ['dragenter', 'dragover', 'drop', 'paste'], dropHandled: false, pasteHandled: true }] });
  const a = await uploadImage(handled.session, { imageId: handled.imageId, coordinate: [1, 2], tabId: 1 }, ctxFor(handled.session));
  assert.match(a, /the drop was ignored, but the paste fallback was handled\./);

  const ignored = sessionWithImage({ callJson: [{ ok: true, target: 'body', dispatched: ['dragenter'], dropHandled: false, pasteHandled: false }] });
  const b = await uploadImage(ignored.session, { imageId: ignored.imageId, coordinate: [1, 2], tabId: 1 }, ctxFor(ignored.session));
  assert.match(b, /neither the drop nor the paste fallback was handled - the target may not accept files\./);

  const accepted = sessionWithImage({ callJson: [{ ok: true, target: 'div', dispatched: ['dragenter', 'dragover', 'drop'], dropHandled: false, accepted: true, pasteHandled: false }] });
  const c = await uploadImage(accepted.session, { imageId: accepted.imageId, coordinate: [1, 2], tabId: 1 }, ctxFor(accepted.session));
  assert.match(c, /the target accepted the drag but never canceled the drop, so it may not have kept the file\./);

  const failed = sessionWithImage({ callJson: [{ ok: false, error: 'no element at (1, 2)' }] });
  await assert.rejects(
    uploadImage(failed.session, { imageId: failed.imageId, coordinate: [1, 2], tabId: 1 }, ctxFor(failed.session)),
    /Drag & drop of img_1 at \(1, 2\) failed: no element at \(1, 2\)\./
  );
});

test('coordinate has to be a pair of numbers', async () => {
  const { session, imageId } = sessionWithImage();
  for (const bad of [[1], [1, 2, 3], ['a', 'b'], [1, NaN]]) {
    await assert.rejects(
      uploadImage(session, { imageId, coordinate: bad, tabId: 1 }, ctxFor(session)),
      /coordinate must be \[x, y\] viewport coordinates\./
    );
  }
  assert.deepEqual(requirePoint(['12.7', 8]), { x: 13, y: 8 });
});

// --- the page-side scripts ------------------------------------------------

// Runs a page script with its globals shadowed by stubs, so its real logic is
// exercised without a browser.
function instantiate(src, env) {
  const names = Object.keys(env);
  return new Function(...names, `return ${src};`)(...names.map((n) => env[n]));
}

test('the readback script reports the input it finds and misses stale refs', () => {
  const el = { isConnected: true, localName: 'input', type: 'FILE', multiple: true, files: [{ name: 'a.txt' }, { name: 'b.png' }] };
  const window = { __ffuse: { refs: new Map([['ref_1', el], ['ref_2', { isConnected: false, localName: 'input' }]]) } };
  const read = instantiate(FILES_FN, { window });
  assert.deepEqual(JSON.parse(read('ref_1')), {
    found: true, tag: 'input', fileInput: true, multiple: true, count: 2, names: ['a.txt', 'b.png'],
  });
  assert.deepEqual(JSON.parse(read('ref_2')), { found: false });
  assert.deepEqual(JSON.parse(read('ref_9')), { found: false });
  assert.equal(JSON.parse(instantiate(FILES_FN, { window: {} })('ref_1')).found, false);
});

test('the drop script builds a File from base64 and dispatches the drag sequence', () => {
  const seen = [];
  const dropEnv = (handler, id = 'editor') => {
    const target = {
      localName: 'div', id,
      dispatchEvent(ev) { seen.push(ev); if (handler(ev)) ev.preventDefault(); return true; },
    };
    class Ev {
      constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
    }
    return {
      document: { elementFromPoint: (x, y) => (x < 0 ? null : target), activeElement: null, body: {} },
      atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
      Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
      File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; } },
      DataTransfer: class { constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; } },
      DragEvent: Ev, ClipboardEvent: Ev,
    };
  };

  const env = dropEnv((ev) => ev.type === 'drop');
  const res = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', 12, 34));
  assert.deepEqual(res.dispatched, ['dragenter', 'dragover', 'drop']);
  assert.equal(res.dropHandled, true);
  assert.equal(res.pasteHandled, false);
  assert.equal(res.target, 'div#editor');
  assert.deepEqual(seen.map((e) => [e.clientX, e.clientY]), [[12, 34], [12, 34], [12, 34]]);
  const file = seen[0].dataTransfer.files[0];
  assert.equal(file.name, 'shot.png');
  assert.equal(file.type, 'image/png');
  assert.equal(Buffer.from(file.parts[0].parts[0]).toString(), 'fake-png-bytes');
});

test('the drop script falls back to paste and gives up cleanly with no target', () => {
  const seen = [];
  class Ev {
    constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const target = { localName: 'body', id: '', dispatchEvent(ev) { seen.push(ev.type); if (ev.type === 'paste') ev.preventDefault(); return true; } };
  const env = {
    document: { elementFromPoint: (x) => (x < 0 ? null : target), activeElement: null, body: {} },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Blob: class {}, File: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; } },
    DragEvent: Ev, ClipboardEvent: Ev,
  };
  const res = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', 5, 6));
  assert.deepEqual(seen, ['dragenter', 'dragover', 'drop', 'paste']);
  assert.equal(res.dropHandled, false);
  assert.equal(res.pasteHandled, true);
  assert.equal(res.target, 'body');

  const nothing = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', -1, -1));
  assert.deepEqual(nothing, { ok: false, error: 'no element at (-1, -1)' });
});

test('a target that accepts the drag is not pasted into a second time', () => {
  const seen = [];
  class Ev {
    constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const target = {
    localName: 'div', id: 'zone',
    dispatchEvent(ev) { seen.push(ev.type); if (ev.type === 'dragover') ev.preventDefault(); return true; },
  };
  const env = {
    document: { elementFromPoint: () => target, activeElement: null, body: {} },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Blob: class {}, File: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; } },
    DragEvent: Ev, ClipboardEvent: Ev,
  };
  const res = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', 3, 4));
  assert.deepEqual(seen, ['dragenter', 'dragover', 'drop'], 'no paste after an accepted drag');
  assert.equal(res.accepted, true);
  assert.equal(res.dropHandled, false, 'only the drop event counts as handled');
  assert.equal(res.pasteHandled, false);
});

test('a page without a usable DragEvent is reported instead of throwing', () => {
  const env = {
    document: { elementFromPoint: () => ({ localName: 'div', id: '', dispatchEvent() {} }), activeElement: null, body: {} },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Blob: class {}, File: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; } },
    DragEvent: class { constructor() { throw new Error('DragEvent is not a constructor'); } },
    ClipboardEvent: class {},
  };
  const res = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', 1, 1));
  assert.deepEqual(res, { ok: false, error: 'could not dispatch the drag sequence: DragEvent is not a constructor' });
});

test('a page without DataTransfer is reported instead of throwing', () => {
  const env = {
    document: { elementFromPoint: () => ({ localName: 'div', id: '', dispatchEvent() {} }), activeElement: null, body: {} },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Blob: class {}, File: class {},
    DataTransfer: class { constructor() { throw new Error('not supported'); } },
    DragEvent: class {}, ClipboardEvent: class {},
  };
  const res = JSON.parse(instantiate(DROP_FN, env)(PNG_B64, 'image/png', 'shot.png', 1, 1));
  assert.deepEqual(res, { ok: false, error: 'DataTransfer is unavailable: not supported' });
});

test('the page scripts stay ASCII so they survive transport as-is', () => {
  for (const src of [FILES_FN, DROP_FN]) {
    assert.ok(!/[^\x20-\x7e\n\r\t]/.test(src), 'no raw control or non-ASCII characters');
    assert.equal(typeof new Function(`return ${src}`)(), 'function');
  }
});

// --- tool definitions -----------------------------------------------------

test('the tool definitions match docs/chrome-tool-spec.json verbatim', () => {
  const spec = require('../docs/chrome-tool-spec.json');
  const specTools = spec.tools || spec;
  const defs = tools(ctxFor(new FakeSession()));
  assert.deepEqual(defs.map((t) => t.name).sort(), ['file_upload', 'upload_image']);
  for (const def of defs) {
    const want = specTools.find((t) => t.name === def.name);
    assert.ok(want, `${def.name} is in the spec`);
    assert.equal(def.description, want.description, `${def.name} description`);
    assert.deepEqual(def.inputSchema, want.inputSchema, `${def.name} inputSchema`);
    assert.equal(typeof def.handler, 'function');
    for (const required of def.inputSchema.required) {
      assert.ok(def.inputSchema.properties[required], `${def.name} requires undeclared "${required}"`);
    }
  }
});

test('building the tools opens no browser, and the handler passes ctx through', async () => {
  let opened = 0;
  const session = new FakeSession();
  const ctx = { session: async () => { opened++; return session; }, config: { downloadDir: TMP } };
  const defs = tools(ctx);
  assert.equal(opened, 0);

  const upload = defs.find((t) => t.name === 'file_upload');
  const out = await upload.handler({ paths: [tmpFile('via-handler.txt', 'x')], ref: 'ref_1', tabId: 1 });
  assert.equal(opened, 1);
  assert.match(out, /Attached 1 file \(1 B\) to ref_1 on tab 1:/);
});
