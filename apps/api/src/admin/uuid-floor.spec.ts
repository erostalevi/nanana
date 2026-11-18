import { v7 as uuidv7 } from 'uuid';
import { uuidV7Floor } from './uuid-floor.js';

describe('uuidV7Floor', () => {
  it('formats the 48-bit timestamp as a version-7 uuid', () => {
    expect(uuidV7Floor(0)).toBe('00000000-0000-7000-8000-000000000000');
    expect(uuidV7Floor(0x0123456789ab)).toBe('01234567-89ab-7000-8000-000000000000');
  });
  it('sorts at or below real uuidv7 ids from the same millisecond and above older ones', () => {
    const t = Date.now();
    const floor = uuidV7Floor(t);
    expect(uuidv7({ msecs: t }) >= floor).toBe(true);
    expect(uuidv7({ msecs: t - 1 }) < floor).toBe(true);
    expect(uuidv7({ msecs: t + 5 }) > floor).toBe(true);
  });
  it('clamps out-of-range input', () => {
    expect(uuidV7Floor(-5)).toBe('00000000-0000-7000-8000-000000000000');
    expect(uuidV7Floor(2 ** 50)).toBe('ffffffff-ffff-7000-8000-000000000000');
  });
});
