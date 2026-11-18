import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export type VideoRotationDegrees = 0 | 90 | 180 | 270;

export interface Mp4VideoOrientationMetadata {
  rotation: VideoRotationDegrees;
  mirrored: boolean;
  codedWidth: number;
  codedHeight: number;
  trackWidth: number;
  trackHeight: number;
}

export interface VideoOrientationCorrection {
  rotation: VideoRotationDegrees;
  mirrored: boolean;
  needsSwap: boolean;
}

const orientationCache = new Map<string, Mp4VideoOrientationMetadata | null>();

function readUint32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readInt32BE(view: DataView, offset: number): number {
  return view.getInt32(offset, false);
}

function readUint16BE(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

interface Mp4Box {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
  size: number;
}

function iterMp4Boxes(bytes: Uint8Array, view: DataView, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let pos = start;

  while (pos + 8 <= end && pos + 8 <= bytes.length) {
    const size32 = readUint32BE(view, pos);
    const type = readAscii(bytes, pos + 4, 4);
    let headerSize = 8;
    let boxSize = size32;

    if (size32 === 1) {
      if (pos + 16 > end || pos + 16 > bytes.length) break;
      const hi = readUint32BE(view, pos + 8);
      const lo = readUint32BE(view, pos + 12);
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - pos;
    }

    if (boxSize < headerSize || !Number.isFinite(boxSize)) {
      break;
    }

    const boxEnd = pos + boxSize;
    boxes.push({
      type,
      start: pos,
      bodyStart: pos + headerSize,
      end: Math.min(boxEnd, end),
      size: boxSize,
    });

    if (boxEnd <= pos) break;
    pos = boxEnd;
  }

  return boxes;
}

/**
 * Normalizes a 3x3 MP4/MOV tkhd display matrix [a, b, u, c, d, v, tx, ty, w]
 * into clockwise CSS rotation degrees (0 | 90 | 180 | 270) and mirror flag.
 *
 * ISO 14496-12 row-vector convention:
 *   x' = a*x + c*y + tx
 *   y' = b*x + d*y + ty
 * CSS clockwise rotation by θ has (a = cos θ, b = sin θ, c = -sin θ, d = cos θ),
 * so CSS clockwise rotation angle equals atan2(b, a).
 */
export function extractRotationFromTkhdMatrix(
  aFixed: number,
  bFixed: number,
  cFixed: number,
  dFixed: number,
): { rotation: VideoRotationDegrees; mirrored: boolean } {
  const a = aFixed / 65536;
  const b = bFixed / 65536;
  const c = cFixed / 65536;
  const d = dFixed / 65536;

  if (Math.abs(a) < 1e-4 && Math.abs(b) < 1e-4 && Math.abs(c) < 1e-4 && Math.abs(d) < 1e-4) {
    return { rotation: 0, mirrored: false };
  }

  const det = a * d - b * c;
  const mirrored = det < -0.5;
  const rawDeg = (Math.atan2(b, a) * 180) / Math.PI;
  const snapped = (((Math.round(rawDeg / 90) * 90) % 360) + 360) % 360;

  if (snapped === 90 || snapped === 180 || snapped === 270) {
    return { rotation: snapped, mirrored };
  }
  return { rotation: 0, mirrored };
}

function parseMoovBox(
  bytes: Uint8Array,
  view: DataView,
  moovStart: number,
  moovEnd: number,
): Mp4VideoOrientationMetadata | null {
  const children = iterMp4Boxes(bytes, view, moovStart, moovEnd);

  for (const trak of children) {
    if (trak.type !== "trak") continue;

    const trakBoxes = iterMp4Boxes(bytes, view, trak.bodyStart, trak.end);
    let rotation: VideoRotationDegrees = 0;
    let mirrored = false;
    let trackWidth = 0;
    let trackHeight = 0;
    let hasTkhd = false;
    let handlerType = "";
    let codedWidth = 0;
    let codedHeight = 0;

    for (const box of trakBoxes) {
      if (box.type === "tkhd") {
        if (box.bodyStart + 4 > box.end) continue;
        const version = bytes[box.bodyStart] ?? 0;
        const matrixOffset = box.bodyStart + 4 + (version === 1 ? 48 : 36);
        if (matrixOffset + 44 <= box.end) {
          const a = readInt32BE(view, matrixOffset);
          const b = readInt32BE(view, matrixOffset + 4);
          const c = readInt32BE(view, matrixOffset + 12);
          const d = readInt32BE(view, matrixOffset + 16);
          const parsed = extractRotationFromTkhdMatrix(a, b, c, d);
          rotation = parsed.rotation;
          mirrored = parsed.mirrored;
          trackWidth = Math.round(readUint32BE(view, matrixOffset + 36) / 65536);
          trackHeight = Math.round(readUint32BE(view, matrixOffset + 40) / 65536);
          hasTkhd = true;
        }
      } else if (box.type === "mdia") {
        const mdiaBoxes = iterMp4Boxes(bytes, view, box.bodyStart, box.end);
        for (const mBox of mdiaBoxes) {
          if (mBox.type === "hdlr") {
            if (mBox.bodyStart + 12 <= mBox.end) {
              handlerType = readAscii(bytes, mBox.bodyStart + 8, 4);
            }
          } else if (mBox.type === "minf") {
            const minfBoxes = iterMp4Boxes(bytes, view, mBox.bodyStart, mBox.end);
            for (const minfBox of minfBoxes) {
              if (minfBox.type === "stbl") {
                const stblBoxes = iterMp4Boxes(bytes, view, minfBox.bodyStart, minfBox.end);
                for (const stblBox of stblBoxes) {
                  if (stblBox.type === "stsd" && stblBox.bodyStart + 8 <= stblBox.end) {
                    const sampleEntries = iterMp4Boxes(
                      bytes,
                      view,
                      stblBox.bodyStart + 8,
                      stblBox.end,
                    );
                    const firstEntry = sampleEntries[0];
                    if (firstEntry && firstEntry.bodyStart + 28 <= firstEntry.end) {
                      codedWidth = readUint16BE(view, firstEntry.bodyStart + 24);
                      codedHeight = readUint16BE(view, firstEntry.bodyStart + 26);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    if (handlerType === "vide" && hasTkhd) {
      return {
        rotation,
        mirrored,
        codedWidth: codedWidth > 0 ? codedWidth : trackWidth,
        codedHeight: codedHeight > 0 ? codedHeight : trackHeight,
        trackWidth,
        trackHeight,
      };
    }
  }

  return null;
}

/**
 * Parses MP4/MOV/M4V orientation metadata from a buffer containing top-level boxes
 * (including a complete `moov` box, or a standalone `moov` box buffer).
 */
export function parseMp4VideoOrientation(
  input: ArrayBuffer | Uint8Array,
): Mp4VideoOrientationMetadata | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 16) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const topBoxes = iterMp4Boxes(bytes, view, 0, bytes.byteLength);

  for (const box of topBoxes) {
    if (
      box.type === "moov" &&
      box.end <= bytes.byteLength &&
      box.size <= bytes.byteLength - box.start
    ) {
      return parseMoovBox(bytes, view, box.bodyStart, box.end);
    }
  }

  return null;
}

function isIsoBmffBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const topBoxes = iterMp4Boxes(bytes, view, 0, bytes.byteLength);
  const first = topBoxes[0];
  if (!first) return false;
  return ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"].includes(first.type);
}

/**
 * Reads MP4/MOV/M4V orientation metadata directly from a local File or Blob
 * using minimal slice reads (supports `moov` at either the beginning or end of the file).
 */
export async function readVideoOrientationFromBlob(
  blob: Blob,
): Promise<Mp4VideoOrientationMetadata | null> {
  try {
    if (blob.size < 16) return null;

    const headSize = Math.min(blob.size, 65536);
    const headBytes = new Uint8Array(await blob.slice(0, headSize).arrayBuffer());
    if (!isIsoBmffBuffer(headBytes)) {
      return null;
    }

    const parsedHead = parseMp4VideoOrientation(headBytes);
    if (parsedHead) return parsedHead;

    // Walk top-level box headers across the Blob to locate `moov` cleanly without reading `mdat`
    let offset = 0;
    const MAX_MOOV_BYTES = 8 * 1024 * 1024;
    let steps = 0;
    while (offset + 8 <= blob.size && steps < 64) {
      steps++;
      const hdrBuf = new Uint8Array(
        await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer(),
      );
      if (hdrBuf.byteLength < 8) break;
      const view = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, hdrBuf.byteLength);
      const size32 = readUint32BE(view, 0);
      const type = readAscii(hdrBuf, 4, 4);
      let boxSize = size32;
      let hdrLen = 8;

      if (size32 === 1) {
        if (hdrBuf.byteLength < 16) break;
        boxSize = readUint32BE(view, 8) * 4294967296 + readUint32BE(view, 12);
        hdrLen = 16;
      } else if (size32 === 0) {
        boxSize = blob.size - offset;
      }

      if (boxSize < hdrLen || offset + boxSize > blob.size) break;

      if (type === "moov") {
        if (boxSize > MAX_MOOV_BYTES) return null;
        const moovBuf = await blob.slice(offset, offset + boxSize).arrayBuffer();
        return parseMp4VideoOrientation(moovBuf);
      }

      offset += boxSize;
    }

    return null;
  } catch {
    return null;
  }
}

function parseTotalSizeFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!match || !match[1]) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function fetchByteRange(
  url: string,
  start: number,
  endInclusive: number,
): Promise<{ bytes: Uint8Array; totalSize: number | null; isFullFile: boolean } | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${endInclusive}` },
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    const totalSize = parseTotalSizeFromContentRange(res.headers.get("Content-Range"));
    return {
      bytes: new Uint8Array(buf),
      totalSize,
      isFullFile: res.status === 200,
    };
  } catch {
    return null;
  }
}

function findBoxStartingWithMoovInTail(bytes: Uint8Array): Mp4VideoOrientationMetadata | null {
  // Scan for 4-byte 'moov' marker aligned with a valid size header inside tail buffer
  for (let i = 4; i + 16 <= bytes.byteLength; i++) {
    if (
      bytes[i] === 0x6d &&
      bytes[i + 1] === 0x6f &&
      bytes[i + 2] === 0x6f &&
      bytes[i + 3] === 0x76
    ) {
      const boxStart = i - 4;
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + boxStart,
        bytes.byteLength - boxStart,
      );
      const size32 = readUint32BE(view, 0);
      if (size32 >= 16 && boxStart + size32 <= bytes.byteLength) {
        const parsed = parseMp4VideoOrientation(bytes.subarray(boxStart, boxStart + size32));
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

/**
 * Fetches minimal byte ranges of a remote or blob video URL to inspect MP4/MOV `tkhd`
 * rotation metadata. Caches results per URL and safely returns null on unsupported formats,
 * network failures, or CORS restrictions.
 */
export async function fetchVideoOrientationFromUrl(
  url: string,
): Promise<Mp4VideoOrientationMetadata | null> {
  if (!url || typeof window === "undefined") return null;

  if (orientationCache.has(url)) {
    return orientationCache.get(url) ?? null;
  }

  const clean = url.split("?")[0]?.toLowerCase() ?? "";
  if (clean.endsWith(".webm") || clean.endsWith(".ogg") || clean.endsWith(".ogv")) {
    orientationCache.set(url, null);
    return null;
  }

  let result: Mp4VideoOrientationMetadata | null = null;

  try {
    if (url.startsWith("blob:")) {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        result = await readVideoOrientationFromBlob(blob);
      }
    } else {
      const head = await fetchByteRange(url, 0, 65535);
      if (head && isIsoBmffBuffer(head.bytes)) {
        result = parseMp4VideoOrientation(head.bytes);

        if (!result && !head.isFullFile) {
          let offset = 0;
          let steps = 0;
          const MAX_MOOV_BYTES = 8 * 1024 * 1024;

          // Walk top-level boxes using targeted Range jumps (skipping `mdat` payload)
          while (steps < 16) {
            steps++;
            let chunkBytes: Uint8Array;
            let chunkOffset = offset;

            if (offset + 16 <= head.bytes.byteLength) {
              chunkBytes = head.bytes;
              chunkOffset = 0;
            } else {
              const probe = await fetchByteRange(url, offset, offset + 65535);
              if (!probe || probe.bytes.byteLength < 8) break;
              chunkBytes = probe.bytes;
              chunkOffset = offset;
              // Check if `moov` fits entirely inside this probe
              const direct = parseMp4VideoOrientation(chunkBytes);
              if (direct) {
                result = direct;
                break;
              }
            }

            const localPos = offset - chunkOffset;
            if (localPos + 8 > chunkBytes.byteLength) break;

            const view = new DataView(
              chunkBytes.buffer,
              chunkBytes.byteOffset + localPos,
              chunkBytes.byteLength - localPos,
            );
            const size32 = readUint32BE(view, 0);
            const type = readAscii(chunkBytes, localPos + 4, 4);
            let boxSize = size32;
            let hdrLen = 8;

            if (size32 === 1) {
              if (localPos + 16 > chunkBytes.byteLength) break;
              boxSize = readUint32BE(view, 8) * 4294967296 + readUint32BE(view, 12);
              hdrLen = 16;
            } else if (size32 === 0) {
              if (head.totalSize && head.totalSize > offset) {
                boxSize = head.totalSize - offset;
              } else {
                break;
              }
            }

            if (boxSize < hdrLen) break;

            if (type === "moov") {
              if (boxSize <= MAX_MOOV_BYTES) {
                const moovRange = await fetchByteRange(url, offset, offset + boxSize - 1);
                if (moovRange) {
                  result = parseMp4VideoOrientation(moovRange.bytes);
                }
              }
              break;
            }

            offset += boxSize;
            if (head.totalSize && offset >= head.totalSize) break;
          }

          // Fallback: check last 256 KB via suffix Range if `moov` was at tail and box-walk stopped early
          if (!result) {
            try {
              const tailRes = await fetch(url, { headers: { Range: "bytes=-262144" } });
              if (tailRes.ok || tailRes.status === 206) {
                const tailBytes = new Uint8Array(await tailRes.arrayBuffer());
                result = findBoxStartingWithMoovInTail(tailBytes);
              }
            } catch {
              // ignore tail fallback failure
            }
          }
        }
      }
    }
  } catch {
    result = null;
  }

  orientationCache.set(url, result);
  return result;
}

/**
 * Determines whether CSS orientation correction should be applied to a video element or canvas,
 * strictly avoiding double rotation when the browser has already applied container `tkhd` rotation.
 */
export function computeVideoOrientationCorrection(params: {
  metadata: Mp4VideoOrientationMetadata | null;
  videoWidth: number;
  videoHeight: number;
}): VideoOrientationCorrection {
  const { metadata, videoWidth, videoHeight } = params;

  if (!metadata || (metadata.rotation === 0 && !metadata.mirrored)) {
    return { rotation: 0, mirrored: false, needsSwap: false };
  }

  if (metadata.rotation === 90 || metadata.rotation === 270) {
    const { codedWidth, codedHeight } = metadata;
    if (codedWidth > 0 && codedHeight > 0 && videoWidth > 0 && videoHeight > 0) {
      if (codedWidth !== codedHeight) {
        const codedIsLandscape = codedWidth > codedHeight;
        const renderedIsLandscape = videoWidth > videoHeight;

        // Browser ALREADY applied the 90/270 tkhd matrix and swapped dimensions -> do NOT rotate again.
        if (codedIsLandscape !== renderedIsLandscape) {
          return { rotation: 0, mirrored: false, needsSwap: false };
        }

        // Browser ignored tkhd matrix (rendered dimensions still match unrotated coded pixels) -> apply correction.
        return {
          rotation: metadata.rotation,
          mirrored: metadata.mirrored,
          needsSwap: true,
        };
      }
    }
  }

  // For 0° or 180° (where width/height don't swap), modern browsers apply tkhd natively;
  // do not inject CSS rotation blindly to avoid double rotation.
  return { rotation: 0, mirrored: false, needsSwap: false };
}

/**
 * Computes inline CSS positioning and transform for `<video>` when an unapplied 90°/270° rotation
 * correction is required, fitting cleanly inside the target container without clipping or distortion.
 * Returns `undefined` when no correction is needed so normal styling remains untouched.
 */
export function getOrientedVideoStyle(params: {
  correction: VideoOrientationCorrection;
  containerWidth: number;
  containerHeight: number;
  fit: "contain" | "cover";
}): CSSProperties | undefined {
  const { correction, containerWidth, containerHeight } = params;

  if (correction.rotation === 0 && !correction.mirrored) {
    return undefined;
  }

  const transforms: string[] = [];

  if (correction.needsSwap) {
    if (containerWidth > 0 && containerHeight > 0) {
      transforms.push(`translate(-50%, -50%)`);
      transforms.push(`rotate(${correction.rotation}deg)`);
      if (correction.mirrored) {
        transforms.push("scaleX(-1)");
      }
      return {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: `${containerHeight}px`,
        height: `${containerWidth}px`,
        maxWidth: "none",
        maxHeight: "none",
        transform: transforms.join(" "),
        transformOrigin: "center center",
      };
    }

    transforms.push(`rotate(${correction.rotation}deg)`);
    if (correction.mirrored) {
      transforms.push("scaleX(-1)");
    }
    return {
      transform: transforms.join(" "),
      transformOrigin: "center center",
    };
  }

  if (correction.rotation !== 0) {
    transforms.push(`rotate(${correction.rotation}deg)`);
  }
  if (correction.mirrored) {
    transforms.push("scaleX(-1)");
  }

  return transforms.length > 0
    ? {
        transform: transforms.join(" "),
        transformOrigin: "center center",
      }
    : undefined;
}

/**
 * React hook that monitors a container's size and a `<video>` element's metadata
 * to apply orientation correction only when the browser did not apply container rotation metadata.
 */
export function useVideoOrientation(
  src: string | undefined,
  containerRef: RefObject<HTMLElement | null>,
  fit: "contain" | "cover" = "contain",
): {
  correction: VideoOrientationCorrection;
  videoStyle: CSSProperties | undefined;
  handleLoadedMetadata: (videoEl: HTMLVideoElement | null) => void;
} {
  const [metadata, setMetadata] = useState<Mp4VideoOrientationMetadata | null>(null);
  const [videoDims, setVideoDims] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    setVideoDims({ width: 0, height: 0 });
    if (!src) {
      setMetadata(null);
      return;
    }

    let cancelled = false;
    fetchVideoOrientationFromUrl(src)
      .then((parsed) => {
        if (!cancelled) {
          setMetadata(parsed);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMetadata(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof window === "undefined") return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setContainerSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };

    updateSize();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [containerRef, src]);

  const handleLoadedMetadata = useCallback((videoEl: HTMLVideoElement | null) => {
    if (!videoEl) return;
    const width = videoEl.videoWidth || 0;
    const height = videoEl.videoHeight || 0;
    if (width > 0 && height > 0) {
      setVideoDims((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    }
  }, []);

  const correction = useMemo(
    () =>
      computeVideoOrientationCorrection({
        metadata,
        videoWidth: videoDims.width,
        videoHeight: videoDims.height,
      }),
    [metadata, videoDims.width, videoDims.height],
  );

  const videoStyle = useMemo(
    () =>
      getOrientedVideoStyle({
        correction,
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        fit,
      }),
    [correction, containerSize.width, containerSize.height, fit],
  );

  return { correction, videoStyle, handleLoadedMetadata };
}
