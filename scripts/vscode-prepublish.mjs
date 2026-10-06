// The platform build script stages one verified runtime and builds shared code
// before asking VSCE to package it. Refuse bare VSCE invocations that could mix
// several cached target folders in a generic package.
if (process.env.VCODEX_PACKAGE_PREBUILT !== '1' || !process.env.VCODEX_VSIX_TARGET) {
  throw new Error('Use bun run package or node scripts/build-vsix.mjs --target <platform-arch> to package a verified platform VSIX.');
}
