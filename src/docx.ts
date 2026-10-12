// Minimal Word (.docx) writer: OOXML parts in a stored zip. No dependencies.
import { zip } from './zip.ts';
import { isStep, type Recording } from './recorder.ts';
import { emphasis, guideMeta, guideTitle, visibleEntries } from './sop.ts';
export { crc32 } from './zip.ts';

export interface DocxImage { bytes: Uint8Array; width: number; height: number }

// XML text: escaped, with characters XML 1.0 forbids removed.
const xml = (value: string) => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
interface RunStyle { bold?: boolean; italic?: boolean; color?: string; size?: number }
function run(text: string, style: RunStyle = {}): string {
  const props = `${style.bold ? '<w:b/>' : ''}${style.italic ? '<w:i/>' : ''}${style.color ? `<w:color w:val="${style.color}"/>` : ''}${style.size ? `<w:sz w:val="${style.size}"/>` : ''}`;
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return text.split('\n').map((line, index) => `<w:r>${rPr}${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('');
}
function paragraph(runs: string, props = ''): string { return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`; }
const style = (name: string) => `<w:pStyle w:val="${name}"/>`;

const emuPerPixel = 9525; // at 96 dpi
const maxWidth = 5943600; // 6.5 in: Letter with 1 in margins
const maxHeight = 6858000; // 7.5 in
function picture(id: number, image: DocxImage, description: string): string {
  let cx = maxWidth; let cy = Math.round(cx * image.height / image.width);
  if (image.width * emuPerPixel < cx) { cx = image.width * emuPerPixel; cy = image.height * emuPerPixel; }
  if (cy > maxHeight) { cx = Math.round(cx * maxHeight / cy); cy = maxHeight; }
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${xml(description)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdImage${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="DDE4E8"/></a:solidFill></a:ln></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// images: screenshots keyed by step id, with the click marker already drawn in.
export function buildDocx(recording: Recording, images: Map<string, DocxImage>): Uint8Array {
  const body: string[] = [];
  const media: { name: string; data: Uint8Array }[] = [];
  const title = guideTitle(recording);
  body.push(paragraph(run(title), style('Title')));
  for (const line of (recording.description ?? '').split('\n').filter(l => l.trim())) body.push(paragraph(run(line, { color: '3D4B55' })));
  body.push(paragraph(run(guideMeta(recording), { color: '5D6B75', size: 18 }), '<w:spacing w:after="360"/>'));
  let number = 0;
  for (const entry of visibleEntries(recording)) {
    if (!isStep(entry)) {
      if (entry.kind === 'header') { body.push(paragraph(run(entry.text.trim()), style('Heading1'))); continue; }
      const fill = entry.kind === 'tip' ? 'E9F3F1' : 'FFF3D6';
      const color = entry.kind === 'tip' ? '174F48' : '5E4413';
      body.push(paragraph(run(entry.kind === 'tip' ? 'Tip  ' : 'Alert  ', { bold: true, color }) + run(entry.text.trim(), { color }),
        `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:spacing w:before="120" w:after="240"/><w:ind w:left="144" w:right="144"/>`));
      continue;
    }
    number++;
    body.push(paragraph(run(`${number}. `, { color: '12675E', bold: true }) + emphasis(entry).map(part => run(part.text, { bold: part.bold })).join(''), style('Heading2')));
    if (entry.note) body.push(paragraph(run(entry.note, { color: '4D5C66' }), '<w:keepNext/>'));
    const image = images.get(entry.id ?? '');
    if (image) {
      const id = media.length + 1;
      media.push({ name: `word/media/image${id}.jpeg`, data: image.bytes });
      body.push(paragraph(picture(id, image, `Screenshot for step ${number}`), '<w:spacing w:before="120" w:after="240"/>'));
    } else body.push(paragraph(run(entry.reason ?? 'No screenshot for this step.', { italic: true, color: '5D6B75' })));
  }
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const heading = (id: string, name: string, size: number, color: string, before: number, level: number, bold = true) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="202B33"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="202B33"/><w:sz w:val="56"/></w:rPr></w:style>` +
    heading('Heading1', 'heading 1', 34, '12675E', 480, 0) + heading('Heading2', 'heading 2', 26, '202B33', 360, 1, false) + `</w:styles>`;
  const imageRels = media.map((_, i) => `<Relationship Id="rIdImage${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.jpeg"/>`).join('');
  const encoder = new TextEncoder();
  const part = (name: string, content: string) => ({ name, data: encoder.encode(content) });
  return zip([
    part('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    part('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    part('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xml(title)}</dc:title><dc:creator>Stepnote</dc:creator></cp:coreProperties>`),
    part('word/document.xml', document),
    part('word/styles.xml', styles),
    part('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imageRels}</Relationships>`),
    ...media,
  ]);
}
