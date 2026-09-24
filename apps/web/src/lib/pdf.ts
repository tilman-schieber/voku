/**
 * Reading a PDF in the browser.
 *
 * The file never leaves the machine: the text layer is pulled out here, and
 * only pages that turn out to be photographs are rendered to images and sent to
 * the model, the same way a photographed page already is. A 19-page word list
 * with real text therefore costs nothing and works with no model configured at
 * all, which is the point — the AI is optional everywhere.
 *
 * pdf.js is most of a megabyte. Import this file only with `import()`, never
 * statically: the admin screens ship in the same bundle as the student app,
 * and a student on a school iPad should not download a PDF reader to answer
 * vocabulary questions.
 */
// The legacy build, not the default one: pdf.js 6 relies on JavaScript that
// only this year's browsers have (Map.getOrInsertComputed), and without the
// polyfills a school iPad a version behind opens the text of a PDF but fails
// on every picture page.
import {
  GlobalWorkerOptions,
  OPS,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {
  largestImageCover,
  needsCoverCheck,
  type CoverOps,
  type PageContent,
} from './pdf-pages.ts';

GlobalWorkerOptions.workerSrc = workerUrl;

export type Pdf = {
  doc: PDFDocumentProxy;
  pageCount: number;
  /** Lets go of the file; pdf.js keeps all of it in its worker until then. */
  close: () => void;
};

const COVER_OPS: CoverOps = {
  save: OPS.save,
  restore: OPS.restore,
  transform: OPS.transform,
  formBegin: OPS.paintFormXObjectBegin,
  formEnd: OPS.paintFormXObjectEnd,
  images: [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject],
};

export async function openPdf(file: File): Promise<Pdf> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data });
  const doc = await task.promise;
  return { doc, pageCount: doc.numPages, close: () => void task.destroy() };
}

/**
 * The text layer of one page, with the line breaks the document itself has,
 * and — only where the text alone cannot settle it — how much of the page is
 * one picture.
 */
export async function readPage(pdf: Pdf, pageNumber: number): Promise<PageContent> {
  const page = await pdf.doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join('');

  let imageCover = 0;
  if (needsCoverCheck(text)) {
    const { fnArray, argsArray } = await page.getOperatorList();
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
    imageCover = largestImageCover(fnArray, argsArray, COVER_OPS, (x1 - x0) * (y1 - y0));
  }

  page.cleanup();
  return { text, imageCover };
}

/**
 * A scanned page as a JPEG data URI, wide enough for the model to read small
 * print but not so wide that a batch of them exceeds the request body limit.
 */
export async function renderPageImage(pdf: Pdf, pageNumber: number, width = 1400): Promise<string> {
  const page = await pdf.doc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / unscaled.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the page');

  // Scans photographed on a phone often have no background of their own.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  page.cleanup();

  return canvas.toDataURL('image/jpeg', 0.8);
}
