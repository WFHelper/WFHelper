"use strict";

/**
 * DXGI Desktop Duplication screen capture via koffi FFI.
 *
 * Provides ~2-10 ms full-screen capture vs ~100-300 ms with Electron's
 * desktopCapturer.getSources. Falls back gracefully when DXGI is unavailable
 * (e.g. RDP, Hyper-V, older GPU drivers).
 *
 * Lifecycle:
 *   - `captureDxgi()` lazily initialises the duplication session on first call.
 *   - On DXGI_ERROR_ACCESS_LOST the session is torn down and re-created on the
 *     next call (DWM restart, resolution change, etc.).
 *   - `destroyDxgi()` releases all COM objects; safe to call at any time.
 */

import { withScope } from "./logger";

const log = withScope("dxgiCapture");

// ---------------------------------------------------------------------------
// koffi imports — resolved lazily so module loads even if koffi is missing
// ---------------------------------------------------------------------------
let _koffi: typeof import("koffi") | null = null;

function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

// ---------------------------------------------------------------------------
// HRESULT constants
// ---------------------------------------------------------------------------
const S_OK = 0;
const DXGI_ERROR_WAIT_TIMEOUT = 0x887a0001 | 0; // signed
const DXGI_ERROR_ACCESS_LOST = 0x887a0026 | 0;

// ---------------------------------------------------------------------------
// GUIDs
// ---------------------------------------------------------------------------
interface GUID {
  Data1: number;
  Data2: number;
  Data3: number;
  Data4: number[];
}

const IID_IDXGIFactory: GUID = {
  Data1: 0x7b7166ec,
  Data2: 0x21c7,
  Data3: 0x44ae,
  Data4: [0xb2, 0x1a, 0xc9, 0xae, 0x32, 0x1a, 0xe3, 0x69],
};

const IID_IDXGIOutput1: GUID = {
  Data1: 0x00cddea8,
  Data2: 0x939b,
  Data3: 0x4b83,
  Data4: [0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc],
};

const IID_ID3D11Texture2D: GUID = {
  Data1: 0x6f15aaf2,
  Data2: 0xd208,
  Data3: 0x4e89,
  Data4: [0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c],
};

// ---------------------------------------------------------------------------
// COM vtable dispatch
// ---------------------------------------------------------------------------
let _protoCounter = 0;

function uniqueProto(
  k: typeof import("koffi"),
  retType: string,
  argTypes: any[],
): any {
  return k.proto("_dxP" + _protoCounter++, retType, ["void*", ...argTypes]);
}

/** Call a COM interface method at the given vtable slot. */
function comCall(obj: any, slot: number, proto: any, ...args: any[]): any {
  const k = koffi();
  const vtbl = k.decode(obj, "void*");
  const fn = k.decode(vtbl, slot * 8, "void*");
  return k.call(fn, proto, obj, ...args);
}

function comRelease(obj: any): void {
  if (obj) comCall(obj, 2, _protos.Release);
}

// ---------------------------------------------------------------------------
// Shared proto definitions — initialised once in `ensureProtos()`
// ---------------------------------------------------------------------------
let _protos: {
  Release: any;
  QI: any;
  EnumAdapters: any;
  EnumOutputs: any;
  GetAdapterDesc: any;
  DuplicateOutput: any;
  GetDuplDesc: any;
  AcquireNextFrame: any;
  ReleaseFrame: any;
  CreateTexture2D: any;
  CopyResource: any;
  Map: any;
  Unmap: any;
};

let _GUID_TYPE: any;
let _dxgiLib: any;
let _d3d11Lib: any;
let _CreateDXGIFactory1: any;
let _D3D11CreateDevice: any;

function ensureProtos(): void {
  if (_protos) return;

  const k = koffi();

  _GUID_TYPE = k.struct("_GUID_dxgi", {
    Data1: "uint32",
    Data2: "uint16",
    Data3: "uint16",
    Data4: k.array("uint8", 8),
  });

  const gp = k.pointer(_GUID_TYPE);
  const outPtr = k.out(k.pointer("void*"));

  _protos = {
    Release: k.proto("uint32 __stdcall _dxRel(void*)"),
    QI: uniqueProto(k, "int32", [gp, outPtr]),
    EnumAdapters: uniqueProto(k, "int32", ["uint32", outPtr]),
    EnumOutputs: uniqueProto(k, "int32", ["uint32", outPtr]),
    GetAdapterDesc: uniqueProto(k, "int32", ["void*"]),
    DuplicateOutput: uniqueProto(k, "int32", ["void*", outPtr]),
    GetDuplDesc: uniqueProto(k, "int32", ["void*"]),
    AcquireNextFrame: uniqueProto(k, "int32", ["uint32", "void*", outPtr]),
    ReleaseFrame: k.proto("int32 __stdcall _dxRelFrame(void*)"),
    CreateTexture2D: uniqueProto(k, "int32", ["void*", "void*", outPtr]),
    CopyResource: k.proto("void __stdcall _dxCopyR(void*, void*, void*)"),
    Map: uniqueProto(k, "int32", ["void*", "uint32", "uint32", "uint32", "void*"]),
    Unmap: k.proto("void __stdcall _dxUnmap(void*, void*, uint32)"),
  };

  _dxgiLib = k.load("dxgi.dll");
  _d3d11Lib = k.load("d3d11.dll");

  _CreateDXGIFactory1 = _dxgiLib.func("__stdcall", "CreateDXGIFactory1", "int32", [
    k.pointer(_GUID_TYPE),
    k.out(k.pointer("void*")),
  ]);

  _D3D11CreateDevice = _d3d11Lib.func("__stdcall", "D3D11CreateDevice", "int32", [
    "void*", // pAdapter
    "uint32", // DriverType
    "void*", // Software
    "uint32", // Flags
    "void*", // pFeatureLevels
    "uint32", // FeatureLevels count
    "uint32", // SDKVersion
    k.out(k.pointer("void*")), // ppDevice
    k.out(k.pointer("uint32")), // pFeatureLevel
    k.out(k.pointer("void*")), // ppImmediateContext
  ]);
}

// ---------------------------------------------------------------------------
// Duplication session state
// ---------------------------------------------------------------------------
interface DxgiSession {
  factory: any;
  adapter: any;
  output: any;
  output1: any;
  device: any;
  context: any;
  duplication: any;
  staging: any;
  width: number;
  height: number;
}

let _session: DxgiSession | null = null;
let _initFailed = false;
// Last successfully captured frame — returned on DXGI_ERROR_WAIT_TIMEOUT so that
// the readiness gate sees identical consecutive frames and correctly detects stability.
let _lastFrame: DxgiCaptureResult | null = null;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function initSession(): DxgiSession | null {
  ensureProtos();

  const factoryOut = [null];
  let hr = _CreateDXGIFactory1(IID_IDXGIFactory, factoryOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] CreateDXGIFactory1 failed:", "0x" + (hr >>> 0).toString(16));
    return null;
  }
  const factory = factoryOut[0];

  // Enumerate adapter 0 (primary GPU)
  const adapterOut = [null];
  hr = comCall(factory, 7, _protos.EnumAdapters, 0, adapterOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] EnumAdapters(0) failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(factory);
    return null;
  }
  const adapter = adapterOut[0];

  // Read adapter name for diagnostics
  const adBuf = Buffer.alloc(512);
  comCall(adapter, 8, _protos.GetAdapterDesc, adBuf);
  const adName = adBuf.subarray(0, 256).toString("utf16le").replace(/\0+$/, "");
  log.log("[dxgiCapture] Adapter:", adName);

  // Enumerate output 0 (primary monitor)
  const outputOut = [null];
  hr = comCall(adapter, 7, _protos.EnumOutputs, 0, outputOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] EnumOutputs(0) failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  // QI → IDXGIOutput1
  const output1Out = [null];
  hr = comCall(outputOut[0], 0, _protos.QI, IID_IDXGIOutput1, output1Out);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] QI IDXGIOutput1 failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(outputOut[0]);
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  // D3D11 device
  const devOut = [null],
    flOut = [0],
    ctxOut = [null];
  hr = _D3D11CreateDevice(adapter, 0, null, 0, null, 0, 7, devOut, flOut, ctxOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] D3D11CreateDevice failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(output1Out[0]);
    comRelease(outputOut[0]);
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  // DuplicateOutput (slot 22 on IDXGIOutput1)
  const duplOut = [null];
  hr = comCall(output1Out[0], 22, _protos.DuplicateOutput, devOut[0], duplOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] DuplicateOutput failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(devOut[0]);
    comRelease(ctxOut[0]);
    comRelease(output1Out[0]);
    comRelease(outputOut[0]);
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  // Read surface dimensions from duplication desc
  const ddBuf = Buffer.alloc(64);
  comCall(duplOut[0], 7, _protos.GetDuplDesc, ddBuf);
  // ModeDesc.Width at offset 0, ModeDesc.Height at offset 4
  const width = ddBuf.readUInt32LE(0);
  const height = ddBuf.readUInt32LE(4);
  const format = ddBuf.readUInt32LE(16); // ModeDesc.Format

  if (!width || !height) {
    log.warn("[dxgiCapture] Invalid surface dimensions:", width, "x", height);
    comRelease(duplOut[0]);
    comRelease(devOut[0]);
    comRelease(ctxOut[0]);
    comRelease(output1Out[0]);
    comRelease(outputOut[0]);
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  log.log("[dxgiCapture] Surface:", width, "x", height, "format:", format);

  // Create staging texture for CPU readback
  const tdBuf = Buffer.alloc(44);
  tdBuf.writeUInt32LE(width, 0); // Width
  tdBuf.writeUInt32LE(height, 4); // Height
  tdBuf.writeUInt32LE(1, 8); // MipLevels
  tdBuf.writeUInt32LE(1, 12); // ArraySize
  tdBuf.writeUInt32LE(format, 16); // Format (B8G8R8A8_UNORM = 87)
  tdBuf.writeUInt32LE(1, 20); // SampleCount
  tdBuf.writeUInt32LE(0, 24); // SampleQuality
  tdBuf.writeUInt32LE(3, 28); // Usage = D3D11_USAGE_STAGING
  tdBuf.writeUInt32LE(0, 32); // BindFlags
  tdBuf.writeUInt32LE(0x20000, 36); // CPUAccessFlags = D3D11_CPU_ACCESS_READ
  tdBuf.writeUInt32LE(0, 40); // MiscFlags

  const stagingOut = [null];
  hr = comCall(devOut[0], 5, _protos.CreateTexture2D, tdBuf, null, stagingOut);
  if (hr !== S_OK) {
    log.warn("[dxgiCapture] CreateTexture2D (staging) failed:", "0x" + (hr >>> 0).toString(16));
    comRelease(duplOut[0]);
    comRelease(devOut[0]);
    comRelease(ctxOut[0]);
    comRelease(output1Out[0]);
    comRelease(outputOut[0]);
    comRelease(adapter);
    comRelease(factory);
    return null;
  }

  return {
    factory,
    adapter,
    output: outputOut[0],
    output1: output1Out[0],
    device: devOut[0],
    context: ctxOut[0],
    duplication: duplOut[0],
    staging: stagingOut[0],
    width,
    height,
  };
}

/**
 * Release all COM objects and reset session state.
 * Safe to call even if no session exists.
 */
export function destroyDxgi(): void {
  if (!_session) return;
  const s = _session;
  _session = null;
  _lastFrame = null;
  try {
    comRelease(s.staging);
    comRelease(s.duplication);
    comRelease(s.output1);
    comRelease(s.output);
    comRelease(s.adapter);
    comRelease(s.factory);
    comRelease(s.device);
    comRelease(s.context);
  } catch (err) {
    log.warn("[dxgiCapture] destroyDxgi cleanup error:", String(err));
  }
  log.log("[dxgiCapture] Session destroyed");
}

// ---------------------------------------------------------------------------
// Public capture API
// ---------------------------------------------------------------------------

export interface DxgiCaptureResult {
  /** BGRA pixel buffer (compatible with Electron nativeImage.createFromBitmap) */
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Capture the primary display via DXGI Desktop Duplication.
 *
 * Returns BGRA pixel data or `null` if capture fails. On
 * `DXGI_ERROR_ACCESS_LOST` the session is torn down so the next call
 * re-initialises transparently.
 *
 * Default `timeoutMs = 0` (non-blocking): AcquireNextFrame returns immediately
 * if no new frame has been composed by DWM since the last release.
 * On DXGI_ERROR_WAIT_TIMEOUT the last successfully captured frame is returned
 * instead — this means the display content is unchanged, which the readiness
 * gate interprets correctly as a stable frame.
 */
export function captureDxgi(timeoutMs = 0): DxgiCaptureResult | null {
  if (_initFailed) return null;

  if (!_session) {
    try {
      _session = initSession();
    } catch (err) {
      log.warn("[dxgiCapture] initSession threw:", String(err));
      _initFailed = true;
      return null;
    }
    if (!_session) {
      _initFailed = true;
      return null;
    }
  }

  const s = _session;
  const k = koffi();

  // AcquireNextFrame (slot 8 on IDXGIOutputDuplication).
  // Bootstrap: block up to 1 s on the very first capture after session init to
  // guarantee _lastFrame is populated.  The old initSession() probe consumed
  // the available frame without saving pixel data, causing every subsequent
  // captureDxgi(0) to return WAIT_TIMEOUT -> null -> desktopCapturer fallback.
  // rowPitch is read live from the Map result on every call, so a probe is not
  // needed.
  const frameTimeout = _lastFrame === null ? 1000 : timeoutMs;
  const frameInfoBuf = Buffer.alloc(48);
  const resourceOut = [null];
  const hr = comCall(s.duplication, 8, _protos.AcquireNextFrame, frameTimeout, frameInfoBuf, resourceOut);

  if (hr === DXGI_ERROR_ACCESS_LOST) {
    log.warn("[dxgiCapture] ACCESS_LOST — reinitialising on next call");
    destroyDxgi();
    _initFailed = false; // allow retry
    return null;
  }
  if (hr === DXGI_ERROR_WAIT_TIMEOUT) {
    // Desktop unchanged - return the cached last frame so the readiness gate
    // sees identical consecutive samples and registers stability correctly.
    // On bootstrap _lastFrame is only null if DXGI produced no frame within 1 s
    // (headless / RDP / driver issue).  Mark unavailable to skip future waits.
    if (_lastFrame === null) {
      log.warn("[dxgiCapture] Bootstrap timed out - marking unavailable");
      destroyDxgi();
      _initFailed = true;
    }
    return _lastFrame;
  }
  if (hr !== S_OK || !resourceOut[0]) {
    log.warn("[dxgiCapture] AcquireNextFrame failed:", "0x" + (hr >>> 0).toString(16));
    return null;
  }

  let result: DxgiCaptureResult | null = null;

  try {
    // QI resource → ID3D11Texture2D
    const texOut = [null];
    if (comCall(resourceOut[0], 0, _protos.QI, IID_ID3D11Texture2D, texOut) !== S_OK) {
      return null;
    }

    try {
      // CopyResource: GPU texture → staging texture (slot 47)
      comCall(s.context, 47, _protos.CopyResource, s.staging, texOut[0]);

      // Map staging texture to CPU (slot 14)
      const mapBuf = Buffer.alloc(16);
      if (comCall(s.context, 14, _protos.Map, s.staging, 0, 1, 0, mapBuf) !== S_OK) {
        return null;
      }

      try {
        const pData = k.decode(mapBuf, "void*");
        const rowPitch = mapBuf.readUInt32LE(8);
        const rowBytes = s.width * 4;
        const totalBytes = rowBytes * s.height;
        const pixelBuf = Buffer.alloc(totalBytes);

        if (rowPitch === rowBytes) {
          // Contiguous — single bulk read
          const raw = k.decode(pData, 0, k.array("uint8", totalBytes));
          Buffer.from(raw).copy(pixelBuf);
        } else {
          // Padded rows — read row by row
          for (let y = 0; y < s.height; y++) {
            const row = k.decode(pData, y * rowPitch, k.array("uint8", rowBytes));
            Buffer.from(row).copy(pixelBuf, y * rowBytes);
          }
        }

        result = { buffer: pixelBuf, width: s.width, height: s.height };
        _lastFrame = result; // cache for WAIT_TIMEOUT returns
      } finally {
        // Unmap (slot 15)
        comCall(s.context, 15, _protos.Unmap, s.staging, 0);
      }
    } finally {
      comRelease(texOut[0]);
    }
  } finally {
    // ReleaseFrame (slot 13)
    comCall(s.duplication, 13, _protos.ReleaseFrame);
    comRelease(resourceOut[0]);
  }

  return result;
}

/**
 * Returns true if DXGI capture is potentially available (koffi loadable,
 * Windows platform). Does NOT initialise the session.
 */
export function isDxgiAvailable(): boolean {
  if (process.platform !== "win32") return false;
  if (_initFailed) return false;
  try {
    koffi(); // ensure koffi can load
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the _initFailed flag so the next `captureDxgi()` will retry
 * initialisation. Useful after a display config change.
 */
export function resetDxgiFailure(): void {
  _initFailed = false;
}
