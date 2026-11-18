import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeVideoOrientationCorrection,
  extractRotationFromTkhdMatrix,
  getOrientedVideoStyle,
  parseMp4VideoOrientation,
  readVideoOrientationFromBlob,
} from "../lib/video-orientation.ts";

function u32be(val: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, val >>> 0, false);
  return buf;
}

function i32be(val: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, val | 0, false);
  return buf;
}

function u16be(val: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, val & 0xffff, false);
  return buf;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function toBlob(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

function makeBox(type: string, payload: Uint8Array, largeSize = false): Uint8Array {
  if (largeSize) {
    const size = 16 + payload.byteLength;
    const hi = Math.floor(size / 4294967296);
    const lo = size >>> 0;
    return concatBytes(u32be(1), ascii(type), u32be(hi), u32be(lo), payload);
  }
  return concatBytes(u32be(8 + payload.byteLength), ascii(type), payload);
}

function makeTkhd(params: {
  version?: 0 | 1;
  matrix: [number, number, number, number];
  trackWidth: number;
  trackHeight: number;
}): Uint8Array {
  const version = params.version ?? 0;
  const fullBoxHeader = new Uint8Array([version, 0, 0, 3]);
  const preMatrixBytes = new Uint8Array(version === 1 ? 48 : 36);
  const FP = 65536;
  const [a, b, c, d] = params.matrix;
  const matrixBytes = concatBytes(
    i32be(a * FP),
    i32be(b * FP),
    i32be(0),
    i32be(c * FP),
    i32be(d * FP),
    i32be(0),
    i32be(0),
    i32be(0),
    i32be(0x40000000),
  );
  const dims = concatBytes(u32be(params.trackWidth * FP), u32be(params.trackHeight * FP));
  return makeBox("tkhd", concatBytes(fullBoxHeader, preMatrixBytes, matrixBytes, dims));
}

function makeHdlr(handlerType: string): Uint8Array {
  const fullBoxHeader = new Uint8Array(4);
  const preDefined = new Uint8Array(4);
  const name = new Uint8Array(12);
  return makeBox("hdlr", concatBytes(fullBoxHeader, preDefined, ascii(handlerType), name));
}

function makeStsd(codedWidth: number, codedHeight: number): Uint8Array {
  const fullBoxHeader = new Uint8Array(4);
  const entryCount = u32be(1);
  // VisualSampleEntry payload: 24 bytes before width(2) + height(2) + extra
  const preDims = new Uint8Array(24);
  const entryPayload = concatBytes(
    preDims,
    u16be(codedWidth),
    u16be(codedHeight),
    new Uint8Array(8),
  );
  const sampleEntry = makeBox("avc1", entryPayload);
  return makeBox("stsd", concatBytes(fullBoxHeader, entryCount, sampleEntry));
}

function makeSyntheticMp4(params: {
  moovAtEnd?: boolean;
  tkhdVersion?: 0 | 1;
  matrix: [number, number, number, number];
  codedWidth: number;
  codedHeight: number;
  trackWidth?: number;
  trackHeight?: number;
  includeAudioTrackFirst?: boolean;
  largeMdatBox?: boolean;
}): Uint8Array {
  const ftyp = makeBox("ftyp", concatBytes(ascii("isom"), u32be(512), ascii("isomiso2avc1")));
  const mdat = makeBox("mdat", new Uint8Array(128), Boolean(params.largeMdatBox));

  const tracks: Uint8Array[] = [];
  if (params.includeAudioTrackFirst) {
    const audioTkhd = makeTkhd({ matrix: [1, 0, 0, 1], trackWidth: 0, trackHeight: 0 });
    const audioMdia = makeBox("mdia", makeHdlr("soun"));
    tracks.push(makeBox("trak", concatBytes(audioTkhd, audioMdia)));
  }

  const videoTkhd = makeTkhd({
    version: params.tkhdVersion ?? 0,
    matrix: params.matrix,
    trackWidth: params.trackWidth ?? params.codedWidth,
    trackHeight: params.trackHeight ?? params.codedHeight,
  });
  const stbl = makeBox("stbl", makeStsd(params.codedWidth, params.codedHeight));
  const minf = makeBox("minf", stbl);
  const mdia = makeBox("mdia", concatBytes(makeHdlr("vide"), minf));
  tracks.push(makeBox("trak", concatBytes(videoTkhd, mdia)));

  const moov = makeBox("moov", concatBytes(...tracks));
  return params.moovAtEnd ? concatBytes(ftyp, mdat, moov) : concatBytes(ftyp, moov, mdat);
}

describe("FaceTube: Video Orientation & Rotation Metadata", () => {
  describe("extractRotationFromTkhdMatrix", () => {
    const FP = 65536;

    it("extracts 0, 90, 180, 270 clockwise rotations accurately", () => {
      assert.deepEqual(extractRotationFromTkhdMatrix(1 * FP, 0, 0, 1 * FP), {
        rotation: 0,
        mirrored: false,
      });
      assert.deepEqual(extractRotationFromTkhdMatrix(0, 1 * FP, -1 * FP, 0), {
        rotation: 90,
        mirrored: false,
      });
      assert.deepEqual(extractRotationFromTkhdMatrix(-1 * FP, 0, 0, -1 * FP), {
        rotation: 180,
        mirrored: false,
      });
      assert.deepEqual(extractRotationFromTkhdMatrix(0, -1 * FP, 1 * FP, 0), {
        rotation: 270,
        mirrored: false,
      });
    });

    it("detects mirrored matrices and zero-matrix fallbacks safely", () => {
      assert.deepEqual(extractRotationFromTkhdMatrix(-1 * FP, 0, 0, 1 * FP), {
        rotation: 180,
        mirrored: true,
      });
      assert.deepEqual(extractRotationFromTkhdMatrix(0, 0, 0, 0), {
        rotation: 0,
        mirrored: false,
      });
    });
  });

  describe("MP4/MOV ISO BMFF Parser", () => {
    it("parses moov at file start, audio track skipping, tkhd v1, and 64-bit boxes", async () => {
      const mp4 = makeSyntheticMp4({
        moovAtEnd: false,
        tkhdVersion: 1,
        matrix: [0, 1, -1, 0],
        codedWidth: 1920,
        codedHeight: 1080,
        includeAudioTrackFirst: true,
      });

      const parsed = parseMp4VideoOrientation(mp4);
      assert.ok(parsed);
      assert.equal(parsed.rotation, 90);
      assert.equal(parsed.mirrored, false);
      assert.equal(parsed.codedWidth, 1920);
      assert.equal(parsed.codedHeight, 1080);

      const blobParsed = await readVideoOrientationFromBlob(toBlob(mp4));
      assert.deepEqual(blobParsed, parsed);
    });

    it("locates moov at end of file after large/64-bit mdat via Blob slice walking", async () => {
      const mp4 = makeSyntheticMp4({
        moovAtEnd: true,
        matrix: [0, -1, 1, 0],
        codedWidth: 1920,
        codedHeight: 1080,
        largeMdatBox: true,
      });

      const blobParsed = await readVideoOrientationFromBlob(toBlob(mp4));
      assert.ok(blobParsed);
      assert.equal(blobParsed.rotation, 270);
      assert.equal(blobParsed.codedWidth, 1920);
      assert.equal(blobParsed.codedHeight, 1080);
    });

    it("returns null safely for WebM, truncated, or invalid files", async () => {
      const webmMagic = new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42,
      ]);
      assert.equal(parseMp4VideoOrientation(webmMagic), null);
      assert.equal(await readVideoOrientationFromBlob(toBlob(webmMagic)), null);
      assert.equal(await readVideoOrientationFromBlob(toBlob(new Uint8Array(4))), null);
    });
  });

  describe("Double-Rotation Guard & Layout Geometry", () => {
    it("keeps rotation at 0 for normal landscape and portrait videos without rotation metadata", () => {
      assert.deepEqual(
        computeVideoOrientationCorrection({
          metadata: {
            rotation: 0,
            mirrored: false,
            codedWidth: 1920,
            codedHeight: 1080,
            trackWidth: 1920,
            trackHeight: 1080,
          },
          videoWidth: 1920,
          videoHeight: 1080,
        }),
        { rotation: 0, mirrored: false, needsSwap: false },
      );

      assert.deepEqual(
        computeVideoOrientationCorrection({
          metadata: {
            rotation: 0,
            mirrored: false,
            codedWidth: 1080,
            codedHeight: 1920,
            trackWidth: 1080,
            trackHeight: 1920,
          },
          videoWidth: 1080,
          videoHeight: 1920,
        }),
        { rotation: 0, mirrored: false, needsSwap: false },
      );
    });

    it("prevents double rotation when browser already rotated coded 1920x1080 video to 1080x1920", () => {
      for (const rotation of [90, 270] as const) {
        const correction = computeVideoOrientationCorrection({
          metadata: {
            rotation,
            mirrored: false,
            codedWidth: 1920,
            codedHeight: 1080,
            trackWidth: 1920,
            trackHeight: 1080,
          },
          videoWidth: 1080,
          videoHeight: 1920,
        });
        assert.deepEqual(correction, { rotation: 0, mirrored: false, needsSwap: false });
        assert.equal(
          getOrientedVideoStyle({
            correction,
            containerWidth: 800,
            containerHeight: 450,
            fit: "contain",
          }),
          undefined,
        );
      }
    });

    it("applies exact rotation & swapped layout box when browser ignored 90/270 tkhd metadata", () => {
      const portraitCorrection = computeVideoOrientationCorrection({
        metadata: {
          rotation: 90,
          mirrored: false,
          codedWidth: 1920,
          codedHeight: 1080,
          trackWidth: 1920,
          trackHeight: 1080,
        },
        videoWidth: 1920,
        videoHeight: 1080,
      });
      assert.deepEqual(portraitCorrection, {
        rotation: 90,
        mirrored: false,
        needsSwap: true,
      });

      const style = getOrientedVideoStyle({
        correction: portraitCorrection,
        containerWidth: 800,
        containerHeight: 450,
        fit: "contain",
      });
      assert.ok(style);
      assert.equal(style.position, "absolute");
      assert.equal(style.width, "450px");
      assert.equal(style.height, "800px");
      assert.equal(style.transform, "translate(-50%, -50%) rotate(90deg)");

      const landscapeCorrection = computeVideoOrientationCorrection({
        metadata: {
          rotation: 270,
          mirrored: false,
          codedWidth: 1080,
          codedHeight: 1920,
          trackWidth: 1080,
          trackHeight: 1920,
        },
        videoWidth: 1080,
        videoHeight: 1920,
      });
      assert.deepEqual(landscapeCorrection, {
        rotation: 270,
        mirrored: false,
        needsSwap: true,
      });
    });
  });

  describe("Real FFmpeg MP4 Container Verification", () => {
    it("parses real FFmpeg-generated 0°, 90°, 180°, and 270° MP4 files (including faststart & moov-at-tail)", async (t) => {
      let hasFfmpeg = false;
      try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
        hasFfmpeg = true;
      } catch {
        hasFfmpeg = false;
      }

      if (!hasFfmpeg) {
        t.skip("ffmpeg not available in environment");
        return;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-orient-"));
      try {
        const basePath = path.join(tmpDir, "base.mp4");
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x180:d=0.2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            basePath,
          ],
          { stdio: "ignore" },
        );

        const baseBytes = fs.readFileSync(basePath);
        const baseParsed = await readVideoOrientationFromBlob(toBlob(baseBytes));
        assert.ok(baseParsed);
        assert.equal(baseParsed.rotation, 0);
        assert.equal(baseParsed.codedWidth, 320);
        assert.equal(baseParsed.codedHeight, 180);

        // ffmpeg `-metadata:s:v:0 rotate=90` encodes a -90° (270° clockwise) forward tkhd matrix,
        // placing the original top edge on the left; `rotate=270` encodes +90° clockwise (top on right).
        const cases: Array<{ ffmpegFlag: number; expectedCssClockwise: number }> = [
          { ffmpegFlag: 90, expectedCssClockwise: 270 },
          { ffmpegFlag: 180, expectedCssClockwise: 180 },
          { ffmpegFlag: 270, expectedCssClockwise: 90 },
        ];

        for (const { ffmpegFlag, expectedCssClockwise } of cases) {
          const outPath = path.join(tmpDir, `rot_${ffmpegFlag}.mp4`);
          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-i",
              basePath,
              "-c",
              "copy",
              "-metadata:s:v:0",
              `rotate=${ffmpegFlag}`,
              outPath,
            ],
            { stdio: "ignore" },
          );
          const bytes = fs.readFileSync(outPath);
          const parsed = await readVideoOrientationFromBlob(toBlob(bytes));
          assert.ok(parsed, `Expected metadata parsed for rotate=${ffmpegFlag}`);
          assert.equal(parsed.rotation, expectedCssClockwise);
          assert.equal(parsed.codedWidth, 320);
          assert.equal(parsed.codedHeight, 180);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
