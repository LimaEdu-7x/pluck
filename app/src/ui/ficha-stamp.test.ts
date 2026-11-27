import { describe, it, expect } from 'vitest';
import { formatFichaStamp } from './ui-helpers';

describe('formatFichaStamp', () => {
  it('formata dia, mês em caixa alta, ano e hora com zeros', () => {
    expect(formatFichaStamp(new Date(2026, 10, 27, 9, 5))).toBe('27 NOV 2026 · 09:05');
    expect(formatFichaStamp(new Date(2027, 0, 3, 23, 59))).toBe('03 JAN 2027 · 23:59');
  });
});
