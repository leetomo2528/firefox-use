'use strict';
// file_upload / upload_image: getting bytes into a page.
//
// A file input can only be filled through BiDi input.setFiles - clicking one
// opens a native picker no tool can see. upload_image adds the session's
// screenshot store as a source, plus a synthesized drag & drop for editors
// that take a dropped file but expose no <input type="file">.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { NO_REF } = require('./session');

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMAGE_NAME = 'image.png';
const UPLOAD_ROOTS_ENV = 'FIREFOX_USE_UPLOAD_ROOTS';

// Reads back what the input actually holds, so the report is not a guess.
const FILES_FN = `(function (ref) {
  var store = window.__ffuse && window.__ffuse.refs;
  var el = store && store.get(ref);
  if (!el || !el.isConnected) return JSON.stringify({ found: false });
  var names = [];
  if (el.files) for (var i = 0; i < el.files.length; i++) names.push(el.files[i].name);
  return JSON.stringify({
    found: true,
    tag: el.localName,
    fileInput: el.localName === 'input' && String(el.type).toLowerCase() === 'file',
    multiple: !!el.multiple,
    count: el.files ? el.files.length : null,
    names: names
  });
})`;

// base64 -> File -> DataTransfer -> dragenter/dragover/drop on the element at
// (x, y), with a paste fallback for editors that only listen for pasted files.
const DROP_FN = `(function (b64, mimeType, name, x, y) {
  var target = document.elementFromPoint(x, y);
  if (!target) return JSON.stringify({ ok: false, error: 'no element at (' + x + ', ' + y + ')' });
  var file, dt;
  try {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    file = new File([new Blob([bytes], { type: mimeType })], name, { type: mimeType });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'could not build the file: ' + (e && e.message) });
  }
  try {
    dt = new DataTransfer();
    dt.items.add(file);
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'DataTransfer is unavailable: ' + (e && e.message) });
  }
  var dispatched = [];
  var dropHandled = false; // the drop event itself was canceled
  var accepted = false;    // dragenter/dragover canceled: the target takes drags
  var types = ['dragenter', 'dragover', 'drop'];
  try {
    for (var j = 0; j < types.length; j++) {
      var ev = new DragEvent(types[j], {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, dataTransfer: dt
      });
      target.dispatchEvent(ev);
      dispatched.push(types[j]);
      if (!ev.defaultPrevented) continue;
      if (types[j] === 'drop') dropHandled = true; else accepted = true;
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'could not dispatch the drag sequence: ' + (e && e.message) });
  }
  // Only try the clipboard route when nothing about the drag was taken up: a
  // target that accepted the drag may already hold the file, and pasting a
  // second copy into it would duplicate the image.
  var pasteHandled = false;
  if (!dropHandled && !accepted) {
    try {
      var focused = document.activeElement;
      var pasteTarget = focused && focused !== document.body ? focused : target;
      var pe = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      pasteTarget.dispatchEvent(pe);
      dispatched.push('paste');
      pasteHandled = pe.defaultPrevented;
    } catch (e) { /* no constructable ClipboardEvent here */ }
  }
  return JSON.stringify({
    ok: true,
    target: target.localName + (target.id ? '#' + target.id : ''),
    dispatched: dispatched,
    dropHandled: dropHandled,
    accepted: accepted,
    pasteHandled: pasteHandled
  });
})`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The upload sandbox. The tool description promises that only files inside a
// small set of folders can be handed to a page; this is that rule. Without it a
// page saying "attach ~/.ssh/id_rsa" would be obeyed.
//
// Roots: the folder this server writes downloads to, anything the operator
// listed in FIREFOX_USE_UPLOAD_ROOTS, and the directory the server was started
// in (nothing here ever chdir()s, so process.cwd() is still that directory).
function scratchDir(ctx) {
  // Also root #1, so the scratch copy upload_image writes can never be refused
  // by the gate that guards it.
  return (ctx && ctx.config && ctx.config.downloadDir) || os.tmpdir();
}

function uploadRoots(ctx) {
  const roots = [];
  const add = (raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const given = path.resolve(expandHome(raw.trim()));
    let real;
    // A root that does not exist yet is still worth naming in the error; it
    // simply matches nothing until it is created.
    try { real = fs.realpathSync(given); } catch { real = given; }
    if (!roots.some((r) => r.given === given && r.real === real)) roots.push({ given, real });
  };
  add(scratchDir(ctx));
  // path.delimiter is ':' where we run, and ';' on Windows - the one separator
  // that cannot be confused with a drive letter.
  for (const entry of String(process.env[UPLOAD_ROOTS_ENV] || '').split(path.delimiter)) add(entry);
  add(process.cwd());
  return roots;
}

function under(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function insideRoots(target, roots) {
  return roots.some((r) => under(target, r.given) || under(target, r.real));
}

function outsideRoots(what, roots) {
  return new Error(
    `${what} is outside the folders this server may upload from. `
    + `Allowed roots: ${roots.map((r) => r.given).join(', ')}. `
    + `To add one, start the server with ${UPLOAD_ROOTS_ENV}=/absolute/path `
    + '(colon-separated for more than one).'
  );
}

// Every path has to sit inside an allowed root - after symlinks are resolved -
// and be a readable regular file, and the batch has to fit the documented 10 MB
// budget, before the page is touched at all.
function resolvePaths(paths, ctx) {
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error('paths must be a non-empty array of absolute file paths.');
  }
  const roots = uploadRoots(ctx);
  const files = [];
  let total = 0;
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('Every entry in paths must be a non-empty string.');
    }
    const abs = path.resolve(expandHome(raw.trim()));
    let real = null;
    let unreadable = null;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      unreadable = err; // reported below, but only once the path is allowed
    }
    // The realpath decides, never the given path. Both directions matter: a
    // symlink planted inside a root and pointing out of it is the escape this
    // gate exists to stop, and a root reached through a symlinked ancestor
    // (/tmp -> /private/tmp, and process.cwd() is always the resolved form) is
    // still that root, so naming it the other way must not be refused.
    // A path that cannot be resolved at all is judged on its literal form, so
    // an outside path is refused with the same message either way and cannot
    // double as an existence oracle for the model or the page.
    if (!insideRoots(real === null ? abs : real, roots)) {
      throw real !== null && real !== abs
        ? outsideRoots(`${abs} resolves to ${real}, which`, roots)
        : outsideRoots(abs, roots);
    }
    if (real === null) {
      if (unreadable.code === 'ENOENT') throw new Error(`File not found: ${abs}`);
      throw new Error(`Cannot read ${abs}: ${unreadable.message}`);
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      throw new Error(`Cannot read ${abs}: ${err.message}`);
    }
    if (stat.isDirectory()) throw new Error(`${abs} is a directory. file_upload takes files, not folders.`);
    if (!stat.isFile()) throw new Error(`${abs} is not a regular file.`);
    total += stat.size;
    // The resolved path is the one that was checked, so it is the one the
    // browser is handed.
    files.push({ path: real, size: stat.size });
  }
  if (total >= MAX_TOTAL_BYTES) {
    const much = files.length === 1
      ? `${files[0].path} is ${formatBytes(total)}`
      : `These ${plural(files.length, 'file')} add up to ${formatBytes(total)}`;
    throw new Error(
      `${much}. One call may carry less than 10 MB across every path it names.`
    );
  }
  return { files, total };
}

function targetTab(session, tabId) {
  if (tabId === undefined || tabId === null || tabId === '') return session.defaultTabId();
  const n = Number(tabId);
  // Number('x') is NaN; passing the original through keeps NO_TAB readable.
  return Promise.resolve(Number.isFinite(n) ? n : tabId);
}

// The one way to fill a file input: hand BiDi the element and the paths.
async function attachFiles(session, tabId, ref, files) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error('ref is required: locate the file input with read_page or find, then pass the ref it printed.');
  }
  const context = session.requireContext(tabId);
  await session.ensureRefStore(tabId);
  const node = await session.refNode(tabId, ref);
  if (!node || !node.sharedId) throw new Error(NO_REF(ref));
  const element = { sharedId: node.sharedId };
  if (node.handle) element.handle = node.handle;
  try {
    await session.send('input.setFiles', { context, element, files });
  } catch (err) {
    const failed = new Error(
      `Could not attach files to ${ref}: ${err.message}. The element must be an <input type="file">.`
    );
    failed.setFilesFailed = true;
    throw failed;
  }
  try {
    return await session.callJson(tabId, FILES_FN, [String(ref)]);
  } catch {
    return null; // reading the input back is a courtesy, not the operation
  }
}

function describeInput(info, expected) {
  if (!info || info.found !== true) return 'The input could not be read back to confirm the attachment.';
  if (info.count === null || info.count === undefined) {
    return `<${info.tag}> exposes no files list, so the attachment could not be confirmed.`;
  }
  const names = (info.names || []).join(', ');
  if (info.count !== expected) {
    const why = expected > 1 && info.multiple === false
      ? ' The input has no multiple attribute, so it holds one file at a time.'
      : '';
    return `Warning: the input reports ${plural(info.count, 'file')}${names ? ` (${names})` : ''}, not ${expected}.${why}`;
  }
  return `The input now reports ${plural(info.count, 'file')}${names ? `: ${names}` : ''}.`;
}

async function fileUpload(session, { paths, ref, tabId } = {}, ctx = {}) {
  const { files, total } = resolvePaths(paths, ctx);
  const tid = await targetTab(session, tabId);
  const info = await attachFiles(session, tid, ref, files.map((f) => f.path));
  const lines = [`Attached ${plural(files.length, 'file')} (${formatBytes(total)}) to ${ref} on tab ${tid}:`];
  for (const f of files) lines.push(`  ${f.path} (${formatBytes(f.size)})`);
  lines.push(describeInput(info, files.length));
  return lines.join('\n');
}

function requireImage(session, imageId) {
  if (typeof imageId !== 'string' || !imageId.trim()) {
    throw new Error('imageId is required: capture one with the computer tool\'s screenshot action first.');
  }
  const image = session.images && session.images.get(imageId);
  if (image) return image;
  const known = session.images && session.images.images ? [...session.images.images.keys()] : [];
  throw new Error(
    `Unknown imageId "${imageId}". ` +
    (known.length
      ? `Available image ids: ${known.join(', ')}.`
      : 'No images have been captured in this session yet; use the computer tool\'s screenshot action first.')
  );
}

function imageName(filename, mimeType) {
  // basename() only strips the platform's separator, so drop the other one too:
  // the result is joined onto downloadDir and must not be able to climb out.
  const raw = typeof filename === 'string' ? path.basename(filename.trim()) : '';
  const base = raw.replace(/[\\/]+/g, '_').replace(/^\.+$/, '');
  if (!base || base === '.' || base === '..') return DEFAULT_IMAGE_NAME;
  if (/\.[a-z0-9]{1,5}$/i.test(base)) return base;
  return `${base}${String(mimeType).includes('jpeg') ? '.jpg' : '.png'}`;
}

function requirePoint(coordinate) {
  const bad = new Error('coordinate must be [x, y] viewport coordinates.');
  if (!Array.isArray(coordinate) || coordinate.length !== 2) throw bad;
  const x = Number(coordinate[0]);
  const y = Number(coordinate[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw bad;
  return { x: Math.round(x), y: Math.round(y) };
}

// The scratch copy upload_image hands to input.setFiles passes the same gate as
// a caller-supplied path: it is written at its resolved location inside the
// download folder, and nowhere else.
function writeImageFile(image, name, ctx) {
  const dir = scratchDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  const file = path.join(realDir, name);
  if (path.dirname(file) !== realDir || !insideRoots(file, uploadRoots(ctx))) {
    throw new Error(`Refusing to write ${file}: images written for an upload stay in ${realDir}.`);
  }
  const bytes = Buffer.from(image.data, 'base64');
  fs.writeFileSync(file, bytes);
  return { path: file, size: bytes.length };
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* nothing to clean up */ }
}

async function refBox(session, tabId, ref) {
  try {
    return await session.resolveRef(tabId, ref, { scroll: true });
  } catch {
    return null; // a stale ref is reported by the caller's own error
  }
}

// One synthesized drag & drop, shared by the coordinate path and by the ref
// path when the referenced element turns out not to be a file input.
async function dropImage(session, tabId, image, name, imageId, x, y) {
  const res = await session.callJson(tabId, DROP_FN, [image.data, image.mimeType || 'image/png', name, x, y]);
  if (!res || res.ok !== true) {
    const why = (res && res.error) || 'the page returned no result';
    throw new Error(`Drag & drop of ${imageId} at (${x}, ${y}) failed: ${why}.`);
  }
  const outcome = res.dropHandled
    ? 'the page handled the drop'
    : res.pasteHandled
      ? 'the drop was ignored, but the paste fallback was handled'
      : res.accepted
        ? 'the target accepted the drag but never canceled the drop, so it may not have kept the file'
        : 'neither the drop nor the paste fallback was handled - the target may not accept files';
  return [
    `Dropped ${imageId} as ${name} onto <${res.target}> at (${x}, ${y}) on tab ${tabId}.`,
    `Dispatched ${(res.dispatched || []).join(', ')}; ${outcome}.`,
  ];
}

async function uploadImage(session, { imageId, ref, coordinate, tabId, filename } = {}, ctx = {}) {
  const hasRef = typeof ref === 'string' && ref.trim() !== '';
  const hasPoint = coordinate !== undefined && coordinate !== null;
  if (hasRef && hasPoint) throw new Error('ref and coordinate are alternatives: pass exactly one of them.');
  if (!hasRef && !hasPoint) {
    throw new Error('Aim the image with one of ref (a file input or drop target) or coordinate ([x, y] over a visible drop target).');
  }
  const image = requireImage(session, imageId);
  const name = imageName(filename, image.mimeType);
  const tid = await targetTab(session, tabId);

  if (hasRef) {
    const file = writeImageFile(image, name, ctx);
    let info = null;
    let refused = null;
    try {
      info = await attachFiles(session, tid, ref, [file.path]);
    } catch (err) {
      if (!err.setFilesFailed) { removeQuietly(file.path); throw err; }
      refused = err; // not a file input - the ref may still be a drop target
    }
    if (refused) {
      const box = await refBox(session, tid, ref);
      removeQuietly(file.path);
      if (!box || !box.visible) throw refused;
      let lines;
      try {
        lines = await dropImage(session, tid, image, name, imageId, box.x, box.y);
      } catch (err) {
        throw new Error(`${refused.message} Dropping onto ${ref} did not work either: ${err.message}`);
      }
      return [`${ref} is not a file input, so ${imageId} was dropped onto it instead.`, ...lines].join('\n');
    }
    return [
      `Uploaded ${imageId} to ${ref} on tab ${tid} as ${name} (${formatBytes(file.size)}) through the file input.`,
      `Wrote ${file.path}`,
      describeInput(info, 1),
    ].join('\n');
  }

  const { x, y } = requirePoint(coordinate);
  return (await dropImage(session, tid, image, name, imageId, x, y)).join('\n');
}

function tools(ctx) {
  return [
    {
      name: 'file_upload',
      description: 'Puts one or more files from this machine into an <input type="file"> on the page. '
        + 'Never try to click the input or the button that fronts it: Firefox answers a click with the operating '
        + "system's own picker window, which sits outside the page where nothing here can reach it. Locate the input "
        + 'with read_page or find instead, then call this tool with the ref it was listed under. All three arguments - '
        + 'paths, ref and tabId - are required. Reading a file is gated: a path is accepted only when it resolves '
        + "inside an upload root, meaning this session's download folder, the directory the server process was started "
        + 'in, or an absolute path named in the FIREFOX_USE_UPLOAD_ROOTS environment variable (separate several with '
        + 'the platform path separator). Symlinks are followed before that check, so a link parked in a root but '
        + 'aimed outside one is turned down as well, and the refusal lists the roots that would have worked. Chrome '
        + 'instead scopes uploads to whatever the user shared with the conversation; this server has no such notion. '
        + 'One call may carry less than 10 MB in total across every file named. Afterwards the input is read back and '
        + 'the result states how many files it now holds, which is how you catch an input with no multiple attribute '
        + 'keeping just one of several.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'One absolute path per file, with a leading ~ expanded for you. Folders are turned down; '
              + 'name the files themselves. Each entry has to sit, after symlinks are resolved, in an upload root - '
              + "this session's download folder, the directory the server was launched from, or an entry of "
              + 'FIREFOX_USE_UPLOAD_ROOTS. Sizes are added up and a total of 10 MB or more fails the call before the '
              + 'page is touched at all.',
          },
          ref: {
            type: 'string',
            description: 'The id read_page or find printed beside the file input, in the form ref_12. A ref belongs '
              + 'to the snapshot it came from, so read the page again after a navigation or a re-render rather than '
              + 'reusing an older one.',
          },
          tabId: {
            type: 'number',
            description: 'The tab holding that input. Run tabs_context_mcp when you do not already have a live id. '
              + 'There is no per-site approval step as in Chrome - the file lands in the page straight away, in the '
              + 'dedicated Firefox profile this server drives.',
          },
        },
        required: ['paths', 'ref', 'tabId'],
      },
      handler: async (args) => fileUpload(await ctx.session(), args, ctx),
    },
    {
      name: 'upload_image',
      description: 'Feeds a picture the session is already holding - a screenshot or zoom taken with the computer '
        + 'tool, which prints an imageId such as img_3 - into a page, so no file has to travel through you. There '
        + 'are two ways to aim it and you must pick exactly one: ref, an element from read_page or find, which is '
        + 'how you reach a file input the page keeps hidden behind styling; or coordinate, an [x, y] point in the '
        + 'viewport, for editors that take a dropped file and expose no input at all. Giving both is an error and so '
        + 'is giving neither; imageId and tabId are always needed. Down the ref path the image is written to a '
        + "scratch file in this session's download folder and handed to the input, and should that element turn out "
        + 'not to be a file input, the tool scrolls to it and drops the image on it instead. Down the coordinate '
        + 'path whatever sits under the point gets a synthesized dragenter, dragover and drop, plus a paste event as '
        + 'a fallback when none of the three was taken up. Read the result line: it names which of drop, paste or '
        + 'nothing the page actually handled, so a target that quietly ignored the image cannot pass for success.',
      inputSchema: {
        type: 'object',
        properties: {
          imageId: {
            type: 'string',
            description: 'The id reported when the picture was captured by the computer tool (its screenshot or zoom '
              + 'action), for instance img_3; an image the user supplied carries one too. Only the 20 most recent '
              + 'survive in the session, so an id from much earlier may already be gone.',
          },
          ref: {
            type: 'string',
            description: 'An element id from read_page or find, in the form ref_9. Reach for it whenever the target '
              + 'can be named - above all a file input the page hides - rather than aiming at pixels. Cannot be '
              + 'combined with coordinate, and goes stale as soon as the page navigates or re-renders.',
          },
          coordinate: {
            type: 'array',
            items: { type: 'number' },
            description: 'A point [x, y] in viewport pixels, for a visible region that accepts dropped files without '
              + 'exposing an input. Take the numbers off the newest screenshot; a scroll or a layout shift since '
              + 'then has moved the target out from under them. Cannot be combined with ref.',
          },
          tabId: {
            type: 'number',
            description: 'The tab that is to receive the image; always required. tabs_context_mcp lists the ids of '
              + "this session's tabs if you do not have one.",
          },
          filename: {
            type: 'string',
            description: 'The name the page should see, image.png when you leave it out. A directory part is '
              + 'stripped off, and a bare name with no suffix gains .png, or .jpg when the capture is a JPEG.',
          },
        },
        required: ['imageId', 'tabId'],
      },
      handler: async (args) => uploadImage(await ctx.session(), args, ctx),
    },
  ];
}

module.exports = {
  fileUpload, uploadImage, tools,
  resolvePaths, attachFiles, requireImage, imageName, requirePoint, formatBytes,
  uploadRoots, writeImageFile,
  FILES_FN, DROP_FN, MAX_TOTAL_BYTES, UPLOAD_ROOTS_ENV,
};
