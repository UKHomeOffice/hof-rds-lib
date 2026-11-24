import { expect } from '@jest/globals';
import {
  DEFAULT_SELECTABLE_PROPS,
  defineSelectableProps,
  validateColumnValues
} from '../../../lib/model-helpers.js';

describe('validateColumnValues', () => {
  it('returns a copy of a valid where object', () => {
    const date = new Date();
    const where = { email: 'test@example.com', id: 1, active: true, deleted_at: null, created_at: date };
    const result = validateColumnValues(where);

    expect(result).toEqual(where);
    expect(result).not.toBe(where);
  });

  it('accepts objects parsed from JSON and with a null prototype', () => {
    expect(validateColumnValues(JSON.parse('{"id":1}'))).toEqual({ id: 1 });
    expect(validateColumnValues(Object.assign(Object.create(null), { id: 1 }))).toEqual({ id: 1 });
  });

  it('rejects non plain objects', () => {
    for (const where of [undefined, null, 'id', 1, [], new Date(), new Map()]) {
      expect(() => validateColumnValues(where)).toThrow(TypeError);
      expect(() => validateColumnValues(where)).toThrow('input must be a plain object');
    }
  });

  it('rejects invalid column names', () => {
    for (const column of ['', '1id', 'id;', 'id = 1', 'a.b', '"id"', 'id--']) {
      expect(() => validateColumnValues({ [column]: 1 })).toThrow(TypeError);
      expect(() => validateColumnValues({ [column]: 1 })).toThrow('Invalid column name');
    }
  });

  it('rejects unsupported values', () => {
    for (const value of [undefined, {}, [1], () => { }, NaN, Infinity, new Date('x'), Symbol('s'), 1n]) {
      expect(() => validateColumnValues({ id: value })).toThrow(TypeError);
      expect(() => validateColumnValues({ id: value })).toThrow('Invalid value for column "id"');
    }
  });

  it('rejects empty objects when requireNonEmpty is true', () => {
    expect(() => validateColumnValues({}, true)).toThrow(TypeError);
    expect(() => validateColumnValues({}, true)).toThrow('input must contain at least one column');
  });
});


describe('defineSelectableProps', () => {
  it('appends props to the defaults without duplicates', () => {
    expect(defineSelectableProps(['email'])).toEqual([...DEFAULT_SELECTABLE_PROPS, 'email']);
    expect(defineSelectableProps(['id', 'email'])).toEqual([...DEFAULT_SELECTABLE_PROPS, 'email']);
  });

  it('returns the defaults when no props are given', () => {
    expect(defineSelectableProps()).toEqual(DEFAULT_SELECTABLE_PROPS);
    expect(defineSelectableProps([])).toEqual(DEFAULT_SELECTABLE_PROPS);
  });

  it('returns * on its own', () => {
    expect(defineSelectableProps(['*'])).toEqual(['*']);
  });

  it('does not mutate the defaults', () => {
    defineSelectableProps().push('email');
    expect(DEFAULT_SELECTABLE_PROPS).toEqual(['id', 'created_at', 'updated_at']);
  });
});
