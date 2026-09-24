import { describe, expect, it } from 'vitest';
import {
  appendText,
  assemble,
  batched,
  isScanned,
  joinPages,
  largestImageCover,
  needsCoverCheck,
  pageBatches,
  pageRange,
  scannedPages,
  type CoverOps,
  type PageContent,
} from '../src/lib/pdf-pages.ts';

/**
 * A PDF is either a document or a stack of photographs, and the teacher cannot
 * be expected to know which. Telling them apart is what decides whether the
 * paid path runs at all, so it is stated here as a rule rather than left to the
 * shape of a page.
 */

const WORD_LIST_PAGE = `English German Example
to grind sth out herunterleiern The channel grinds out the same story every week.
lavish üppig a lavish reception at the embassy`;

const STAMP = 'Lizenziert für Schule Muttenz, nur zum Gebrauch im Unterricht';

const text = (t: string): PageContent => ({ text: t, imageCover: 0 });
const picture = (t = ''): PageContent => ({ text: t, imageCover: 0.95 });

describe('telling a document from a scan', () => {
  it('reads a page that has real text', () => {
    expect(isScanned(text(WORD_LIST_PAGE))).toBe(false);
  });

  it('counts a page with nothing on it as a scan', () => {
    expect(isScanned(text(''))).toBe(true);
    expect(isScanned(text('   \n\n  '))).toBe(true);
  });

  // What a scanner leaves behind: a page number, a stamp, one stray ligature.
  it('is not fooled by the litter a scanner leaves in the text layer', () => {
    expect(isScanned(text('12'))).toBe(true);
    expect(isScanned(text('Seite 3 von 19'))).toBe(true);
  });

  // The failure this guards against is silent: "Read all 19 pages", and the
  // page's actual content never reaches the box.
  it('sees through a licence stamp printed across a scanned page', () => {
    expect(isScanned(picture(STAMP))).toBe(true);
  });

  it('still reads a text page that also has a large picture on it', () => {
    expect(isScanned(picture(WORD_LIST_PAGE.repeat(2)))).toBe(false);
  });

  it('only measures pictures when the text alone cannot decide', () => {
    expect(needsCoverCheck('')).toBe(false);
    expect(needsCoverCheck(STAMP)).toBe(true);
    expect(needsCoverCheck(WORD_LIST_PAGE.repeat(2))).toBe(false);
  });

  it('names the scanned pages the way a teacher counts them, from one', () => {
    expect(scannedPages([text(WORD_LIST_PAGE), text(''), text(WORD_LIST_PAGE), text('7')])).toEqual(
      [2, 4],
    );
  });

  it('says nothing needs paying for when every page has text', () => {
    expect(scannedPages([text(WORD_LIST_PAGE), text(WORD_LIST_PAGE)])).toEqual([]);
  });
});

describe('measuring how much of a page is one picture', () => {
  const ops: CoverOps = {
    save: 1,
    restore: 2,
    transform: 3,
    formBegin: 4,
    formEnd: 5,
    images: [9],
  };
  const A4 = 595 * 842;

  it('sees a full-page scan as covering the page', () => {
    const cover = largestImageCover([1, 3, 9, 2], [[], [595, 0, 0, 842, 0, 0], [], []], ops, A4);
    expect(cover).toBeCloseTo(1);
  });

  it('sees a logo in the corner as covering almost nothing', () => {
    const cover = largestImageCover([1, 3, 9, 2], [[], [60, 0, 0, 40, 20, 780], [], []], ops, A4);
    expect(cover).toBeLessThan(0.01);
  });

  it('forgets a transform once it is restored', () => {
    const cover = largestImageCover(
      [1, 3, 2, 3, 9],
      [[], [595, 0, 0, 842, 0, 0], [], [60, 0, 0, 40, 0, 0], []],
      ops,
      A4,
    );
    expect(cover).toBeLessThan(0.01);
  });

  it('follows the scale of a form the image is drawn inside', () => {
    const cover = largestImageCover(
      [4, 3, 9, 5],
      [[[595, 0, 0, 842, 0, 0]], [1, 0, 0, 1, 0, 0], [], []],
      ops,
      A4,
    );
    expect(cover).toBeCloseTo(1);
  });
});

describe('putting the pages together', () => {
  it('separates pages by a blank line, which is what starts a paragraph here', () => {
    expect(joinPages(['One', 'Two'])).toBe('One\n\nTwo');
  });

  it('leaves out the pages that had nothing on them', () => {
    expect(joinPages(['One', '   ', 'Two'])).toBe('One\n\nTwo');
  });

  it('keeps a mixed document in page order, with what the model read in place', () => {
    const pages = [text('Page one text here.'), picture(), picture(), text('Page four text here.')];
    expect(assemble(pages, { 2: 'Read off pages two and three.', 3: '' })).toBe(
      'Page one text here.\n\nRead off pages two and three.\n\nPage four text here.',
    );
  });

  it('keeps what a picture page had when nobody paid to read it', () => {
    expect(assemble([text('Page one.'), picture('A caption')], {})).toBe('Page one.\n\nA caption');
  });

  it('adds to the teacher’s text instead of replacing it', () => {
    expect(appendText('Already here.', 'From the PDF.')).toBe('Already here.\n\nFrom the PDF.');
    expect(appendText('', 'From the PDF.')).toBe('From the PDF.');
  });

  it('does not add a blank line when the PDF gave nothing', () => {
    expect(appendText('Already here.', '  ')).toBe('Already here.');
  });
});

describe('sending pages to the model', () => {
  // The request body has a ceiling, and a batch that fails should cost one
  // batch rather than the whole book.
  it('goes a few pages at a time, however long the document is', () => {
    const pages = Array.from({ length: 19 }, (_, i) => `page ${i + 1}`);
    const batches = batched(pages);

    expect(batches.every((batch) => batch.length <= 4)).toBe(true);
    expect(batches.flat()).toEqual(pages);
  });

  // One text comes back per batch, so a batch must be pages that sit together.
  it('never puts pages either side of a text page in one batch', () => {
    expect(pageBatches([2, 3, 5, 6, 7, 8, 9, 12])).toEqual([[2, 3], [5, 6, 7, 8], [9], [12]]);
  });

  it('says which pages it is on, not which batch', () => {
    expect(pageRange(5, 8)).toBe('pages 5–8');
    expect(pageRange(3, 3)).toBe('page 3');
  });
});
