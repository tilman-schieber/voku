/**
 * Deciding what a PDF actually gave us, kept apart from the reader itself so it
 * can be tested without a browser.
 *
 * A PDF is one of two things wearing the same file extension: a document with
 * real text in it, which costs nothing to read, and a stack of photographs,
 * which only a vision model can read and which therefore costs money. The
 * teacher should never have to know which they were handed — but they do need
 * to be asked before the paid path runs, so the two cases are told apart here.
 */

/** What the reader found on one page. */
export type PageContent = {
  text: string;
  /** Share of the page, 0–1, covered by its largest image. */
  imageCover: number;
};

/**
 * Below this, a page's text layer is noise — a page number, a scanner's stamp,
 * a stray ligature — and the page is really a photograph.
 */
const REAL_TEXT_CHARS = 25;

/**
 * A page that is mostly one picture is a scan even with a line of text on it.
 * Licensing portals stamp "Lizenziert für …" across every page of a scanned
 * copy master, which is well over 25 characters and would otherwise pass the
 * whole page off as read while dropping everything in the picture.
 */
const PICTURE_COVER = 0.5;
const CAPTION_CHARS = 200;

const chars = (text: string) => text.replace(/\s/g, '').length;

/**
 * Whether the image cover is worth measuring for this text. Measuring means
 * decoding the page's images, so a page that is plainly text or plainly empty
 * skips it — a 19-page word list stays under a second.
 */
export function needsCoverCheck(text: string): boolean {
  const n = chars(text);
  return n >= REAL_TEXT_CHARS && n < CAPTION_CHARS;
}

export function isScanned(page: PageContent): boolean {
  const n = chars(page.text);
  if (n < REAL_TEXT_CHARS) return true;
  return page.imageCover >= PICTURE_COVER && n < CAPTION_CHARS;
}

/** Page numbers (1-based, as the teacher counts them) that need reading by eye. */
export function scannedPages(pages: PageContent[]): number[] {
  return pages.map((page, i) => (isScanned(page) ? i + 1 : 0)).filter((n) => n > 0);
}

/**
 * The document in page order: what the model read where it read something,
 * the text layer everywhere else. A picture page nobody paid for still gives
 * up whatever text it had — a caption is better than nothing.
 */
export function assemble(pages: PageContent[], read: Record<number, string>): string {
  return joinPages(pages.map((page, i) => read[i + 1] ?? page.text));
}

/** One blank line between pages, which is how a paragraph break is written here. */
export function joinPages(pages: string[]): string {
  return pages
    .map((page) => page.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Adds to what is already in the box rather than replacing the teacher's text. */
export function appendText(existing: string, addition: string): string {
  if (!addition.trim()) return existing;
  return existing.trim() ? `${existing.trim()}\n\n${addition.trim()}` : addition.trim();
}

/**
 * Pages are sent to the model in small batches: the request body has a ceiling,
 * and a batch that fails should cost one batch, not the whole book.
 */
export const PAGES_PER_BATCH = 4;

export function batched<T>(items: T[], size = PAGES_PER_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Batches of page numbers that never reach across a text page. The model sends
 * back one text per batch, and it can only go back where its pages were if
 * those pages sat next to each other.
 */
export function pageBatches(pages: number[], size = PAGES_PER_BATCH): number[][] {
  const out: number[][] = [];
  for (const page of pages) {
    const last = out.at(-1);
    if (last && last.length < size && last.at(-1) === page - 1) last.push(page);
    else out.push([page]);
  }
  return out;
}

/** "page 3" or "pages 3–6", for the status line. */
export function pageRange(first: number, last: number): string {
  return first === last ? `page ${first}` : `pages ${first}–${last}`;
}

/** The operator codes {@link largestImageCover} needs, passed in so this file needs no pdf.js. */
export type CoverOps = {
  save: number;
  restore: number;
  transform: number;
  formBegin: number;
  formEnd: number;
  images: number[];
};

/**
 * How much of the page its largest image covers, from the page's drawing
 * operations. Every image is drawn into a unit square under the current
 * transform, so its area is the transform's determinant — which is all that
 * needs tracking through save and restore.
 */
export function largestImageCover(
  fnArray: number[],
  argsArray: unknown[][],
  ops: CoverOps,
  pageArea: number,
): number {
  const det = (m: unknown) => {
    const [a = 0, b = 0, c = 0, d = 0] = m as number[];
    return a * d - b * c;
  };
  const stack: number[] = [];
  let scale = 1;
  let largest = 0;

  fnArray.forEach((fn, i) => {
    const args = argsArray[i] ?? [];
    if (fn === ops.save) stack.push(scale);
    else if (fn === ops.restore || fn === ops.formEnd) scale = stack.pop() ?? 1;
    else if (fn === ops.transform) scale *= det(args);
    else if (fn === ops.formBegin) {
      stack.push(scale);
      if (Array.isArray(args[0])) scale *= det(args[0]);
    } else if (ops.images.includes(fn)) largest = Math.max(largest, Math.abs(scale));
  });

  return pageArea > 0 ? Math.min(1, largest / pageArea) : 0;
}
