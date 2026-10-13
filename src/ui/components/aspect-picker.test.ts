import { describe, expect, it } from 'vitest';
import type { AspectEstimate } from '../../cv/aspect.ts';
import type { Quad } from '../../cv/geometry.ts';
import { ASPECT_CHIPS, aspectSuggestions, autoChipLabel, chipLabel } from './aspect-picker.ts';

const est = (over: Partial<AspectEstimate> = {}): AspectEstimate => ({
  ratio: 1 / Math.SQRT2,
  rawRatio: 0.7,
  confidence: 'high',
  snapped: null,
  usedPrior: false,
  ...over,
});

const LANDSCAPE: Quad = [[100, 100], [900, 120], [880, 600], [110, 580]];
const PORTRAIT: Quad = [[300, 100], [700, 110], [690, 900], [310, 880]];

describe('chips', () => {
  it('lists Auto, A portrait, A landscape, 4:3, 16:9 and Free in order', () => {
    expect(ASPECT_CHIPS.map((c) => c.label)).toEqual(['Auto', 'A portrait', 'A landscape', '4:3', '16:9', 'Free']);
    expect(ASPECT_CHIPS.map((c) => c.mode)).toEqual(['auto', 'a-portrait', 'a-landscape', '4:3', '16:9', 'free']);
  });
});

describe('Auto chip text (AC-15, finding 4)', () => {
  it('is always an estimate', () => {
    expect(autoChipLabel(null)).toBe('Auto (est.)');
    expect(autoChipLabel(est())).toBe('Auto (est.)');
  });
  it('names the snapped ratio', () => {
    expect(autoChipLabel(est({ snapped: 'A-series' }))).toBe('Auto (est.) ~A-series');
  });
  it('says so on low confidence, even when snapped', () => {
    expect(autoChipLabel(est({ confidence: 'low' }))).toBe('Auto (est., low confidence)');
    expect(autoChipLabel(est({ confidence: 'low', snapped: '4:3' }))).toBe('Auto (est., low confidence)');
  });
  it('only the Auto chip carries the estimate', () => {
    expect(chipLabel('free', est({ confidence: 'low' }))).toBe('Free');
    expect(chipLabel('auto', est({ confidence: 'low' }))).toBe('Auto (est., low confidence)');
  });
});

describe('one-tap suggestions for a low-confidence estimate', () => {
  const low = est({ confidence: 'low', usedPrior: true });

  it('offers A-series and 4:3 for a landscape quad', () => {
    expect(aspectSuggestions(low, LANDSCAPE, 'auto')).toEqual([
      { label: 'A-series', mode: 'a-landscape' },
      { label: '4:3', mode: '4:3' },
    ]);
  });

  it('offers only A-series (portrait) for a portrait quad, because 4:3 is a landscape ratio', () => {
    expect(aspectSuggestions(low, PORTRAIT, 'auto')).toEqual([{ label: 'A-series', mode: 'a-portrait' }]);
  });

  it('offers nothing for high or medium confidence, a missing estimate, or a non-Auto mode', () => {
    expect(aspectSuggestions(est({ confidence: 'high' }), LANDSCAPE, 'auto')).toEqual([]);
    expect(aspectSuggestions(est({ confidence: 'medium' }), LANDSCAPE, 'auto')).toEqual([]);
    expect(aspectSuggestions(null, LANDSCAPE, 'auto')).toEqual([]);
    expect(aspectSuggestions(low, LANDSCAPE, 'free')).toEqual([]);
  });
});
