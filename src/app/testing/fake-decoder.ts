// Test support: a simulated createImageBitmap that models EXIF orientation and resize options.
// Not imported by app code. No vitest import here so the main-thread project type-checks it unchanged.
export interface FakeImage {
  /** Stored (un-rotated) dimensions. */
  w: number;
  h: number;
  /** EXIF orientation 1..8. */
  orientation: number;
}

export interface FakeConfig {
  /** Throw TypeError when imageOrientation: 'from-image' is passed. */
  throwOnFromImage?: boolean;
  /** Ignore resizeWidth/resizeHeight completely. */
  ignoreResize?: boolean;
  /** Apply resize in stored space (before the orientation swap). */
  resizeInStoredSpace?: boolean;
  /** Default decode (no imageOrientation option) applies EXIF. Default true. */
  defaultHonorsExif?: boolean;
}

export interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  markerTopRight: boolean;
  close(): void;
}

export interface Call {
  opts: ImageBitmapOptions;
  crop?: { sx: number; sy: number; sw: number; sh: number };
}

export class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): unknown {
    return { imageSmoothingEnabled: true, imageSmoothingQuality: 'low', drawImage() {} };
  }
}

export function createFakeDecoder(config: FakeConfig = {}) {
  const images = new WeakMap<object, FakeImage>();
  const calls: Call[] = [];
  const bitmaps: FakeBitmap[] = [];

  const mk = (width: number, height: number, markerTopRight = false): FakeBitmap => {
    const b: FakeBitmap = {
      width,
      height,
      closed: false,
      markerTopRight,
      close() {
        b.closed = true;
      },
    };
    bitmaps.push(b);
    return b;
  };

  const createImageBitmap = async (src: unknown, ...rest: unknown[]): Promise<ImageBitmap> => {
    const last = rest[rest.length - 1];
    const opts = (typeof last === 'object' && last !== null ? last : {}) as ImageBitmapOptions;
    const nums = rest.filter((x): x is number => typeof x === 'number');
    const call: Call = { opts };
    if (nums.length === 4) call.crop = { sx: nums[0]!, sy: nums[1]!, sw: nums[2]!, sh: nums[3]! };
    calls.push(call);
    if (src instanceof FakeOffscreenCanvas) return mk(src.width, src.height) as unknown as ImageBitmap;
    const img = images.get(src as object);
    if (!img) throw new Error('fake decoder: unknown blob');
    if (opts.imageOrientation === 'from-image' && config.throwOnFromImage) throw new TypeError('invalid enum value');
    const honors = opts.imageOrientation === 'from-image' || config.defaultHonorsExif !== false;
    let w = img.w;
    let h = img.h;
    const swap = honors && img.orientation >= 5;
    if (call.crop) {
      return mk(call.crop.sw, call.crop.sh) as unknown as ImageBitmap;
    }
    if (opts.resizeWidth && opts.resizeHeight && !config.ignoreResize) {
      if (config.resizeInStoredSpace) {
        w = opts.resizeWidth;
        h = opts.resizeHeight;
        return mk(swap ? h : w, swap ? w : h, honors && img.orientation === 6) as unknown as ImageBitmap;
      }
      return mk(opts.resizeWidth, opts.resizeHeight, honors && img.orientation === 6) as unknown as ImageBitmap;
    }
    return mk(swap ? h : w, swap ? w : h, honors && img.orientation === 6) as unknown as ImageBitmap;
  };

  return {
    createImageBitmap,
    calls,
    bitmaps,
    /** Creates a Blob the fake can "decode". */
    blob(image: FakeImage): Blob {
      const b = new Blob([`fake-${image.w}x${image.h}-o${image.orientation}`], { type: 'image/jpeg' });
      images.set(b, image);
      return b;
    },
  };
}
