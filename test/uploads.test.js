'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  fileUpload, uploadImage, tools, resolvePaths, imageName, requirePoint,
  uploadRoots, writeImageFile, UPLOAD_ROOTS_ENV,
  FILES_FN, DROP_FN,
} = require('../src/uploads');
const { FakeSession } = require('./helpers/fake-session');
const { NO_TAB, NO_REF } = require('../src/session');

// realpath'd: on macOS os.tmpdir() is a symlink, and the gate reports resolved
// paths, so the fixtures have to be resolved too.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-uploads-')));
// Deliberately not an allowed root: the sandbox is TMP (the download dir) plus
// the server's own working directory.
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-outside-')));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

function tmpFile(name, contents = 'hello') {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents);
  return p;
}

function outsideFile(name, contents = 'secret') {
  const p = path.join(OUTSIDE, name);
  fs.writeFileSync(p, contents);
  return p;
}

// file_upload reads the upload sandbox off ctx, exactly as its handler does, so
// every direct call in this file supplies one.
const CTX = { config: { downloadDir: TMP } };
const upload = (session, args, ctx = CTX) => fileUpload(session, args, ctx);

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

// The env var is process-wide; put it back whatever the body does.
async function withUploadRoots(value, body) {
  const before = process.env[UPLOAD_ROOTS_ENV];
  process.env[UPLOAD_ROOTS_ENV] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[UPLOAD_ROOTS_ENV];
    else process.env[UPLOAD_ROOTS_ENV] = before;
  }
}

// --- path validation ------------------------------------------------------

test('paths must be a non-empty array of strings', async () => {
  const session = new FakeSession();
  await assert.rejects(upload(session, { paths: [], ref: 'ref_1', tabId: 1 }), /non-empty array/);
  await assert.rejects(upload(session, { ref: 'ref_1', tabId: 1 }), /non-empty array/);
  await assert.rejects(upload(session, { paths: ['  '], ref: 'ref_1', tabId: 1 }), /non-empty string/);
  assert.equal(session.calls.length, 0, 'the page is never touched for an invalid request');
});

test('a missing file is reported by absolute path, before any page work', async () => {
  const session = new FakeSession();
  const missing = path.join(TMP, 'nope.txt');
  await assert.rejects(
    upload(session, { paths: [missing], ref: 'ref_1', tabId: 1 }),
    (err) => err.message === `File not found: ${missing}`
  );
  assert.equal(session.calls.length, 0);
});

test('a directory is refused instead of being handed to setFiles', async () => {
  const session = new FakeSession();
  await assert.rejects(
    upload(session, { paths: [TMP], ref: 'ref_1', tabId: 1 }),
    /is a directory\. file_upload takes files, not folders\./
  );
  assert.equal(setFilesCall(session), undefined);
});

test('relative and ~ paths become absolute in the setFiles payload', () => {
  const rel = path.relative(process.cwd(), tmpFile('rel.txt'));
  const { files } = resolvePaths([rel], CTX);
  assert.equal(files[0].path, path.join(TMP, 'rel.txt'));
  assert.throws(() => resolvePaths(['~/definitely-not-here-ffuse.txt'], CTX), (err) => {
    assert.match(err.message, /is outside the folders this server may upload from/);
    assert.ok(err.message.startsWith(os.homedir()), 'the ~ is expanded before reporting');
    return true;
  });
});

// --- the upload sandbox ---------------------------------------------------
//
// The tool description promises that only files in a known set of folders can
// be uploaded. A page that asks for ~/.ssh/id_rsa must be refused, not obeyed.

test('a path outside every allowed root is refused before the page is touched', async () => {
  const session = new FakeSession();
  const secret = outsideFile('id_rsa', 'PRIVATE KEY');
  await assert.rejects(
    upload(session, { paths: [secret], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.ok(
        err.message.startsWith(`${secret} is outside the folders this server may upload from.`),
        err.message
      );
      assert.ok(err.message.includes(`Allowed roots: ${TMP}`), 'the download folder is named');
      assert.ok(err.message.includes(process.cwd()), 'the working directory is named');
      assert.match(err.message, /FIREFOX_USE_UPLOAD_ROOTS=\/absolute\/path/, 'says how to add one');
      return true;
    }
  );
  assert.equal(session.calls.length, 0, 'no BiDi traffic at all for a refused path');
});

test('one bad path refuses the whole batch, so nothing is attached', async () => {
  const session = new FakeSession();
  await assert.rejects(
    upload(session, { paths: [tmpFile('fine.txt'), outsideFile('nope.txt')], ref: 'ref_1', tabId: 1 }),
    /is outside the folders this server may upload from/
  );
  assert.equal(setFilesCall(session), undefined);
});

test('a symlink inside a root that resolves outside it is refused', async () => {
  const session = new FakeSession();
  const secret = outsideFile('linked-secret.txt', 'ssh key');
  const link = path.join(TMP, 'looks-innocent.txt');
  fs.symlinkSync(secret, link);
  await assert.rejects(
    upload(session, { paths: [link], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.ok(
        err.message.startsWith(`${link} resolves to ${secret}, which is outside the folders`),
        err.message
      );
      return true;
    }
  );
  assert.equal(setFilesCall(session), undefined, 'the link is never handed to the browser');
});

test('a symlink that stays inside a root is fine, and the target path is sent', async () => {
  const target = tmpFile('inside-target.txt', 'ok');
  const link = path.join(TMP, 'inside-link.txt');
  fs.symlinkSync(target, link);
  const session = new FakeSession();
  await upload(session, { paths: [link], ref: 'ref_1', tabId: 1 });
  assert.deepEqual(setFilesCall(session).args.params.files, [target]);
});

test(`${UPLOAD_ROOTS_ENV} opens extra roots, colon-separated`, async () => {
  const allowed = outsideFile('opted-in.txt', 'x');
  const session = new FakeSession();
  await withUploadRoots(`${path.join(OUTSIDE, 'not-created-yet')}:${OUTSIDE}`, async () => {
    const out = await upload(session, { paths: [allowed], ref: 'ref_1', tabId: 1 });
    assert.deepEqual(setFilesCall(session).args.params.files, [allowed]);
    assert.match(out, /Attached 1 file/);
  });
  await assert.rejects(
    upload(new FakeSession(), { paths: [allowed], ref: 'ref_1', tabId: 1 }),
    /is outside the folders this server may upload from/,
    'the root is gone again once the variable is'
  );
});

test('the directory the server was started in is a root', async () => {
  const file = outsideFile('cwd-file.txt', 'x');
  await assert.rejects(
    upload(new FakeSession(), { paths: [file], ref: 'ref_1', tabId: 1 }),
    /is outside the folders this server may upload from/
  );
  const here = process.cwd();
  process.chdir(OUTSIDE);
  try {
    const session = new FakeSession();
    await upload(session, { paths: [file], ref: 'ref_1', tabId: 1 });
    assert.deepEqual(setFilesCall(session).args.params.files, [file]);
  } finally {
    process.chdir(here);
  }
});

test('uploadRoots is the download folder, the env roots and the working directory', async () => {
  await withUploadRoots(`${OUTSIDE}:  :${OUTSIDE}`, () => {
    const roots = uploadRoots(CTX);
    assert.deepEqual(
      roots.map((r) => r.given),
      [TMP, OUTSIDE, process.cwd()],
      'blank entries and duplicates drop out; order is downloads, env, cwd'
    );
  });
  assert.deepEqual(uploadRoots(CTX).map((r) => r.given), [TMP, process.cwd()]);
});

test('a symlinked root is usable by either name, and the resolved path is sent', async () => {
  const real = fs.mkdtempSync(path.join(TMP, 'root-real-'));
  const link = path.join(TMP, 'root-link');
  fs.symlinkSync(real, link);
  const ctx = { config: { downloadDir: link } };
  const file = path.join(real, 'doc.txt');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(uploadRoots(ctx)[0], { given: link, real });

  for (const given of [file, path.join(link, 'doc.txt')]) {
    const session = new FakeSession();
    await upload(session, { paths: [given], ref: 'ref_1', tabId: 1 }, ctx);
    assert.deepEqual(setFilesCall(session).args.params.files, [file], `${given} resolves to the real path`);
  }
});

test('a root named in resolved form is still reachable through a symlinked ancestor', async () => {
  // process.cwd() is always the resolved path, and on macOS the usual scratch
  // parents (/tmp, /var) are symlinks - so the model is routinely handed the
  // unresolved name of a file that really does sit inside an allowed root.
  const real = fs.mkdtempSync(path.join(TMP, 'anc-real-'));
  const root = path.join(real, 'root');
  fs.mkdirSync(root);
  const alias = path.join(TMP, 'anc-link');
  fs.symlinkSync(real, alias); // the symlink is ABOVE the root, not the root
  const file = path.join(root, 'doc.txt');
  fs.writeFileSync(file, 'x');

  const ctx = { config: { downloadDir: root } };
  const session = new FakeSession();
  await upload(session, { paths: [path.join(alias, 'root', 'doc.txt')], ref: 'ref_1', tabId: 1 }, ctx);
  assert.deepEqual(
    setFilesCall(session).args.params.files,
    [file],
    'the alias resolves into the root, so it is allowed and sent resolved'
  );
});

test('a path outside the roots is refused the same way whether or not it exists', async () => {
  // The refusal must not double as an existence oracle: a page that asks for
  // ~/.ssh/id_rsa learns nothing from the answer either way.
  const missing = path.join(OUTSIDE, 'never-created.txt');
  const present = outsideFile('does-exist.txt', 'x');
  const messages = [];
  for (const p of [missing, present]) {
    await assert.rejects(
      upload(new FakeSession(), { paths: [p], ref: 'ref_1', tabId: 1 }),
      (err) => { messages.push(err.message.replace(p, '<path>')); return true; }
    );
  }
  assert.equal(messages[0], messages[1], 'the wording does not reveal whether the file is there');
  assert.match(messages[0], /^<path> is outside the folders this server may upload from\./);
});

test('the sandbox is enforced through the tool handler, not only the direct call', async () => {
  const session = new FakeSession();
  const tool = tools({ session: async () => session, config: { downloadDir: TMP } })
    .find((t) => t.name === 'file_upload');
  await assert.rejects(
    tool.handler({ paths: [outsideFile('via-handler-outside.txt')], ref: 'ref_1', tabId: 1 }),
    /is outside the folders this server may upload from/
  );
  assert.equal(setFilesCall(session), undefined);
});

// --- the 10 MB budget -----------------------------------------------------

test('the combined size limit is 10 MB across all files, in our own wording', async () => {
  const session = new FakeSession();
  const a = tmpSparse('big-a.bin', 6 * 1024 * 1024);
  const b = tmpSparse('big-b.bin', 6 * 1024 * 1024);
  await assert.rejects(
    upload(session, { paths: [a, b], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.match(err.message, /These 2 files add up to 12\.0 MB\./);
      assert.match(err.message, /One call may carry less than 10 MB across every path it names\./);
      return true;
    }
  );
  assert.equal(session.calls.length, 0);
});

test('the budget is exclusive: 10 MB exactly is refused, a byte under is not', async () => {
  const at = tmpSparse('edge-at.bin', 10 * 1024 * 1024);
  await assert.rejects(
    upload(new FakeSession(), { paths: [at], ref: 'ref_1', tabId: 1 }),
    (err) => {
      assert.equal(
        err.message,
        `${at} is 10.0 MB. One call may carry less than 10 MB across every path it names.`,
        'a single oversized file is named, not counted as "These 1 file"'
      );
      return true;
    }
  );
  const under = tmpSparse('edge-under.bin', 10 * 1024 * 1024 - 1);
  const session = new FakeSession({ responses: { callJson: [{ found: true, tag: 'input', count: 1, names: ['edge-under.bin'] }] } });
  const out = await upload(session, { paths: [under], ref: 'ref_1', tabId: 1 });
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
  const out = await upload(session, { paths: [a, b], ref: 'ref_3', tabId: 1 });

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
  const out = await upload(session, { paths: [tmpFile('c.txt')], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Warning: the input reports 0 files, not 1\./);
});

test('a page that cannot be read back does not fail the upload', async () => {
  const session = new FakeSession();
  session.callJson = async () => { throw new Error('page script failed'); };
  const out = await upload(session, { paths: [tmpFile('d.txt')], ref: 'ref_1', tabId: 1 });
  assert.match(out, /Attached 1 file/);
  assert.match(out, /could not be read back to confirm/);
  assert.ok(setFilesCall(session), 'setFiles still ran');
});

test('a non-file element surfaces the BiDi error with the type hint', async () => {
  const session = new FakeSession();
  session.send = async () => { throw new Error('no such element: not a file input'); };
  await assert.rejects(
    upload(session, { paths: [tmpFile('e.txt')], ref: 'ref_2', tabId: 1 }),
    /Could not attach files to ref_2: no such element: not a file input\. The element must be an <input type="file">\./
  );
});

test('a stale ref and a dead tab keep the shared Chrome wording', async () => {
  const stale = new FakeSession({ responses: { refNode: [null] } });
  await assert.rejects(
    upload(stale, { paths: [tmpFile('f.txt')], ref: 'ref_7', tabId: 1 }),
    (err) => err.message === NO_REF('ref_7')
  );
  const gone = new FakeSession();
  await assert.rejects(
    upload(gone, { paths: [tmpFile('g.txt')], ref: 'ref_1', tabId: 42 }),
    (err) => err.message === NO_TAB(42)
  );
});

test('file_upload without a ref says which tool produces one', async () => {
  const session = new FakeSession();
  await assert.rejects(
    upload(session, { paths: [tmpFile('h.txt')], tabId: 1 }),
    /ref is required: locate the file input with read_page or find/
  );
});

test('an omitted tabId falls back to the default tab', async () => {
  const session = new FakeSession({ tabs: [{ tabId: 5, context: 'ctx-5', url: 'https://x/' }] });
  const out = await upload(session, { paths: [tmpFile('i.txt')], ref: 'ref_1' });
  assert.equal(setFilesCall(session).args.params.context, 'ctx-5');
  assert.match(out, /on tab 5:/);
});

test('a tabId that is not a number keeps the tab wording readable', async () => {
  const session = new FakeSession();
  await assert.rejects(
    upload(session, { paths: [tmpFile('j.txt')], ref: 'ref_1', tabId: 'abc' }),
    (err) => err.message === NO_TAB('abc')
  );
  assert.equal(setFilesCall(session), undefined);
});

test('a single-file input that swallowed the extras says why', async () => {
  const session = new FakeSession({
    responses: { callJson: [{ found: true, tag: 'input', fileInput: true, multiple: false, count: 1, names: ['b.txt'] }] },
  });
  const out = await upload(session, { paths: [tmpFile('k.txt'), tmpFile('l.txt')], ref: 'ref_1', tabId: 1 });
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
    /^Error: ref and coordinate are alternatives: pass exactly one of them\.$/
  );
  await assert.rejects(
    uploadImage(session, { imageId, tabId: 1 }, ctxFor(session)),
    /Aim the image with one of ref .* or coordinate/
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

test('the scratch copy is written at the resolved download folder', async () => {
  const real = fs.mkdtempSync(path.join(TMP, 'dl-real-'));
  const link = path.join(TMP, 'dl-link');
  fs.symlinkSync(real, link);
  const { session, imageId } = sessionWithImage({ callJson: [{ found: true, tag: 'input', count: 1, names: ['image.png'] }] });
  const out = await uploadImage(session, { imageId, ref: 'ref_1', tabId: 1 }, ctxFor(session, link));
  assert.deepEqual(
    setFilesCall(session).args.params.files,
    [path.join(real, 'image.png')],
    'the page gets the resolved path - the one the gate checked'
  );
  assert.ok(out.includes(`Wrote ${path.join(real, 'image.png')}`));
});

test('writeImageFile refuses a name that would climb out of the download folder', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl-guard-'));
  const image = { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
  assert.throws(
    () => writeImageFile(image, `..${path.sep}escape.png`, { config: { downloadDir: dir } }),
    /Refusing to write .*escape\.png: images written for an upload stay in /
  );
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.png')), 'nothing was written outside the folder');
  assert.deepEqual(writeImageFile(image, 'shot.png', { config: { downloadDir: dir } }), {
    path: path.join(dir, 'shot.png'),
    size: 3,
  });
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

// Descriptions are prose and may differ from Chrome's; the machine-readable
// half of the definition may not. (parity.test.js enforces the same rule.)
function schemaShape(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(schemaShape);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'description') out[key] = schemaShape(value);
  }
  return out;
}

// The Chrome reference is generated locally (npm run spec) and never committed,
// so these checks stand down when it is absent - see test/parity.test.js.
const SPEC_PATH = path.join(__dirname, '..', '.spec', 'chrome-tool-spec.json');
const SPEC = fs.existsSync(SPEC_PATH) ? JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) : null;
const skipSpec = SPEC ? false : 'run `npm run spec` to generate .spec/chrome-tool-spec.json';
const specTool = (name) => (SPEC.tools || SPEC).find((t) => t.name === name);

test('the tool definitions keep the Chrome schema shapes', { skip: skipSpec }, () => {
  const defs = tools(ctxFor(new FakeSession()));
  assert.deepEqual(defs.map((t) => t.name).sort(), ['file_upload', 'upload_image']);
  for (const def of defs) {
    const want = specTool(def.name);
    assert.ok(want, `${def.name} is in the spec`);
    // Properties, types, required and the rest have to match exactly; the
    // description strings are the one part that is ours to write.
    assert.deepEqual(schemaShape(def.inputSchema), schemaShape(want.inputSchema), `${def.name} inputSchema`);
    for (const [prop, theirs] of Object.entries(want.inputSchema.properties || {})) {
      if (!theirs.description) continue;
      const ours = def.inputSchema.properties[prop];
      assert.ok(ours && ours.description, `${def.name}.${prop} needs a description`);
    }
  }
});

test('the prose is written here, not copied from Chrome', { skip: skipSpec }, () => {
  for (const def of tools(ctxFor(new FakeSession()))) {
    const want = specTool(def.name);
    assert.notEqual(def.description.trim(), want.description.trim(), `${def.name} description is verbatim`);
    for (const [prop, theirs] of Object.entries(want.inputSchema.properties || {})) {
      if (!theirs.description) continue;
      assert.notEqual(
        def.inputSchema.properties[prop].description.trim(), theirs.description.trim(),
        `${def.name}.${prop} is verbatim`
      );
    }
  }
});

// Holds with or without the reference file.
test('the definitions are wired up and document the tools', () => {
  const defs = tools(ctxFor(new FakeSession()));
  for (const def of defs) {
    assert.equal(typeof def.handler, 'function');
    for (const required of def.inputSchema.required) {
      assert.ok(def.inputSchema.properties[required], `${def.name} requires undeclared "${required}"`);
    }
    for (const [prop, schema] of Object.entries(def.inputSchema.properties)) {
      assert.ok(schema.description && schema.description.length >= 10, `${def.name}.${prop} needs a description`);
    }
  }
  // upload_image is useless unless the two aiming modes and their rule are said
  // out loud, and the coordinate gotcha with them.
  const img = defs.find((t) => t.name === 'upload_image');
  assert.match(img.description, /exactly one/);
  assert.match(img.inputSchema.properties.ref.description, /coordinate/);
  assert.match(img.inputSchema.properties.coordinate.description, /\bref\b/);
  assert.match(img.inputSchema.properties.coordinate.description, /newest screenshot/);
  assert.match(img.inputSchema.properties.filename.description, /image\.png/);
});

test('file_upload documents the sandbox it actually enforces', () => {
  const def = tools(ctxFor(new FakeSession())).find((t) => t.name === 'file_upload');

  // Chrome's promise - attachments and folders the user connected - describes a
  // sandbox this server does not have. Claiming it would be worse than useless:
  // the model would trust a rule nothing enforces.
  for (const claim of [/shared with this session/, /folders the user has connected/, /outputs\/uploads/]) {
    assert.ok(!claim.test(def.description), `description still claims ${claim}`);
    assert.ok(!claim.test(def.inputSchema.properties.paths.description), `paths still claims ${claim}`);
  }
  // ... and it names the rule that is enforced, so a rejection is predictable.
  assert.match(def.description, /FIREFOX_USE_UPLOAD_ROOTS/);
  assert.match(def.description, /[Ss]ymlink/);
  assert.match(def.description, /10 MB/);
  assert.match(def.inputSchema.properties.paths.description, /FIREFOX_USE_UPLOAD_ROOTS/);
  assert.match(def.inputSchema.properties.paths.description, /10 MB/);
  // The one thing a model must not do with a file input is click it.
  assert.match(def.description, /read_page or find/);
  assert.match(def.description, /click/);
});

test('building the tools opens no browser, and the handler passes ctx through', async () => {
  let opened = 0;
  const session = new FakeSession();
  const ctx = { session: async () => { opened++; return session; }, config: { downloadDir: TMP } };
  const defs = tools(ctx);
  assert.equal(opened, 0);

  const tool = defs.find((t) => t.name === 'file_upload');
  const out = await tool.handler({ paths: [tmpFile('via-handler.txt', 'x')], ref: 'ref_1', tabId: 1 });
  assert.equal(opened, 1);
  assert.match(out, /Attached 1 file \(1 B\) to ref_1 on tab 1:/);
});
