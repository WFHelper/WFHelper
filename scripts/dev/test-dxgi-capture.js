// DXGI Desktop Duplication proof-of-concept via koffi (Buffer-based struct IO)
const koffi = require("koffi");

// ─── Basic types ─────────────────────────────────────────────────────
const GUID = koffi.struct("GUID2", {
  Data1: "uint32", Data2: "uint16", Data3: "uint16",
  Data4: koffi.array("uint8", 8),
});

// ─── GUIDs ───────────────────────────────────────────────────────────
const IID_IDXGIFactory   = { Data1: 0x7b7166ec, Data2: 0x21c7, Data3: 0x44ae, Data4: [0xb2,0x1a,0xc9,0xae,0x32,0x1a,0xe3,0x69] };
const IID_IDXGIOutput1   = { Data1: 0x00cddea8, Data2: 0x939b, Data3: 0x4b83, Data4: [0xa3,0x40,0xa6,0x85,0x22,0x66,0x66,0xcc] };
const IID_ID3D11Tex2D    = { Data1: 0x6f15aaf2, Data2: 0xd208, Data3: 0x4e89, Data4: [0x9a,0xb4,0x48,0x95,0x35,0xd3,0x4f,0x9c] };

// ─── DLL exports ─────────────────────────────────────────────────────
const dxgi  = koffi.load("dxgi.dll");
const d3d11 = koffi.load("d3d11.dll");

const CreateDXGIFactory1 = dxgi.func("__stdcall", "CreateDXGIFactory1", "int32",
  [koffi.pointer(GUID), koffi.out(koffi.pointer("void*"))]);

const D3D11CreateDevice = d3d11.func("__stdcall", "D3D11CreateDevice", "int32", [
  "void*", "uint32", "void*", "uint32", "void*", "uint32", "uint32",
  koffi.out(koffi.pointer("void*")),   // ppDevice
  koffi.out(koffi.pointer("uint32")),  // pFeatureLevel
  koffi.out(koffi.pointer("void*")),   // ppImmediateContext
]);

// ─── COM vtable helper ──────────────────────────────────────────────
function comCall(obj, slot, proto, ...args) {
  const vtbl = koffi.decode(obj, "void*");
  const fn   = koffi.decode(vtbl, slot * 8, "void*");
  return koffi.call(fn, proto, obj, ...args);
}

// Unique proto names (koffi requires unique names per proto)
let _pc = 0;
function p(retType, argTypes) {
  return koffi.proto("_p" + (_pc++), retType, ["void*", ...argTypes]);
}

const QI       = p("int32", [koffi.pointer(GUID), koffi.out(koffi.pointer("void*"))]);
const Release  = koffi.proto("uint32 __stdcall _Rel(void*)");
const EnumA    = p("int32", ["uint32", koffi.out(koffi.pointer("void*"))]);
const EnumO    = p("int32", ["uint32", koffi.out(koffi.pointer("void*"))]);
const GetDescA = p("int32", ["void*"]);  // pass raw buffer
const GetDescD = p("int32", ["void*"]);  // pass raw buffer for DXGI_OUTDUPL_DESC
const DuplOut  = p("int32", ["void*", koffi.out(koffi.pointer("void*"))]);
const AcqFrame = p("int32", ["uint32", "void*", koffi.out(koffi.pointer("void*"))]);
const RelFrame = koffi.proto("int32 __stdcall _RelFrame(void*)");
const CreateT  = p("int32", ["void*", "void*", koffi.out(koffi.pointer("void*"))]);
const CopyR    = koffi.proto("void __stdcall _CopyR(void*, void*, void*)");
const MapR     = p("int32", ["void*", "uint32", "uint32", "uint32", "void*"]);
const UnmapR   = koffi.proto("void __stdcall _Unmap(void*, void*, uint32)");

function comRelease(obj) { if (obj) comCall(obj, 2, Release); }

// ─── Main ────────────────────────────────────────────────────────────
(function main() {
  // 1) Factory
  const fo = [null];
  if (CreateDXGIFactory1(IID_IDXGIFactory, fo)) { console.error("Factory failed"); return; }
  const factory = fo[0];
  console.log("OK Factory");

  // 2) Adapter
  const ao = [null];
  if (comCall(factory, 7, EnumA, 0, ao)) { console.error("EnumAdapters failed"); return; }
  const adapter = ao[0];

  // Read adapter desc via raw buffer (DXGI_ADAPTER_DESC = 280 bytes on x64)
  const adBuf = Buffer.alloc(512);
  comCall(adapter, 8, GetDescA, adBuf);
  const adName = adBuf.subarray(0, 256).toString("utf16le").replace(/\0+$/, "");
  // Offset of DedicatedVideoMemory = 256(Description) + 16(4xUINT) = 272
  const vram = Number(adBuf.readBigUInt64LE(272));
  console.log("OK Adapter:", JSON.stringify(adName), "VRAM:", Math.round(vram / 1048576), "MB");

  // 3) Output 0
  const oo = [null];
  if (comCall(adapter, 7, EnumO, 0, oo)) { console.error("EnumOutputs failed"); return; }
  console.log("OK Output");

  // 4) QI -> IDXGIOutput1
  const o1o = [null];
  if (comCall(oo[0], 0, QI, IID_IDXGIOutput1, o1o)) { console.error("QI Output1 failed"); return; }
  console.log("OK IDXGIOutput1");

  // 5) D3D11 Device
  const devo = [null], flo = [0], ctxo = [null];
  let hr = D3D11CreateDevice(adapter, 0, null, 0, null, 0, 7, devo, flo, ctxo);
  if (hr) { console.error("D3D11CreateDevice failed:", "0x" + (hr>>>0).toString(16)); return; }
  console.log("OK D3D11 Device, FL:", "0x" + (flo[0]>>>0).toString(16));

  // 6) DuplicateOutput (slot 22 on IDXGIOutput1)
  const duplo = [null];
  hr = comCall(o1o[0], 22, DuplOut, devo[0], duplo);
  if (hr) { console.error("DuplicateOutput failed:", "0x" + (hr>>>0).toString(16)); return; }
  console.log("OK OutputDuplication");

  // Read dupl desc via raw buffer
  const ddBuf = Buffer.alloc(128);
  comCall(duplo[0], 7, GetDescD, ddBuf);
  // Dump first 64 bytes
  console.log("  DuplDesc raw:");
  for (let off = 0; off < 64; off += 4) {
    const v = ddBuf.readUInt32LE(off);
    if (v) console.log("    offset", off, "=", v, "(0x" + v.toString(16) + ")");
  }
  // DXGI_OUTDUPL_DESC: ModeDesc(28) + SampleDesc(8) + SurfaceWidth(4) + SurfaceHeight(4) + Format(4) + Bool(4) = 52
  // Also check ModeDesc.Width/Height at offset 0 and 4
  const modeW = ddBuf.readUInt32LE(0);
  const modeH = ddBuf.readUInt32LE(4);
  const surfW = ddBuf.readUInt32LE(36);
  const surfH = ddBuf.readUInt32LE(40);
  const surfFmt = ddBuf.readUInt32LE(44);
  console.log("  ModeDesc WxH:", modeW, "x", modeH);
  console.log("  Surface:", surfW, "x", surfH, "format:", surfFmt);

  // Use modeW/modeH if surface is 0
  const w = surfW || modeW;
  const h = surfH || modeH;
  const fmt = surfFmt || ddBuf.readUInt32LE(16); // ModeDesc.Format
  console.log("  Using:", w, "x", h, "fmt:", fmt);

  // 7) AcquireNextFrame (slot 8)
  const fiBuf = Buffer.alloc(48);
  const reso = [null];
  const t0 = performance.now();
  hr = comCall(duplo[0], 8, AcqFrame, 500, fiBuf, reso);
  const t1 = performance.now();
  if (hr) { console.error("AcquireNextFrame failed:", "0x" + (hr>>>0).toString(16)); return; }
  console.log("OK AcquireNextFrame:", (t1-t0).toFixed(2), "ms");

  // 8) QI -> ID3D11Texture2D
  const texo = [null];
  hr = comCall(reso[0], 0, QI, IID_ID3D11Tex2D, texo);
  if (hr) { console.error("QI Texture2D failed:", "0x" + (hr>>>0).toString(16)); return; }

  // 9) Create staging texture via raw buffer
  const tdBuf = Buffer.alloc(44);
  tdBuf.writeUInt32LE(w, 0);     // Width
  tdBuf.writeUInt32LE(h, 4);     // Height
  tdBuf.writeUInt32LE(1, 8);         // MipLevels
  tdBuf.writeUInt32LE(1, 12);        // ArraySize
  tdBuf.writeUInt32LE(fmt, 16);  // Format
  tdBuf.writeUInt32LE(1, 20);        // SampleCount
  tdBuf.writeUInt32LE(0, 24);        // SampleQuality
  tdBuf.writeUInt32LE(3, 28);        // Usage = D3D11_USAGE_STAGING
  tdBuf.writeUInt32LE(0, 32);        // BindFlags
  tdBuf.writeUInt32LE(0x20000, 36);  // CPUAccessFlags = D3D11_CPU_ACCESS_READ
  tdBuf.writeUInt32LE(0, 40);        // MiscFlags

  const stago = [null];
  hr = comCall(devo[0], 5, CreateT, tdBuf, null, stago);
  if (hr) { console.error("CreateTexture2D failed:", "0x" + (hr>>>0).toString(16)); return; }
  console.log("OK Staging texture");

  // 10) CopyResource (slot 47 on ID3D11DeviceContext)
  const t2 = performance.now();
  comCall(ctxo[0], 47, CopyR, stago[0], texo[0]);
  const t3 = performance.now();
  console.log("OK CopyResource:", (t3-t2).toFixed(2), "ms");

  // 11) Map (slot 14) -- D3D11_MAPPED_SUBRESOURCE: pData(8) RowPitch(4) DepthPitch(4) = 16 bytes
  const mapBuf = Buffer.alloc(16);
  hr = comCall(ctxo[0], 14, MapR, stago[0], 0, 1, 0, mapBuf); // D3D11_MAP_READ=1, flags=0
  if (hr) { console.error("Map failed:", "0x" + (hr>>>0).toString(16)); return; }

  const pData = koffi.decode(mapBuf, "void*");   // read first 8 bytes as a koffi pointer
  const rowPitch = mapBuf.readUInt32LE(8);
  console.log("OK Map -- RowPitch:", rowPitch, "pData:", pData);

  // 12) Read pixel data
  const t4 = performance.now();
  const rowBytes = w * 4;
  const totalBytes = rowBytes * h;
  const pixelBuf = Buffer.alloc(totalBytes);

  for (let y = 0; y < h; y++) {
    const rowData = koffi.decode(pData, y * rowPitch, koffi.array("uint8", rowBytes));
    Buffer.from(rowData).copy(pixelBuf, y * rowBytes);
  }
  const t5 = performance.now();
  console.log("OK Read pixels:", (t5-t4).toFixed(2), "ms", `(${w}x${h}, ${(totalBytes/1048576).toFixed(1)}MB)`);

  // Sample pixels
  console.log("  [0,0] BGRA:", pixelBuf[0], pixelBuf[1], pixelBuf[2], pixelBuf[3]);
  const midOff = ((h >> 1) * rowBytes) + ((w >> 1) * 4);
  console.log("  [mid] BGRA:", pixelBuf[midOff], pixelBuf[midOff+1], pixelBuf[midOff+2], pixelBuf[midOff+3]);

  let nonBlack = 0;
  for (let i = 0; i < totalBytes; i += 4) {
    if (pixelBuf[i] || pixelBuf[i+1] || pixelBuf[i+2]) nonBlack++;
  }
  console.log("  Non-black pixels:", nonBlack, "/", w * h);

  // 13) Unmap (slot 15)
  comCall(ctxo[0], 15, UnmapR, stago[0], 0);

  // 14) ReleaseFrame (slot 13 on IDXGIOutputDuplication)
  comCall(duplo[0], 13, RelFrame);

  // ── Second capture for timing ──
  console.log("\n--- Second capture (warm) ---");
  const fiBuf2 = Buffer.alloc(48);
  const reso2 = [null];
  const s0 = performance.now();
  hr = comCall(duplo[0], 8, AcqFrame, 500, fiBuf2, reso2);
  const s1 = performance.now();
  if (!hr) {
    const texo2 = [null];
    comCall(reso2[0], 0, QI, IID_ID3D11Tex2D, texo2);
    comCall(ctxo[0], 47, CopyR, stago[0], texo2[0]);
    const s2 = performance.now();
    comCall(ctxo[0], 14, MapR, stago[0], 0, 1, 0, mapBuf);
    const pData2 = koffi.decode(mapBuf, "void*");
    for (let y = 0; y < h; y++) {
      const row = koffi.decode(pData2, y * rowPitch, koffi.array("uint8", rowBytes));
      Buffer.from(row).copy(pixelBuf, y * rowBytes);
    }
    const s3 = performance.now();
    comCall(ctxo[0], 15, UnmapR, stago[0], 0);
    comCall(duplo[0], 13, RelFrame);
    comRelease(texo2[0]);
    comRelease(reso2[0]);
    console.log("  Acquire:", (s1-s0).toFixed(2), "ms  Copy:", (s2-s1).toFixed(2), "ms  Read:", (s3-s2).toFixed(2), "ms  TOTAL:", (s3-s0).toFixed(2), "ms");
  } else {
    console.log("  AcqFrame2 hr:", "0x" + (hr>>>0).toString(16));
  }

  // Cleanup
  comRelease(stago[0]);
  comRelease(texo[0]);
  comRelease(reso[0]);
  comRelease(duplo[0]);
  comRelease(o1o[0]);
  comRelease(oo[0]);
  comRelease(adapter);
  comRelease(factory);
  comRelease(devo[0]);
  comRelease(ctxo[0]);

  console.log("\nDXGI Desktop Duplication via koffi: SUCCESS");
})();
