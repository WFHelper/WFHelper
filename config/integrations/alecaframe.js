"use strict";

const ALECA_FETCH_TIMEOUT_MS = 8_000;

const ALECA_KEY_SOURCE = Object.freeze({
  // Pinned raw file URL (includes immutable gist file revision segment).
  url: "https://gist.githubusercontent.com/nrbdev/cd73cc5c02ee5e23aca3251423aa85b0/raw/04c15a877e37a9e6cbaa8d0beb5e1a75b229d60c/enc_key",
  sha256: "f94736532c339d7bbac874f8cd1467cb9330d7cf8dd029467d222e7e5f99e468",
});

const ALECA_IV_SOURCE = Object.freeze({
  // Pinned raw file URL (includes immutable gist file revision segment).
  url: "https://gist.githubusercontent.com/nrbdev/8ebb6a1849ebbf80724b26faf30451a1/raw/b767141aea5d050f138e41d507ecbb91bb14f636/enc_iv",
  sha256: "d670fc7a5cafef4cacff2ee7716cce8ffc6b2d0a46d507a52b8be73ba97268ca",
});

module.exports = {
  ALECA_FETCH_TIMEOUT_MS,
  ALECA_KEY_SOURCE,
  ALECA_IV_SOURCE,
};