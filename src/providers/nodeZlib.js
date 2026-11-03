import { Buffer } from "buffer";
import { deflateRaw, inflateRaw } from "pako";

export function deflateRawSync(input) {
  return Buffer.from(deflateRaw(input));
}

export function inflateRawSync(input) {
  return Buffer.from(inflateRaw(input));
}