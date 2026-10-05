import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx, crc32 } from '../src/docx.ts';
import type { Recording } from '../src/recorder.ts';

// Minimal reader for stored (uncompressed) zip entries, checked against the central directory.
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory entry');
    assert.equal(view.getUint16(at + 10, true), 0, 'stored');
    const crc = view.getUint32(at + 16, true); const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true); const extra = view.getUint16(at + 30, true); const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, 'local header');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files.set(name, data);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
const text = (files: Map<string, Uint8Array>, name: string) => new TextDecoder().decode(files.get(name));

const recording: Recording = {
  tabId: 1, windowId: 1, documentId: 'd', title: 'Captured', url: 'https://example.com/work', status: 'stopped', startedAt: Date.UTC(2026, 9, 2),
  guideTitle: 'Close a <ticket> & "archive"', description: 'For support.\nSecond line.',
  steps: [
    { id: 'h', kind: 'header', text: 'Open the queue', at: 1 },
    { id: 'a', label: 'Click Save', text: 'Choose Save', note: 'Top right.\nThen wait.', title: 'W', url: 'https://example.com/', x: 1, y: 1, width: 10, height: 10, at: 2, screenshot: 'data:image/jpeg;base64,YQ==' },
    { id: 't', kind: 'tip', text: 'Use filters.', at: 3 },
    { id: 'blank', kind: 'alert', text: ' ', at: 4 },
    { id: 'b', label: 'Click Done\u0001', title: 'W', url: 'https://example.com/', x: 1, y: 1, width: 10, height: 10, at: 5, reason: 'Screenshot rate limit.' },
  ],
};
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a .docx package holds the required parts, the guide text and embedded screenshots', () => {
  const files = unzip(buildDocx(recording, new Map([['a', { bytes: jpeg, width: 1600, height: 1200 }]])));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'word/media/image1.jpeg']) assert.ok(files.has(part), part);
  assert.deepEqual([...files.get('word/media/image1.jpeg')!], [...jpeg]);
  const types = text(files, '[Content_Types].xml');
  assert.match(types, /Extension="jpeg" ContentType="image\/jpeg"/);
  assert.match(types, /PartName="\/word\/document.xml"/);
  const rels = text(files, 'word/_rels/document.xml.rels');
  assert.match(rels, /Id="rIdImage1"[^>]*Target="media\/image1.jpeg"/);
  const xml = text(files, 'word/document.xml');
  assert.match(xml, /<w:pStyle w:val="Title"\/>.*Close a &lt;ticket&gt; &amp; &quot;archive&quot;/);
  assert.match(xml, /For support\./); assert.match(xml, /Second line\./);
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>.*Open the queue/);
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>.*1\. .*Choose Save/);
  assert.match(xml, /Top right\.<\/w:t><\/w:r><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:br\/><w:t xml:space="preserve">Then wait\./, 'note line breaks');
  assert.match(xml, /r:embed="rIdImage1"/);
  assert.match(xml, /<wp:extent cx="5943600" cy="4457700"\/>/, '6.5 inch wide, aspect kept');
  assert.match(xml, /Tip.*Use filters\./);
  assert.doesNotMatch(xml, /Alert/, 'blank blocks are skipped');
  assert.match(xml, /2\. .*Click .*<w:b\/>.*Done/);
  assert.doesNotMatch(xml, /\u0001/, 'invalid XML characters are removed');
  assert.match(xml, /Screenshot rate limit\./);
  assert.match(text(files, 'docProps/core.xml'), /<dc:title>Close a &lt;ticket&gt;/);
});

test('tall screenshots are scaled down to fit the page height', () => {
  const xml = text(unzip(buildDocx(recording, new Map([['a', { bytes: jpeg, width: 800, height: 3000 }]]))), 'word/document.xml');
  const [, cx, cy] = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)!.map(Number);
  assert.ok(cy <= 6858000, 'at most 7.5 inches tall');
  assert.ok(Math.abs(cx / cy - 800 / 3000) < 0.001);
});
