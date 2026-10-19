import jpeg from "jpeg-js";

type Box = { x: number; y: number; width: number; height: number };

export function cropHomeworkJpeg(bytes: ArrayBuffer, box: Box, maxPixels = 8_000_000) {
  const decoded = jpeg.decode(new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true, maxResolutionInMP: Math.min(maxPixels, 12_000_000) / 1_000_000 });
  if (!decoded.width || !decoded.height || decoded.width * decoded.height > Math.min(maxPixels, 12_000_000)) throw new Error("校准图尺寸过大，暂不生成错题局部图");
  const paddingX = Math.max(8, Math.round(decoded.width * .025));
  const paddingY = Math.max(8, Math.round(decoded.height * .025));
  const left = Math.max(0, Math.floor(box.x / 1000 * decoded.width) - paddingX);
  const top = Math.max(0, Math.floor(box.y / 1000 * decoded.height) - paddingY);
  const right = Math.min(decoded.width, Math.ceil((box.x + box.width) / 1000 * decoded.width) + paddingX);
  const bottom = Math.min(decoded.height, Math.ceil((box.y + box.height) / 1000 * decoded.height) + paddingY);
  const width = right - left; const height = bottom - top;
  if (width < 16 || height < 16 || width * height > 4_000_000) throw new Error("错题定位区域无效");
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((top + row) * decoded.width + left) * 4;
    data.set(decoded.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  const encoded = jpeg.encode({ data, width, height }, 88).data;
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}
