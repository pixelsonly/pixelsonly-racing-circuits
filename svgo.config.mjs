// SVGO config for track + flag assets.
// Goals: shrink assets without breaking the things the consumers rely on.
//  - keep viewBox (corner positions are expressed as 0-1 of the viewBox; removing it breaks scaling)
//  - keep comments (placeholders and production notes carry sourcing/licensing info)
//  - keep aria-label / role for accessibility on the circuit pages
export default {
  multipass: true,
  js2svg: { indent: 2, pretty: true },
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          removeViewBox: false,
          removeComments: false,
          cleanupIds: false,
          // don't strip role/aria-* or title used for accessibility
          removeUnknownsAndDefaults: { keepAriaAttrs: true, keepRoleAttr: true },
        },
      },
    },
  ],
};
